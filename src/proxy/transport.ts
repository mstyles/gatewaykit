import http from 'node:http';
import https from 'node:https';
import type { UpstreamTarget } from '../config/types.js';
import { GatewayError } from '../errors.js';
import type { GatewayRequest, GatewayResponse, HeaderMap } from '../pipeline/types.js';

// RFC 9110 §7.6.1: connection-scoped headers that must not be forwarded by a proxy.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function stripHopByHop(headers: Record<string, string | string[] | undefined>): HeaderMap {
  const listedInConnection = String(headers.connection ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const result: HeaderMap = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || listedInConnection.includes(name)) continue;
    result[name] = value;
  }
  return result;
}

/**
 * Sends one request to one upstream target and buffers the response. Upstream HTTP errors
 * (4xx/5xx) are returned as responses. Timeouts (504) and connection failures (502) are
 * thrown so retry and circuit-breaker middleware can tell them apart from real responses.
 * If the client goes away (`req.signal`), the upstream request is cancelled and a
 * `client_closed_request` error is thrown; retry and the breaker must not count it.
 */
export async function forward(req: GatewayRequest, target: UpstreamTarget, timeoutMs: number): Promise<GatewayResponse> {
  const url = upstreamUrl(target.url, req.path, req.query);
  const headers: HeaderMap = {
    ...stripHopByHop(req.headers),
    host: url.host,
    'content-length': String(req.body.length),
    'x-forwarded-for': appendForwardedFor(req.headers['x-forwarded-for'], req.clientIp),
    'x-forwarded-proto': 'http',
  };
  if (typeof req.headers.host === 'string') headers['x-forwarded-host'] = req.headers.host;

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  try {
    return await send(url, req.method, headers, req.body, AbortSignal.any([timeout.signal, req.signal]));
  } catch (err) {
    if (req.signal.aborted) throw new GatewayError(499, 'client_closed_request');
    if (timeout.signal.aborted) {
      throw new GatewayError(504, 'gateway_timeout', { message: `upstream did not respond within ${timeoutMs}ms` });
    }
    throw new GatewayError(502, 'bad_gateway', {
      message: 'upstream unavailable',
      cause: (err as NodeJS.ErrnoException).code ?? 'unknown',
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Joins the target's base path (if any) with the request path. */
export function upstreamUrl(base: URL, path: string, query = ''): URL {
  const url = new URL(base);
  url.pathname = base.pathname.replace(/\/+$/, '') + path;
  url.search = query;
  return url;
}

function appendForwardedFor(existing: string | string[] | undefined, clientIp: string): string {
  const prior = Array.isArray(existing) ? existing.join(', ') : existing;
  return prior ? `${prior}, ${clientIp}` : clientIp;
}

function send(url: URL, method: string, headers: HeaderMap, body: Buffer, signal: AbortSignal): Promise<GatewayResponse> {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, { method, headers, signal }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 502,
          headers: stripHopByHop(response.headers),
          body: Buffer.concat(chunks),
        }),
      );
    });
    request.on('error', reject);
    request.end(body);
  });
}
