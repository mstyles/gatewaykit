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
  502 `bad_gateway`, 503 `service_unavailable`, 504 `gateway_timeout`.
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
  stacking with it. `global_rate_limit` is a *default applied per route*: each route has its own
  buckets, not one counter shared across the gateway. That includes `per: global`: under
  `global_rate_limit` it means "all clients of *this route* share a bucket", so
  `{ requests: 100, per: global }` inherited by 5 routes allows 500 requests per window in total,
  not 100. I read the global block as a default, consistent with the route-level field of the
  same shape. A true gateway-wide ceiling would need its own config field. Unmatched paths
  (404/405) and `/health` are not counted.
- **Rate limit responses**: 429 `{ "error": "too_many_requests", "retry_after": <s> }` with
  `Retry-After`, the same code auth's failed-attempt limiter uses. Every response from a limited
  route that got past auth carries `X-RateLimit-Limit` and `X-RateLimit-Remaining`, including
  gateway errors raised further in (502, 504, an open breaker's 503). The one exception is an
  unexpected 500 from a bug: the server logs its stack and answers a generic `internal_error`.
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

## Rate limiting

- **`fixed_window`**: one counter per key, windows aligned to the epoch. O(1) memory per key, but
  a client can send up to 2× the limit across a window boundary (there's a test pinning this).
- **`sliding_window`**: a sliding *log* of accepted-request timestamps. It's exact, with no
  boundary bursts. Memory is O(`requests`) per key, and dropping expired entries costs O(n) on
  the request path. That's fine for the limits a gateway config expresses, but `requests` has no
  upper bound: a limit of 100k per IP across 10k clients could hold up to 10^9 timestamps. For
  large limits I'd switch to the sliding-window *counter* approximation (current count + weighted
  previous-window count, O(1)), or cap `requests` for this strategy in validation. Rejected requests aren't logged, so a
  client hammering a limit isn't locked out past the window.
- **Concurrency**: check-and-consume is one synchronous call with no `await` between read and
  write. Node runs JS on a single thread, so concurrent requests can't race past the limit. The
  end-to-end test fires 50 concurrent requests at a limit of 10 and asserts exactly 10 succeed.
  Running multiple gateway processes would need a shared store (e.g. Redis with an atomic Lua
  script); the `RateLimiter` interface is the seam for that.
- **Memory**: at most once per window, the first request after it has passed sweeps out buckets
  that can no longer affect a decision, so memory tracks *active* clients rather than every IP
  ever seen. Sweeping on the request path instead of with a timer means nothing to stop on
  shutdown and no timer overflow on very long windows (Node turns delays over ~24.8 days into
  1 ms). It also runs on the injected clock, so tests drive it directly.
- **Known gaps**:
  - The request body is buffered before the pipeline runs, so a client that is over its limit
    (or has no valid key) can still make the gateway read up to 10 MB. Fix: run auth and the rate
    limit before reading the body.
  - `per: ip` keys on the full address. An IPv6 client usually controls a whole /64, so it can
    rotate source addresses to get a fresh bucket per request. Fix: key IPv6 clients by their /64
    prefix.

## Retry

- **`attempts` is the total**, including the first try: `attempts: 3` is one call plus two
  retries. (Config validation caps it at 10.)
- **What gets retried**: an upstream response whose status is in `on`, or a timeout (504) or
  connection failure (502) the gateway raised itself, if that status is in `on`. A client
  abort (499), a gateway rejection, or an unexpected error is never retried.
- **Non-idempotent methods are retried.** The example config retries a route that allows
  POST, so I honor the config rather than silently narrowing it. The risk: a POST that timed
  out may have been applied upstream, and the retry applies it again. With more time I'd
  retry only idempotent methods by default, and POST only when the client sends an
  `Idempotency-Key` (forwarded so the upstream can dedupe).
- **Backoff**: `fixed` waits `initial_delay` before each retry. `exponential` waits
  `initial_delay × 2^(n−1)` with ±20% jitter, so clients that failed together don't come
  back in lockstep and hammer a recovering upstream.
- **The last outcome is returned unchanged**, so after exhausted retries the client sees
  the real upstream status (e.g. 503 with its body), not a gateway-invented one.
- **Each attempt picks a target again**, so with load balancing a retry can land on a
  healthy target.
- **Client aborts** stop the loop: mid-attempt (the upstream call throws 499, which isn't
  retried) and mid-backoff (`Clock.sleep` takes the request's signal).
- **Every retry is logged** (`warn`, with route, attempt, status and delay), since retries
  hide upstream trouble from clients.
- **Known gaps**:
  - No overall deadline: each attempt gets the full route timeout, so the example `/api/orders`
    route can take 3 × 5s + 1s + 2s ≈ 18s before answering. Fix: a per-request budget that
    caps the remaining attempts and backoff.
  - Exponential delay has no cap; with 10 attempts and a large `initial_delay` the last wait
    is 256× the initial one. Fix: a max delay (not in the schema, so it would be a constant).
  - An upstream `Retry-After` header is ignored.
  - No retry budget: during an outage every client request multiplies upstream load by up to
    `attempts`. The circuit breaker (next) is the mitigation.

## Circuit breaker

- **What counts as a failure**: an upstream response with status ≥ 500, or a timeout (504) or
  connection failure (502) the gateway raised itself. Both, because an upstream answering 500s
  is as unhealthy as one that doesn't answer. A 4xx is a success (the upstream is up and
  answering), and a client abort (499), a gateway rejection or an unexpected error doesn't count
  either way. Measured after retries (see pipeline order above).
- **Window**: closed-state failures are a sliding log of timestamps within `window`; the breaker
  opens when the count reaches `threshold`. The log is pruned on every failure and cleared on
  opening, so it never holds more than `threshold` entries. Successes don't reset the count.
- **Open**: 503 `{ "error": "service_unavailable", "retry_after": <s> }` with `Retry-After`
  (seconds left in the cooldown, rounded up, at least 1), without calling the upstream.
- **Half-open**: the first request after the cooldown is the single probe; concurrent requests
  get 503 with `retry_after: 1` until it settles. Probe success closes the breaker and resets the
  count; probe failure reopens it with a fresh cooldown. A probe that ends neutral (client abort)
  frees the slot and leaves the breaker half-open, so the next request probes.
- **Late results are ignored**: a request admitted while closed that fails after the breaker
  opened doesn't extend the cooldown or decide the probe.
- **Transitions are logged**: `warn` on opening, `info` on half-open and closing, with the route.
- **State is per route, per process**: in memory, like rate limits. Several gateway instances
  each trip independently.
- **Known gaps**:
  - One breaker per route, not per target: with load balancing, one bad target can open the
    breaker for the healthy ones. Health checks are the per-target mitigation.
  - The threshold is a count, not a failure rate, so a busy route trips on a small fraction of
    errors and a quiet one needs the same absolute count. Fix: a minimum request volume plus a
    failure percentage (not in the schema).
  - A single probe decides recovery; a flaky upstream can flap between open and closed.

<!-- Still to decide as features land:
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
