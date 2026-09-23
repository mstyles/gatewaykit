import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { systemClock, type Clock } from '../src/clock.js';
import type { HealthCheckConfig, RouteConfig } from '../src/config/types.js';
import { HealthMonitor, type Probe } from '../src/upstream/health.js';
import { deadUpstreamUrl, FakeClock, recordingLogger, startGateway, startMockUpstream } from './helpers.js';

interface Options {
  threshold?: number;
  intervalMs?: number;
  /** The route's upstream timeout. */
  timeoutMs?: number;
  path?: string;
  clock?: Clock;
}

/** `probe` defaults to the real HTTP probe. */
function monitorFor(urls: string[], probe: Probe | undefined, options: Options = {}) {
  const { threshold = 3, intervalMs = 10_000, timeoutMs = 5_000, path = '/healthz', clock = new FakeClock() } = options;
  const healthCheck: HealthCheckConfig = { path, intervalMs, unhealthyThreshold: threshold };
  const route: RouteConfig = {
    path: '/api/products',
    methods: ['GET', 'HEAD'],
    stripPrefix: true,
    upstream: { targets: urls.map((url) => ({ url: new URL(url), weight: 1 })), balance: 'round_robin', timeoutMs },
    healthCheck,
  };
  const shutdown = new AbortController();
  const { logger, entries } = recordingLogger();
  const monitor = new HealthMonitor(route, healthCheck, { clock, logger, shutdown: shutdown.signal }, probe);
  return { monitor, targets: route.upstream.targets, entries, shutdown };
}

type Outcome = number | 'refused' | 'hang';

/**
 * A probe that plays scripted outcomes per origin (200 once a script runs out). `hang` never
 * answers and only rejects when the signal aborts. Records every URL probed.
 */
function scriptedProbe(script: Record<string, Outcome[]>) {
  const calls: string[] = [];
  const probe: Probe = async (url, signal) => {
    calls.push(url.href);
    const outcome = script[url.origin]?.shift() ?? 200;
    if (outcome === 'hang') {
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    if (outcome === 'refused') throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    return outcome;
  };
  return { probe, calls };
}

const A = 'http://a.test';
const B = 'http://b.test';

describe('HealthMonitor', () => {
  it('marks a target unhealthy on the unhealthy_threshold-th consecutive failure, not before', async () => {
    const { probe } = scriptedProbe({ [A]: [503, 'refused', 500] });
    const { monitor, targets, entries } = monitorFor([A], probe);
    const [a] = targets;
    expect(monitor.isHealthy(a)).toBe(true);

    await monitor.checkOnce();
    await monitor.checkOnce();
    expect(monitor.isHealthy(a)).toBe(true);

    await monitor.checkOnce();
    expect(monitor.isHealthy(a)).toBe(false);
    expect(entries).toEqual([
      {
        level: 'warn',
        msg: 'upstream target unhealthy',
        fields: { route: '/api/products', target: 'http://a.test/', consecutive_failures: 3, reason: 'status 500' },
      },
    ]);
  });

  it('marks an unhealthy target healthy again after a single success', async () => {
    const { probe } = scriptedProbe({ [A]: [503, 503, 503, 200] });
    const { monitor, targets, entries } = monitorFor([A], probe);
    for (let i = 0; i < 3; i++) await monitor.checkOnce();
    expect(monitor.isHealthy(targets[0])).toBe(false);

    await monitor.checkOnce();
    expect(monitor.isHealthy(targets[0])).toBe(true);
    expect(entries.at(-1)).toEqual({
      level: 'info',
      msg: 'upstream target healthy again',
      fields: { route: '/api/products', target: 'http://a.test/' },
    });
  });

  it('resets the failure count on success, so failures must be consecutive', async () => {
    const { probe } = scriptedProbe({ [A]: [503, 503, 204, 503, 503] });
    const { monitor, targets, entries } = monitorFor([A], probe);
    for (let i = 0; i < 5; i++) await monitor.checkOnce();
    expect(monitor.isHealthy(targets[0])).toBe(true);
    expect(entries).toEqual([]);
  });

  it('tracks each target independently', async () => {
    const { probe, calls } = scriptedProbe({ [A]: [503, 503, 503] });
    const { monitor, targets } = monitorFor([A, B], probe);
    for (let i = 0; i < 3; i++) await monitor.checkOnce();
    expect(monitor.isHealthy(targets[0])).toBe(false);
    expect(monitor.isHealthy(targets[1])).toBe(true);
    expect(calls.filter((url) => url.startsWith(B))).toHaveLength(3);
  });

  it('probes all targets concurrently', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const probe: Probe = async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return 200;
    };
    const { monitor } = monitorFor([A, B, 'http://c.test'], probe);
    await monitor.checkOnce();
    expect(maxInFlight).toBe(3);
  });

  it.each([
    { case: 'interval', intervalMs: 20, timeoutMs: 5_000 },
    { case: 'route timeout', intervalMs: 10_000, timeoutMs: 20 },
  ])('counts no answer within min(interval, route timeout) as a failure ($case is shorter)', async (options) => {
    const { probe } = scriptedProbe({ [A]: ['hang'] });
    const { monitor, targets, entries } = monitorFor([A], probe, { ...options, threshold: 1 });
    await monitor.checkOnce();
    expect(monitor.isHealthy(targets[0])).toBe(false);
    expect(entries[0].fields?.reason).toBe('no response within 20ms');
  });

  it('joins the health check path onto a target base path', async () => {
    const { probe, calls } = scriptedProbe({});
    const { monitor } = monitorFor(['http://a.test/base/'], probe);
    await monitor.checkOnce();
    expect(calls).toEqual(['http://a.test/base/healthz']);
  });

  it('looks targets up by URL; unknown targets count as healthy', async () => {
    const { probe } = scriptedProbe({ [A]: [503] });
    const { monitor } = monitorFor([A], probe, { threshold: 1 });
    await monitor.checkOnce();
    expect(monitor.isHealthy({ url: new URL(A), weight: 5 })).toBe(false);
    expect(monitor.isHealthy({ url: new URL(B), weight: 1 })).toBe(true);
  });

  describe('loop', () => {
    it('probes every interval until shutdown', async () => {
      const clock = new FakeClock();
      let probes = 0;
      // The fake clock's sleep returns at once, so the probe ends the run on the third round.
      const probe: Probe = async (_url, signal) => {
        if (++probes === 3) shutdown.abort();
        if (signal.aborted) throw signal.reason;
        return 503;
      };
      const { monitor, targets, entries, shutdown } = monitorFor([A], probe, { clock, threshold: 3 });

      await monitor.start();
      expect(probes).toBe(3);
      expect(clock.sleeps).toEqual([10_000, 10_000]);
      // The third probe was cut off by shutdown, which says nothing about the target.
      expect(monitor.isHealthy(targets[0])).toBe(true);
      expect(entries).toEqual([]);
    });

    it('stops mid-sleep when shutdown aborts', async () => {
      const { probe, calls } = scriptedProbe({});
      const { monitor, shutdown } = monitorFor([A], probe, { clock: systemClock, intervalMs: 60_000 });
      const loop = monitor.start();
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      shutdown.abort();
      await loop;
      expect(calls).toHaveLength(1);
    });

    it('cancels a probe in flight when shutdown aborts, without counting it', async () => {
      let probeSignal: AbortSignal | undefined;
      const probe: Probe = (_url, signal) => {
        probeSignal = signal;
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      };
      const { monitor, targets, entries, shutdown } = monitorFor([A], probe, {
        clock: systemClock,
        threshold: 1,
        intervalMs: 60_000,
        timeoutMs: 60_000,
      });
      const loop = monitor.start();
      await vi.waitFor(() => expect(probeSignal).toBeDefined());
      shutdown.abort();
      await loop;
      expect(probeSignal!.aborted).toBe(true);
      expect(monitor.isHealthy(targets[0])).toBe(true);
      expect(entries).toEqual([]);
    });
  });
});

