import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createJWT, TimeSpan } from 'wasp/auth/jwt';
import { completeOAuthCode } from './oauth-exchange';
import { lockAccountAdministration } from '../team/access';
import { setUserDisabled } from '../team/admin';

const injected = vi.hoisted(() => ({ db: null as any }));
// Replace only Wasp's process-global database/config. JWT signing/verification
// and the native session reader remain the real installed framework code.
vi.mock('wasp/server', () => ({
  prisma: new Proxy({}, { get: (_, name) => injected.db[name] }),
  config: { auth: { jwtSecret: 'isolated-oauth-exchange-test-signing-key' } },
}));
const testUrl = process.env.SAAS_TEST_DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url: testUrl ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
const otherProcess = new PrismaClient({ datasources: { db: { url: testUrl ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
const userIds: string[] = [];
async function fixture(options: { disabled?: boolean; provider?: string; data?: unknown; admin?: boolean } = {}) {
  const email = `oauth-exchange-${randomUUID()}@example.test`;
  const user = await db.user.create({ data: {
    email, isAdmin: options.admin ?? false, disabledAt: options.disabled ? new Date() : null,
    auth: { create: { identities: { create: {
      providerName: options.provider ?? 'google', providerUserId: randomUUID(),
      providerData: JSON.stringify(options.data ?? { version: 1, admitted: true, verifiedEmail: email }),
    } } } },
  }, include: { auth: true } });
  userIds.push(user.id);
  return { user, authId: user.auth!.id };
}
async function codeFor(authId: string) { return createJWT({ id: authId }, { expiresIn: new TimeSpan(1, 'm') }); }
function hash(code: string) { return createHash('sha256').update(code).digest('hex'); }
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function expectRejected(code: unknown) {
  await expect(completeOAuthCode(db, { code })).rejects.toMatchObject({ status: 401, code: 'GOOGLE_SIGN_IN_FAILED' });
}
afterAll(async () => {
  if (userIds.length) {
    await db.auditEvent.deleteMany({ where: { OR: [{ actorUserId: { in: userIds } }, { targetId: { in: userIds } }] } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await Promise.all([db.$disconnect(), otherProcess.$disconnect()]);
});

describe.skipIf(!testUrl)('atomic Wasp Google code exchange', () => {
  beforeAll(() => { injected.db = db; });

  it('returns a session accepted by Wasp and persists only a bounded hash receipt', async () => {
    const f = await fixture(), code = await codeFor(f.authId), started = Date.now();
    const result = await completeOAuthCode(db, { code });
    const session = await db.session.findUniqueOrThrow({ where: { id: result.sessionId } });
    expect(result.sessionId).toMatch(/^[a-z2-7]{40}$/);
    expect(session.userId).toBe(f.authId);
    expect(session.expiresAt.getTime() - started).toBeGreaterThanOrEqual(30 * 86_400_000);
    expect(session.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 86_400_000);
    const { getSessionAndUserFromSessionId } = await import('wasp/auth/session');
    const native = await getSessionAndUserFromSessionId(result.sessionId);
    expect(native?.user.id).toBe(f.user.id);
    const receipt = await db.oAuthCodeUse.findUniqueOrThrow({ where: { tokenHash: hash(code) } });
    expect(receipt).toMatchObject({ authId: f.authId, userId: f.user.id, source: 'GOOGLE' });
    expect(receipt.expiresAt.getTime()).toBe(JSON.parse(Buffer.from(code.split('.')[1], 'base64url').toString()).exp * 1000);
    expect(JSON.stringify(receipt)).not.toContain(code);
  });

  it('rejects replay through a new database client and creates exactly one session', async () => {
    const f = await fixture(), code = await codeFor(f.authId);
    await completeOAuthCode(db, { code });
    await expect(completeOAuthCode(otherProcess, { code })).rejects.toMatchObject({ code: 'GOOGLE_SIGN_IN_FAILED' });
    expect(await db.session.count({ where: { userId: f.authId } })).toBe(1);
  });

  it('allows only one winner when separate clients concurrently exchange the same code', async () => {
    const f = await fixture(), code = await codeFor(f.authId);
    const attempts = await Promise.allSettled([completeOAuthCode(db, { code }), completeOAuthCode(otherProcess, { code })]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await db.session.count({ where: { userId: f.authId } })).toBe(1);
    expect(await db.oAuthCodeUse.count({ where: { userId: f.user.id } })).toBe(1);
  });

  it('rejects altered signatures and alternate base64url encodings of an already-used signature', async () => {
    const f = await fixture(), code = await codeFor(f.authId), pieces = code.split('.');
    const tampered = `${pieces[0]}.${Buffer.from(JSON.stringify({ id: randomUUID(), exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url')}.${pieces[2]}`;
    await expectRejected(tampered);
    await completeOAuthCode(db, { code });
    await expectRejected(`${code}=`);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(code.at(-1)!);
    await expectRejected(code.slice(0, -1) + alphabet[last + 1]);
    expect(await db.session.count({ where: { userId: f.authId } })).toBe(1);
  });

  it('rejects missing, malformed, expired, unbounded and non-OAuth claims without consuming anything', async () => {
    const f = await fixture();
    for (const code of [undefined, null, 1, {}, '', 'x'.repeat(4097),
      await createJWT({ id: f.authId }, {}),
      await createJWT({ id: f.authId, exp: Math.floor(Date.now() / 1000) - 1 }, {}),
      await createJWT({ id: f.authId }, { expiresIn: new TimeSpan(30, 'm') }),
      await createJWT({ email: f.user.email }, { expiresIn: new TimeSpan(1, 'm') }),
    ]) await expectRejected(code);
    expect(await db.session.count({ where: { userId: f.authId } })).toBe(0);
    expect(await db.oAuthCodeUse.count({ where: { userId: f.user.id } })).toBe(0);
  });

  it.each([
    { disabled: true }, { provider: 'email' }, { data: {} },
    { data: { version: 1, admitted: false, verifiedEmail: 'wrong@example.test' } },
    { data: { version: 1, admitted: true, verifiedEmail: 'wrong@example.test' } },
    { data: { version: 2, admitted: true, verifiedEmail: 'wrong@example.test' } },
  ])('rejects disabled, non-Google or unadmitted identity %#', async options => {
    const f = await fixture(options), code = await codeFor(f.authId);
    await expectRejected(code);
    expect(await db.session.count({ where: { userId: f.authId } })).toBe(0);
    expect(await db.oAuthCodeUse.count({ where: { userId: f.user.id } })).toBe(0);
  });

  it('does not transfer an old code to a replacement identity at the same email', async () => {
    const f = await fixture(), code = await codeFor(f.authId);
    await db.auth.delete({ where: { id: f.authId } });
    const replacement = await db.auth.create({ data: { userId: f.user.id, identities: { create: { providerName: 'google', providerUserId: randomUUID(), providerData: JSON.stringify({ version: 1, admitted: true, verifiedEmail: f.user.email }) } } } });
    await expectRejected(code);
    expect(await db.session.count({ where: { userId: replacement.id } })).toBe(0);
  });

  it('rolls consumption back when session persistence fails, so a safe retry succeeds', async () => {
    const f = await fixture(), code = await codeFor(f.authId);
    const failing = { $transaction: (fn: any, options: any) => db.$transaction(tx => fn(new Proxy(tx, {
      get: (target, name) => name === 'session' ? { ...target.session, create: async () => { throw new Error('private-database-detail'); } } : (target as any)[name],
    })), options) } as PrismaClient;
    await expect(completeOAuthCode(failing, { code })).rejects.toMatchObject({ code: 'GOOGLE_SIGN_IN_FAILED', message: 'Google 登录失败，请重新登录。' });
    expect(await db.oAuthCodeUse.findUnique({ where: { tokenHash: hash(code) } })).toBeNull();
    expect(await db.session.count({ where: { userId: f.authId } })).toBe(0);
    await expect(completeOAuthCode(db, { code })).resolves.toHaveProperty('sessionId');
  });

  it('checks the latest disabled state after waiting for account administration', async () => {
    const f = await fixture(), code = await codeFor(f.authId), held = gate(), release = gate();
    const disabling = db.$transaction(async tx => {
      await lockAccountAdministration(tx); held.release(); await release.promise;
      await tx.user.update({ where: { id: f.user.id }, data: { disabledAt: new Date() } });
    });
    await held.promise;
    const exchange = completeOAuthCode(otherProcess, { code });
    const rejected = expect(exchange).rejects.toMatchObject({ code: 'GOOGLE_SIGN_IN_FAILED' });
    release.release(); await disabling; await rejected;
    expect(await db.session.count({ where: { userId: f.authId } })).toBe(0);
  });

  it('lets a later real disable revoke a session whose exchange held the administration lock', async () => {
    const f = await fixture(), admin = await fixture({ admin: true }), code = await codeFor(f.authId), entered = gate(), release = gate();
    const pausing = { $transaction: (fn: any, options: any) => db.$transaction(tx => fn(new Proxy(tx, {
      get: (target, name) => name === 'session' ? { ...target.session, create: async (args: any) => { entered.release(); await release.promise; return target.session.create(args); } } : (target as any)[name],
    })), options) } as PrismaClient;
    const exchange = completeOAuthCode(pausing, { code }); await entered.promise;
    let disabled = false;
    const disabling = setUserDisabled(otherProcess, { actorUserId: admin.user.id, targetUserId: f.user.id, disabled: true, reason: 'isolated OAuth race regression' }).then(() => { disabled = true; });
    await new Promise(resolve => setTimeout(resolve, 50)); expect(disabled).toBe(false);
    release.release(); const result = await exchange; await disabling;
    expect(await db.session.findUnique({ where: { id: result.sessionId } })).toBeNull();
    await expectRejected(code);
  });

  it('rejects a code that expires while waiting for the lock', async () => {
    const f = await fixture(), exp = Math.floor(Date.now() / 1000) + 2;
    const code = await createJWT({ id: f.authId, exp }, {}), held = gate(), release = gate();
    const lock = db.$transaction(async tx => { await lockAccountAdministration(tx); held.release(); await release.promise; });
    await held.promise;
    const rejected = expect(completeOAuthCode(otherProcess, { code })).rejects.toMatchObject({ code: 'GOOGLE_SIGN_IN_FAILED' });
    await new Promise(resolve => setTimeout(resolve, Math.max(0, exp * 1000 - Date.now() + 30)));
    release.release(); await lock; await rejected;
    expect(await db.session.count({ where: { userId: f.authId } })).toBe(0);
  });
});
