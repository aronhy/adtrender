import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { issueAuthLink } from '../auth/links';

const injected = vi.hoisted(() => ({ db: null as unknown, email: '' }));
// Only the Wasp global-client binding is injected. Express routing, Wasp's
// password validator, PostgreSQL and the production middleware remain real.
vi.mock('wasp/server', () => ({
  prisma: injected.db,
  HttpError: class extends Error { constructor(public statusCode: number, message: string) { super(message); } },
}));
vi.mock('wasp/auth/jwt', () => ({ validateJWT: async () => ({ email: injected.email }) }));
const testUrl = process.env.SAAS_TEST_DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url: testUrl ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
const key = 'c'.repeat(64), nativeToken = 'native.signed.framework-token';
let server: Server | undefined;
let origin = '';
let originalKey: string | undefined;
let originalTrustedProxyIps: string | undefined;

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  if (originalKey === undefined) delete process.env.OUTBOX_ENCRYPTION_KEY;
  else process.env.OUTBOX_ENCRYPTION_KEY = originalKey;
  if (originalTrustedProxyIps === undefined) delete process.env.TRUSTED_PROXY_IPS;
  else process.env.TRUSTED_PROXY_IPS = originalTrustedProxyIps;
  await db.$disconnect();
});

describe.skipIf(!testUrl)('auth protection with real Express routing and PostgreSQL', () => {
  beforeAll(async () => {
    injected.db = db;
    originalKey = process.env.OUTBOX_ENCRYPTION_KEY;
    originalTrustedProxyIps = process.env.TRUSTED_PROXY_IPS;
    delete process.env.TRUSTED_PROXY_IPS;
    process.env.OUTBOX_ENCRYPTION_KEY = key;
    const { middlewareConfig } = await import('./middleware');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // Namespace each case's rate bucket without touching another test/agent.
      Object.defineProperty(req.socket, 'remoteAddress', { value: String(req.headers['x-test-principal']), configurable: true });
      next();
    });
    app.use(middlewareConfig(new Map()).get('saas.protection')!);
    app.post(['/auth/email/reset-password', '/auth/email/verify-email'], (req, res) => res.status(req.body.token === nativeToken ? 204 : 400).end());
    app.post('/auth/email/login', (_req, res) => res.status(204).end());
    await new Promise<void>((resolve, reject) => { server = app.listen(0, '127.0.0.1', (error?: Error) => error ? reject(error) : resolve()); });
    const address = server!.address();
    if (!address || typeof address === 'string') throw new Error('Test listener did not bind');
    origin = `http://127.0.0.1:${address.port}`;
  });
  async function post(path: string, body: object, principal: string = randomUUID(), headers: Record<string, string> = {}) {
    return fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-principal': principal, ...headers }, body: JSON.stringify(body) });
  }
  async function inRateWindow(run: () => Promise<void>) {
    // A real HTTP sequence can cross a minute boundary. Keep Date in one
    // bucket while leaving socket, timeout and other Node timers real.
    const middle = Math.floor(Date.now() / 60_000) * 60_000 + 30_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(middle));
    try { await run(); } finally { vi.useRealTimers(); }
  }

  it.each(['/auth/email/reset-password', '/auth/email/reset-password/', '/auth/email/RESET-PASSWORD', '/AUTH/EMAIL/VERIFY-EMAIL/'])('requires an opaque link on Express-compatible route %s', async (path) => {
    const response = await post(path, { token: nativeToken, password: 'StrongPass123!' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: 'AUTH_LINK_INVALID' });
  });

  it('returns the invitation requirement before creating an uninvited account or email', async () => {
    const email = `uninvited-${randomUUID()}@example.test`;
    vi.stubEnv('REGISTRATION_MODE', 'invite');
    vi.stubEnv('REGISTRATION_ALLOWLIST', '');
    try {
      const response = await post('/auth/email/signup', { email, password: 'StrongPass123!' });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ message: 'INVITATION_REQUIRED' });
      expect(await db.user.count({ where: { email } })).toBe(0);
      expect(await db.emailDelivery.count({ where: { recipientEmail: email } })).toBe(0);
    } finally { vi.unstubAllEnvs(); }
  });

  it('applies identity login limits to case and trailing-slash variants', () => inRateWindow(async () => {
    const email = `${randomUUID()}@example.test`, principal = randomUUID();
    for (let attempt = 0; attempt < 10; attempt++) expect((await post('/auth/email/LOGIN/', { email, password: 'StrongPass123!' }, principal)).status).toBe(204);
    expect((await post('/auth/email/LOGIN/', { email, password: 'StrongPass123!' }, principal)).status).toBe(429);
  }));

  it('keeps separate PostgreSQL rate buckets for clients behind one trusted proxy', () => inRateWindow(async () => {
    const proxy = `10.${[...randomBytes(3)].join('.')}`;
    process.env.TRUSTED_PROXY_IPS = proxy;
    const client = `10.${[...randomBytes(3)].join('.')}`;
    try {
      for (let attempt = 0; attempt < 30; attempt++) expect((await post('/auth/email/login', {}, `::ffff:${proxy}`, { 'x-real-ip': client })).status).toBe(204);
      expect((await post('/auth/email/login', {}, proxy, { 'x-real-ip': client })).status).toBe(429);
      expect((await post('/auth/email/login', {}, proxy, { 'x-real-ip': `10.${[...randomBytes(3)].join('.')}` })).status).toBe(204);
    } finally { delete process.env.TRUSTED_PROXY_IPS; }
  }));

  it('cannot evade the direct-connection PostgreSQL rate bucket with forged forwarding headers', () => inRateWindow(async () => {
    const principal = `10.${[...randomBytes(3)].join('.')}`;
    process.env.TRUSTED_PROXY_IPS = '172.18.0.1';
    try {
      for (let attempt = 0; attempt < 30; attempt++) expect((await post('/auth/email/login', {}, principal, { 'x-real-ip': `192.0.2.${attempt + 1}`, 'x-forwarded-for': `198.51.100.${attempt + 1}` })).status).toBe(204);
      expect((await post('/auth/email/login', {}, principal, { 'x-real-ip': '192.0.2.99', 'x-forwarded-for': '198.51.100.99' })).status).toBe(429);
    } finally { delete process.env.TRUSTED_PROXY_IPS; }
  }));

  it('validates passwords before consumption and invalidates only the reset account sessions once', async () => {
    const email = `${randomUUID()}@example.test`;
    const user = await db.user.create({ data: { email, auth: { create: { identities: { create: { providerName: 'email', providerUserId: email, providerData: JSON.stringify({ hashedPassword: 'fixture-hash', isEmailVerified: false }) } } } } } });
    const auth = await db.auth.findUniqueOrThrow({ where: { userId: user.id } });
    injected.email = email;
    const session = await db.session.create({ data: { id: randomUUID(), userId: auth.id, expiresAt: new Date(Date.now() + 3_600_000) } });
    const otherUser = await db.user.create({ data: { email: `${randomUUID()}@example.test` } });
    const otherAuth = await db.auth.create({ data: { userId: otherUser.id } });
    const otherSession = await db.session.create({ data: { id: randomUUID(), userId: otherAuth.id, expiresAt: new Date(Date.now() + 3_600_000) } });
    const token = await issueAuthLink(db, { email, purpose: 'RESET', frameworkToken: nativeToken, key });
    expect((await post('/auth/email/RESET-PASSWORD/', { token, password: 'short' })).status).toBe(400);
    expect(await db.session.findUnique({ where: { id: session.id } })).not.toBeNull();
    expect((await post('/auth/email/RESET-PASSWORD/', { token, password: 'StrongPass123!' })).status).toBe(200);
    expect(await db.session.findUnique({ where: { id: session.id } })).toBeNull();
    expect(await db.session.findUnique({ where: { id: otherSession.id } })).not.toBeNull();
    expect((await post('/auth/email/reset-password', { token, password: 'StrongPass123!' })).status).toBe(400);
  });

  it('does not let a verification envelope reset a password and consumes verification once', async () => {
    const email = `${randomUUID()}@example.test`;
    await db.user.create({ data: { email, auth: { create: { identities: { create: { providerName: 'email', providerUserId: email, providerData: JSON.stringify({ hashedPassword: 'fixture-hash', isEmailVerified: false }) } } } } } });
    injected.email = email;
    const token = await issueAuthLink(db, { email, purpose: 'VERIFY', frameworkToken: nativeToken, key });
    expect((await post('/auth/email/reset-password', { token, password: 'StrongPass123!' })).status).toBe(400);
    expect((await post('/auth/email/verify-email/', { token })).status).toBe(200);
    expect((await post('/auth/email/verify-email/', { token })).status).toBe(400);
  });
});
