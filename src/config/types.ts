// Normalized, validated gateway configuration. Everything downstream of the loader works
// with these types, never with raw YAML. Durations are milliseconds; header names used for
// lookup (remove lists, auth header) are lowercased to match Node's incoming header keys.

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export const RATE_LIMIT_STRATEGIES = ['fixed_window', 'sliding_window'] as const;
export const RATE_LIMIT_SCOPES = ['ip', 'global'] as const;
export const BALANCE_STRATEGIES = ['round_robin', 'weighted_round_robin'] as const;
export const BACKOFF_STRATEGIES = ['fixed', 'exponential'] as const;
export const AUTH_TYPES = ['api_key'] as const;

export interface GatewayConfig {
  port: number;
  globalTimeoutMs: number;
  globalRateLimit?: RateLimitConfig;
  routes: RouteConfig[];
}

export interface RouteConfig {
  /** Normalized prefix: leading slash, no trailing slash (except "/"). */
  path: string;
  /** Uppercased, deduplicated. */
  methods: string[];
  stripPrefix: boolean;
  upstream: UpstreamConfig;
  /** Effective limit: the route's own rate_limit, else gateway.global_rate_limit, else none. */
  rateLimit?: RateLimitConfig;
  retry?: RetryConfig;
  healthCheck?: HealthCheckConfig;
  requestTransform?: RequestTransformConfig;
  responseTransform?: ResponseTransformConfig;
  auth?: AuthConfig;
  circuitBreaker?: CircuitBreakerConfig;
}

export interface UpstreamTarget {
  url: URL;
  weight: number;
}

export interface UpstreamConfig {
  /** A single `url` is normalized to one target with weight 1. */
  targets: UpstreamTarget[];
  balance: (typeof BALANCE_STRATEGIES)[number];
  /** Route timeout, else gateway.global_timeout. */
  timeoutMs: number;
}

export interface RateLimitConfig {
  requests: number;
  windowMs: number;
  strategy: (typeof RATE_LIMIT_STRATEGIES)[number];
  per: (typeof RATE_LIMIT_SCOPES)[number];
}

export interface RetryConfig {
  attempts: number;
  backoff: (typeof BACKOFF_STRATEGIES)[number];
  initialDelayMs: number;
  on: number[];
}

export interface HealthCheckConfig {
  path: string;
  intervalMs: number;
  unhealthyThreshold: number;
}

export interface HeaderTransform {
  add: Record<string, string>;
  remove: string[];
}

export interface RequestTransformConfig {
  headers?: HeaderTransform;
  body?: { mapping: Record<string, string> };
}

export interface ResponseTransformConfig {
  headers?: HeaderTransform;
  body?: { envelope: Record<string, unknown> };
}

export interface AuthConfig {
  type: (typeof AUTH_TYPES)[number];
  header: string;
  keys: string[];
}

export interface CircuitBreakerConfig {
  threshold: number;
  windowMs: number;
  cooldownMs: number;
}
