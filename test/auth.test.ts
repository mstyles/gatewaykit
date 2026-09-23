import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Clock } from '../src/clock.js';
import { parseConfig } from '../src/config/load.js';
import { GatewayError } from '../src/errors.js';
import { auth, FAILED_ATTEMPT_WINDOW_MS, MAX_FAILED_ATTEMPTS } from '../src/features/auth.js';
import { silentLogger } from '../src/logger.js';
import type { GatewayRequest, GatewayResponse, Middleware } from '../src/pipeline/types.js';
import { startGateway, startMockUpstream } from './helpers.js';

const ROUTES = `
gateway: {}
routes:
  - path: /internal
    methods: [GET]
    upstream: { url: "http://localhost:9" }
    auth: { type: api_key, header: X-API-Key, keys: [sk_one, sk_two] }
  - path: /open
    methods: [GET]
    upstream: { url: "http://localhost:9" }
`;

function fakeClock(start = 1_000_000): Clock & { advance(ms: number): void } {
  let now = start;
  return { now: () => now, sleep: async () => {}, advance: (ms) => (now += ms) };
}

describe('auth middleware', () => {
  const [internal, open] = parseConfig(ROUTES).config.routes;

  function setup() {
    const clock = fakeClock();
    const middleware = auth.create(internal, {
      clock,
      logger: silentLogger,
      shutdown: new AbortController().signal,
    }) as Middleware;
    const forwarded: GatewayRequest[] = [];
    const next = async (req: GatewayRequest): Promise<GatewayResponse> => {
      forwarded.push(req);
      return { status: 200, headers: {}, body: Buffer.from('ok') };
    };
    const call = (key?: string, clientIp = '198.51.100.1') =>
      middleware(
        {
          method: 'GET',
          originalPath: '/internal',
          path: '/internal',
          query: '',
          headers: key === undefined ? { accept: '*/*' } : { accept: '*/*', 'x-api-key': key },
          body: Buffer.alloc(0),
          clientIp,
          receivedAt: new Date(clock.now()),
          route: internal,
          signal: new AbortController().signal,
        },
        next,
      );
    const status = (key?: string, clientIp?: string) =>
      call(key, clientIp).then(
        (res) => res.status,
        (err: GatewayError) => err.status,
      );
    return { clock, call, status, forwarded };
  }

  it('is not installed on routes without auth', () => {
    expect(auth.create(open, { clock: fakeClock(), logger: silentLogger, shutdown: new AbortController().signal })).toBeUndefined();
  });

  it('accepts any configured key and strips it before forwarding', async () => {
    const { status, forwarded } = setup();
    expect(await status('sk_one')).toBe(200);
    expect(await status('sk_two')).toBe(200);
    expect(forwarded[0].headers).toEqual({ accept: '*/*' });
  });

  it('answers a missing key and a wrong key the same way: 401', async () => {
    const { call } = setup();
    const missing = await call().catch((err: GatewayError) => err);
    const wrong = await call('sk_nope').catch((err: GatewayError) => err);
    for (const err of [missing, wrong]) {
      expect(err).toBeInstanceOf(GatewayError);
      expect(err).toMatchObject({ status: 401, code: 'unauthorized' });
    }
    expect((missing as GatewayError).body).toEqual((wrong as GatewayError).body);
  });

  it('rejects near-misses of a valid key', async () => {
    const { status } = setup();
    for (const key of ['sk_on', 'sk_one ', 'SK_ONE', 'sk_one, sk_one', '']) expect(await status(key), key).toBe(401);
  });

  it('locks an IP out after too many failures, even with a valid key, until the window ends', async () => {
    const { clock, call, status } = setup();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) expect(await status('wrong')).toBe(401);

    const locked = await call('sk_one').catch((err: GatewayError) => err);
    expect(locked).toMatchObject({ status: 429, code: 'too_many_requests', headers: { 'retry-after': '60' } });
    expect((locked as GatewayError).body).toMatchObject({ retry_after: 60 });

    clock.advance(FAILED_ATTEMPT_WINDOW_MS - 1_500);
    expect(await call('sk_one').catch((err: GatewayError) => err)).toMatchObject({
      status: 429,
      headers: { 'retry-after': '2' },
    });

    clock.advance(1_500);
    expect(await status('sk_one')).toBe(200);
  });

  it('counts failures per client IP', async () => {
    const { status } = setup();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await status('wrong', '198.51.100.1');
    expect(await status('sk_one', '198.51.100.1')).toBe(429);
    expect(await status('sk_one', '198.51.100.2')).toBe(200);
  });

  it('does not count successful requests toward the limit', async () => {
    const { status } = setup();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS * 2; i++) expect(await status('sk_one')).toBe(200);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) await status('wrong');
    expect(await status('sk_one')).toBe(200);
  });

  it('starts a fresh count once a window has passed', async () => {
    const { clock, status } = setup();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) await status('wrong');
    clock.advance(FAILED_ATTEMPT_WINDOW_MS);
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) await status('wrong');
    expect(await status('sk_one')).toBe(200);
  });
});

describe('auth (end to end)', () => {
  let upstream: Awaited<ReturnType<typeof startMockUpstream>>;
  let gateway: Awaited<ReturnType<typeof startGateway>>;

  beforeAll(async () => {
    upstream = await startMockUpstream('internal');
    gateway = await startGateway(ROUTES.replaceAll('http://localhost:9', upstream.url));
  });

  afterAll(async () => {
    await gateway?.close();
    await upstream?.close();
  });

  it('returns 401 JSON without contacting the upstream when the key is missing or wrong', async () => {
    for (const headers of [{}, { 'x-api-key': 'nope' }] as Record<string, string>[]) {
      const res = await fetch(`${gateway.url}/internal/data`, { headers });
      expect(res.status).toBe(401);
      expect(res.headers.get('x-upstream')).toBeNull();
      expect(await res.json()).toEqual({ error: 'unauthorized', message: 'missing or invalid x-api-key header' });
    }
  });

  it('forwards an authenticated request without the key header', async () => {
    const res = await fetch(`${gateway.url}/internal/data`, { headers: { 'X-API-Key': 'sk_two' } });
    expect(res.status).toBe(200);
    const echoed = await res.json();
    expect(echoed.path).toBe('/internal/data');
    expect(echoed.headers).not.toHaveProperty('x-api-key');
  });

  it('leaves routes without auth open', async () => {
    expect((await fetch(`${gateway.url}/open`)).status).toBe(200);
  });
});
