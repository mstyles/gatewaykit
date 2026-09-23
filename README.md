# GatewayKit

A lightweight, config-driven API gateway written in TypeScript on Node's standard `http` module.
It reads a YAML config (see [`gateway.yaml`](gateway.yaml)) and proxies requests to upstream services.

## Prerequisites

- Node.js 20+ (developed on 24)
- npm

## Setup and run

```sh
npm install

# Terminal 1: start mock upstreams on :3001–3006 (the ports gateway.yaml uses)
npm run mock

# Terminal 2: start the gateway (config path as an argument or via GATEWAY_CONFIG)
npm start -- gateway.yaml
GATEWAY_CONFIG=gateway.yaml npm start
```

```sh
curl localhost:8080/health
curl localhost:8080/api/products/123
```

An invalid config makes the gateway exit with status 1 and list every problem found.

## Tests

```sh
npm test          # full suite, self-contained (starts in-process mock upstreams on ephemeral ports)
npm run typecheck
```

## Mock upstream

`mock/upstream.ts` matches on the path suffix, so it works behind any route prefix:

| Path | Behaviour |
|---|---|
| `…/healthz` | `200 {"status":"ok"}` |
| `…/slow?ms=N` | waits N ms (default 2000), then echoes |
| `…/status/NNN` | responds with status NNN |
| `…/flaky?fail=N` | first N hits return 503, later hits echo |
| anything else | echoes method, path, query, headers and body |

## Config feature checklist

- [x] `gateway.port`, `gateway.global_timeout`
- [x] `GET /health`
- [x] Config validation (all errors reported at once, unknown keys warned)
- [x] Routing: segment-aware longest-prefix match, 404, 405 with `Allow`
- [x] `strip_prefix`
- [x] Proxying with per-route `upstream.timeout` (504) and connection failures (502)
- [ ] `rate_limit` / `global_rate_limit` (`fixed_window`, `sliding_window`, `per: ip|global`)
- [x] `auth` (`api_key`), with a per-IP limit on failed attempts
- [ ] `retry` (`fixed`, `exponential`)
- [ ] `circuit_breaker`
- [ ] `upstream.targets` load balancing (`round_robin`, `weighted_round_robin`); currently uses the first target
- [ ] `health_check`
- [ ] `request_transform` / `response_transform` (headers)
- [ ] `request_transform.body.mapping` / `response_transform.body.envelope`

## Layout

```
src/
  index.ts            entrypoint: load config, start server, graceful shutdown
  server.ts           HTTP server: /health, routing, error → JSON responses
  router.ts           prefix router (404 / 405 / strip_prefix)
  config/             YAML loading, validation, normalized types
  pipeline/           middleware types, composition, per-route pipeline builder
  features/           one module per config feature, registered in features/index.ts
  proxy/transport.ts  outbound request to one upstream target
  upstream/           target selection (load balancing)
mock/                 mock upstream server
test/                 vitest suite
```
