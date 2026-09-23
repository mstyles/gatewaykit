import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UpstreamConfig, UpstreamTarget } from '../src/config/types.js';
import { createSelector, type TargetHealth } from '../src/upstream/selector.js';
import { recordingLogger, startGateway, startMockUpstream } from './helpers.js';

const target = (name: string, weight = 1): UpstreamTarget => ({ url: new URL(`http://${name}.test`), weight });

const upstream = (balance: UpstreamConfig['balance'], ...targets: UpstreamTarget[]): UpstreamConfig => ({
  targets,
  balance,
  timeoutMs: 1_000,
});

/** Health that tests flip by hand; targets are named by their hostname. */
function fakeHealth(...down: string[]) {
  const unhealthy = new Set(down);
  const health: TargetHealth = { isHealthy: (t) => !unhealthy.has(t.url.hostname.replace('.test', '')) };
  return { health, down: (name: string) => unhealthy.add(name), up: (name: string) => unhealthy.delete(name) };
}

const picks = (selector: { pick(): UpstreamTarget }, n: number) =>
  Array.from({ length: n }, () => selector.pick().url.hostname.replace('.test', ''));

const counts = (names: string[]) =>
  names.reduce<Record<string, number>>((acc, name) => ({ ...acc, [name]: (acc[name] ?? 0) + 1 }), {});

describe('createSelector', () => {
  it('single target: always picks it', () => {
    expect(picks(createSelector(upstream('round_robin', target('a'))), 3)).toEqual(['a', 'a', 'a']);
  });

  it('round_robin: rotates through the targets in order', () => {
    const selector = createSelector(upstream('round_robin', target('a'), target('b'), target('c')));
    expect(picks(selector, 6)).toEqual(['a', 'b', 'c', 'a', 'b', 'c']);
  });

  it('round_robin: ignores weights', () => {
    const selector = createSelector(upstream('round_robin', target('a', 3), target('b', 1)));
    expect(picks(selector, 4)).toEqual(['a', 'b', 'a', 'b']);
  });

  it('weighted_round_robin: 3:1 gives exactly 300/100 over 400 picks', () => {
    const selector = createSelector(upstream('weighted_round_robin', target('a', 3), target('b', 1)));
    expect(counts(picks(selector, 400))).toEqual({ a: 300, b: 100 });
  });

  it('weighted_round_robin: interleaves rather than bursting', () => {
    const selector = createSelector(upstream('weighted_round_robin', target('a', 3), target('b', 1)));
    expect(picks(selector, 8)).toEqual(['a', 'a', 'b', 'a', 'a', 'a', 'b', 'a']);
  });

  it('weighted_round_robin: 5:1:1 is smooth (nginx reference sequence)', () => {
    const selector = createSelector(upstream('weighted_round_robin', target('a', 5), target('b', 1), target('c', 1)));
    expect(picks(selector, 7)).toEqual(['a', 'a', 'b', 'a', 'c', 'a', 'a']);
  });

  it('skips an unhealthy target and puts it back once it recovers', () => {
    const { health, down, up } = fakeHealth();
    const selector = createSelector(upstream('round_robin', target('a'), target('b'), target('c')), health);

    down('b');
    expect(picks(selector, 4)).toEqual(['a', 'c', 'a', 'c']);

    up('b');
    expect(counts(picks(selector, 6))).toEqual({ a: 2, b: 2, c: 2 });
  });

  it('weighted_round_robin: only healthy targets share the traffic', () => {
    const { health, up } = fakeHealth('a');
    const selector = createSelector(
      upstream('weighted_round_robin', target('a', 3), target('b', 1), target('c', 1)),
      health,
    );
    expect(counts(picks(selector, 10))).toEqual({ b: 5, c: 5 });

    up('a');
    expect(counts(picks(selector, 50))).toEqual({ a: 30, b: 10, c: 10 });
  });

  it('fails open when every target is unhealthy, warning once on entry', () => {
    const { logger, entries } = recordingLogger();
    const { health, up } = fakeHealth('a', 'b');
    const selector = createSelector(upstream('round_robin', target('a'), target('b')), health, logger);

    expect(picks(selector, 4)).toEqual(['a', 'b', 'a', 'b']);
    expect(entries).toEqual([
      {
        level: 'warn',
        msg: 'all upstream targets unhealthy, failing open',
        fields: { targets: ['http://a.test/', 'http://b.test/'] },
      },
    ]);

    up('b');
    expect(picks(selector, 2)).toEqual(['b', 'b']);
    expect(entries.map((e) => e.level)).toEqual(['warn', 'info']);
  });

  it('does not log while at least one target is healthy', () => {
    const { logger, entries } = recordingLogger();
    const { health } = fakeHealth('a');
    picks(createSelector(upstream('round_robin', target('a'), target('b')), health, logger), 5);
    expect(entries).toEqual([]);
  });
});

describe('load balancing end to end', () => {
  let a: Awaited<ReturnType<typeof startMockUpstream>>;
  let b: Awaited<ReturnType<typeof startMockUpstream>>;
  let gateway: Awaited<ReturnType<typeof startGateway>>;

  beforeAll(async () => {
    a = await startMockUpstream('a');
    b = await startMockUpstream('b');
    gateway = await startGateway(`
gateway: {}
routes:
  - path: /rr
    methods: [GET]
    upstream:
      targets: [{ url: "${a.url}" }, { url: "${b.url}" }]
      balance: round_robin
  - path: /weighted
    methods: [GET]
    upstream:
      targets: [{ url: "${a.url}", weight: 3 }, { url: "${b.url}", weight: 1 }]
      balance: weighted_round_robin
`);
  });

  afterAll(async () => {
    await gateway.close();
    await Promise.all([a.close(), b.close()]);
  });

  /** Sequential, so the order of picks is deterministic. */
  async function servedBy(path: string, n: number): Promise<string[]> {
    const names: string[] = [];
    for (let i = 0; i < n; i++) {
      const res = await fetch(`${gateway.url}${path}`);
      expect(res.status).toBe(200);
      await res.arrayBuffer();
      names.push(res.headers.get('x-upstream') ?? '');
    }
    return names;
  }

  it('round_robin alternates between the targets', async () => {
    expect(await servedBy('/rr', 4)).toEqual(['a', 'b', 'a', 'b']);
  });

  it('weighted_round_robin splits traffic by weight', async () => {
    const names = await servedBy('/weighted', 40);
    expect(names.slice(0, 4)).toEqual(['a', 'a', 'b', 'a']);
    expect(counts(names)).toEqual({ a: 30, b: 10 });
  });
});
