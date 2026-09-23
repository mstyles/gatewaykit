export interface Routable {
  path: string;
  methods: readonly string[];
  stripPrefix: boolean;
}

export type RouteMatch<T> =
  | { kind: 'matched'; route: T; upstreamPath: string }
  | { kind: 'method_not_allowed'; allowed: readonly string[] }
  | { kind: 'not_found' };

/**
 * Prefix router. A route owns its path and everything below it on a segment boundary
 * ("/api/users" matches "/api/users/1" but not "/api/usersX"). The longest matching
 * prefix wins; if that route rejects the method the result is 405, with no fallback to a
 * shorter prefix.
 */
export class Router<T extends Routable> {
  private readonly routes: T[];

  constructor(routes: readonly T[]) {
    this.routes = [...routes].sort((a, b) => b.path.length - a.path.length);
  }

  match(method: string, pathname: string): RouteMatch<T> {
    const route = this.routes.find((r) => ownsPath(r.path, pathname));
    if (!route) return { kind: 'not_found' };
    if (!route.methods.includes(method)) return { kind: 'method_not_allowed', allowed: route.methods };
    return {
      kind: 'matched',
      route,
      upstreamPath: route.stripPrefix ? stripPrefix(route.path, pathname) : pathname,
    };
  }
}

function ownsPath(prefix: string, pathname: string): boolean {
  return prefix === '/' || pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function stripPrefix(prefix: string, pathname: string): string {
  if (prefix === '/') return pathname;
  const rest = pathname.slice(prefix.length);
  return rest === '' ? '/' : rest;
}
