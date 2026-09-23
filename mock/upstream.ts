import http from 'node:http';

/**
 * A canned upstream for manual runs and tests. Endpoints match on the path *suffix* so they
 * work behind any route prefix (e.g. /api/orders/slow):
 *
 *   .../healthz                200 {"status":"ok"}, or 503 {"status":"failing"} while failing
 *   POST .../healthz/fail      make this server's /healthz fail (any prefix) until recovered
 *   POST .../healthz/recover   make /healthz answer 200 again
 *   .../slow?ms=N              waits N ms (default 2000), then echoes
 *   .../status/NNN             responds with status NNN
 *   .../flaky?fail=N           first N hits on this path return 503, later hits echo
 *   anything else              200 echo of method, path, query, headers and body
 *
 * Every response carries Server / X-Powered-By (for response header transforms) and
 * X-Upstream (to see which target served a load-balanced request).
 */
export function createMockUpstream(name: string): http.Server {
  const hits = new Map<string, number>();
  // Server-wide rather than per path: a health check may use any prefix.
  let healthzFailing = false;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock.invalid');
    const hitCount = (hits.get(url.pathname) ?? 0) + 1;
    hits.set(url.pathname, hitCount);

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString('utf8');

    const reply = (status: number, payload: unknown) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        server: 'mock-upstream',
        'x-powered-by': 'mock',
        'x-upstream': name,
      });
      res.end(JSON.stringify(payload));
    };
    const echo = () =>
      reply(200, {
        upstream: name,
        method: req.method,
        path: url.pathname,
        query: url.search,
        headers: req.headers,
        body: parseBody(rawBody),
      });

    const status = /\/status\/(\d{3})$/.exec(url.pathname);
    if (req.method === 'POST' && /\/healthz\/(fail|recover)$/.test(url.pathname)) {
      healthzFailing = url.pathname.endsWith('/fail');
      return reply(200, { upstream: name, healthz_failing: healthzFailing });
    }
    if (url.pathname.endsWith('/healthz')) {
      return healthzFailing ? reply(503, { status: 'failing' }) : reply(200, { status: 'ok' });
    }
    if (status) return reply(Number(status[1]), { upstream: name, status: Number(status[1]) });
    if (url.pathname.endsWith('/slow')) {
      await new Promise((resolve) => setTimeout(resolve, Number(url.searchParams.get('ms') ?? 2000)));
      return echo();
    }
    if (url.pathname.endsWith('/flaky') && hitCount <= Number(url.searchParams.get('fail') ?? 2)) {
      return reply(503, { upstream: name, error: 'flaky', hit: hitCount });
    }
    return echo();
  });
}

function parseBody(raw: string): unknown {
  if (raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
