import type { Clock } from '../clock.js';
import type { RouteConfig } from '../config/types.js';
import type { Logger } from '../logger.js';

/** Lowercased header names, as Node delivers them. */
export type HeaderMap = Record<string, string | string[]>;

export interface GatewayRequest {
  method: string;
  /** Path as received from the client (dot segments already resolved). */
  originalPath: string;
  /** Path to send upstream: after strip_prefix; transforms may rewrite it. */
  path: string;
  /** Raw query string including the leading "?", or "". */
  query: string;
  headers: HeaderMap;
  /** Fully buffered; see DECISIONS.md (needed for retries and body transforms). */
  body: Buffer;
  clientIp: string;
  receivedAt: Date;
  route: RouteConfig;
  /**
   * Aborted when the client goes away before the response is written. Anything slow on the
   * request path (upstream calls, retry backoff) should stop when it fires.
   */
  signal: AbortSignal;
}

export interface GatewayResponse {
  status: number;
  headers: HeaderMap;
  body: Buffer;
}

export type Handler = (req: GatewayRequest) => Promise<GatewayResponse>;

/**
 * Wraps the rest of the pipeline. Upstream HTTP responses (including 5xx) come back from
 * `next` as values; transport failures and gateway rejections are thrown as GatewayError.
 */
export type Middleware = (req: GatewayRequest, next: Handler) => Promise<GatewayResponse>;

export interface GatewayDeps {
  clock: Clock;
  logger: Logger;
  /** Aborted when the gateway shuts down: stop background work such as health checks. */
  shutdown: AbortSignal;
}

/**
 * One config-driven capability. `create` is called once per route at startup and returns
 * undefined when the route doesn't configure it, so unused features cost nothing per request.
 */
export interface Feature {
  name: string;
  create(route: RouteConfig, deps: GatewayDeps): Middleware | undefined;
}

export function compose(middlewares: readonly Middleware[], terminal: Handler): Handler {
  return middlewares.reduceRight<Handler>((next, middleware) => (req) => middleware(req, next), terminal);
}
