import type { Clock } from '../clock.js';
import type { CircuitBreakerConfig } from '../config/types.js';
import { GatewayError } from '../errors.js';
import type { Feature, GatewayResponse } from '../pipeline/types.js';

/** Thrown gateway failures that mean "the upstream never answered", as opposed to rejections. */
const TRANSPORT_FAILURES = new Set([502, 504]);

export type BreakerState = 'closed' | 'open' | 'half_open';

/**
 * How a request ended, from the breaker's point of view. `ignored` covers outcomes that say
 * nothing about upstream health: a client abort (499), a gateway rejection, or a bug.
 */
export type BreakerResult = 'success' | 'failure' | 'ignored';

/** A request the breaker let through. `probe` is the single half-open trial request. */
export interface Permit {
  probe: boolean;
}

export type Admission = ({ allowed: true } & Permit) | { allowed: false; retryAfterMs: number };

/**
 * closed → open when `threshold` failures land within `window`; open → half_open once
 * `cooldown` has elapsed (checked lazily, on the next request); half_open lets exactly one
 * probe through and rejects everything else until it settles. The probe's success closes the
 * breaker and its failure reopens it with a fresh cooldown.
 *
 * Only results from the state a request was admitted in count: a request admitted while
 * closed that fails after the breaker opened doesn't extend the cooldown or disturb a probe.
 * Admission and recording are synchronous, so on Node's single thread concurrent requests
 * can't both become the probe.
 */
export class CircuitBreaker {
  private current: BreakerState = 'closed';
  /** Failure timestamps within the window while closed; never more than `threshold`. */
  private failures: number[] = [];
  private openUntil = 0;
  private probeInFlight = false;

  constructor(
    private readonly config: CircuitBreakerConfig,
    private readonly clock: Clock,
    private readonly onTransition: (from: BreakerState, to: BreakerState) => void = () => {},
  ) {}

  get state(): BreakerState {
    return this.current;
  }

  tryAcquire(): Admission {
    const now = this.clock.now();
    if (this.current === 'open') {
      if (now < this.openUntil) return { allowed: false, retryAfterMs: this.openUntil - now };
      this.transition('half_open');
    }
    if (this.current === 'half_open') {
      // The probe's duration is unknown, so there's no better hint than "try again shortly".
      if (this.probeInFlight) return { allowed: false, retryAfterMs: 0 };
      this.probeInFlight = true;
      return { allowed: true, probe: true };
    }
    return { allowed: true, probe: false };
  }

  record(permit: Permit, result: BreakerResult): void {
    if (permit.probe) {
      this.probeInFlight = false;
      if (result === 'success') this.close();
      else if (result === 'failure') this.open();
      return;
    }
    if (this.current !== 'closed' || result !== 'failure') return;

    const now = this.clock.now();
    const firstLive = this.failures.findIndex((t) => t > now - this.config.windowMs);
    this.failures.splice(0, firstLive === -1 ? this.failures.length : firstLive);
    this.failures.push(now);
    if (this.failures.length >= this.config.threshold) this.open();
  }

  private open(): void {
    this.failures = [];
    this.openUntil = this.clock.now() + this.config.cooldownMs;
    this.transition('open');
  }

  private close(): void {
    this.failures = [];
    this.transition('closed');
  }

  private transition(to: BreakerState): void {
    const from = this.current;
    this.current = to;
    this.onTransition(from, to);
  }
}

/** A failure is an upstream 5xx or a timeout/connection failure, measured after retries. */
export function classify(outcome: Outcome): BreakerResult {
  if (outcome.ok) return outcome.response.status >= 500 ? 'failure' : 'success';
  return outcome.error instanceof GatewayError && TRANSPORT_FAILURES.has(outcome.error.status) ? 'failure' : 'ignored';
}

/**
 * One breaker per route, in process memory. Sits outside retry, so it sees one outcome per
 * client request (after all retries), and an open breaker rejects before any retry runs.
 * Rejections are 503 `service_unavailable` with `retry_after` and `Retry-After`.
 */
export const circuitBreakerFeature: Feature = {
  name: 'circuit_breaker',
  create(route, { clock, logger }) {
    const config = route.circuitBreaker;
    if (!config) return undefined;

    const breaker = new CircuitBreaker(config, clock, (from, to) => {
      const fields = { route: route.path, from, to };
      if (to === 'open') logger.warn('circuit breaker opened', { ...fields, cooldown_ms: config.cooldownMs });
      else logger.info(to === 'closed' ? 'circuit breaker closed' : 'circuit breaker half-open', fields);
    });

    return async (req, next) => {
      const admission = breaker.tryAcquire();
      if (!admission.allowed) {
        const retryAfter = Math.max(1, Math.ceil(admission.retryAfterMs / 1000));
        throw new GatewayError(503, 'service_unavailable', { retry_after: retryAfter }, { 'retry-after': String(retryAfter) });
      }
      let response: GatewayResponse;
      try {
        response = await next(req);
      } catch (error) {
        breaker.record(admission, classify({ ok: false, error }));
        throw error;
      }
      breaker.record(admission, classify({ ok: true, response }));
      return response;
    };
  },
};

type Outcome = { ok: true; response: GatewayResponse } | { ok: false; error: unknown };
