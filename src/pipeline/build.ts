import type { RouteConfig } from '../config/types.js';
import { FEATURES } from '../features/index.js';
import { forward } from '../proxy/transport.js';
import { startHealthMonitor } from '../upstream/health.js';
import { createSelector } from '../upstream/selector.js';
import { compose, type GatewayDeps, type Handler, type Middleware } from './types.js';

/** Builds a route's request pipeline once at startup: configured features wrapping the upstream call. */
export function buildRouteHandler(route: RouteConfig, deps: GatewayDeps): Handler {
  // Probes in the background until deps.shutdown aborts; undefined without health_check, in
  // which case the selector treats every target as healthy.
  const monitor = startHealthMonitor(route, deps);
  const selector = createSelector(route.upstream, monitor, deps.logger);
  const callUpstream: Handler = (req) => forward(req, selector.pick(), route.upstream.timeoutMs);

  const middlewares = FEATURES.map((feature) => feature.create(route, deps)).filter(
    (middleware): middleware is Middleware => middleware !== undefined,
  );
  return compose(middlewares, callUpstream);
}
