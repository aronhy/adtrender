import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { hashPassword } from 'wasp/auth/password';
import { ensureValidEmail, ensureValidPassword } from 'wasp/auth/validation';
import { consumeAuthLink, issueAuthLink } from './links';
import { queueEmail } from '../server/email';
import { DomainError } from '../team/access';
import { z } from 'zod';
import { safelyRecordConversion } from '../growth/conversions';
import { growthEnabled } from '../growth/contract';
import { currentGrowthToken } from '../growth/context';

type Purpose = 'RESET' | 'VERIFY';
type TokenProvider = { create(email: string): Promise<string>; validate(token: string): Promise<{ email: string }> };
const waspTokens: TokenProvider = {
  async create(email) { const { createJWT, TimeSpan } = await import('wasp/auth/jwt'); return createJWT({ email }, { expiresIn: new TimeSpan(30, 'm') }); },
  async validate(token) { const { validateJWT } = await import('wasp/auth/jwt'); return validateJWT<{ email: string }>(token); },
};

/** Uses Wasp's public createUser and provider serializer, without its destructive
 * unverified-user replacement branch. Concurrent creation is resolved by the
 * framework tables' unique identity/email constraints. */
export async function registerEmailAccount(db: PrismaClient, input: { email: string; password: string; key: string; origin: string }) {
  const email = input.email.trim().toLowerCase();
  ensureValidEmail({ email }); ensureValidPassword({ password: input.password });
  if (!z.email().safeParse(email).success) throw new DomainError(400, 'INVALID_EMAIL');
  const { createUser, createProviderId, sanitizeAndSerializeProviderData } = await import('wasp/auth/utils');
  const providerData = await sanitizeAndSerializeProviderData<'email'>({ hashedPassword: input.password, isEmailVerified: false, emailVerificationSentAt: new Date(0).toISOString(), passwordResetSentAt: null });
  let created = true;
  let createdUserId: string | undefined;
  try { createdUserId = (await createUser(createProviderId('email', email), providerData, { email })).id; }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'P2002') throw error;
    created = false;
  }
  // Native Wasp owns the account-creation transaction. Attribute only its real
  // returned new user; a failed optional ledger write must not change signup.
  if (createdUserId && growthEnabled() && currentGrowthToken()) {
    try { await db.$transaction(tx => safelyRecordConversion(tx, createdUserId!, 'ACCOUNT_CREATED'), { maxWait: 1000, timeout: 2000 }); }
    catch { console.warn('GROWTH_CONVERSION_NOT_RECORDED'); }
  }
  // A pre-existing unverified identity may have been created by somebody else.
  // Its mailbox owner must set their own password instead of verifying that hash.
  await requestAuthEmail(db, { ...input, email, purpose: created ? 'VERIFY' : 'RESET', unverifiedOnly: !created });
  return { success: true };
}

/** Wasp's native identity, password hash and JWT format; no second credential store. */
export async function completeAuthLink(db: PrismaClient, input: { token: string; purpose: Purpose; key: string; password?: string }, tokens: TokenProvider = waspTokens) {
  if (input.purpose === 'RESET') ensureValidPassword({ password: input.password });
  return consumeAuthLink(db, input.token, input.purpose, input.key, async (tx, link) => {
    let payload: { email: string };
    try { payload = await tokens.validate(link.frameworkToken); } catch { throw new DomainError(400, 'AUTH_LINK_INVALID'); }
    if (payload.email?.toLowerCase() !== link.email) throw new DomainError(400, 'AUTH_LINK_INVALID');
    const data = JSON.parse(link.providerData);
    const firstVerification = data.isEmailVerified !== true;
    if (input.purpose === 'RESET') data.hashedPassword = await hashPassword(input.password!);
    data.isEmailVerified = true;
    await tx.authIdentity.update({ where: { providerName_providerUserId: { providerName: 'email', providerUserId: link.email } }, data: { providerData: JSON.stringify(data) } });
    if (input.purpose === 'RESET') await tx.session.deleteMany({ where: { userId: link.authId } });
    if (firstVerification) await safelyRecordConversion(tx, link.userId, 'REGISTRATION_VERIFIED');
    return { success: true };
  });
}

/** Same neutral response for absent, verified, disabled and throttled identities.
 * Metadata writes share the Auth lock with reset, avoiding stale hash overwrites. */
export async function requestAuthEmail(db: PrismaClient, input: { email: string; purpose: Purpose; key: string; origin: string; unverifiedOnly?: boolean }, tokens: TokenProvider = waspTokens) {
  const email = input.email.trim().toLowerCase(); ensureValidEmail({ email });
  if (!z.email().safeParse(email).success) throw new DomainError(400, 'INVALID_EMAIL');
  await db.$transaction(async tx => {
    const initial = await tx.authIdentity.findUnique({ where: { providerName_providerUserId: { providerName: 'email', providerUserId: email } } });
    if (!initial) return;
    await tx.$queryRaw`SELECT id FROM "Auth" WHERE id=${initial.authId} FOR UPDATE`;
    const identity = await tx.authIdentity.findUnique({ where: { providerName_providerUserId: { providerName: 'email', providerUserId: email } }, include: { auth: { include: { user: true } } } });
    if (!identity || (!identity.auth.user || identity.auth.user.disabledAt) || identity.authId !== initial.authId) return;
    const data = JSON.parse(identity.providerData);
    if (input.unverifiedOnly && data.isEmailVerified) return;
    if (input.purpose === 'VERIFY' && data.isEmailVerified) return;
    const field = input.purpose === 'RESET' ? 'passwordResetSentAt' : 'emailVerificationSentAt';
    if (data[field] && Date.now() - new Date(data[field]).valueOf() < 60_000) return;
    const native = await tokens.create(email);
    const opaque = await issueAuthLink(tx, { email, purpose: input.purpose, frameworkToken: native, key: input.key });
    const path = input.purpose === 'RESET' ? '/password-reset' : '/email-verification';
    const url = new URL(path, input.origin); url.searchParams.set('token', opaque);
    const subject = input.purpose === 'RESET' ? '重置您的密码' : '验证您的邮箱';
    await queueEmail(tx, { to: email, subject, text: `${subject}：${url.toString()}。链接一次有效，28 分钟内有效。若非本人操作，请忽略。` }, { key: input.key, dedupeKey: createHash('sha256').update(email + opaque).digest('hex'), templateKey: input.purpose, expiresAt: new Date(Date.now() + 28 * 60000) });
    data[field] = new Date().toISOString();
    await tx.authIdentity.update({ where: { providerName_providerUserId: { providerName: 'email', providerUserId: email } }, data: { providerData: JSON.stringify(data) } });
  }, { maxWait: 10_000, timeout: 20_000 });
  return { success: true };
}
