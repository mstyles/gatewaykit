import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RateLimitConfig, RouteConfig } from '../src/config/types.js';
import { GatewayError } from '../src/errors.js';
import { createRateLimiter, rateLimitFeature } from '../src/features/rate-limit.js';
import { silentLogger } from '../src/logger.js';
import type { GatewayRequest, GatewayResponse, Middleware } from '../src/pipeline/types.js';
import { FakeClock, startGateway, startMockUpstream } from './helpers.js';

const limit = (overrides: Partial<RateLimitConfig> = {}): RateLimitConfig => ({
  requests: 3,
  windowMs: 10_000,
  strategy: 'fixed_window',
  per: 'ip',
  ...overrides,
});

describe('FixedWindowLimiter', () => {
  it('allows up to the limit per window, then resets on the boundary', () => {
    const clock = new FakeClock(0);
    const limiter = createRateLimiter(limit(), clock);

    expect([1, 2, 3].map(() => limiter.tryAcquire('a').remaining)).toEqual([2, 1, 0]);
    clock.advance(4_000);
    expect(limiter.tryAcquire('a')).toEqual({ allowed: false, remaining: 0, retryAfterMs: 6_000 });

    clock.advance(6_000);
    expect(limiter.tryAcquire('a').allowed).toBe(true);
  });

  it('allows a burst across a window boundary (the known trade-off)', () => {
    const clock = new FakeClock(9_999);
    const limiter = createRateLimiter(limit(), clock);
    for (let i = 0; i < 3; i++) expect(limiter.tryAcquire('a').allowed).toBe(true);
    clock.advance(1);
    for (let i = 0; i < 3; i++) expect(limiter.tryAcquire('a').allowed).toBe(true);
  });

  it('tracks keys independently', () => {
    const limiter = createRateLimiter(limit({ requests: 1 }), new FakeClock());
    expect(limiter.tryAcquire('a').allowed).toBe(true);
    expect(limiter.tryAcquire('a').allowed).toBe(false);
    expect(limiter.tryAcquire('b').allowed).toBe(true);
  });

  it('sweeps expired windows', () => {
    const clock = new FakeClock();
    const limiter = createRateLimiter(limit(), clock);
    limiter.tryAcquire('a');
    limiter.tryAcquire('b');
    limiter.sweep();
    expect(limiter.size).toBe(2);
    clock.advance(10_000);
    limiter.sweep();
    expect(limiter.size).toBe(0);
  });
});

describe('lazy sweeping', () => {
  it.each(['fixed_window', 'sliding_window'] as const)('%s: sweeps expired keys on the first request after a window', (strategy) => {
    const clock = new FakeClock();
    const limiter = createRateLimiter(limit({ strategy }), clock);
    limiter.tryAcquire('a');
    limiter.tryAcquire('b');
    clock.advance(9_999);
    limiter.tryAcquire('c');
    expect(limiter.size).toBe(3);
    clock.advance(10_000);
    limiter.tryAcquire('d');
    expect(limiter.size).toBe(1);
  });
});

describe('SlidingWindowLimiter', () => {
  it('limits over any rolling window, with no boundary burst', () => {
    const clock = new FakeClock(9_999);
    const limiter = createRateLimiter(limit({ strategy: 'sliding_window' }), clock);
    for (let i = 0; i < 3; i++) expect(limiter.tryAcquire('a').allowed).toBe(true);
    clock.advance(1);
    expect(limiter.tryAcquire('a')).toEqual({ allowed: false, remaining: 0, retryAfterMs: 9_999 });
  });

  it('frees capacity as individual requests age out', () => {
    const clock = new FakeClock(0);
    const limiter = createRateLimiter(limit({ strategy: 'sliding_window' }), clock);
    limiter.tryAcquire('a'); // t=0
    clock.advance(3_000);
    limiter.tryAcquire('a'); // t=3000
    limiter.tryAcquire('a'); // t=3000
    expect(limiter.tryAcquire('a').allowed).toBe(false);

    clock.advance(7_000); // t=10000: the t=0 request leaves the window
    expect(limiter.tryAcquire('a')).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.tryAcquire('a')).toMatchObject({ allowed: false, retryAfterMs: 3_000 });
  });

  it('does not count rejected requests', () => {
    const clock = new FakeClock(0);
    const limiter = createRateLimiter(limit({ strategy: 'sliding_window', requests: 1 }), clock);
    limiter.tryAcquire('a');
    for (let i = 0; i < 5; i++) limiter.tryAcquire('a');
    clock.advance(10_000);
    expect(limiter.tryAcquire('a').allowed).toBe(true);
  });

  it('sweeps idle keys', () => {
    const clock = new FakeClock();
    const limiter = createRateLimiter(limit({ strategy: 'sliding_window' }), clock);
    limiter.tryAcquire('a');
    clock.advance(10_000);
    limiter.sweep();
    expect(limiter.size).toBe(0);
  });
});

