import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stripHopByHop } from '../src/proxy/transport.js';
import { closeServer, listen, rawRequest, startGateway, startMockUpstream } from './helpers.js';

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('stripHopByHop', () => {
  it('drops the fixed hop-by-hop set and anything named in Connection', () => {
    expect(
      stripHopByHop({
        connection: 'close, X-Session-Hint',
        'keep-alive': 'timeout=5',
        'proxy-authorization': 'Basic abc',
        'proxy-connection': 'keep-alive',
        te: 'trailers',
        trailer: 'x-checksum',
        'transfer-encoding': 'chunked',
        upgrade: 'websocket',
        'x-session-hint': 'secret',
        'x-kept': 'yes',
        'set-cookie': ['a=1', 'b=2'],
        'x-undefined': undefined,
      }),
    ).toEqual({ 'x-kept': 'yes', 'set-cookie': ['a=1', 'b=2'] });
  });
});

describe('proxy header handling (end to end)', () => {
  let echo: Awaited<ReturnType<typeof startMockUpstream>>;
  let chatty: http.Server;
  let gateway: Awaited<ReturnType<typeof startGateway>>;

  beforeAll(async () => {
    echo = await startMockUpstream('echo');
    // An upstream that sends hop-by-hop headers of its own.
    chatty = http.createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        connection: 'x-upstream-hint',
        'x-upstream-hint': 'internal',
        'keep-alive': 'timeout=5',
        'proxy-authenticate': 'Basic realm="upstream"',
        'x-kept': 'yes',
      });
      res.end('ok');
    });
    const chattyUrl = await listen(chatty);
    gateway = await startGateway(`
gateway: {}
routes:
  - { path: /echo, methods: [GET], upstream: { url: "${echo.url}" } }
  - { path: /chatty, methods: [GET], upstream: { url: "${chattyUrl}" } }
`);
  });

  afterAll(async () => {
    await gateway?.close();
    await echo?.close();
    if (chatty) await closeServer(chatty);
  });

  it('strips hop-by-hop request headers, including ones named in Connection', async () => {
    const res = await rawRequest(gateway.url, '/echo', {
      headers: {
        connection: 'close, x-client-hint',
        'x-client-hint': 'secret',
        'keep-alive': 'timeout=5',
        te: 'trailers',
        'proxy-authorization': 'Basic abc',
        'x-kept': 'yes',
      },
    });
    const forwarded = JSON.parse(res.body).headers;
    expect(forwarded['x-kept']).toBe('yes');
    for (const name of ['x-client-hint', 'keep-alive', 'te', 'proxy-authorization']) {
      expect(forwarded, name).not.toHaveProperty(name);
    }
  });

  it('strips hop-by-hop response headers, including ones named in Connection', async () => {
    const res = await rawRequest(gateway.url, '/chatty');
    expect(res.status).toBe(200);
    expect(res.headers['x-kept']).toBe('yes');
    for (const name of ['x-upstream-hint', 'keep-alive', 'proxy-authenticate']) {
      expect(res.headers, name).not.toHaveProperty(name);
    }
  });

  it('rewrites Host and sets X-Forwarded-Host and -Proto, ignoring client-supplied values', async () => {
    const res = await rawRequest(gateway.url, '/echo', {
      headers: { host: 'shop.example.com', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example' },
    });
    const forwarded = JSON.parse(res.body).headers;
    expect(forwarded.host).toBe(new URL(echo.url).host);
    expect(forwarded['x-forwarded-host']).toBe('shop.example.com');
    expect(forwarded['x-forwarded-proto']).toBe('http');
  });

  it('appends the client IP to an existing X-Forwarded-For', async () => {
    const res = await rawRequest(gateway.url, '/echo', { headers: { 'x-forwarded-for': '203.0.113.7' } });
    expect(JSON.parse(res.body).headers['x-forwarded-for']).toBe('203.0.113.7, 127.0.0.1');
  });
});

describe('upstream cancellation', () => {
  it('cancels the upstream request when the client goes away', async () => {
    let upstreamClosedEarly: Promise<number> | undefined;
    const upstream = http.createServer((_req, res) => {
      const started = Date.now();
      upstreamClosedEarly = new Promise((resolve) => res.on('close', () => resolve(Date.now() - started)));
      setTimeout(() => res.end('too late'), 2_000);
    });
    const upstreamUrl = await listen(upstream);
    const gateway = await startGateway(`
gateway: {}
routes:
  - { path: /api, methods: [GET], upstream: { url: "${upstreamUrl}" } }
`);
    try {
      const controller = new AbortController();
      const res = fetch(`${gateway.url}/api/slow`, { signal: controller.signal }).catch(() => undefined);
      await settle(100);
      controller.abort();
      await res;

      expect(upstreamClosedEarly).toBeDefined();
      expect(await upstreamClosedEarly).toBeLessThan(1_000);
    } finally {
      await gateway.close(100);
      await closeServer(upstream);
    }
  });
});
