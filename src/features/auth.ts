import { createHash, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../clock.js';
import { GatewayError } from '../errors.js';
import type { Feature } from '../pipeline/types.js';

/** Failed attempts allowed per client IP per window before the route stops checking keys. */
export const MAX_FAILED_ATTEMPTS = 10;
export const FAILED_ATTEMPT_WINDOW_MS = 60_000;

/**
 * API-key auth. A missing or wrong key is 401 either way, so a client can't tell which one it
 * got. Keys are compared in constant time, and the key header is removed before forwarding so
 * gateway credentials never reach the upstream.
 *
 * rate_limit runs inside auth and never sees rejected requests, so auth limits failures itself:
 * after MAX_FAILED_ATTEMPTS from one IP within the window, that IP gets 429 without its key
 * being checked, until the window ends.
 */
export const auth: Feature = {
  name: 'auth',
  create(route, deps) {
    if (!route.auth) return undefined;
    const { header, keys } = route.auth;
    const keyDigests = keys.map(digest);
    const failures = new FailureCounter(deps.clock, MAX_FAILED_ATTEMPTS, FAILED_ATTEMPT_WINDOW_MS);

    return async (req, next) => {
      const lockedFor = failures.lockedForMs(req.clientIp);
      if (lockedFor > 0) {
        const retryAfter = Math.ceil(lockedFor / 1000);
        throw new GatewayError(
          429,
          'too_many_requests',
          { message: 'too many failed authentication attempts', retry_after: retryAfter },
          { 'retry-after': String(retryAfter) },
        );
      }

      const presented = req.headers[header];
      if (typeof presented !== 'string' || !matchesAny(digest(presented), keyDigests)) {
        failures.record(req.clientIp);
        throw new GatewayError(401, 'unauthorized', { message: `missing or invalid ${header} header` });
      }

      const { [header]: _key, ...headers } = req.headers;
      return next({ ...req, headers });
    };
  },
};

/** Hashing first gives equal-length inputs, which timingSafeEqual requires. */
function digest(key: string): Buffer {
  return createHash('sha256').update(key).digest();
}

/** Checks every key, so the time taken doesn't reveal which one (if any) matched. */
function matchesAny(candidate: Buffer, keyDigests: readonly Buffer[]): boolean {
  let matched = false;
  for (const keyDigest of keyDigests) matched = timingSafeEqual(candidate, keyDigest) || matched;
  return matched;
}

/** Fixed-window failure counts per client IP. Expired entries are swept once per window. */
class FailureCounter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private lastSweep: number;

  constructor(
    private readonly clock: Clock,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    this.lastSweep = clock.now();
  }

  /** How long this IP stays locked out, or 0 if it may try a key. */
  lockedForMs(ip: string): number {
    const now = this.clock.now();
    this.sweep(now);
    const window = this.windows.get(ip);
    if (!window || now - window.start >= this.windowMs || window.count < this.limit) return 0;
    return window.start + this.windowMs - now;
  }

  record(ip: string): void {
    const now = this.clock.now();
    const window = this.windows.get(ip);
    if (!window || now - window.start >= this.windowMs) this.windows.set(ip, { start: now, count: 1 });
    else window.count++;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [ip, window] of this.windows) {
      if (now - window.start >= this.windowMs) this.windows.delete(ip);
    }
  }
}
