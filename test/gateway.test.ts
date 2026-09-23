import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deadUpstreamUrl, startGateway, startMockUpstream } from './helpers.js';

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
    expect(res.headers.get('allow')).toBe('GET');
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
});