describe('health checks against real upstreams', () => {
  let a: Awaited<ReturnType<typeof startMockUpstream>>;
  let b: Awaited<ReturnType<typeof startMockUpstream>>;

  beforeAll(async () => {
    a = await startMockUpstream('a');
    b = await startMockUpstream('b');
  });

  afterAll(async () => {
    await a.close();
    await b.close();
  });

  const setHealthz = (url: string, state: 'fail' | 'recover') => fetch(`${url}/healthz/${state}`, { method: 'POST' });

  it('marks a target whose /healthz fails unhealthy, and healthy again once it recovers', async () => {
    const { monitor, targets, entries } = monitorFor([a.url, b.url], undefined, {
      clock: systemClock,
      threshold: 2,
    });
    await setHealthz(a.url, 'fail');
    try {
      await monitor.checkOnce();
      await monitor.checkOnce();
      expect(monitor.isHealthy(targets[0])).toBe(false);
      expect(monitor.isHealthy(targets[1])).toBe(true);
      expect(entries[0].fields?.reason).toBe('status 503');
    } finally {
      await setHealthz(a.url, 'recover');
    }
    await monitor.checkOnce();
    expect(monitor.isHealthy(targets[0])).toBe(true);
  });

  it('counts a refused connection as a failure', async () => {
    const { monitor, targets, entries } = monitorFor([await deadUpstreamUrl()], undefined, {
      clock: systemClock,
      threshold: 1,
    });
    await monitor.checkOnce();
    expect(monitor.isHealthy(targets[0])).toBe(false);
    expect(entries[0].fields?.reason).toBe('ECONNREFUSED');
  });

  it('runs from the gateway on the configured interval and stops when the gateway closes', async () => {
    const { logger, entries } = recordingLogger();
    const gateway = await startGateway(
      `
gateway:
  port: 8080
routes:
  - path: "/products"
    methods: ["GET"]
    upstream:
      url: "${a.url}"
    health_check:
      path: "/healthz"
      interval: "20ms"
      unhealthy_threshold: 2
`,
      logger,
    );
    const health = () => entries.filter((entry) => entry.msg.startsWith('upstream target'));
    try {
      await setHealthz(a.url, 'fail');
      await vi.waitFor(() => expect(health().map((entry) => entry.level)).toEqual(['warn']));
      await setHealthz(a.url, 'recover');
      await vi.waitFor(() => expect(health().map((entry) => entry.level)).toEqual(['warn', 'info']));
    } finally {
      await gateway.close();
    }

    // A loop still running would notice this within a few intervals.
    await setHealthz(a.url, 'fail');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await setHealthz(a.url, 'recover');
    expect(health()).toHaveLength(2);
  });
});
