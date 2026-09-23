import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import { deadUpstreamUrl, rawRequest, recordingLogger, startGateway, startMockUpstream } from './helpers.js';

describe('gateway (end to end)', () => {
  let upstream: Awaited<ReturnType<typeof startMockUpstream>>;
  let gateway: Awaited<ReturnType<typeof startGateway>>;

  beforeAll(async () => {
    upstream = await startMockUpstream('users');
    gateway = await startGateway(`
gateway:
  port: 8080
  global_timeout: "30s"
routes:
  - path: /api/users
    methods: [GET, POST]
    upstream: { url: "${upstream.url}" }
  - path: /api/products
    methods: [GET]
    strip_prefix: true
    upstream: { url: "${upstream.url}/base" }
  - path: /api/slow
    methods: [GET]
    upstream: { url: "${upstream.url}", timeout: "200ms" }
  - path: /api/down
    methods: [GET]
    upstream: { url: "${await deadUpstreamUrl()}" }
`);
  });

  afterAll(async () => {
    await gateway?.close();
    await upstream?.close();
  });

  const get = (path: string, init?: RequestInit) => fetch(`${gateway.url}${path}`, init);

  it('serves /health regardless of routes', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'healthy', uptime_seconds: expect.any(Number) });
  });

  it('proxies a matched GET and returns the upstream response', async () => {
    const res = await get('/api/users/42?expand=true');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-upstream')).toBe('users');
    expect(await res.json()).toMatchObject({ method: 'GET', path: '/api/users/42', query: '?expand=true' });
  });

  it('forwards the request body and headers', async () => {
    const res = await get('/api/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-custom': 'yes' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    const echoed = await res.json();
    expect(echoed.body).toEqual({ name: 'Ada' });
    expect(echoed.headers['x-custom']).toBe('yes');
    expect(echoed.headers['x-forwarded-for']).toBe('127.0.0.1');
    expect(echoed.headers.host).toBe(new URL(upstream.url).host);
  });

  it('strips the route prefix and joins the upstream base path', async () => {
    const res = await get('/api/products/123?x=1');
    expect(await res.json()).toMatchObject({ path: '/base/123', query: '?x=1' });
  });

  it('passes upstream error statuses through unchanged', async () => {
    const res = await get('/api/users/status/418');
    expect(res.status).toBe(418);
  });

  it('returns 404 for unmatched paths', async () => {
    const res = await get('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('returns 405 with an Allow header for a disallowed method', async () => {
    const res = await get('/api/products/1', { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('proxies HEAD on GET routes without a body', async () => {
    const res = await get('/api/products/1', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-upstream')).toBe('users');
    expect(await res.text()).toBe('');
  });

  it('serves HEAD on /health with the length of the GET body', async () => {
    const body = await (await get('/health')).text();
    const res = await get('/health', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(body.length));
    expect(await res.text()).toBe('');
  });

  it('rejects a declared oversize body with 413 without waiting for it', async () => {
    const { status } = await rawRequest(gateway.url, '/api/users', {
      method: 'POST',
      headers: { 'content-length': String(20 * 1024 * 1024) },
    });
    expect(status).toBe(413);
  });

  it('rejects a streamed body with 413 once it passes the limit', async () => {
    const res = await get('/api/users', {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'payload_too_large' });
  });

  it('returns 504 when the upstream exceeds the route timeout', async () => {
    const res = await get('/api/slow/slow?ms=1000');
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: 'gateway_timeout' });
  });

  it('returns 502 when the upstream is unreachable', async () => {
    const res = await get('/api/down');
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'bad_gateway' });
  });

  describe('request target handling', () => {
    it('answers 400 to an unparseable request target and keeps serving', async () => {
      expect((await rawRequest(gateway.url, 'http://[')).status).toBe(400);
      expect((await get('/health')).status).toBe(200);
    });

    it('resolves dot segments, including encoded ones, before routing', async () => {
      const res = await get('/api/products/%2e%2e/users/1');
      expect(await res.json()).toMatchObject({ path: '/api/users/1' });
    });

    it('treats leading "//" as a path, not a protocol-relative URL', async () => {
      const res = await get('//api/users/1');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ path: '/api/users/1' });
    });

    it.each(['/api/users%2F..%2Finternal', '/api/users%2f1', '/api/users%5C1'])(
      'rejects encoded path separators in %s',
      async (path) => {
        const res = await get(path);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: 'bad_request' });
      },
    );
  });
});

