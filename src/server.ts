import http from 'node:http';
import { systemClock } from './clock.js';
import type { GatewayConfig, RouteConfig } from './config/types.js';
import { GatewayError } from './errors.js';
import { consoleLogger } from './logger.js';
import { buildRouteHandler } from './pipeline/build.js';
import type { GatewayDeps, GatewayRequest, GatewayResponse, Handler, HeaderMap } from './pipeline/types.js';
import { Router } from './router.js';

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const SHUTDOWN_GRACE_MS = 10_000;
/** Logged, never sent: the nginx convention for "client closed the connection first". */
const CLIENT_CLOSED_REQUEST = 499;
// Encoded "/" or "\": upstreams that decode them would see a different path than we routed.
const ENCODED_SEPARATOR = /%2f|%5c/i;

interface CompiledRoute extends RouteConfig {
  handle: Handler;
}

export interface Gateway {
  server: http.Server;
  /**
   * Stops accepting connections and background work, lets in-flight requests finish, and
   * force-closes whatever is still open after `graceMs`.
   */
  close(graceMs?: number): Promise<void>;
}

export function createGateway(config: GatewayConfig, overrides: Partial<Omit<GatewayDeps, 'shutdown'>> = {}): Gateway {
  const shutdown = new AbortController();
  const deps: GatewayDeps = {
    clock: overrides.clock ?? systemClock,
    logger: overrides.logger ?? consoleLogger,
    shutdown: shutdown.signal,
  };
  const startedAt = deps.clock.now();
  const router = new Router<CompiledRoute>(
    config.routes.map((route) => ({ ...route, handle: buildRouteHandler(route, deps) })),
  );

  async function dispatch(req: http.IncomingMessage, url: URL, signal: AbortSignal): Promise<GatewayResponse> {
    const method = req.method ?? 'GET';

    // Always available, and takes precedence over any configured route at the same path.
    if (url.pathname === '/health') {
      if (method !== 'GET' && method !== 'HEAD') {
        throw new GatewayError(405, 'method_not_allowed', {}, { allow: 'GET, HEAD' });
      }
      const uptimeSeconds = Math.floor((deps.clock.now() - startedAt) / 1000);
      return json(200, { status: 'healthy', uptime_seconds: uptimeSeconds });
    }

    const match = router.match(method, url.pathname);
    if (match.kind === 'not_found') throw new GatewayError(404, 'not_found');
    if (match.kind === 'method_not_allowed') {
      throw new GatewayError(405, 'method_not_allowed', {}, { allow: match.allowed.join(', ') });
    }

    const request: GatewayRequest = {
      method,
      originalPath: url.pathname,
      path: match.upstreamPath,
      query: url.search,
      headers: definedHeaders(req.headers),
      body: await readBody(req),
      clientIp: clientIp(req),
      receivedAt: new Date(deps.clock.now()),
      route: match.route,
      signal,
    };
    return match.route.handle(request);
  }

  const server = http.createServer(async (req, res) => {
    const started = deps.clock.now();
    let path = req.url ?? '/';
    let response: GatewayResponse;
    const clientGone = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) clientGone.abort();
    });
    // Everything stays inside the try: a throw escaping this async handler is an unhandled
    // rejection, which takes down the whole process.
    try {
      const url = parseRequestUrl(req.url ?? '/');
      path = url.pathname;
      response = await dispatch(req, url, clientGone.signal);
    } catch (err) {
      if (clientClosed(res)) return logClientClosed(req, path, started);
      response = errorResponse(err, deps);
    }
    // The client hung up while we were reading its body or waiting on the upstream: there is
    // no one to answer, and it isn't a gateway failure.
    if (clientClosed(res)) return logClientClosed(req, path, started);
    try {
      writeResponse(res, req.method, response, shutdown.signal.aborted);
    } catch (err) {
      deps.logger.error('failed to write response', { error: err instanceof Error ? err.message : String(err) });
      res.destroy();
    }
    deps.logger.info('request', {
      method: req.method,
      path,
      status: response.status,
      duration_ms: deps.clock.now() - started,
    });
  });

  function logClientClosed(req: http.IncomingMessage, path: string, started: number): void {
    deps.logger.info('request', {
      method: req.method,
      path,
      status: CLIENT_CLOSED_REQUEST,
      duration_ms: deps.clock.now() - started,
    });
  }

  return {
    server,
    close: (graceMs = SHUTDOWN_GRACE_MS) =>
      new Promise<void>((resolve) => {
        shutdown.abort();
        // Let in-flight requests finish (their responses carry "connection: close"), and only
        // cut remaining connections once the grace period runs out.
        const force = setTimeout(() => server.closeAllConnections(), graceMs);
        force.unref();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      }),
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): GatewayResponse {
  const payload = Buffer.from(JSON.stringify(body));
  return {
    status,
    // Set here so HEAD responses to gateway-generated JSON still report the body's length.
    headers: { 'content-type': 'application/json', 'content-length': String(payload.length), ...headers },
    body: payload,
  };
}

function errorResponse(err: unknown, deps: GatewayDeps): GatewayResponse {
  if (err instanceof GatewayError) {
    // The code goes last so a body can't overwrite it.
    return json(err.status, { ...err.body, error: err.code }, err.headers);
  }
  deps.logger.error('unhandled error', { error: err instanceof Error ? err.stack : String(err) });
  return json(500, { error: 'internal_error' });
}

/**
 * Parsing against a dummy origin resolves dot segments (including encoded ones), so
 * "/api/users/../internal" is routed, and authenticated, as "/api/internal".
 */
function parseRequestUrl(target: string): URL {
  // "//host/path" would otherwise parse as a protocol-relative URL, turning "host" into a hostname.
  const normalized = target.replace(/^\/{2,}/, '/');
  let url: URL;
  try {
    url = new URL(normalized, 'http://gateway.invalid');
  } catch {
    throw new GatewayError(400, 'bad_request', { message: 'invalid request target' });
  }
  if (ENCODED_SEPARATOR.test(url.pathname)) {
    throw new GatewayError(400, 'bad_request', { message: 'encoded path separators are not allowed' });
  }
  return url;
}

function writeResponse(
  res: http.ServerResponse,
  method: string | undefined,
  response: GatewayResponse,
  closing: boolean,
): void {
  if (res.headersSent || res.destroyed) return;
  const headers: HeaderMap = { ...response.headers };
  if (closing) headers.connection = 'close';
  // Bodies are fully buffered (and may be transformed), so length is always recomputed.
  // HEAD responses have no body, so they keep the content-length they came with.
  if (method !== 'HEAD') headers['content-length'] = String(response.body.length);
  res.writeHead(response.status, headers);
  res.end(method === 'HEAD' ? undefined : response.body);
}

function clientClosed(res: http.ServerResponse): boolean {
  return res.destroyed && !res.writableEnded;
}

function payloadTooLarge(): GatewayError {
  return new GatewayError(413, 'payload_too_large', { max_bytes: MAX_BODY_BYTES }, { connection: 'close' });
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  // Reject a declared oversize body before reading any of it.
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) throw payloadTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw payloadTooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function definedHeaders(headers: http.IncomingHttpHeaders): HeaderMap {
  const result: HeaderMap = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) result[name] = value;
  }
  return result;
}

/**
 * The TCP peer address. X-Forwarded-For is deliberately not trusted: a client could set it
 * to dodge per-IP rate limits. Supporting a trusted-proxy list is future work.
 */
function clientIp(req: http.IncomingMessage): string {
  const address = req.socket.remoteAddress ?? 'unknown';
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}
