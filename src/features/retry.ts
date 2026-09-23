import type { RetryConfig } from '../config/types.js';
import { GatewayError } from '../errors.js';
import type { Feature, GatewayResponse } from '../pipeline/types.js';

/** Thrown gateway failures that mean "the upstream never answered", as opposed to rejections. */
const TRANSPORT_FAILURES = new Set([502, 504]);

/** Exponential delays vary by ±20% so clients that failed together don't retry in lockstep. */
const JITTER = 0.2;

/**
 * Delay before retry `n` (1 = the first retry). `fixed` waits `initial_delay` every time;
 * `exponential` doubles it each retry, with jitter. `random` is injectable for tests.
 */
export function backoffDelay(config: RetryConfig, n: number, random: () => number = Math.random): number {
  if (config.backoff === 'fixed') return config.initialDelayMs;
  const base = config.initialDelayMs * 2 ** (n - 1);
  return Math.round(base * (1 + JITTER * (2 * random() - 1)));
}

/**
 * Re-sends the request while the outcome is retryable: an upstream status listed in `on`, or
 * a timeout (504) / connection failure (502) whose status is listed in `on`. `attempts` counts
 * the first try. Each attempt calls `next` again, so it picks a target again and a retry can
 * land on a different one. The last attempt's outcome is returned (or thrown) unchanged, so the
 * client sees the real upstream status.
 *
 * Every method the route allows is retried, POST included, because the config asks for it;
 * see DECISIONS.md for the duplicate-write risk. A client that hangs up stops the loop, both
 * mid-attempt (forward throws 499, which is never retried) and during a backoff sleep.
 */
export const retryFeature: Feature = {
  name: 'retry',
  create(route, { clock, logger }) {
    const config = route.retry;
    if (!config) return undefined;

    const retryable = (outcome: Outcome) =>
      outcome.ok
        ? config.on.includes(outcome.response.status)
        : outcome.error instanceof GatewayError &&
          TRANSPORT_FAILURES.has(outcome.error.status) &&
          config.on.includes(outcome.error.status);

    return async (req, next) => {
      for (let attempt = 1; ; attempt++) {
        const outcome = await next(req).then(
          (response): Outcome => ({ ok: true, response }),
          (error: unknown): Outcome => ({ ok: false, error }),
        );
        if (attempt >= config.attempts || !retryable(outcome)) {
          if (outcome.ok) return outcome.response;
          throw outcome.error;
        }

        const delayMs = backoffDelay(config, attempt);
        logger.warn('retrying upstream request', {
          route: route.path,
          method: req.method,
          path: req.originalPath,
          attempt,
          status: outcome.ok ? outcome.response.status : (outcome.error as GatewayError).status,
          delay_ms: delayMs,
        });
        try {
          await clock.sleep(delayMs, req.signal);
        } catch {
          throw new GatewayError(499, 'client_closed_request');
        }
      }
    };
  },
};

type Outcome = { ok: true; response: GatewayResponse } | { ok: false; error: unknown };
