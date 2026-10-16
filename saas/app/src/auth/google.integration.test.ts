import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser, validateAndGetUserFields } from 'wasp/auth/utils';
import { hashPassword } from 'wasp/auth/password';
import { getGoogleUserFields } from './google-signup';
import { onAfterLogin, onAfterSignup, onBeforeLogin, onBeforeSignup } from './hooks';

const injected = vi.hoisted(() => ({ db: null as any }));
// Keep Wasp's real field validation, nested User/Auth creation and passwords.
// Only its process-global database/config is bound to this isolated PostgreSQL.
vi.mock('wasp/server', async () => {
  const { PrismaClient } = await import('@prisma/client');
  injected.db = new PrismaClient({ datasources: { db: { url: process.env.SAAS_TEST_DATABASE_URL ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
  return {
    prisma: injected.db,
    config: { auth: { jwtSecret: 'local-google-admission-test-signing-key' } },
    HttpError: class extends Error {
      constructor(public statusCode: number, message: string, public data?: unknown) { super(message); }
    },
  };
});

const testUrl = process.env.SAAS_TEST_DATABASE_URL;
const db = injected.db as PrismaClient;
const userIds: string[] = [], organizationIds: string[] = [];
const password = 'Local-Google-Admission-42';
const profile = (overrides: Record<string, unknown> = {}) => ({
  sub: randomUUID(), email: `google-admission-${randomUUID()}@gmail.com`, email_verified: true, name: 'Google fixture', ...overrides,
});
type Fixture = Awaited<ReturnType<typeof googleUser>>;
const fetchMock = vi.fn<typeof fetch>();
function googleResponse(value: unknown) {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }));
}
function context(f: Fixture, req: object = { body: {} }) {
  // SDK OAuthData is generated from main.wasp.ts; this is solely a hook test
  // boundary and works both before and after the coordinated SDK regeneration.
  return { req, prisma: db, providerId: f.providerId, user: f.user,
    oauth: { providerName: 'google', uniqueRequestId: 'local-state', tokens: { accessToken: 'local-access-token' } } } as any;
}
async function googleUser(value = profile(), options: { admitted?: boolean; disabled?: boolean } = {}) {
  const email = value.email.toLowerCase(), providerId = { providerName: 'google', providerUserId: value.sub } as const;
  const user = await db.user.create({ data: {
    email, disabledAt: options.disabled ? new Date() : null,
    auth: { create: { identities: { create: { ...providerId,
      providerData: JSON.stringify(options.admitted ? { version: 1, admitted: true, verifiedEmail: email } : {}),
    } } } },
  }, include: { auth: true } });
  userIds.push(user.id);
  return { profile: value, user, providerId, authId: user.auth!.id };
}
async function nativeSignup(value = profile()) {
  const providerId = { providerName: 'google', providerUserId: value.sub } as const;
  const fields = await validateAndGetUserFields({ profile: value }, getGoogleUserFields);
  await onBeforeSignup({ providerId, req: { body: {} }, prisma: db } as any);
  const user = await createUser(providerId, '{}', fields);
  userIds.push(user.id);
  return { profile: value, providerId, user, authId: user.auth!.id };
}
async function identity(f: Pick<Fixture, 'providerId'>) {
  return db.authIdentity.findUniqueOrThrow({ where: { providerName_providerUserId: f.providerId } });
}
async function invitation(email: string) {
  const owner = await googleUser(profile(), { admitted: true });
  const organization = await db.organization.create({ data: {
    name: 'Google admission fixture', slug: `google-admission-${randomUUID()}`,
    members: { create: { userId: owner.user.id, role: 'OWNER' } },
  } });
  organizationIds.push(organization.id);
  const row = await db.invitation.create({ data: {
    email, organizationId: organization.id, invitedByUserId: owner.user.id,
    tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000),
  } });
  return { row, owner, organization };
}

