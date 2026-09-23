import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemClock } from '../src/clock.js';
import type { RetryConfig, RouteConfig } from '../src/config/types.js';
import { GatewayError } from '../src/errors.js';
import { backoffDelay, retryFeature } from '../src/features/retry.js';
import { silentLogger } from '../src/logger.js';
import type { GatewayRequest, GatewayResponse, Handler, Middleware } from '../src/pipeline/types.js';
import { deadUpstreamUrl, FakeClock, recordingLogger, startGateway, startMockUpstream } from './helpers.js';

const retry = (overrides: Partial<RetryConfig> = {}): RetryConfig => ({
  attempts: 3,
  backoff: 'exponential',
  initialDelayMs: 1_000,
  on: [502, 503, 504],
  ...overrides,
});

describe('backoffDelay', () => {
  it('fixed: waits initial_delay before every retry', () => {
    const config = retry({ backoff: 'fixed' });
    expect([1, 2, 3].map((n) => backoffDelay(config, n))).toEqual([1_000, 1_000, 1_000]);
  });

  it('exponential: doubles each retry', () => {
    const noJitter = () => 0.5;
    expect([1, 2, 3].map((n) => backoffDelay(retry(), n, noJitter))).toEqual([1_000, 2_000, 4_000]);
  });

  it('exponential: jitters by at most ±20%', () => {
    expect(backoffDelay(retry(), 2, () => 0)).toBe(1_600);
    expect(backoffDelay(retry(), 2, () => 1)).toBe(2_400);
  });
});

describe('systemClock.sleep', () => {
  it('rejects as soon as the signal aborts', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const sleeping = systemClock.sleep(10_000, controller.signal);
    setTimeout(() => controller.abort(new Error('gone')), 10);
    await expect(sleeping).rejects.toThrow('gone');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('retry middleware', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const response = (status: number): GatewayResponse => ({ status, headers: {}, body: Buffer.from(String(status)) });

  function setup(config: RetryConfig | undefined) {
    const clock = new FakeClock();
    const route = { path: '/r', retry: config } as RouteConfig;
    const middleware = retryFeature.create(route, { clock, logger: silentLogger, shutdown: new AbortController().signal });
    return { clock, middleware: middleware as Middleware };
  }

  /** A `next` that plays the given outcomes in order (Errors are thrown) and counts calls. */
  function upstream(...outcomes: (number | Error)[]) {
    let calls = 0;
    const next: Handler = async () => {
      const outcome = outcomes[Math.min(calls++, outcomes.length - 1)];
      if (outcome instanceof Error) throw outcome;
      return response(outcome);
    };
    return { next, calls: () => calls };
  }

  const request = (signal = new AbortController().signal) => ({ method: 'GET', originalPath: '/r', signal }) as GatewayRequest;

  it('is not installed when the route has no retry config', () => {
    expect(setup(undefined).middleware).toBeUndefined();
  });

  it('retries a status listed in `on` until the upstream succeeds', async () => {
    const { middleware } = setup(retry());
    const { next, calls } = upstream(503, 502, 200);
    expect((await middleware(request(), next)).status).toBe(200);
    expect(calls()).toBe(3);
  });

  it('counts the first try as an attempt and returns the last response unchanged', async () => {
    const { middleware } = setup(retry({ attempts: 2 }));
    const { next, calls } = upstream(503, 504);
    const result = await middleware(request(), next);
    expect(result).toEqual(response(504));
    expect(calls()).toBe(2);
  });

  it('does not retry a status missing from `on`', async () => {
    const { middleware } = setup(retry());
    const { next, calls } = upstream(500, 200);
    expect((await middleware(request(), next)).status).toBe(500);
    expect(calls()).toBe(1);
  });

  it('retries timeouts and connection failures listed in `on`, rethrowing the last one', async () => {
    const { middleware } = setup(retry());
    const last = new GatewayError(502, 'bad_gateway');
    const { next, calls } = upstream(new GatewayError(504, 'gateway_timeout'), last);
    await expect(middleware(request(), next)).rejects.toBe(last);
    expect(calls()).toBe(3);
  });

  it('does not retry a timeout when 504 is not in `on`', async () => {
    const { middleware } = setup(retry({ on: [503] }));
    const { next, calls } = upstream(new GatewayError(504, 'gateway_timeout'), 200);
    await expect(middleware(request(), next)).rejects.toMatchObject({ status: 504 });
    expect(calls()).toBe(1);
  });

  it.each([
    ['a client abort', new GatewayError(499, 'client_closed_request')],
    ['a gateway rejection', new GatewayError(503, 'service_unavailable')],
    ['an unexpected bug', new TypeError('oops')],
  ])('does not retry %s', async (_, error) => {
    const { middleware } = setup(retry({ on: [499, 503] }));
    const { next, calls } = upstream(error, 200);
    await expect(middleware(request(), next)).rejects.toBe(error);
    expect(calls()).toBe(1);
  });

  it('backs off exponentially between attempts', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { middleware, clock } = setup(retry({ attempts: 4 }));
    await middleware(request(), upstream(503).next);
    expect(clock.sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  it('stops when the client hangs up during a backoff sleep', async () => {
    const { middleware } = setup(retry());
    const client = new AbortController();
    let calls = 0;
    const next: Handler = async () => {
      calls++;
      client.abort();
      return response(503);
    };
    await expect(middleware(request(client.signal), next)).rejects.toMatchObject({ status: 499 });
    expect(calls).toBe(1);
  });
});

describe('retry (end to end)', () => {
  let upstream: Awaited<ReturnType<typeof startMockUpstream>>;
  let gateway: Awaited<ReturnType<typeof startGateway>>;
  const { logger, entries } = recordingLogger();

  beforeAll(async () => {
    upstream = await startMockUpstream('retry');
    gateway = await startGateway(
      `
gateway: {}
routes:
  - path: /orders
    methods: [GET, POST]
    upstream: { url: "${upstream.url}" }
    retry: { attempts: 3, backoff: exponential, initial_delay: "10ms", on: [502, 503, 504] }
  - path: /down
    methods: [GET]
    upstream: { url: "${await deadUpstreamUrl()}" }
    retry: { attempts: 3, backoff: fixed, initial_delay: "1ms", on: [502] }
`,
      logger,
    );
  });

  afterAll(async () => {
    await gateway?.close();
    await upstream?.close();
  });

  it('succeeds on the third attempt when the upstream fails twice', async () => {
    const response = await fetch(`${gateway.url}/orders/a/flaky?fail=2`);
    expect(response.status).toBe(200);
  });

  it('passes the upstream failure through once attempts run out', async () => {
    const response = await fetch(`${gateway.url}/orders/b/flaky?fail=3`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'flaky', hit: 3 });
  });

  it('replays the request body on every attempt', async () => {
    const response = await fetch(`${gateway.url}/orders/c/flaky?fail=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item: 'widget' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ method: 'POST', body: { item: 'widget' } });
  });

  it('retries connection failures, then returns 502 and logs each retry', async () => {
    entries.length = 0;
    const response = await fetch(`${gateway.url}/down`);
    expect(response.status).toBe(502);
    const retries = entries.filter((e) => e.msg === 'retrying upstream request');
    expect(retries.map((e) => e.fields?.attempt)).toEqual([1, 2]);
    expect(retries[0].fields).toMatchObject({ route: '/down', status: 502, delay_ms: 1 });
  });
});
