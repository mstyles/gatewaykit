import type { UpstreamConfig, UpstreamTarget } from '../config/types.js';
import { silentLogger, type Logger } from '../logger.js';

/** Chooses the upstream target for one attempt; called again on each retry. */
export interface UpstreamSelector {
  pick(): UpstreamTarget;
}

/** Which targets are currently able to serve traffic (implemented by the health monitor). */
export interface TargetHealth {
  isHealthy(target: UpstreamTarget): boolean;
}

const ALL_HEALTHY: TargetHealth = { isHealthy: () => true };

/**
 * nginx's smooth weighted round robin over the healthy targets. Each pick adds every
 * candidate's weight to its running score, takes the highest score, and subtracts the
 * candidates' total weight from the winner, so 3:1 interleaves as A A B A rather than
 * bursting A A A B. `round_robin` is the same algorithm with every weight set to 1, which
 * reduces to plain rotation.
 *
 * Unhealthy targets sit out (their score is frozen until they recover). If every target is
 * unhealthy, fail open and pick among all of them: the health view may be stale or wrong, and
 * trying a target costs no more than a guaranteed 503. The switch into and out of that state is
 * logged once, not on every pick.
 */
export function createSelector(
  upstream: UpstreamConfig,
  health: TargetHealth = ALL_HEALTHY,
  logger: Logger = silentLogger,
): UpstreamSelector {
  const { targets } = upstream;
  const weights = targets.map((t) => (upstream.balance === 'weighted_round_robin' ? t.weight : 1));
  const scores = targets.map(() => 0);
  let failingOpen = false;

  const candidates = (): number[] => {
    const healthy = targets.flatMap((t, i) => (health.isHealthy(t) ? [i] : []));
    if (healthy.length === 0 !== failingOpen) {
      failingOpen = !failingOpen;
      const fields = { targets: targets.map((t) => t.url.href) };
      if (failingOpen) logger.warn('all upstream targets unhealthy, failing open', fields);
      else logger.info('upstream target healthy again, no longer failing open', fields);
    }
    return failingOpen ? targets.map((_, i) => i) : healthy;
  };

  return {
    pick() {
      let best = -1;
      let total = 0;
      for (const i of candidates()) {
        scores[i] += weights[i];
        total += weights[i];
        if (best === -1 || scores[i] > scores[best]) best = i;
      }
      scores[best] -= total;
      return targets[best];
    },
  };
}
