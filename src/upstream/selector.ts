import type { UpstreamConfig, UpstreamTarget } from '../config/types.js';

/** Chooses the upstream target for one attempt; called again on each retry. */
export interface UpstreamSelector {
  pick(): UpstreamTarget;
}

export function createSelector(upstream: UpstreamConfig): UpstreamSelector {
  // TODO(load-balancing): implement round_robin / weighted_round_robin and skip targets
  // that health checks have marked unhealthy. Until then every request goes to the first target.
  const [first] = upstream.targets;
  return { pick: () => first };
}