describe('client aborts', () => {
  let upstream: Awaited<ReturnType<typeof startMockUpstream>>;
  let gateway: Awaited<ReturnType<typeof startGateway>>;
  let log: ReturnType<typeof recordingLogger>;

  beforeAll(async () => {
    upstream = await startMockUpstream('aborts');
    log = recordingLogger();
    gateway = await startGateway(
      `
gateway: {}
routes:
  - { path: /api, methods: [GET, POST], upstream: { url: "${upstream.url}" } }
`,
      log.logger,
    );
  });

  afterAll(async () => {
    await gateway?.close();
    await upstream?.close();
  });

  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const requestLogs = (path: string) => log.entries.filter((e) => e.msg === 'request' && e.fields?.path === path);

  it('logs a client that hangs up mid-body as 499, not an internal error', async () => {
    const { hostname, port } = new URL(gateway.url);
    const socket = net.connect(Number(port), hostname, () => {
      socket.write(`POST /api/upload HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\npartial`);
      setTimeout(() => socket.destroy(), 50);
    });
    socket.on('error', () => {});
    await settle(200);

    expect(requestLogs('/api/upload')).toEqual([expect.objectContaining({ fields: expect.objectContaining({ status: 499 }) })]);
    expect(log.entries.filter((e) => e.level === 'error')).toEqual([]);
  });

  it('logs a client that hangs up while the upstream is slow as 499', async () => {
    const controller = new AbortController();
    const res = fetch(`${gateway.url}/api/slow?ms=200`, { signal: controller.signal }).catch(() => undefined);
    await settle(50);
    controller.abort();
    await res;
    await settle(300);

    expect(requestLogs('/api/slow')).toEqual([expect.objectContaining({ fields: expect.objectContaining({ status: 499 }) })]);
  });
});

describe('gateway shutdown', () => {
  it('lets in-flight requests finish before closing', async () => {
    const upstream = await startMockUpstream('slow');
    const gateway = await startGateway(`
gateway: {}
routes:
  - { path: /api, methods: [GET], upstream: { url: "${upstream.url}" } }
`);
    try {
      const inFlight = fetch(`${gateway.url}/api/slow?ms=300`);
      await new Promise((resolve) => setTimeout(resolve, 50)); // let the request reach the upstream
      const closed = gateway.close(5_000);

      const res = await inFlight;
      expect(res.status).toBe(200);
      expect(res.headers.get('connection')).toBe('close');
      await closed;
    } finally {
      await upstream.close();
    }
  });

  it('force-closes connections still open after the grace period', async () => {
    const upstream = await startMockUpstream('stuck');
    const gateway = await startGateway(`
gateway: {}
routes:
  - { path: /api, methods: [GET], upstream: { url: "${upstream.url}" } }
`);
    try {
      const inFlight = fetch(`${gateway.url}/api/slow?ms=5000`).then(
        () => 'responded',
        () => 'connection closed',
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const started = Date.now();
      await gateway.close(100);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(await inFlight).toBe('connection closed');
    } finally {
      await upstream.close();
    }
  });
});

describe('unimplemented features', () => {
  it('warns at startup when a route configures transforms, which are not applied yet', async () => {
    const { logger, entries } = recordingLogger();
    const gateway = await startGateway(
      `
gateway: {}
routes:
  - path: /legacy
    methods: [GET]
    upstream: { url: "http://127.0.0.1:1" }
    request_transform: { headers: { remove: [X-Internal] } }
  - path: /plain
    methods: [GET]
    upstream: { url: "http://127.0.0.1:1" }
`,
      logger,
    );
    await gateway.close();
    const warnings = entries.filter((e) => e.level === 'warn' && e.msg.startsWith('transforms'));
    expect(warnings).toEqual([
      expect.objectContaining({ fields: { route: '/legacy', transforms: ['request_transform'] } }),
    ]);
  });
});
