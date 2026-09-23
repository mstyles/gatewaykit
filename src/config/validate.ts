import { parseDuration } from './duration.js';
import {
  AUTH_TYPES,
  BACKOFF_STRATEGIES,
  BALANCE_STRATEGIES,
  HTTP_METHODS,
  RATE_LIMIT_SCOPES,
  RATE_LIMIT_STRATEGIES,
  type AuthConfig,
  type CircuitBreakerConfig,
  type GatewayConfig,
  type HeaderTransform,
  type HealthCheckConfig,
  type RateLimitConfig,
  type RequestTransformConfig,
  type ResponseTransformConfig,
  type RetryConfig,
  type RouteConfig,
  type UpstreamConfig,
  type UpstreamTarget,
} from './types.js';

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`invalid gateway config:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export interface ValidationResult {
  config: GatewayConfig;
  /** Non-fatal problems, e.g. unknown keys (likely typos). */
  warnings: string[];
}

const DEFAULT_PORT = 8080;
const DEFAULT_GLOBAL_TIMEOUT_MS = 30_000;

const GATEWAY_KEYS = ['port', 'global_timeout', 'global_rate_limit'];
const ROUTE_KEYS = [
  'path',
  'methods',
  'strip_prefix',
  'upstream',
  'rate_limit',
  'retry',
  'health_check',
  'request_transform',
  'response_transform',
  'auth',
  'circuit_breaker',
];
const UPSTREAM_KEYS = ['url', 'targets', 'balance', 'timeout'];
const RATE_LIMIT_KEYS = ['requests', 'window', 'strategy', 'per'];
const HEADER_TRANSFORM_KEYS = ['add', 'remove'];

type RawObject = Record<string, unknown>;

interface Issues {
  errors: string[];
  warnings: string[];
}

const MISSING = Symbol('missing');

const isObject = (value: unknown): value is RawObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads one mapping of the raw config. On invalid input a reader records an error and
 * returns a placeholder, so a single pass reports every problem at once. validateConfig
 * throws before a config containing placeholders can escape.
 */
class Reader {
  constructor(
    private readonly raw: RawObject,
    readonly path: string,
    private readonly issues: Issues,
    allowedKeys: readonly string[],
  ) {
    for (const key of Object.keys(raw)) {
      if (!allowedKeys.includes(key)) issues.warnings.push(`${this.at(key)}: unknown key, ignored`);
    }
  }

  at(key: string): string {
    return this.path ? `${this.path}.${key}` : key;
  }

  has(key: string): boolean {
    return this.raw[key] !== undefined && this.raw[key] !== null;
  }

  error(message: string, key?: string): void {
    this.issues.errors.push(`${key === undefined ? this.path : this.at(key)}: ${message}`);
  }

  private required(key: string): unknown {
    if (this.has(key)) return this.raw[key];
    this.error('is required', key);
    return MISSING;
  }

  string(key: string): string {
    const value = this.required(key);
    if (value === MISSING) return '';
    if (typeof value !== 'string' || value === '') {
      this.error('must be a non-empty string', key);
      return '';
    }
    return value;
  }

  int(key: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
    const value = this.required(key);
    if (value === MISSING) return min;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      this.error(`must be an integer between ${min} and ${max}`, key);
      return min;
    }
    return value;
  }

  boolean(key: string): boolean {
    const value = this.required(key);
    if (value === MISSING) return false;
    if (typeof value !== 'boolean') {
      this.error('must be true or false', key);
      return false;
    }
    return value;
  }

  duration(key: string, { allowZero = false } = {}): number {
    const value = this.required(key);
    if (value === MISSING) return 0;
    if (typeof value !== 'string') {
      this.error('must be a duration string such as "30s" (bare numbers are ambiguous)', key);
      return 0;
    }
    try {
      const ms = parseDuration(value);
      if (ms === 0 && !allowZero) this.error('must be greater than zero', key);
      return ms;
    } catch (err) {
      this.error((err as Error).message, key);
      return 0;
    }
  }

  oneOf<T extends string>(key: string, allowed: readonly T[]): T {
    const value = this.required(key);
    if (value === MISSING) return allowed[0];
    if (!allowed.includes(value as T)) {
      this.error(`must be one of ${allowed.map((a) => `"${a}"`).join(', ')}`, key);
      return allowed[0];
    }
    return value as T;
  }

  url(key: string): URL {
    const placeholder = new URL('http://invalid.invalid');
    const value = this.string(key);
    if (!value) return placeholder;
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        this.error('must be an http:// or https:// URL', key);
        return placeholder;
      }
      return url;
    } catch {
      this.error(`is not a valid URL: "${value}"`, key);
      return placeholder;
    }
  }

  stringArray(key: string): string[] {
    const value = this.required(key);
    if (value === MISSING) return [];
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      this.error('must be a list of strings', key);
      return [];
    }
    return value;
  }

  intArray(key: string, min: number, max: number): number[] {
    const value = this.required(key);
    if (value === MISSING) return [];
    const valid = (item: unknown) => Number.isInteger(item) && (item as number) >= min && (item as number) <= max;
    if (!Array.isArray(value) || !value.every(valid)) {
      this.error(`must be a list of integers between ${min} and ${max}`, key);
      return [];
    }
    return value;
  }

  stringMap(key: string): Record<string, string> {
    const value = this.required(key);
    if (value === MISSING) return {};
    if (!isObject(value) || !Object.values(value).every((v) => typeof v === 'string')) {
      this.error('must be a mapping of string keys to string values', key);
      return {};
    }
    return value as Record<string, string>;
  }

  anyObject(key: string): RawObject {
    const value = this.required(key);
    if (value === MISSING) return {};
    if (!isObject(value)) {
      this.error('must be a mapping', key);
      return {};
    }
    return value;
  }

  object(key: string, allowedKeys: readonly string[]): Reader {
    return new Reader(this.anyObject(key), this.at(key), this.issues, allowedKeys);
  }

  objectList(key: string, allowedKeys: readonly string[]): Reader[] {
    const value = this.required(key);
    if (value === MISSING) return [];
    if (!Array.isArray(value)) {
      this.error('must be a list', key);
      return [];
    }
    return value.flatMap((item, i) => {
      const path = `${this.at(key)}[${i}]`;
      if (!isObject(item)) {
        this.issues.errors.push(`${path}: must be a mapping`);
        return [];
      }
      return [new Reader(item, path, this.issues, allowedKeys)];
    });
  }
}

/** Reads an optional sub-section, returning undefined when the key is absent. */
function section<T>(r: Reader, key: string, keys: readonly string[], read: (s: Reader) => T): T | undefined {
  return r.has(key) ? read(r.object(key, keys)) : undefined;
}

export function validateConfig(raw: unknown): ValidationResult {
  if (!isObject(raw)) throw new ConfigError(['config root must be a mapping with "gateway" and "routes"']);

  const issues: Issues = { errors: [], warnings: [] };
  const root = new Reader(raw, '', issues, ['gateway', 'routes']);

  const gateway = root.object('gateway', GATEWAY_KEYS);
  const port = gateway.has('port') ? gateway.int('port', 1, 65_535) : DEFAULT_PORT;
  const globalTimeoutMs = gateway.has('global_timeout') ? gateway.duration('global_timeout') : DEFAULT_GLOBAL_TIMEOUT_MS;
  const globalRateLimit = section(gateway, 'global_rate_limit', RATE_LIMIT_KEYS, readRateLimit);

  const routes = root.objectList('routes', ROUTE_KEYS).map((r) => readRoute(r, globalTimeoutMs, globalRateLimit));
  if (routes.length === 0) issues.warnings.push('routes: no routes configured; every request except /health will 404');

  const seen = new Set<string>();
  for (const route of routes) {
    if (route.path && seen.has(route.path)) issues.errors.push(`routes: duplicate route path "${route.path}"`);
    seen.add(route.path);
  }

  if (issues.errors.length > 0) throw new ConfigError(issues.errors);
  return { config: { port, globalTimeoutMs, globalRateLimit, routes }, warnings: issues.warnings };
}

function readRoute(r: Reader, globalTimeoutMs: number, globalRateLimit?: RateLimitConfig): RouteConfig {
  return {
    path: readRoutePath(r),
    methods: readMethods(r),
    stripPrefix: r.has('strip_prefix') ? r.boolean('strip_prefix') : false,
    upstream: readUpstream(r.object('upstream', UPSTREAM_KEYS), globalTimeoutMs),
    rateLimit: section(r, 'rate_limit', RATE_LIMIT_KEYS, readRateLimit) ?? globalRateLimit,
    retry: section(r, 'retry', ['attempts', 'backoff', 'initial_delay', 'on'], readRetry),
    healthCheck: section(r, 'health_check', ['path', 'interval', 'unhealthy_threshold'], readHealthCheck),
    requestTransform: section(r, 'request_transform', ['headers', 'body'], readRequestTransform),
    responseTransform: section(r, 'response_transform', ['headers', 'body'], readResponseTransform),
    auth: section(r, 'auth', ['type', 'header', 'keys'], readAuth),
    circuitBreaker: section(r, 'circuit_breaker', ['threshold', 'window', 'cooldown'], readCircuitBreaker),
  };
}

function readRoutePath(r: Reader): string {
  const path = r.string('path');
  if (path && !path.startsWith('/')) r.error('must start with "/"', 'path');
  const normalized = path.replace(/\/+$/, '');
  return normalized === '' ? '/' : normalized;
}

function readMethods(r: Reader): string[] {
  const methods = [...new Set(r.stringArray('methods').map((m) => m.toUpperCase()))];
  if (r.has('methods') && methods.length === 0) r.error('must list at least one method', 'methods');
  for (const method of methods) {
    if (!(HTTP_METHODS as readonly string[]).includes(method)) r.error(`unsupported HTTP method "${method}"`, 'methods');
  }
  return methods;
}

function readUpstream(u: Reader, globalTimeoutMs: number): UpstreamConfig {
  let targets: UpstreamTarget[] = [];
  if (u.has('url') === u.has('targets')) {
    u.error('must set exactly one of "url" or "targets"');
  } else if (u.has('url')) {
    targets = [{ url: u.url('url'), weight: 1 }];
  } else {
    targets = u.objectList('targets', ['url', 'weight']).map((t) => ({
      url: t.url('url'),
      weight: t.has('weight') ? t.int('weight', 1) : 1,
    }));
    if (targets.length === 0) u.error('must contain at least one target', 'targets');
  }

  return {
    targets,
    balance: u.has('balance') ? u.oneOf('balance', BALANCE_STRATEGIES) : 'round_robin',
    timeoutMs: u.has('timeout') ? u.duration('timeout') : globalTimeoutMs,
  };
}

function readRateLimit(r: Reader): RateLimitConfig {
  return {
    requests: r.int('requests', 1),
    windowMs: r.duration('window'),
    strategy: r.has('strategy') ? r.oneOf('strategy', RATE_LIMIT_STRATEGIES) : 'fixed_window',
    per: r.has('per') ? r.oneOf('per', RATE_LIMIT_SCOPES) : 'ip',
  };
}

function readRetry(r: Reader): RetryConfig {
  return {
    attempts: r.int('attempts', 1, 10),
    backoff: r.has('backoff') ? r.oneOf('backoff', BACKOFF_STRATEGIES) : 'fixed',
    initialDelayMs: r.has('initial_delay') ? r.duration('initial_delay', { allowZero: true }) : 0,
    on: r.has('on') ? r.intArray('on', 100, 599) : [502, 503, 504],
  };
}

function readHealthCheck(r: Reader): HealthCheckConfig {
  const path = r.string('path');
  if (path && !path.startsWith('/')) r.error('must start with "/"', 'path');
  return {
    path,
    intervalMs: r.duration('interval'),
    unhealthyThreshold: r.has('unhealthy_threshold') ? r.int('unhealthy_threshold', 1) : 3,
  };
}

function readHeaderTransform(r: Reader): HeaderTransform {
  return {
    add: r.has('add') ? r.stringMap('add') : {},
    remove: r.has('remove') ? r.stringArray('remove').map((h) => h.toLowerCase()) : [],
  };
}

function readRequestTransform(r: Reader): RequestTransformConfig {
  return {
    headers: section(r, 'headers', HEADER_TRANSFORM_KEYS, readHeaderTransform),
    body: section(r, 'body', ['mapping'], (b) => ({ mapping: b.stringMap('mapping') })),
  };
}

function readResponseTransform(r: Reader): ResponseTransformConfig {
  return {
    headers: section(r, 'headers', HEADER_TRANSFORM_KEYS, readHeaderTransform),
    body: section(r, 'body', ['envelope'], (b) => ({ envelope: b.anyObject('envelope') })),
  };
}

function readAuth(r: Reader): AuthConfig {
  const keys = r.stringArray('keys');
  if (r.has('keys') && keys.length === 0) r.error('must list at least one key', 'keys');
  return {
    type: r.oneOf('type', AUTH_TYPES),
    header: r.string('header').toLowerCase(),
    keys,
  };
}

function readCircuitBreaker(r: Reader): CircuitBreakerConfig {
  return {
    threshold: r.int('threshold', 1),
    windowMs: r.duration('window'),
    cooldownMs: r.duration('cooldown'),
  };
}