afterAll(async () => {
  if (userIds.length || organizationIds.length) await db.$transaction(async tx => {
    await tx.invitation.deleteMany({ where: { organizationId: { in: organizationIds } } });
    await tx.organizationMember.deleteMany({ where: { organizationId: { in: organizationIds } } });
    await tx.organization.deleteMany({ where: { id: { in: organizationIds } } });
    await tx.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await db.$disconnect();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe.skipIf(!testUrl)('Google admission with native Wasp identities and PostgreSQL', () => {
  beforeEach(() => {
    vi.stubEnv('GOOGLE_AUTH_ENABLED', 'true');
    vi.stubEnv('GOOGLE_CLIENT_ID', 'local-fixture.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'local-fixture-never-a-real-secret');
    vi.stubEnv('REGISTRATION_MODE', 'invite');
    vi.stubEnv('REGISTRATION_ALLOWLIST', '');
    fetchMock.mockReset().mockRejectedValue(new Error('UNEXPECTED_NETWORK_ATTEMPT'));
    vi.stubGlobal('fetch', fetchMock);
  });

  it('fails closed when disabled, before creating an account or requesting userinfo', async () => {
    vi.stubEnv('GOOGLE_AUTH_ENABLED', 'false');
    const value = profile();
    await expect(nativeSignup(value)).rejects.toThrow();
    expect(await db.user.findUnique({ where: { email: value.email } })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('admits verified Gmail and Workspace profiles in public registration without creating organization privileges', async () => {
    vi.stubEnv('REGISTRATION_MODE', 'public');
    for (const value of [profile({ email: `Google-Public-${randomUUID()}@Gmail.com` }), profile({ email: `google-${randomUUID()}@company.test`, hd: 'company.test' })]) {
      const f = await nativeSignup(value);
      expect(f.user.email).toBe(value.email.toLowerCase());
      expect(f.user.isAdmin).toBe(false);
      expect(await db.organizationMember.count({ where: { userId: f.user.id } })).toBe(0);
      expect((await identity(f)).providerData).toBe('{}');
    }
  });

  it('uses the server profile for invitation checks and rejects a forged request-body email', async () => {
    const value = profile(), allowed = `allowed-${randomUUID()}@gmail.com`;
    vi.stubEnv('REGISTRATION_ALLOWLIST', allowed);
    await expect(validateAndGetUserFields({ profile: value, email: allowed, body: { email: allowed } }, getGoogleUserFields)).rejects.toMatchObject({ data: { message: 'INVITATION_REQUIRED' } });
    expect(await db.user.findUnique({ where: { email: value.email } })).toBeNull();
  });

  it('allows an explicitly allowlisted mailbox after normalization', async () => {
    const value = profile();
    vi.stubEnv('REGISTRATION_ALLOWLIST', ` , ${value.email.toUpperCase()} , `);
    const f = await nativeSignup(value);
    expect(f.user.email).toBe(value.email);
  });

  it('accepts an active invitation for the exact mailbox without consuming it or assigning membership', async () => {
    const value = profile(), invited = await invitation(value.email);
    const f = await nativeSignup(value);
    expect(await db.organizationMember.count({ where: { userId: f.user.id } })).toBe(0);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invited.row.id } })).acceptedAt).toBeNull();
  });

  it.each(['expired', 'revoked', 'accepted', 'organization-disabled', 'inviter-disabled'] as const)('rejects a %s invitation', async reason => {
    const value = profile(), invited = await invitation(value.email);
    if (reason === 'expired') await db.invitation.update({ where: { id: invited.row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    if (reason === 'revoked') await db.invitation.update({ where: { id: invited.row.id }, data: { revokedAt: new Date() } });
    if (reason === 'accepted') await db.invitation.update({ where: { id: invited.row.id }, data: { acceptedAt: new Date() } });
    if (reason === 'organization-disabled') await db.organization.update({ where: { id: invited.organization.id }, data: { status: 'SUSPENDED' } });
    if (reason === 'inviter-disabled') await db.user.update({ where: { id: invited.owner.user.id }, data: { disabledAt: new Date() } });
    await expect(nativeSignup(value)).rejects.toMatchObject({ data: { message: 'INVITATION_REQUIRED' } });
    expect(await db.user.findUnique({ where: { email: value.email } })).toBeNull();
  });

  it('refuses same-email linking and leaves the existing email credential and identity untouched', async () => {
    vi.stubEnv('REGISTRATION_MODE', 'public');
    const value = profile(), providerData = JSON.stringify({ hashedPassword: await hashPassword(password), isEmailVerified: true });
    const existing = await db.user.create({ data: { email: value.email, auth: { create: { identities: { create: { providerName: 'email', providerUserId: value.email, providerData } } } } }, include: { auth: true } });
    userIds.push(existing.id);
    await expect(nativeSignup(value)).rejects.toMatchObject({ data: { message: 'EMAIL_ACCOUNT_EXISTS' } });
    expect(await db.user.count({ where: { email: value.email } })).toBe(1);
    expect(await db.authIdentity.findMany({ where: { authId: existing.auth!.id }, select: { providerName: true, providerData: true } })).toEqual([{ providerName: 'email', providerData }]);
  });

  it('writes first-signup admission only after fresh trusted userinfo and does not create a session in the hook', async () => {
    const value = profile(); vi.stubEnv('REGISTRATION_ALLOWLIST', value.email);
    const f = await nativeSignup(value); googleResponse(value);
    await onAfterSignup(context(f));
    expect(JSON.parse((await identity(f)).providerData)).toEqual({ version: 1, admitted: true, verifiedEmail: value.email });
    expect(await db.session.count({ where: { userId: f.authId } })).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith('https://openidconnect.googleapis.com/v1/userinfo', expect.objectContaining({ headers: { Authorization: 'Bearer local-access-token' }, redirect: 'error' }));
  });

  it('keeps a failed first signup unadmitted and retries the registration gate on its next OAuth login', async () => {
    const value = profile(); vi.stubEnv('REGISTRATION_ALLOWLIST', value.email);
    const f = await nativeSignup(value);
    await expect(onAfterSignup(context(f))).rejects.toMatchObject({ message: 'GOOGLE_EMAIL_REQUIRES_VERIFICATION' });
    expect((await identity(f)).providerData).toBe('{}');
    vi.stubEnv('REGISTRATION_ALLOWLIST', ''); googleResponse(value);
    const firstRetry = context(f); await onBeforeLogin(firstRetry);
    await expect(onAfterLogin(firstRetry)).rejects.toMatchObject({ message: 'INVITATION_REQUIRED' });
    expect((await identity(f)).providerData).toBe('{}');
    await invitation(value.email);
    const allowedRetry = context(f); await onBeforeLogin(allowedRetry); await onAfterLogin(allowedRetry);
    expect(JSON.parse((await identity(f)).providerData).admitted).toBe(true);
  });

  it('rechecks a revoked invitation between native creation and the first-signup hook', async () => {
    const value = profile(), invited = await invitation(value.email), f = await nativeSignup(value);
    await db.invitation.update({ where: { id: invited.row.id }, data: { revokedAt: new Date() } });
    googleResponse(value);
    await expect(onAfterSignup(context(f))).rejects.toMatchObject({ message: 'INVITATION_REQUIRED' });
    expect((await identity(f)).providerData).toBe('{}');
  });

  it('rejects first-signup admission after account disable', async () => {
    const f = await googleUser(profile(), { disabled: true });
    vi.stubEnv('REGISTRATION_ALLOWLIST', f.profile.email); googleResponse(f.profile);
    await expect(onAfterSignup(context(f))).rejects.toMatchObject({ message: 'ACCOUNT_DISABLED' });
    expect((await identity(f)).providerData).toBe('{}');
  });

  it('allows an admitted returning Google user without applying the new-registration allowlist again', async () => {
    const f = await googleUser(profile(), { admitted: true }), attempt = context(f);
    googleResponse(f.profile);
    await onBeforeLogin(attempt); await expect(onAfterLogin(attempt)).resolves.toBeUndefined();
    expect(await db.session.count({ where: { userId: f.authId } })).toBe(0);
  });

  it('rejects an already disabled user before requesting Google userinfo', async () => {
    const f = await googleUser(profile(), { admitted: true, disabled: true });
    await expect(onBeforeLogin(context(f))).rejects.toMatchObject({ statusCode: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects disable between the two native login hooks', async () => {
    const f = await googleUser(profile(), { admitted: true }), attempt = context(f);
    await onBeforeLogin(attempt); googleResponse(f.profile);
    await db.user.update({ where: { id: f.user.id }, data: { disabledAt: new Date() } });
    await expect(onAfterLogin(attempt)).rejects.toMatchObject({ message: 'ACCOUNT_DISABLED' });
  });

  it.each(['email', 'sub'] as const)('rejects a changed Google %s without relinking or changing the stored user', async field => {
    const f = await googleUser(profile(), { admitted: true }), attempt = context(f), before = await identity(f);
    await onBeforeLogin(attempt);
    googleResponse({ ...f.profile, [field]: field === 'email' ? `changed-${randomUUID()}@gmail.com` : randomUUID() });
    await expect(onAfterLogin(attempt)).rejects.toMatchObject({ message: 'GOOGLE_EMAIL_CHANGED' });
    expect(await identity(f)).toEqual(before);
    expect((await db.user.findUniqueOrThrow({ where: { id: f.user.id } })).email).toBe(f.profile.email);
  });

  it.each([
    { email_verified: false },
    { email_verified: 'true' },
    { email: 'no-authority@third-party.test' },
  ])('does not admit an untrusted first-signup profile %#', async changes => {
    const f = await googleUser(); vi.stubEnv('REGISTRATION_ALLOWLIST', f.profile.email);
    googleResponse({ ...f.profile, ...changes });
    await expect(onAfterSignup(context(f))).rejects.toMatchObject({ message: 'GOOGLE_EMAIL_REQUIRES_VERIFICATION' });
    expect((await identity(f)).providerData).toBe('{}');
  });

  it('rejects a provider-data change between hooks instead of accepting a stale admission snapshot', async () => {
    const f = await googleUser(profile(), { admitted: true }), attempt = context(f);
    await onBeforeLogin(attempt); googleResponse(f.profile);
    await db.authIdentity.update({ where: { providerName_providerUserId: f.providerId }, data: { providerData: '{}' } });
    await expect(onAfterLogin(attempt)).rejects.toMatchObject({ message: 'GOOGLE_SIGN_IN_FAILED' });
    expect((await identity(f)).providerData).toBe('{}');
  });

  it('requires the matching before-login hook and does not echo userinfo failures', async () => {
    const f = await googleUser(profile(), { admitted: true }); googleResponse(f.profile);
    await expect(onAfterLogin(context(f))).rejects.toMatchObject({ message: 'GOOGLE_SIGN_IN_FAILED' });
    const attempt = context(f); await onBeforeLogin(attempt);
    fetchMock.mockRejectedValue(new Error('private-provider-token-and-body'));
    await expect(onAfterLogin(attempt)).rejects.toMatchObject({ message: 'GOOGLE_EMAIL_REQUIRES_VERIFICATION' });
    expect(JSON.parse((await identity(f)).providerData).admitted).toBe(true);
  });

  it('preserves verified email/password login and rejects wrong or subsequently replaced passwords', async () => {
    const email = `google-email-regression-${randomUUID()}@example.test`;
    const data = { hashedPassword: await hashPassword(password), isEmailVerified: true };
    const user = await db.user.create({ data: { email, auth: { create: { identities: { create: { providerName: 'email', providerUserId: email, providerData: JSON.stringify(data) } } } } } });
    userIds.push(user.id);
    const providerId = { providerName: 'email', providerUserId: email } as const;
    const args = (candidate = password) => ({ prisma: db, user, providerId, req: { body: { password: candidate } } }) as any;
    const successful = args(); await onBeforeLogin(successful); await onAfterLogin(successful);
    await expect(onBeforeLogin(args('Wrong-Password-64'))).rejects.toMatchObject({ statusCode: 401 });
    const stale = args(); await onBeforeLogin(stale);
    await db.authIdentity.update({ where: { providerName_providerUserId: providerId }, data: { providerData: JSON.stringify({ ...data, hashedPassword: await hashPassword('Changed-Password-72') }) } });
    await expect(onAfterLogin(stale)).rejects.toMatchObject({ statusCode: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
