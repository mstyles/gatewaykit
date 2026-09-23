import http from 'node:http';
import https from 'node:https';
import type { HealthCheckConfig, RouteConfig, UpstreamTarget } from '../config/types.js';
import type { GatewayDeps } from '../pipeline/types.js';
import { upstreamUrl } from '../proxy/transport.js';

/**
 * Sends one health check request and resolves with its status code once the body is drained.
 * Must reject promptly when `signal` aborts (probe timeout or gateway shutdown). Injectable so
 * tests control outcomes without sockets.
 */
export type Probe = (url: URL, signal: AbortSignal) => Promise<number>;

interface TargetState {
  url: URL;
  healthy: boolean;
  consecutiveFailures: number;
}

/**
 * Active health checks for one route's targets. Every `interval`, each target gets
 * `GET <target><path>`; a non-2xx status, a connection error or no answer within
 * min(interval, route timeout) is a failure. `unhealthy_threshold` consecutive failures mark a
 * target unhealthy. The schema has no healthy_threshold, so a single success marks it healthy
 * again and resets the count.
 *
 * State is keyed by target URL, so `isHealthy` works for any object describing the same target.
 * Targets start healthy, and a target the monitor doesn't know is reported healthy.
 */
export class HealthMonitor {
  private readonly targets = new Map<string, TargetState>();
  private readonly timeoutMs: number;

  constructor(
    private readonly route: RouteConfig,
    private readonly config: HealthCheckConfig,
    private readonly deps: GatewayDeps,
    private readonly probe: Probe = httpProbe,
  ) {
    for (const { url } of route.upstream.targets) {
      this.targets.set(url.href, { url, healthy: true, consecutiveFailures: 0 });
    }
    // A probe that outlives the interval would overlap the next round.
    this.timeoutMs = Math.min(config.intervalMs, route.upstream.timeoutMs);
  }

  isHealthy(target: UpstreamTarget): boolean {
    return this.targets.get(target.url.href)?.healthy ?? true;
  }

  /**
   * Runs a round now, then one every interval. Stops when `deps.shutdown` aborts, which also
   * cancels any probe in flight. The returned promise settles (never rejects) once the loop
   * has stopped; callers don't need to await it.
   */
  start(): Promise<void> {
    return this.run().catch((err: unknown) => {
      this.deps.logger.error('health check loop failed', {
        route: this.route.path,
        error: err instanceof Error ? err.stack : String(err),
      });
    });
  }

  /** Probes every target once, concurrently, and updates their state. Never rejects. */
  async checkOnce(): Promise<void> {
    await Promise.all([...this.targets.values()].map((state) => this.check(state)));
  }

  private async run(): Promise<void> {
    const { clock, shutdown } = this.deps;
    while (!shutdown.aborted) {
      await this.checkOnce();
      try {
        await clock.sleep(this.config.intervalMs, shutdown);
      } catch {
        return;
      }
    }
  }

  private async check(state: TargetState): Promise<void> {
    const failure = await this.probeOnce(state.url);
    // Cut off by shutdown: says nothing about the target.
    if (this.deps.shutdown.aborted) return;

    const fields = { route: this.route.path, target: state.url.href };
    if (failure === undefined) {
      if (!state.healthy) this.deps.logger.info('upstream target healthy again', fields);
      state.healthy = true;
      state.consecutiveFailures = 0;
      return;
    }
    state.consecutiveFailures++;
    if (state.healthy && state.consecutiveFailures >= this.config.unhealthyThreshold) {
      state.healthy = false;
      this.deps.logger.warn('upstream target unhealthy', {
        ...fields,
        consecutive_failures: state.consecutiveFailures,
        reason: failure,
      });
    }
  }

  /** Resolves to undefined on success, else a short reason for the logs. */
  private async probeOnce(target: URL): Promise<string | undefined> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    try {
      const url = upstreamUrl(target, this.config.path);
      const status = await this.probe(url, AbortSignal.any([timeout.signal, this.deps.shutdown]));
      return status >= 200 && status < 300 ? undefined : `status ${status}`;
    } catch (err) {
      if (timeout.signal.aborted) return `no response within ${this.timeoutMs}ms`;
      return (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Creates and starts a monitor if the route configures `health_check`. */
export function startHealthMonitor(route: RouteConfig, deps: GatewayDeps): HealthMonitor | undefined {
  if (!route.healthCheck) return undefined;
  const monitor = new HealthMonitor(route, route.healthCheck, deps);
  void monitor.start();
  return monitor;
}

/** The real probe: a plain GET whose body is read and discarded; only the status matters. */
export const httpProbe: Probe = (url, signal) => {
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.get(url, { signal, headers: { 'user-agent': 'gatewaykit-health-check' } }, (response) => {
      response.on('error', reject);
      response.on('end', () => resolve(response.statusCode ?? 0));
      response.resume();
    });
    request.on('error', reject);
  });
};