describe('rate_limit middleware', () => {
  const ok: GatewayResponse = { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('ok') };
  const next = async () => ok;

  function middlewareFor(rateLimit: RateLimitConfig | undefined): Middleware | undefined {
    const route = { path: '/r', methods: ['GET'], stripPrefix: false, rateLimit } as RouteConfig;
    return rateLimitFeature.create(route, { clock: new FakeClock(), logger: silentLogger, shutdown: new AbortController().signal });
  }

  const request = (clientIp: string) => ({ clientIp }) as GatewayRequest;

  async function rejection(promise: Promise<unknown>): Promise<GatewayError> {
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    return err as GatewayError;
  }

  it('is not installed when the route has no effective limit', () => {
    expect(middlewareFor(undefined)).toBeUndefined();
  });

  it('adds rate limit headers to successful responses', async () => {
    const middleware = middlewareFor(limit())!;
    const response = await middleware(request('1.1.1.1'), next);
    expect(response.headers).toMatchObject({ 'content-type': 'text/plain', 'x-ratelimit-limit': '3', 'x-ratelimit-remaining': '2' });
  });

  it('rejects with 429, retry_after and Retry-After once exhausted', async () => {
    const middleware = middlewareFor(limit({ requests: 1 }))!;
    await middleware(request('1.1.1.1'), next);
    const err = await rejection(middleware(request('1.1.1.1'), next));
    expect(err.status).toBe(429);
    expect(err.body).toEqual({ retry_after: 10 });
    expect(err.headers).toMatchObject({ 'retry-after': '10', 'x-ratelimit-remaining': '0' });
  });

  it('adds rate limit headers to gateway errors raised further in, keeping the original error', async () => {
    const middleware = middlewareFor(limit())!;
    class BreakerOpen extends GatewayError {}
    const original = new BreakerOpen(503, 'service_unavailable', {}, { connection: 'close' });
    const failing = async (): Promise<GatewayResponse> => {
      throw original;
    };
    const err = await rejection(middleware(request('1.1.1.1'), failing));
    expect(err).toBe(original);
    expect(err.headers).toEqual({ connection: 'close', 'x-ratelimit-limit': '3', 'x-ratelimit-remaining': '2' });
  });

  it('keys by client IP when per: ip', async () => {
    const middleware = middlewareFor(limit({ requests: 1, per: 'ip' }))!;
    await middleware(request('1.1.1.1'), next);
    await expect(middleware(request('2.2.2.2'), next)).resolves.toBeDefined();
  });

  it('shares one bucket across clients when per: global', async () => {
    const middleware = middlewareFor(limit({ requests: 1, per: 'global' }))!;
    await middleware(request('1.1.1.1'), next);
    expect((await rejection(middleware(request('2.2.2.2'), next))).status).toBe(429);
  });
});

describe('rate limiting (end to end)', () => {
  let upstream: Awaited<ReturnType<typeof startMockUpstream>>;
  let gateway: Awaited<ReturnType<typeof startGateway>>;

  beforeAll(async () => {
    upstream = await startMockUpstream('rl');
    gateway = await startGateway(`
gateway:
  global_rate_limit: { requests: 2, window: "60s", strategy: fixed_window, per: ip }
routes:
  - path: /limited
    methods: [GET]
    upstream: { url: "${upstream.url}" }
    rate_limit: { requests: 10, window: "60s", strategy: sliding_window, per: ip }
  - path: /inherits
    methods: [GET]
    upstream: { url: "${upstream.url}" }
  - path: /also-inherits
    methods: [GET]
    upstream: { url: "${upstream.url}" }
  - path: /authed
    methods: [GET]
    upstream: { url: "${upstream.url}" }
    auth: { type: api_key, header: X-API-Key, keys: [sk_good] }
    rate_limit: { requests: 1, window: "60s", strategy: fixed_window, per: global }
`);
  });

  afterAll(async () => {
    await gateway?.close();
    await upstream?.close();
  });

  it('admits exactly the limit when 50 requests arrive concurrently', async () => {
    const responses = await Promise.all(Array.from({ length: 50 }, () => fetch(`${gateway.url}/limited`)));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(40);

    const rejected = responses.find((r) => r.status === 429)!;
    expect(Number(rejected.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await rejected.json()).toEqual({ error: 'too_many_requests', retry_after: expect.any(Number) });
  });

  it('applies the global default to routes without their own limit, with separate buckets per route', async () => {
    const inherits = [];
    for (let i = 0; i < 3; i++) inherits.push((await fetch(`${gateway.url}/inherits`)).status);
    expect(inherits).toEqual([200, 200, 429]);
    expect((await fetch(`${gateway.url}/also-inherits`)).status).toBe(200);
  });

  it('runs inside auth, so rejected requests do not use up the budget', async () => {
    for (let i = 0; i < 3; i++) expect((await fetch(`${gateway.url}/authed`)).status).toBe(401);
    const response = await fetch(`${gateway.url}/authed`, { headers: { 'x-api-key': 'sk_good' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-ratelimit-remaining')).toBe('0');
  });
});
