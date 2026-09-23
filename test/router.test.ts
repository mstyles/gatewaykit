import { describe, expect, it } from 'vitest';
import { Router } from '../src/router.js';

const route = (path: string, methods: string[] = ['GET'], stripPrefix = false) => ({ path, methods, stripPrefix });

describe('Router', () => {
  const router = new Router([
    route('/api'),
    route('/api/users', ['GET', 'POST']),
    route('/api/products', ['GET'], true),
  ]);

  it('matches on segment boundaries', () => {
    expect(router.match('GET', '/api/users')).toMatchObject({ kind: 'matched', route: { path: '/api/users' } });
    expect(router.match('GET', '/api/users/42')).toMatchObject({ kind: 'matched', route: { path: '/api/users' } });
    expect(router.match('GET', '/api/usersX')).toMatchObject({ kind: 'matched', route: { path: '/api' } });
    expect(router.match('GET', '/other')).toEqual({ kind: 'not_found' });
  });

  it('prefers the longest matching prefix regardless of config order', () => {
    expect(router.match('POST', '/api/users/1')).toMatchObject({ kind: 'matched', route: { path: '/api/users' } });
  });

  it('returns 405 info from the most specific route without falling back', () => {
    expect(router.match('DELETE', '/api/users/1')).toEqual({ kind: 'method_not_allowed', allowed: ['GET', 'POST'] });
  });

  it('strips the prefix when configured', () => {
    expect(router.match('GET', '/api/products/123')).toMatchObject({ upstreamPath: '/123' });
    expect(router.match('GET', '/api/products')).toMatchObject({ upstreamPath: '/' });
    expect(router.match('GET', '/api/users/1')).toMatchObject({ upstreamPath: '/api/users/1' });
  });

  it('lets a "/" route catch everything else', () => {
    const catchAll = new Router([route('/'), route('/api')]);
    expect(catchAll.match('GET', '/anything')).toMatchObject({ route: { path: '/' }, upstreamPath: '/anything' });
  });
});
