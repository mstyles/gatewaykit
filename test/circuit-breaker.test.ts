import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CircuitBreakerConfig, RouteConfig } from '../src/config/types.js';
import { GatewayError } from '../src/errors.js';
import { circuitBreakerFeature } from '../src/features/circuit-breaker.js';
import type { GatewayRequest, GatewayResponse, Handler, Middleware } from '../src/pipeline/types.js';
import { FakeClock, recordingLogger, startGateway, startMockUpstream } from './helpers.js';

const breaker = (overrides: Partial<CircuitBreakerConfig> = {}): CircuitBreakerConfig => ({
  threshold: 3,
  windowMs: 10_000,
  cooldownMs: 30_000,
  ...overrides,
});

describe('circuit_breaker middleware', () => {
  const response = (status: number): GatewayResponse => ({ status, headers: {}, body: Buffer.from(String(status)) });

  function setup(config: CircuitBreakerConfig | undefined) {
    const clock = new FakeClock();
    const { logger, entries } = recordingLogger();
    const route = { path: '/r', circuitBreaker: config } as RouteConfig;
    const middleware = circuitBreakerFeature.create(route, { clock, logger, shutdown: new AbortController().signal });
    return { clock, entries, middleware: middleware as Middleware };
  }

  /** A `next` that always plays one outcome (an Error is thrown) and counts calls. */
  function upstream(outcome: number | Error) {
    let calls = 0;
    const next: Handler = async () => {
      calls++;
      if (outcome instanceof Error) throw outcome;
      return response(outcome);
    };
    return { next, calls: () => calls };
  }

  /** A `next` that stays in flight until the test settles it. */
  function pending() {
    let settle!: (outcome: number | Error) => void;
    const next: Handler = () =>
      new Promise((resolve, reject) => {
        settle = (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(response(outcome)));
      });
    return { next, settle: (outcome: number | Error) => settle(outcome) };
  }

  const request = () => ({ method: 'GET', originalPath: '/r' }) as GatewayRequest;
  const ok = upstream(200).next;

  /** Runs one request, swallowing whatever it throws. */
  const send = (middleware: Middleware, next: Handler) => middleware(request(), next).catch((e: unknown) => e);

  async function rejection(promise: Promise<unknown>): Promise<GatewayError> {
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    return err as GatewayError;
  }

  async function trip(middleware: Middleware, threshold = 3) {
    for (let i = 0; i < threshold; i++) await send(middleware, upstream(500).next);
  }

  it('is not installed when the route has no circuit_breaker config', () => {
    expect(setup(undefined).middleware).toBeUndefined();
  });

  it('opens when failures reach the threshold, and logs it', async () => {
    const { middleware, entries } = setup(breaker());
    await send(middleware, upstream(500).next);
    await send(middleware, upstream(new GatewayError(504, 'gateway_timeout')).next);
    expect((await middleware(request(), ok)).status).toBe(200);

    await send(middleware, upstream(new GatewayError(502, 'bad_gateway')).next);
    expect((await rejection(middleware(request(), ok))).status).toBe(503);
    expect(entries).toContainEqual({
      level: 'warn',
      msg: 'circuit breaker opened',
      fields: { route: '/r', from: 'closed', to: 'open', cooldown_ms: 30_000 },
    });
  });

  it('passes upstream outcomes through unchanged', async () => {
    const { middleware } = setup(breaker());
    const error = new GatewayError(504, 'gateway_timeout');
    expect(await middleware(request(), upstream(500).next)).toEqual(response(500));
    await expect(middleware(request(), upstream(error).next)).rejects.toBe(error);
  });

  it('does not count failures that have left the window', async () => {
    const { middleware, clock } = setup(breaker());
    await trip(middleware, 2);
    clock.advance(10_000);
    await trip(middleware, 2);
    expect((await middleware(request(), ok)).status).toBe(200);
    await send(middleware, upstream(500).next);
    expect((await rejection(middleware(request(), ok))).status).toBe(503);
  });

  it.each([
    ['a 4xx response', 404],
    ['a client abort', new GatewayError(499, 'client_closed_request')],
    ['a gateway rejection', new GatewayError(503, 'service_unavailable')],
    ['an unexpected bug', new TypeError('oops')],
  ])('does not count %s as a failure', async (_, outcome) => {
    const { middleware } = setup(breaker({ threshold: 1 }));
    for (let i = 0; i < 5; i++) await send(middleware, upstream(outcome).next);
    expect((await middleware(request(), ok)).status).toBe(200);
  });

  it('rejects while open without calling the upstream, with retry_after in whole seconds', async () => {
    const { middleware, clock } = setup(breaker());
    await trip(middleware);
    clock.advance(10_500);

    const { next, calls } = upstream(200);
    const err = await rejection(middleware(request(), next));
    expect(calls()).toBe(0);
    expect(err.code).toBe('service_unavailable');
    expect(err.body).toEqual({ retry_after: 20 });
    expect(err.headers).toEqual({ 'retry-after': '20' });

    clock.advance(19_000);
    expect((await rejection(middleware(request(), next))).body).toEqual({ retry_after: 1 });
  });

  it('gives each rejection its own headers object', async () => {
    const { middleware } = setup(breaker());
    await trip(middleware);
    const first = await rejection(middleware(request(), ok));
    const second = await rejection(middleware(request(), ok));
    expect(first.headers).not.toBe(second.headers);
  });

  it('lets exactly one probe through after the cooldown, rejecting concurrent requests', async () => {
    const { middleware, clock, entries } = setup(breaker());
    await trip(middleware);
    clock.advance(30_000);

    const probe = pending();
    const inFlight = middleware(request(), probe.next);
    expect(entries.at(-1)).toMatchObject({ level: 'info', msg: 'circuit breaker half-open' });

    const { next, calls } = upstream(200);
    const err = await rejection(middleware(request(), next));
    expect(err.body).toEqual({ retry_after: 1 });
    expect(calls()).toBe(0);

    probe.settle(200);
    expect((await inFlight).status).toBe(200);
  });

  it('closes when the probe succeeds, with the failure count reset', async () => {
    const { middleware, clock, entries } = setup(breaker());
    await trip(middleware, 2);
    await send(middleware, upstream(500).next);
    clock.advance(30_000);

    expect((await middleware(request(), upstream(404).next)).status).toBe(404);
    expect(entries.at(-1)).toEqual({
      level: 'info',
      msg: 'circuit breaker closed',
      fields: { route: '/r', from: 'half_open', to: 'closed' },
    });
    await trip(middleware, 2);
    expect((await middleware(request(), ok)).status).toBe(200);
  });

  it('reopens with a fresh cooldown when the probe fails', async () => {
    const { middleware, clock, entries } = setup(breaker());
    await trip(middleware);
    clock.advance(40_000);

    expect((await middleware(request(), upstream(503).next)).status).toBe(503);
    expect(entries.at(-1)).toMatchObject({ level: 'warn', msg: 'circuit breaker opened', fields: { from: 'half_open' } });
    expect((await rejection(middleware(request(), ok))).body).toEqual({ retry_after: 30 });

    clock.advance(30_000);
    expect((await middleware(request(), ok)).status).toBe(200);
  });

  it('releases the probe slot without changing state when the client aborts the probe', async () => {
    const { middleware, clock } = setup(breaker());
    await trip(middleware);
    clock.advance(30_000);

    await send(middleware, upstream(new GatewayError(499, 'client_closed_request')).next);
    const { next, calls } = upstream(200);
    expect((await middleware(request(), next)).status).toBe(200);
    expect(calls()).toBe(1);
  });

  it('ignores late results from requests admitted before the breaker opened', async () => {
    const { middleware, clock } = setup(breaker());
    const slow = pending();
    const inFlight = send(middleware, slow.next);
    await trip(middleware);
    clock.advance(30_000);

    const probe = pending();
    const probing = middleware(request(), probe.next);
    slow.settle(500);
    await inFlight;
    probe.settle(200);
    await probing;
    expect((await middleware(request(), ok)).status).toBe(200);
  });
});

