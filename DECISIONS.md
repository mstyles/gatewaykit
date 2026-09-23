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
- **HEAD** is allowed wherever GET is (RFC 9110 §9.3.2: HEAD is GET without the body), including
  `/health`. Config normalization adds it to any route listing GET, so `Allow` headers show it.
  HEAD is forwarded upstream as HEAD. Responses the gateway generates itself still carry the
  `Content-Length` of the matching GET body.
- **`strip_prefix`** on an exact match forwards `/`. Query strings are always preserved.
- **Upstream URL with a path** (`http://host/base`) is treated as a base path and joined.
- **`/health`** takes precedence over any configured route at the same path.
- **Path normalization**: dot segments (including encoded `%2e`) are resolved before routing, so
  `/api/users/../internal` is routed, and authenticated, as `/api/internal`. Leading `//` is
  collapsed to `/`. Encoded separators (`%2F`, `%5C`) are rejected with 400: an upstream that
  decodes them would otherwise serve a different path than the one the gateway routed.
- **Client IP** is the TCP peer address. `X-Forwarded-For` is not trusted (a client could forge it
  to dodge per-IP limits), but the gateway appends to it when forwarding.
- **Hop-by-hop headers** (RFC 9110 §7.6.1) are stripped in both directions. `Host` is rewritten
  to the upstream and `X-Forwarded-Host`/`-Proto` are added.
- **Errors** are JSON `{ "error": "<code>", ... }`: 400 `bad_request`, 401 `unauthorized`,
  404 `not_found`, 405 `method_not_allowed`, 413 `payload_too_large`, 429 `too_many_requests`,
  502 `bad_gateway`, 504 `gateway_timeout`.
- **Body limit**: a `Content-Length` over 10 MB is rejected with 413 before any of the body is
  read. Bodies without a declared length (chunked) are rejected as soon as they pass the limit.
- **Client aborts**: if the client hangs up while its body is being read or while the upstream is
  answering, nothing is written and the request is logged with status 499 (the nginx convention),
  not as a 500 or an error. The in-flight upstream request is cancelled too
  (`GatewayRequest.signal`), so a client that gives up doesn't hold an upstream connection. When
  retry and the circuit breaker land, they must stop on that signal (no further attempts or
  backoff sleeps) and must not count a `client_closed_request` as an upstream failure.
- **Shutdown**: on SIGINT/SIGTERM the gateway stops accepting connections, lets in-flight
  requests finish (responding with `Connection: close`), and force-closes anything still open
  after 10s.
- **Rate limit inheritance**: a route's `rate_limit` *replaces* the global one rather than
  stacking with it.
- **Auth (`api_key`)**:
  - A missing key and a wrong key both get 401 `unauthorized` with the same body, so a client
    can't tell which it was. There's no 403: an API key identifies a caller but carries no
    permissions to refuse.
  - Keys are compared in constant time (SHA-256 both sides, `timingSafeEqual` against every
    configured key) so response timing doesn't leak key prefixes.
  - The key header is removed before forwarding, so gateway credentials never reach the upstream.
  - A repeated key header (which Node joins as `a, b`) is treated as a wrong key.
- **Failed-auth limiter**: rate_limit sits inside auth and never sees rejected requests, so auth
  counts its own failures. After 10 failures from one client IP within a fixed 60s window, that
  IP gets 429 `too_many_requests` with `Retry-After` for the rest of the window, *without its key
  being checked*. A valid key doesn't unlock it early, which keeps a guesser from confirming a hit.
  Counts are per route, and successful requests neither count nor reset the counter. Trade-off:
  clients sharing an IP (NAT, corporate proxy) share the budget, so one misconfigured client can
  lock out its neighbours for up to a minute. The limits are constants in `src/features/auth.ts`
  because the config schema has no field for them.
- **Pipeline order: rate limiting runs inside auth** (`auth → rate_limit → …`). Only
  authenticated requests use up rate-limit budget, so on `per: global` routes a flood of
  unauthenticated traffic can't exhaust the bucket for legitimate clients. The trade-off:
  requests rejected with 401 are never rate limited, so auth has its own failed-attempt limiter
  (above).
- **Circuit breaker wraps retry** (`circuit_breaker → retry → upstream`). The breaker sees one
  outcome per client request: the result after all retries. A request that fails three times and
  then succeeds counts as a success, and one that exhausts its retries counts as a single
  failure. So `threshold` means failed client requests, not failed upstream attempts. Once the
  breaker is open, requests are rejected before retry runs, so an open breaker never triggers
  retry storms.

<!-- Still to decide as features land:
  - retry `attempts`: total attempts or retries after the first? Retry non-idempotent POST?
  - circuit breaker: what counts as a failure; half-open behaviour
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
