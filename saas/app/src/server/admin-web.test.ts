import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { adminWebOrigin, clientCorsMiddleware, clientCorsOrigins } from './admin-web';

describe('configured dedicated administrator origin', () => {
  it('is optional and retains only explicitly configured client origins', () => {
    expect(adminWebOrigin({})).toBeNull();
    expect(clientCorsOrigins({ WASP_WEB_CLIENT_URL: 'https://research.example.test/' })).toEqual(['https://research.example.test']);
    expect(clientCorsOrigins({ WASP_WEB_CLIENT_URL: 'https://research.example.test', ADMIN_WEB_CLIENT_URL: 'https://admin.example.test/' })).toEqual(['https://research.example.test', 'https://admin.example.test']);
  });
  it.each(['http://admin.example.test', 'https://admin.example.test/path', 'https://admin.example.test/.', 'https://admin.example.test/path/..', 'https://user:password@admin.example.test', 'https://admin.example.test?next=evil', 'https://admin.example.test#hash', '//admin.example.test', 'javascript:alert(1)', 'https://research.example.test'])('rejects unsafe or shared administrator destination %s', value => {
    expect(() => adminWebOrigin({ WASP_WEB_CLIENT_URL: 'https://research.example.test', ADMIN_WEB_CLIENT_URL: value })).toThrow('INVALID_ADMIN_WEB_CLIENT_URL');
  });
  it.each(['http://127.0.0.1:3102', 'http://localhost:3102', 'http://[::1]:3102'])('allows an HTTP loopback origin for local preview %s', value => {
    expect(adminWebOrigin({ ADMIN_WEB_CLIENT_URL: value })).toBe(new URL(value).origin);
  });
});

describe('precise CORS at the actual middleware boundary', () => {
  const middleware = clientCorsMiddleware({ WASP_WEB_CLIENT_URL: 'https://research.example.test', ADMIN_WEB_CLIENT_URL: 'https://admin.example.test' });
  function run(origin: string | undefined, method = 'GET') {
    const headers = new Map<string, unknown>();
    const next = vi.fn(), end = vi.fn();
    const req = { method, headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } } as unknown as Request;
    const res = { setHeader: (name: string, value: unknown) => headers.set(name.toLowerCase(), value), getHeader: (name: string) => headers.get(name.toLowerCase()), end } as unknown as Response;
    middleware(req, res, next); return { headers, next, end, res };
  }
  it.each(['https://research.example.test', 'https://admin.example.test'])('allows only configured browser origin %s including bearer preflight', origin => {
    const actual = run(origin, 'OPTIONS');
    expect(actual.headers.get('access-control-allow-origin')).toBe(origin);
    expect(actual.headers.get('access-control-allow-headers')).toBe('authorization,content-type');
    expect(actual.headers.get('access-control-allow-methods')).toContain('POST');
    expect(actual.headers.get('vary')).toContain('Origin'); expect(actual.res.statusCode).toBe(204); expect(actual.end).toHaveBeenCalled();
  });
  it.each(['https://evil.test', 'https://admin.example.test.evil.test', 'http://admin.example.test', 'null'])('never grants browser access to %s', origin => {
    expect(run(origin).headers.has('access-control-allow-origin')).toBe(false);
    expect(run(origin, 'OPTIONS').headers.has('access-control-allow-origin')).toBe(false);
  });
  it('retains ordinary same-server and collector requests without an Origin header', () => {
    const actual = run(undefined); expect(actual.next).toHaveBeenCalledOnce(); expect(actual.headers.has('access-control-allow-origin')).toBe(false);
  });
});
