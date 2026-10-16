import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { redirect as nativeRedirect } from 'wasp/server/utils';
import { createJWT, TimeSpan } from 'wasp/auth/jwt';

const injected = vi.hoisted(() => ({ db: null as any }));
vi.mock('wasp/server', () => ({
  prisma: new Proxy({}, { get: (_, name) => injected.db[name] }),
  config: { auth: { jwtSecret: 'isolated-google-middleware-signing-key' } },
  HttpError: class extends Error { constructor(public statusCode: number, message: string) { super(message); } },
}));
// No provider request belongs in a routing test. Keep the real feature switch,
// but fail closed if a later middleware change unexpectedly requests userinfo.
vi.mock('../auth/google', async importOriginal => ({
  ...await importOriginal<typeof import('../auth/google')>(),
  readGoogleProfile: async () => { throw new Error('PROVIDER_NETWORK_FORBIDDEN_IN_ROUTING_TEST'); },
}));

const testUrl = process.env.SAAS_TEST_DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url: testUrl ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
const frontend = 'https://google-middleware.example.test';
const adminFrontend = 'https://admin-google-middleware.example.test';
const rateSecret = `google-middleware-${randomUUID()}`;
const principalHashes = new Set<string>(), userIds: string[] = [];
let server: Server | undefined, origin = '';
function principal(value: string = randomUUID()) {
  principalHashes.add(createHmac('sha256', rateSecret).update(value.replace(/^::ffff:/, '')).digest('hex'));
  return value;
}
function enabled(value: boolean) { vi.stubEnv('GOOGLE_AUTH_ENABLED', String(value)); }
function expectPrivate(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
}
async function request(path: string, options: { method?: string; body?: unknown; principal?: string; headers?: Record<string, string> } = {}) {
  return fetch(origin + path, {
    method: options.method ?? 'GET', redirect: 'manual',
    headers: { 'x-test-principal': principal(options.principal), 'content-type': 'application/json', ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  if (principalHashes.size) await db.rateLimitBucket.deleteMany({ where: { principalHash: { in: [...principalHashes] }, scope: { in: ['GOOGLE_START', 'GOOGLE_CALLBACK', 'GOOGLE_EXCHANGE'] } } });
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

describe.skipIf(!testUrl)('Google middleware with real Express, native Wasp redirects and PostgreSQL', () => {
  beforeEach(() => {
    vi.stubEnv('GOOGLE_AUTH_ENABLED', 'false');
    vi.stubEnv('GOOGLE_CLIENT_ID', 'routing-fixture.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'routing-fixture-not-a-real-provider-secret');
    vi.stubEnv('WASP_WEB_CLIENT_URL', frontend);
    vi.stubEnv('ADMIN_WEB_CLIENT_URL', '');
    vi.stubEnv('JWT_SECRET', 'isolated-admin-google-middleware-key-32');
    vi.stubEnv('RATE_LIMIT_HMAC_SECRET', rateSecret);
    vi.stubEnv('TRUSTED_PROXY_IPS', '');
  });
  beforeAll(async () => {
    injected.db = db;
    const { middlewareConfig } = await import('./middleware');
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: String(req.headers['x-test-principal']), configurable: true });
      next();
    });
    app.use(middlewareConfig(new Map()).get('saas.protection')!);
    // Deliberately visible native fallbacks prove that protection returns before
    // the framework route. Express also dispatches HEAD to these GET handlers.
    app.get('/auth/options', (_req, res) => res.setHeader('X-Native-Fallback', 'options').status(418).json({ native: true }));
    app.get('/auth/google/login', (req, res) => {
      res.setHeader('X-Native-Fallback', 'provider-start');
      if (req.query.app === 'admin') nativeRedirect(res, 'https://accounts.google.com/o/oauth2/v2/auth?state=native-fixture-state&code_challenge=native-fixture-pkce');
      else res.status(204).end();
    });
    app.get('/auth/google/callback', (req, res) => {
      res.setHeader('X-Native-Fallback', 'provider-callback');
      nativeRedirect(res, req.get('x-test-target') ?? `${frontend}/oauth/callback#synthetic.one-time.code`);
    });
    app.post('/auth/exchange-code', (_req, res) => res.setHeader('X-Native-Fallback', 'exchange').status(418).json({ sessionId: 'must-never-escape' }));
    await new Promise<void>((resolve, reject) => { server = app.listen(0, '127.0.0.1', (error?: Error) => error ? reject(error) : resolve()); });
    const address = server!.address();
    if (!address || typeof address === 'string') throw new Error('Test listener did not bind');
    origin = `http://127.0.0.1:${address.port}`;
  });

  it.each(['/auth/options', '/AUTH/OPTIONS/'])('serves feature options for GET and HEAD without a native fallback: %s', async path => {
    for (const on of [false, true]) {
      enabled(on);
      const get = await request(path);
      expect(get.status).toBe(200); expect(await get.json()).toEqual({ google: on }); expectPrivate(get);
      expect(get.headers.get('x-native-fallback')).toBeNull();
      const head = await request(path, { method: 'HEAD' });
      expect(head.status).toBe(200); expect(head.headers.get('content-type')).toContain('application/json');
      expect(await head.text()).toBe(''); expectPrivate(head);
      expect(head.headers.get('x-native-fallback')).toBeNull();
    }
  });

  it.each(['/auth/google/login', '/AUTH/GOOGLE/LOGIN/', '/auth/google/callback', '/AUTH/GOOGLE/CALLBACK/'])('blocks disabled Google GET and HEAD before the provider: %s', async path => {
    for (const method of ['GET', 'HEAD']) {
      const response = await request(path, { method });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(`${frontend}/login?oauth_error=GOOGLE_UNAVAILABLE`);
      expect(response.headers.get('x-native-fallback')).toBeNull(); expectPrivate(response);
    }
  });

  it.each(['/auth/google/login', '/AUTH/GOOGLE/LOGIN/'])('allows enabled GET and HEAD to reach the provider-start boundary: %s', async path => {
    enabled(true);
    for (const method of ['GET', 'HEAD']) {
      const response = await request(path, { method });
      expect(response.status).toBe(204); expect(response.headers.get('x-native-fallback')).toBe('provider-start'); expectPrivate(response);
    }
  });

  async function adminStartCookie() {
    enabled(true); vi.stubEnv('ADMIN_WEB_CLIENT_URL', adminFrontend);
    const response = await request('/auth/google/login?app=admin&returnTo=https://evil.test');
    expect(response.headers.get('location')).toBe('https://accounts.google.com/o/oauth2/v2/auth?state=native-fixture-state&code_challenge=native-fixture-pkce');
    const marker = response.headers.getSetCookie().find(value => value.startsWith('adthrender_google_target=') && !value.startsWith('adthrender_google_target=;'));
    expect(marker).toBeDefined(); expect(marker).toContain('HttpOnly'); expect(marker).toContain('SameSite=Lax'); expect(marker).not.toContain('evil.test');
    return marker!.split(';')[0];
  }
  it.each(['/auth/google/callback', '/AUTH/GOOGLE/CALLBACK/'])('returns a state-bound native callback only to configured admin origin: %s', async path => {
    const cookie = await adminStartCookie();
    const response = await request(path + '?state=native-fixture-state', { headers: { cookie } });
    expect(response.headers.get('location')).toBe(`${adminFrontend}/login/google/callback#synthetic.one-time.code`);
    expect(response.headers.get('x-native-fallback')).toBe('provider-callback'); expectPrivate(response);
    expect(response.headers.getSetCookie().some(value => value.startsWith('adthrender_google_target=;'))).toBe(true);
  });
  it('sanitizes a native Google provider cancellation on the signed admin client', async () => {
    const cookie = await adminStartCookie();
    const response = await request('/auth/google/callback?state=native-fixture-state', { headers: {
      cookie, 'x-test-target': `${frontend}/oauth/callback?error=access_denied:private-provider-details&token=private-provider-token`,
    } });
    expect(response.headers.get('location')).toBe(`${adminFrontend}/login?oauth_error=GOOGLE_SIGN_IN_FAILED`);
    expect(response.headers.get('location')).not.toMatch(/access_denied|private-provider|token/);
    expect(response.headers.get('x-native-fallback')).toBe('provider-callback'); expectPrivate(response);
    expect(response.headers.getSetCookie().some(value => value.startsWith('adthrender_google_target=;'))).toBe(true);
    expect(await response.text()).toBe('');
  });
  it.each(['wrong-state', 'tampered', 'duplicate', 'removed-config'])('blocks invalid admin target before native provider callback: %s', async scenario => {
    let cookie = await adminStartCookie();
    if (scenario === 'tampered') cookie += 'x';
    if (scenario === 'duplicate') cookie += '; ' + cookie;
    if (scenario === 'removed-config') vi.stubEnv('ADMIN_WEB_CLIENT_URL', '');
    const response = await request('/auth/google/callback?state=' + (scenario === 'wrong-state' ? 'other-native-state' : 'native-fixture-state'), { headers: { cookie } });
    expect(response.headers.get('location')).toBe(`${frontend}/login?oauth_error=GOOGLE_SIGN_IN_FAILED`);
    expect(response.headers.get('x-native-fallback')).toBeNull(); expectPrivate(response);
    expect(response.headers.getSetCookie().some(value => value.startsWith('adthrender_google_target=;'))).toBe(true);
  });
  it('retains customer redirects without a signed admin marker and ignores callback app/returnTo', async () => {
    enabled(true); vi.stubEnv('ADMIN_WEB_CLIENT_URL', adminFrontend);
    const response = await request('/auth/google/callback?app=admin&returnTo=https://evil.test');
    expect(response.headers.get('location')).toBe(`${frontend}/login/google/callback#synthetic.one-time.code`);
  });
  it('keeps Google disabled messages on the chosen client and creates no provider request', async () => {
    const cookie = await adminStartCookie(); enabled(false);
    const callback = await request('/auth/google/callback?state=native-fixture-state', { headers: { cookie } });
    expect(callback.headers.get('location')).toBe(`${adminFrontend}/login?oauth_error=GOOGLE_UNAVAILABLE`);
    expect(callback.headers.get('x-native-fallback')).toBeNull();
    const start = await request('/auth/google/login?app=admin&returnTo=https://evil.test');
    expect(start.headers.get('location')).toBe(`${adminFrontend}/login?oauth_error=GOOGLE_UNAVAILABLE`);
    expect(start.headers.get('x-native-fallback')).toBeNull();
  });

  it.each(['/auth/exchange-code', '/AUTH/EXCHANGE-CODE/'])('never delegates disabled or invalid exchange requests to native Wasp: %s', async path => {
    const disabled = await request(path, { method: 'POST', body: { code: 'untrusted-code' } });
    expect(disabled.status).toBe(403); expect(await disabled.json()).toEqual({ message: 'GOOGLE_UNAVAILABLE' });
    expect(disabled.headers.get('x-native-fallback')).toBeNull(); expectPrivate(disabled);
    enabled(true);
    const invalid = await request(path, { method: 'POST', body: { code: 'untrusted-code' } });
    expect(invalid.status).toBe(401); expect(await invalid.json()).toEqual({ message: 'GOOGLE_SIGN_IN_FAILED' });
    expect(invalid.headers.get('x-native-fallback')).toBeNull(); expectPrivate(invalid);
  });

  it('rejects a validly signed code for a disabled account at the HTTP boundary', async () => {
    enabled(true);
    const email = `google-middleware-${randomUUID()}@example.test`;
    const user = await db.user.create({ data: { email, disabledAt: new Date(), auth: { create: { identities: { create: {
      providerName: 'google', providerUserId: randomUUID(), providerData: JSON.stringify({ admitted: true, verifiedEmail: email, version: 1 }),
    } } } } }, include: { auth: true } });
    userIds.push(user.id);
    const code = await createJWT({ id: user.auth!.id }, { expiresIn: new TimeSpan(1, 'm') });
    const response = await request('/AUTH/EXCHANGE-CODE/', { method: 'POST', body: { code } });
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ message: 'GOOGLE_SIGN_IN_FAILED' });
    expect(response.headers.get('x-native-fallback')).toBeNull(); expectPrivate(response);
    expect(await db.session.count({ where: { userId: user.auth!.id } })).toBe(0);
    expect(await db.oAuthCodeUse.count({ where: { userId: user.id } })).toBe(0);
  });

  it.each(['GET', 'HEAD'])('rewrites native Wasp Location headers to the fixed callback page for %s', async method => {
    enabled(true);
    const response = await request('/AUTH/GOOGLE/CALLBACK/', { method });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${frontend}/login/google/callback#synthetic.one-time.code`);
    expect(response.headers.get('x-native-fallback')).toBe('provider-callback'); expectPrivate(response);
    expect(await response.text()).toBe('');
  });

  it.each([
    [`${frontend}/oauth/callback?error=INVITATION_REQUIRED:private-provider-detail`, 'INVITATION_REQUIRED'],
    [`${frontend}/oauth/callback?error=Validation%20failed:%20EMAIL_ACCOUNT_EXISTS`, 'EMAIL_ACCOUNT_EXISTS'],
    [`${frontend}/oauth/callback?error=untrusted-private-detail`, 'GOOGLE_SIGN_IN_FAILED'],
    ['https://untrusted.example.test/oauth/callback#private-code', 'GOOGLE_SIGN_IN_FAILED'],
    [`${frontend}/wrong-path#private-code`, 'GOOGLE_SIGN_IN_FAILED'],
    [`${frontend}/oauth/callback?next=untrusted#private-code`, 'GOOGLE_SIGN_IN_FAILED'],
  ])('maps the native redirect to a safe same-origin error page: %s', async (target, expected) => {
    enabled(true);
    const response = await request('/auth/google/callback', { headers: { 'x-test-target': target } });
    expect(response.status).toBe(302); expect(response.headers.get('location')).toBe(`${frontend}/login?oauth_error=${expected}`);
    expectPrivate(response); expect(await response.text()).toBe('');
  });

  it.each([
    ['/AUTH/GOOGLE/LOGIN/', 'GET', 'GOOGLE_START', 204],
    ['/AUTH/GOOGLE/CALLBACK/', 'HEAD', 'GOOGLE_CALLBACK', 302],
    ['/AUTH/EXCHANGE-CODE/', 'POST', 'GOOGLE_EXCHANGE', 401],
  ] as const)('enforces the Google-specific 30-request PostgreSQL boundary: %s', async (path, method, scope, allowedStatus) => {
    enabled(true);
    // Avoid crossing a real fixed-window boundary during these 31 local calls.
    const remaining = 60_000 - Date.now() % 60_000;
    if (remaining < 1500) await new Promise(resolve => setTimeout(resolve, remaining + 10));
    const address = principal();
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await request(path, { method, principal: address, ...(method === 'POST' ? { body: { code: 'invalid' } } : {}) });
      expect(response.status).toBe(allowedStatus);
    }
    const blocked = await request(path, { method, principal: address, ...(method === 'POST' ? { body: { code: 'invalid' } } : {}) });
    expectPrivate(blocked); expect(blocked.headers.get('x-native-fallback')).toBeNull();
    if (method === 'POST') {
      expect(blocked.status).toBe(429); expect(await blocked.json()).toEqual({ message: 'RATE_LIMITED' });
    } else {
      expect(blocked.status).toBe(302); expect(blocked.headers.get('location')).toBe(`${frontend}/login?oauth_error=GOOGLE_SIGN_IN_FAILED`);
    }
    const rows = await db.rateLimitBucket.findMany({ where: { scope, principalHash: createHmac('sha256', rateSecret).update(address).digest('hex') } });
    expect(rows).toHaveLength(1); expect(rows[0].count).toBe(31);
  });

  it('does not let forged forwarding headers escape the Google exchange IP bucket', async () => {
    enabled(true); vi.stubEnv('TRUSTED_PROXY_IPS', '172.18.0.1');
    const address = `10.${[...randomBytes(3)].join('.')}`;
    const remaining = 60_000 - Date.now() % 60_000;
    if (remaining < 1500) await new Promise(resolve => setTimeout(resolve, remaining + 10));
    for (let attempt = 0; attempt < 30; attempt++) {
      expect((await request('/auth/exchange-code', { method: 'POST', body: { code: 'invalid' }, principal: address,
        headers: { 'x-real-ip': `192.0.2.${attempt + 1}`, 'x-forwarded-for': `198.51.100.${attempt + 1}` },
      })).status).toBe(401);
    }
    const blocked = await request('/auth/exchange-code', { method: 'POST', body: { code: 'invalid' }, principal: address,
      headers: { 'x-real-ip': '192.0.2.99', 'x-forwarded-for': '198.51.100.99' },
    });
    expect(blocked.status).toBe(429); expect(await blocked.json()).toEqual({ message: 'RATE_LIMITED' });
  });
});
