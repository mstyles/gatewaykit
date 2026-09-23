# Decisions

## Prioritization

<!-- Fill in as you go: what you built in which order, and why. Draft plan below. -->

1. **Foundation**: config loading/validation, `/health`, routing, proxying, timeouts, 404/405/502/504.
   The hard requirements, plus the "malformed config" and "upstream down" failure modes.
2. Rate limiting: explicitly called out ("50 requests hit a rate-limited route simultaneously").
3. API-key auth: small, high value.
4. Retry and circuit breaker: resilience.
5. Load balancing and health checks.
6. Header transforms, then body transforms (the most ambiguity and code for the least value).

## Architecture

**Language: TypeScript on Node's `http` module.** Only `yaml` is a runtime dependency.
Validation is hand-written rather than using a schema library, to stay within the
"stdlib + YAML parser" constraint.

**Config is validated and normalized once, at startup.** Durations become milliseconds, a single
`upstream.url` becomes a one-element `targets` list, route-level settings are resolved against
their global defaults (timeout, rate limit), and header names used for lookups are lowercased.
Features never see raw YAML. Validation collects *every* error before failing, so a broken config
is fixed in one round trip. Unknown keys are warnings, not errors, because they're usually typos
but could be forward-compatible fields.

**Per-route middleware pipeline, built once at startup.** Each config feature is a `Feature`
whose `create(route, deps)` returns a middleware, or `undefined` if the route doesn't configure
it. `features/index.ts` lists them in order (outermost first). Adding a feature means writing one
module and adding one line to that list. Routes pay nothing for features they don't use.

**Two kinds of outcome.** Upstream HTTP responses, including 5xx, flow back through the pipeline
as values. Gateway-level failures (timeout, connection refused, rejections such as 401/429/503)
are thrown as `GatewayError`. That lets retry and circuit-breaker middleware tell "upstream said
503" apart from "upstream never answered".

**Bodies are fully buffered** (10 MB cap → 413). Retries must be able to replay the request body
and body transforms need the whole document. The trade-off is memory per in-flight request and no
streaming. For this gateway's use case that's acceptable; with more time, stream when a route has
no body transform and no retry.

**Time is injected** (`Clock`) so rate limits, breakers and backoff can be tested without
sleeping.

## Behavioural decisions (config ambiguities)

- **Route matching**: prefix match on segment boundaries (`/api/users` matches `/api/users/1`,
  not `/api/usersX`). Longest prefix wins, independent of config order. If the winning route
  rejects the method, the answer is 405 with an `Allow` header. There's no fallback to a shorter
  prefix.
- **`strip_prefix`** on an exact match forwards `/`. Query strings are always preserved.
- **Upstream URL with a path** (`http://host/base`) is treated as a base path and joined.
- **`/health`** takes precedence over any configured route at the same path.
- **Path normalization**: dot segments are resolved before routing, so `/api/users/../internal`
  is routed, and authenticated, as `/api/internal`.
- **Client IP** is the TCP peer address. `X-Forwarded-For` is not trusted (a client could forge it
  to dodge per-IP limits), but the gateway appends to it when forwarding.
- **Hop-by-hop headers** (RFC 9110 §7.6.1) are stripped in both directions. `Host` is rewritten
  to the upstream and `X-Forwarded-Host`/`-Proto` are added.
- **Errors** are JSON `{ "error": "<code>", ... }`: 404 `not_found`, 405 `method_not_allowed`,
  413 `payload_too_large`, 502 `bad_gateway`, 504 `gateway_timeout`.
- **Rate limit inheritance**: a route's `rate_limit` *replaces* the global one rather than
  stacking with it.

<!-- Still to decide as features land:
  - retry `attempts`: total attempts or retries after the first? Retry non-idempotent POST?
  - circuit breaker: what counts as a failure; half-open behaviour; does a retried request count once?
  - auth: 401 (missing key) vs 403 (wrong key); pipeline position relative to rate limiting
  - health checks: recovery rule (no healthy_threshold in the schema); all targets unhealthy → 503
  - transforms: $request_time format; unmapped body fields; non-JSON bodies
-->

## Partially implemented

- **Load balancing**: `upstream.targets` is parsed and validated, but every request goes to the
  first target (`src/upstream/selector.ts`).

## What I'd build next

<!-- Fill in at the end. -->

## How I used AI tools

<!-- Fill in: e.g. used Claude Code to review the brief, compare languages, and scaffold the
config/pipeline/test skeleton; then implemented features one at a time with tests. -->
