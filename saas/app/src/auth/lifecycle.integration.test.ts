import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from 'wasp/auth/password';
import { completeAuthLink, registerEmailAccount, requestAuthEmail } from './lifecycle';
import { issueAuthLink } from './links';
import { decryptMessage } from '../server/email';
import { onBeforeLogin, onAfterLogin } from './hooks';

const injected = vi.hoisted(() => ({ db: null as any }));
// Only bind Wasp's global client/config to the isolated database; its JWT,
// password serializer, createUser and password verification are the real SDK.
vi.mock('wasp/server', () => ({
  prisma: new Proxy({}, { get: (_, name) => injected.db[name] }),
  config: { auth: { jwtSecret: 'local-review-jwt-key-never-for-production' }, frontendUrl: 'https://app.example.test' },
  HttpError: class extends Error { constructor(public statusCode: number, message: string) { super(message); } },
}));
const testUrl = process.env.SAAS_TEST_DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url: testUrl ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
const key = 'e'.repeat(64), password = 'Local-Review-Password-42', newPassword = 'New-Review-Password-72';
const origin = 'https://app.example.test';
const recipients = new Set<string>();
async function fixture() {
  const email = `auth-review-${randomUUID()}@example.test`;
  recipients.add(email);
  const user = await db.user.create({ data: { email, auth: { create: { identities: { create: { providerName: 'email', providerUserId: email, providerData: JSON.stringify({ hashedPassword: await hashPassword(password), isEmailVerified: true, emailVerificationSentAt: new Date(0).toISOString(), passwordResetSentAt: null }) } } } } }, include: { auth: true } });
  return { email, user, authId: user.auth!.id };
}
async function link(email: string, purpose: 'RESET'|'VERIFY') {
  const { createJWT, TimeSpan } = await import('wasp/auth/jwt');
  return issueAuthLink(db, { email, purpose, frameworkToken: await createJWT({ email }, { expiresIn: new TimeSpan(30, 'm') }), key });
}
async function nativeSession(authId: string) { return db.session.create({ data: { id: randomUUID(), userId: authId, expiresAt: new Date(Date.now() + 3_600_000) } }); }
afterAll(async () => {
  if (recipients.size) await db.emailDelivery.deleteMany({ where: { recipientEmail: { in: [...recipients] } } });
  await db.$disconnect();
});
describe.skipIf(!testUrl)('Wasp identity lifecycle and concurrent password reset', () => {
  beforeAll(() => { injected.db = db; });
  it('does not replace an unverified identity on sequential or concurrent repeated signup', async () => {
    const email = `signup-review-${randomUUID()}@example.test`;
    recipients.add(email);
    await registerEmailAccount(db, { email, password, key, origin });
    const before = await db.authIdentity.findUniqueOrThrow({ where: { providerName_providerUserId: { providerName: 'email', providerUserId: email } } });
    const firstMail = await db.emailDelivery.findFirstOrThrow({ where: { recipientEmail: email }, orderBy: { createdAt: 'asc' } });
    const opaque = decryptMessage(firstMail.encryptedPayload!, key).text.match(/token=([a-f\d]{64})/)![1];
    await Promise.all([1, 2].map(() => registerEmailAccount(db, { email, password: newPassword, key, origin })));
    const after = await db.authIdentity.findUniqueOrThrow({ where: { providerName_providerUserId: { providerName: 'email', providerUserId: email } } });
    expect(after.authId).toBe(before.authId); expect(JSON.parse(after.providerData).hashedPassword).toBe(JSON.parse(before.providerData).hashedPassword);
    expect(await db.emailDelivery.count({ where: { recipientEmail: email, templateKey: 'RESET' } })).toBe(1);
    await completeAuthLink(db, { token: opaque, purpose: 'VERIFY', key });
    await expect(verifyPassword(JSON.parse(after.providerData).hashedPassword, newPassword)).rejects.toThrow();
    await expect(verifyPassword(JSON.parse(after.providerData).hashedPassword, password)).resolves.toBeUndefined();
  });
  it('creates a single Wasp identity for concurrent first signup and lets its mailbox owner choose a password', async () => {
    const email = `parallel-signup-${randomUUID()}@example.test`;
    recipients.add(email);
    await Promise.all([password, newPassword].map(candidate => registerEmailAccount(db, { email, password: candidate, key, origin })));
    expect(await db.user.count({ where: { email } })).toBe(1);
    expect(await db.authIdentity.count({ where: { providerName: 'email', providerUserId: email } })).toBe(1);
    const reset = await db.emailDelivery.findFirstOrThrow({ where: { recipientEmail: email, templateKey: 'RESET' } });
    const opaque = decryptMessage(reset.encryptedPayload!, key).text.match(/token=([a-f\d]{64})/)![1];
    await completeAuthLink(db, { token: opaque, purpose: 'RESET', key, password: newPassword });
    const identity = await db.authIdentity.findUniqueOrThrow({ where: { providerName_providerUserId: { providerName: 'email', providerUserId: email } } });
    await expect(verifyPassword(JSON.parse(identity.providerData).hashedPassword, newPassword)).resolves.toBeUndefined();
  });
  it('rejects an envelope whose original Wasp identity was deleted and recreated with the same email', async () => {
    const f = await fixture(); const token = await link(f.email, 'VERIFY');
    await db.user.delete({ where: { id: f.user.id } });
    await db.user.create({ data: { email: f.email, auth: { create: { identities: { create: { providerName: 'email', providerUserId: f.email, providerData: JSON.stringify({ hashedPassword: await hashPassword(newPassword), isEmailVerified: false }) } } } } } });
    await expect(completeAuthLink(db, { token, purpose: 'VERIFY', key })).rejects.toMatchObject({ code: 'AUTH_LINK_INVALID' });
    expect((await db.authLink.findFirstOrThrow({ where: { recipientEmail: f.email } })).consumedAt).toBeNull();
  });
  it('does not consume a link when native JWT validation or identity persistence fails', async () => {
    const f = await fixture(); const token = await link(f.email, 'RESET');
    await expect(completeAuthLink(db, { token, purpose: 'RESET', key, password: newPassword }, { create: async () => '', validate: async () => ({ email: 'another@example.test' }) })).rejects.toMatchObject({ code: 'AUTH_LINK_INVALID' });
    const failing = { $transaction: (fn: any, options: any) => db.$transaction(tx => fn(new Proxy(tx, { get: (target, name) => name === 'authIdentity' ? { ...target.authIdentity, update: async () => { throw new Error('IDENTITY_WRITE_FAILED'); } } : (target as any)[name] })), options) } as any;
    await expect(completeAuthLink(failing, { token, purpose: 'RESET', key, password: newPassword })).rejects.toThrow('IDENTITY_WRITE_FAILED');
    expect((await db.authLink.findFirstOrThrow({ where: { recipientEmail: f.email } })).consumedAt).toBeNull();
    await expect(completeAuthLink(db, { token, purpose: 'RESET', key, password: newPassword })).resolves.toEqual({ success: true });
  });
  it('rejects old links after password replacement and atomically revokes current sessions', async () => {
    const f = await fixture(); const first = await link(f.email, 'RESET'), second = await link(f.email, 'RESET');
    const session = await nativeSession(f.authId);
    await completeAuthLink(db, { token: first, purpose: 'RESET', key, password: newPassword });
    expect(await db.session.findUnique({ where: { id: session.id } })).toBeNull();
    await expect(completeAuthLink(db, { token: second, purpose: 'RESET', key, password })).rejects.toMatchObject({ code: 'AUTH_LINK_INVALID' });
    expect((await db.authLink.findMany({ where: { recipientEmail: f.email, consumedAt: null } }))).toHaveLength(1);
  });
  it('rolls password mutation and link consumption back if session revocation cannot persist', async () => {
    const f = await fixture(), token = await link(f.email, 'RESET'), session = await nativeSession(f.authId);
    const failing = { $transaction: (fn: any, options: any) => db.$transaction(tx => fn(new Proxy(tx, { get: (target, name) => name === 'session' ? { deleteMany: async () => { throw new Error('SESSION_REVOKE_FAILED'); } } : (target as any)[name] })), options) } as any;
    await expect(completeAuthLink(failing, { token, purpose: 'RESET', key, password: newPassword })).rejects.toThrow('SESSION_REVOKE_FAILED');
    expect((await db.authLink.findFirstOrThrow({ where: { recipientEmail: f.email } })).consumedAt).toBeNull();
    expect(await db.session.findUnique({ where: { id: session.id } })).not.toBeNull();
    const identity = await db.authIdentity.findUniqueOrThrow({ where: { providerName_providerUserId: { providerName: 'email', providerUserId: f.email } } });
    await expect(verifyPassword(JSON.parse(identity.providerData).hashedPassword, password)).resolves.toBeUndefined();
  });
  it('rejects a login that verified the old password before reset but inserts its session afterwards', async () => {
    const f = await fixture(); const token = await link(f.email, 'RESET');
    const req = { body: { password } } as any, providerId = { providerName: 'email', providerUserId: f.email } as const;
    await onBeforeLogin({ req, providerId, user: f.user, prisma: db } as any);
    let unlock!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; }), started = new Promise<void>(resolve => { locked = resolve; });
    const resetting = completeAuthLink(db, { token, purpose: 'RESET', key, password: newPassword }, { create: async () => '', validate: async () => { locked(); await gate; return { email: f.email }; } });
    await started;
    let inserted = false; const creating = nativeSession(f.authId).then(row => { inserted = true; return row; });
    await new Promise(resolve => setTimeout(resolve, 60)); expect(inserted).toBe(false);
    unlock(); await resetting; await creating;
    await expect(onAfterLogin({ req, providerId, user: f.user, prisma: db } as any)).rejects.toMatchObject({ statusCode: 401 });
    await expect(onBeforeLogin({ req: { body: { password } }, providerId, user: f.user, prisma: db } as any)).rejects.toMatchObject({ statusCode: 401 });
  });
  it('resends verification without replacing credentials and returns the same response for absent accounts', async () => {
    const f = await fixture();
    const identity = await db.authIdentity.findUniqueOrThrow({ where: { providerName_providerUserId: { providerName: 'email', providerUserId: f.email } } });
    const data = JSON.parse(identity.providerData); data.isEmailVerified = false;
    await db.authIdentity.update({ where: { providerName_providerUserId: { providerName: 'email', providerUserId: f.email } }, data: { providerData: JSON.stringify(data) } });
    expect(await requestAuthEmail(db, { email: f.email, purpose: 'VERIFY', key, origin })).toEqual(await requestAuthEmail(db, { email: `absent-${randomUUID()}@example.test`, purpose: 'VERIFY', key, origin }));
    await requestAuthEmail(db, { email: f.email, purpose: 'VERIFY', key, origin });
    expect(await db.emailDelivery.count({ where: { recipientEmail: f.email } })).toBe(1);
    const current = await db.authIdentity.findUniqueOrThrow({ where: { providerName_providerUserId: { providerName: 'email', providerUserId: f.email } } });
    expect(current.authId).toBe(identity.authId); expect(JSON.parse(current.providerData).hashedPassword).toBe(data.hashedPassword);
  });
  it('allows a current verified credential through both native login hooks', async () => {
    const f = await fixture(), req = { body: { password } } as any, providerId = { providerName: 'email', providerUserId: f.email } as const;
    await onBeforeLogin({ req, providerId, user: f.user, prisma: db } as any);
    await nativeSession(f.authId);
    await expect(onAfterLogin({ req, providerId, user: f.user, prisma: db } as any)).resolves.toBeUndefined();
  });
});
