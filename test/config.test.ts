import { describe, expect, it } from 'vitest';
import { loadConfigFile, parseConfig } from '../src/config/load.js';
import { ConfigError } from '../src/config/validate.js';

function configErrors(yaml: string): string[] {
  try {
    parseConfig(yaml);
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
  throw new Error('expected config to be rejected');
}

describe('config loading', () => {
  it('loads and normalizes the reference gateway.yaml', () => {
    const { config, warnings } = loadConfigFile('gateway.yaml');
    expect(warnings).toEqual([]);
    expect(config.port).toBe(8080);
    expect(config.globalTimeoutMs).toBe(30_000);
    expect(config.routes.map((r) => r.path)).toEqual([
      '/api/users',
      '/api/orders',
      '/api/products',
      '/api/legacy',
      '/api/internal',
    ]);

    const [users, orders, products, legacy, internal] = config.routes;
    expect(users.rateLimit).toEqual({ requests: 30, windowMs: 60_000, strategy: 'sliding_window', per: 'ip' });
    expect(users.upstream.timeoutMs).toBe(30_000);
    expect(orders.upstream.timeoutMs).toBe(5_000);
    expect(orders.retry).toEqual({ attempts: 3, backoff: 'exponential', initialDelayMs: 1_000, on: [502, 503, 504] });
    expect(products.upstream.targets.map((t) => [t.url.href, t.weight])).toEqual([
      ['http://localhost:3003/', 3],
      ['http://localhost:3004/', 1],
    ]);
    expect(products.healthCheck).toEqual({ path: '/healthz', intervalMs: 30_000, unhealthyThreshold: 3 });
    expect(legacy.rateLimit).toEqual(config.globalRateLimit); // inherits the global limit
    expect(legacy.requestTransform?.headers?.remove).toEqual(['x-debug', 'x-internal']);
    expect(internal.auth).toEqual({ type: 'api_key', header: 'x-api-key', keys: ['sk_live_abc123', 'sk_live_def456'] });
    expect(internal.circuitBreaker).toEqual({ threshold: 5, windowMs: 60_000, cooldownMs: 30_000 });
  });

  it('applies defaults for optional fields', () => {
    const { config } = parseConfig(`
gateway: {}
routes:
  - path: /svc/
    methods: [get]
    upstream: { url: "http://localhost:9000" }
`);
    expect(config.port).toBe(8080);
    expect(config.globalRateLimit).toBeUndefined();
    const [route] = config.routes;
    expect(route.path).toBe('/svc');
    expect(route.methods).toEqual(['GET']);
    expect(route.stripPrefix).toBe(false);
    expect(route.rateLimit).toBeUndefined();
    expect(route.upstream).toMatchObject({ balance: 'round_robin', timeoutMs: 30_000 });
  });

  it('reports every problem in one pass', () => {
    const errors = configErrors(`
gateway:
  port: 99999
  global_timeout: 30
routes:
  - path: api/a
    methods: [FETCH]
    upstream: { url: "http://a", targets: [{ url: "http://b" }] }
    rate_limit: { requests: 0, window: "1 minute", strategy: leaky_bucket }
  - path: /b
    upstream: { url: "ftp://b" }
`);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('gateway.port'),
        expect.stringContaining('gateway.global_timeout: must be a duration string'),
        expect.stringContaining('routes[0].path: must start with "/"'),
        expect.stringContaining('unsupported HTTP method "FETCH"'),
        expect.stringContaining('routes[0].upstream: must set exactly one of "url" or "targets"'),
        expect.stringContaining('routes[0].rate_limit.requests'),
        expect.stringContaining('routes[0].rate_limit.window'),
        expect.stringContaining('routes[0].rate_limit.strategy'),
        expect.stringContaining('routes[1].methods: is required'),
        expect.stringContaining('routes[1].upstream.url: must be an http'),
      ]),
    );
  });

  it('rejects duplicate route paths', () => {
    expect(
      configErrors(`
gateway: {}
routes:
  - { path: /a, methods: [GET], upstream: { url: "http://x" } }
  - { path: /a/, methods: [POST], upstream: { url: "http://y" } }
`),
    ).toEqual([expect.stringContaining('duplicate route path "/a"')]);
  });

  it('warns about unknown keys instead of failing', () => {
    const { warnings } = parseConfig(`
gateway: { port: 8080 }
routes:
  - { path: /a, methods: [GET], upstream: { url: "http://x" }, strip_prefx: true }
`);
    expect(warnings).toEqual(['routes[0].strip_prefx: unknown key, ignored']);
  });

  it('rejects malformed YAML', () => {
    expect(configErrors('routes: [unclosed')).toEqual([expect.stringContaining('YAML parse error')]);
  });
});
