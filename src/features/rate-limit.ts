import type { Clock } from '../clock.js';
import type { RateLimitConfig } from '../config/types.js';
import { GatewayError } from '../errors.js';
import type { Feature, GatewayResponse } from '../pipeline/types.js';

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  /** When rejected: how long until a request would be allowed. */
  retryAfterMs: number;
}

/**
 * Check-and-consume in one synchronous call. Node runs JavaScript on a single thread, so
 * there is no await between reading and updating a bucket and concurrent requests cannot
 * race past the limit. A multi-process deployment would need a shared store (e.g. Redis
 * with an atomic script) instead.
 */
export interface RateLimiter {
  tryAcquire(key: string): RateLimitDecision;
  /** Drops buckets that can no longer affect a decision, bounding memory by active keys. */
  sweep(): void;
  /** Number of tracked keys (exposed for tests). */
  readonly size: number;
}

/**
 * Counts requests in windows aligned to the epoch. Cheap (one counter per key), but allows
 * bursts of up to 2x the limit across a window boundary.
 */
export class FixedWindowLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly config: RateLimitConfig,
    private readonly clock: Clock,
  ) {}

  get size(): number {
    return this.buckets.size;
  }

  tryAcquire(key: string): RateLimitDecision {
    const now = this.clock.now();
    const windowStart = now - (now % this.config.windowMs);
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.windowStart !== windowStart) {
      bucket = { windowStart, count: 0 };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= this.config.requests) {
      return { allowed: false, remaining: 0, retryAfterMs: windowStart + this.config.windowMs - now };
    }
    bucket.count++;
    return { allowed: true, remaining: this.config.requests - bucket.count, retryAfterMs: 0 };
  }

  sweep(): void {
    const now = this.clock.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowStart + this.config.windowMs <= now) this.buckets.delete(key);
    }
  }
}

/**
 * Sliding log: keeps the timestamps of accepted requests within the last window. Exact (no
 * boundary bursts) at the cost of memory proportional to `requests` per key, which is small
 * for the limits a gateway config expresses. Rejected requests are not logged, so a client
 * hammering a limit is not locked out beyond the window.
 */
export class SlidingWindowLimiter implements RateLimiter {
  private readonly logs = new Map<string, number[]>();

  constructor(
    private readonly config: RateLimitConfig,
    private readonly clock: Clock,
  ) {}

  get size(): number {
    return this.logs.size;
  }

  tryAcquire(key: string): RateLimitDecision {
    const now = this.clock.now();
    const log = this.logs.get(key) ?? [];
    const firstLive = log.findIndex((t) => t > now - this.config.windowMs);
    log.splice(0, firstLive === -1 ? log.length : firstLive);

    if (log.length >= this.config.requests) {
      this.logs.set(key, log);
      return { allowed: false, remaining: 0, retryAfterMs: log[0] + this.config.windowMs - now };
    }
    log.push(now);
    this.logs.set(key, log);
    return { allowed: true, remaining: this.config.requests - log.length, retryAfterMs: 0 };
  }

  sweep(): void {
    const cutoff = this.clock.now() - this.config.windowMs;
    for (const [key, log] of this.logs) {
      if (log.length === 0 || log[log.length - 1] <= cutoff) this.logs.delete(key);
    }
  }
}

export function createRateLimiter(config: RateLimitConfig, clock: Clock): RateLimiter {
  const limiter =
    config.strategy === 'sliding_window'
      ? new SlidingWindowLimiter(config, clock)
      : new FixedWindowLimiter(config, clock);
  return sweepingLazily(limiter, config.windowMs, clock);
}

/**
 * Sweeps at most once per window, on the request path. There is no timer to stop on shutdown
 * (or to overflow on very long windows), and sweeps follow the injected clock. An idle gateway
 * keeps its stale buckets until the next request, which is harmless.
 */
function sweepingLazily(limiter: RateLimiter, windowMs: number, clock: Clock): RateLimiter {
  let lastSweep = clock.now();
  return {
    tryAcquire(key) {
      const now = clock.now();
      if (now - lastSweep >= windowMs) {
        limiter.sweep();
        lastSweep = now;
      }
      return limiter.tryAcquire(key);
    },
    sweep: () => limiter.sweep(),
    get size() {
      return limiter.size;
    },
  };
}

const GLOBAL_KEY = '*';

/**
 * Applies the route's effective rate limit (its own, else the global default). Each route
 * gets independent buckets: global_rate_limit is a default applied per route, not one
 * counter shared across the whole gateway.
 */
export const rateLimitFeature: Feature = {
  name: 'rate_limit',
  create(route, { clock }) {
    const config = route.rateLimit;
    if (!config) return undefined;

    const limiter = createRateLimiter(config, clock);

    return async (req, next) => {
      const decision = limiter.tryAcquire(config.per === 'global' ? GLOBAL_KEY : req.clientIp);
      const headers = {
        'x-ratelimit-limit': String(config.requests),
        'x-ratelimit-remaining': String(decision.remaining),
      };
      if (!decision.allowed) {
        const retryAfter = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
        throw new GatewayError(429, 'too_many_requests', { retry_after: retryAfter }, {
          ...headers,
          'retry-after': String(retryAfter),
        });
      }
      let response: GatewayResponse;
      try {
        response = await next(req);
      } catch (err) {
        // Gateway-generated failures further in (502/504, an open breaker) still used budget.
        // Added in place so the error keeps its class, stack and cause.
        if (err instanceof GatewayError) Object.assign(err.headers, headers);
        throw err;
      }
      return { ...response, headers: { ...response.headers, ...headers } };
    };
  },
};
