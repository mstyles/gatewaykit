import http from 'node:http';
import { systemClock } from './clock.js';
import type { GatewayConfig, RouteConfig } from './config/types.js';
import { GatewayError } from './errors.js';
import { consoleLogger } from './logger.js';
import { buildRouteHandler } from './pipeline/build.js';
import type { GatewayDeps, GatewayRequest, GatewayResponse, Handler, HeaderMap } from './pipeline/types.js';
import { Router } from './router.js';

const MAX_BODY_BYTES = 10 * 1024 * 1024;

interface CompiledRoute extends RouteConfig {
  handle: Handler;
}

export interface Gateway {
  server: http.Server;
  /** Stops accepting connections, drops keep-alive sockets and stops background work. */
  close(): Promise<void>;
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

  async function dispatch(req: http.IncomingMessage, url: URL): Promise<GatewayResponse> {
    const method = req.method ?? 'GET';

    // Always available, and takes precedence over any configured route at the same path.
    if (url.pathname === '/health') {
      if (method !== 'GET') throw new GatewayError(405, 'method_not_allowed', {}, { allow: 'GET' });
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
    };
    return match.route.handle(request);
  }

  const server = http.createServer(async (req, res) => {
    const started = deps.clock.now();
    // Parsing against a dummy origin resolves dot segments, so "/api/users/../internal"
    // is routed (and authenticated) as "/api/internal" rather than slipping past a route.
    const url = new URL(req.url ?? '/', 'http://gateway.invalid');
    let response: GatewayResponse;
    try {
      response = await dispatch(req, url);
    } catch (err) {
      response = errorResponse(err, deps);
    }
    writeResponse(res, req.method, response);
    deps.logger.info('request', {
      method: req.method,
      path: url.pathname,
      status: response.status,
      duration_ms: deps.clock.now() - started,
    });
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        shutdown.abort();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): GatewayResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify(body)),
  };
}

function errorResponse(err: unknown, deps: GatewayDeps): GatewayResponse {
  if (err instanceof GatewayError) {
    return json(err.status, { error: err.code, ...err.body }, err.headers);
  }
  deps.logger.error('unhandled error', { error: err instanceof Error ? err.stack : String(err) });
  return json(500, { error: 'internal_error' });
}

function writeResponse(res: http.ServerResponse, method: string | undefined, response: GatewayResponse): void {
  if (res.headersSent || res.destroyed) return;
  const headers: HeaderMap = { ...response.headers };
  // Bodies are fully buffered (and may be transformed), so length is always recomputed.
  // HEAD responses keep the upstream's content-length since they carry no body.
  if (method !== 'HEAD') headers['content-length'] = String(response.body.length);
  res.writeHead(response.status, headers);
  res.end(method === 'HEAD' ? undefined : response.body);
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new GatewayError(413, 'payload_too_large', { max_bytes: MAX_BODY_BYTES }, { connection: 'close' });
    }
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