describe('circuit breaker (end to end)', () => {
  let upstream: Awaited<ReturnType<typeof startMockUpstream>>;
  let gateway: Awaited<ReturnType<typeof startGateway>>;
  const { logger, entries } = recordingLogger();

  beforeAll(async () => {
    upstream = await startMockUpstream('cb');
    gateway = await startGateway(
      `
gateway: {}
routes:
  - path: /fragile
    methods: [GET]
    upstream: { url: "${upstream.url}" }
    circuit_breaker: { threshold: 2, window: "60s", cooldown: "200ms" }
  - path: /sturdy
    methods: [GET]
    upstream: { url: "${upstream.url}" }
    circuit_breaker: { threshold: 2, window: "60s", cooldown: "200ms" }
`,
      logger,
    );
  });

  afterAll(async () => {
    await gateway?.close();
    await upstream?.close();
  });

  it('opens after repeated upstream 500s, rejects with 503, then recovers after the cooldown', async () => {
    for (let i = 0; i < 2; i++) expect((await fetch(`${gateway.url}/fragile/status/500`)).status).toBe(500);

    const rejected = await fetch(`${gateway.url}/fragile/anything`);
    expect(rejected.status).toBe(503);
    expect(rejected.headers.get('retry-after')).toBe('1');
    expect(await rejected.json()).toEqual({ error: 'service_unavailable', retry_after: 1 });
    const opened = entries.find((e) => e.msg === 'circuit breaker opened');
    expect(opened).toMatchObject({ level: 'warn', fields: { route: '/fragile' } });

    expect((await fetch(`${gateway.url}/sturdy/anything`)).status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await fetch(`${gateway.url}/fragile/anything`)).status).toBe(200);
    expect(entries).toContainEqual(expect.objectContaining({ level: 'info', msg: 'circuit breaker closed' }));
  });
});
