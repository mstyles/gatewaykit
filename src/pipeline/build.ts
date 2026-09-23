import type { RouteConfig } from '../config/types.js';
import { FEATURES } from '../features/index.js';
import { forward } from '../proxy/transport.js';
import { createSelector } from '../upstream/selector.js';
import { compose, type GatewayDeps, type Handler, type Middleware } from './types.js';

/** Builds a route's request pipeline once at startup: configured features wrapping the upstream call. */
export function buildRouteHandler(route: RouteConfig, deps: GatewayDeps): Handler {
  const selector = createSelector(route.upstream);
  const callUpstream: Handler = (req) => forward(req, selector.pick(), route.upstream.timeoutMs);

  const middlewares = FEATURES.map((feature) => feature.create(route, deps)).filter(
    (middleware): middleware is Middleware => middleware !== undefined,
  );
  return compose(middlewares, callUpstream);
}
