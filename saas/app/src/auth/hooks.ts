import type { OnBeforeSignupHook, OnAfterSignupHook, OnBeforeLoginHook, OnAfterLoginHook } from 'wasp/server/auth';
import { HttpError } from 'wasp/server';
import { verifyPassword } from 'wasp/auth/password';
import { credentialHash } from './links';
import { assertRegistrationAllowed } from './registration';
import { googleAuthEnabled, readGoogleProfile } from './google';
import { lockAccountAdministration } from '../team/access';
import { createHash } from 'node:crypto';
import { safelyRecordConversion } from '../growth/conversions';

const googleIdentityVersion = (data: string) => createHash('sha256').update(data).digest('hex');

export const onBeforeSignup: OnBeforeSignupHook = async ({ req, providerId, prisma }) => {
  if (providerId.providerName === 'google') {
    if (!googleAuthEnabled()) throw new HttpError(403, 'GOOGLE_UNAVAILABLE');
    // Native Wasp has already run getGoogleUserFields against server-fetched
    // userinfo. req.body is never a trusted Google email/profile source.
    return;
  }
  if (providerId.providerName !== 'email') throw new HttpError(403, 'INVALID_AUTH_PROVIDER');
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  await assertRegistrationAllowed(prisma, email);
};

export function googleAdmissionMatches(providerData: string, email: string | null) {
  try { const data = JSON.parse(providerData); return data.version === 1 && data.admitted === true && typeof email === 'string' && data.verifiedEmail === email.toLowerCase(); }
  catch { return false; }
}
export const onAfterSignup: OnAfterSignupHook = async ({ providerId, user, oauth, prisma }) => {
  if (providerId.providerName !== 'google') return;
  if (!googleAuthEnabled() || oauth?.providerName !== 'google') throw new HttpError(403, 'GOOGLE_UNAVAILABLE');
  let profile;
  try { profile = await readGoogleProfile(oauth.tokens.accessToken); } catch { throw new HttpError(403, 'GOOGLE_EMAIL_REQUIRES_VERIFICATION'); }
  await prisma.$transaction(async tx => {
    await lockAccountAdministration(tx);
    const identity = await tx.authIdentity.findUnique({ where: { providerName_providerUserId: providerId }, include: { auth: { include: { user: true } } } });
    if (!identity?.auth.user || identity.auth.userId !== user.id || identity.auth.user.disabledAt) throw new HttpError(403, 'ACCOUNT_DISABLED');
    if (profile.sub !== providerId.providerUserId || profile.email !== identity.auth.user.email) throw new HttpError(403, 'GOOGLE_SIGN_IN_FAILED');
    await assertRegistrationAllowed(tx, profile.email);
    // Native signup commits before this hook. If admission fails, its residual
    // identity stays unadmitted and cannot bypass the gate as a returning user.
    await tx.authIdentity.update({ where: { providerName_providerUserId: providerId }, data: { providerData: JSON.stringify({ version: 1, admitted: true, verifiedEmail: profile.email }) } });
    if (!googleAdmissionMatches(identity.providerData, profile.email)) {
      await safelyRecordConversion(tx, user.id, 'ACCOUNT_CREATED');
      await safelyRecordConversion(tx, user.id, 'REGISTRATION_VERIFIED');
    }
  });
};
const loginVersions = new WeakMap<object, { authId: string; credential: string }>();
export const onBeforeLogin: OnBeforeLoginHook = async ({ req, providerId, user, prisma }) => {
  const identity = await prisma.authIdentity.findUnique({ where: { providerName_providerUserId: providerId }, include: { auth: { include: { user: true } } } });
  if (!identity || identity.auth.userId !== user.id || (!identity.auth.user || identity.auth.user.disabledAt)) throw new HttpError(401, 'Invalid credentials');
  if (providerId.providerName === 'google') {
    if (!googleAuthEnabled()) throw new HttpError(403, 'GOOGLE_UNAVAILABLE');
    // A transient failure after native signup may leave an unadmitted identity.
    // Its next OAuth attempt must repeat admission, never skip it as "existing".
    loginVersions.set(req, { authId: identity.authId, credential: googleIdentityVersion(identity.providerData) });
    return;
  }
  if (providerId.providerName !== 'email') throw new HttpError(401, 'Invalid credentials');
  const data = JSON.parse(identity.providerData);
  if (!data.isEmailVerified || typeof req.body?.password !== 'string') throw new HttpError(401, 'Invalid credentials');
  // Wasp may have verified an older hash before a concurrent password reset.
  try { await verifyPassword(data.hashedPassword, req.body.password); } catch { throw new HttpError(401, 'Invalid credentials'); }
  loginVersions.set(req, { authId: identity.authId, credential: credentialHash(identity.providerData) });
};
export const onAfterLogin: OnAfterLoginHook = async ({ req, providerId, oauth, prisma }) => {
  const version = loginVersions.get(req); loginVersions.delete(req);
  if (providerId.providerName === 'google') {
    if (!googleAuthEnabled() || oauth?.providerName !== 'google') throw new HttpError(403, 'GOOGLE_UNAVAILABLE');
    let profile;
    try { profile = await readGoogleProfile(oauth.tokens.accessToken); } catch { throw new HttpError(403, 'GOOGLE_EMAIL_REQUIRES_VERIFICATION'); }
    await prisma.$transaction(async tx => {
      await lockAccountAdministration(tx);
      const fresh = await tx.authIdentity.findUnique({ where: { providerName_providerUserId: providerId }, include: { auth: { include: { user: true } } } });
      if (!fresh?.auth.user || fresh.auth.user.disabledAt) throw new HttpError(403, 'ACCOUNT_DISABLED');
      if (!version || fresh.authId !== version.authId || googleIdentityVersion(fresh.providerData) !== version.credential) throw new HttpError(401, 'GOOGLE_SIGN_IN_FAILED');
      if (profile.sub !== providerId.providerUserId || profile.email !== fresh.auth.user.email) throw new HttpError(403, 'GOOGLE_EMAIL_CHANGED');
      if (!googleAdmissionMatches(fresh.providerData, profile.email)) {
        await assertRegistrationAllowed(tx, profile.email);
        await tx.authIdentity.update({ where: { providerName_providerUserId: providerId }, data: { providerData: JSON.stringify({ version: 1, admitted: true, verifiedEmail: profile.email }) } });
        await safelyRecordConversion(tx, fresh.auth.user.id, 'ACCOUNT_CREATED');
        await safelyRecordConversion(tx, fresh.auth.user.id, 'REGISTRATION_VERIFIED');
      }
    });
    return;
  }
  const identity = await prisma.authIdentity.findUnique({ where: { providerName_providerUserId: providerId }, include: { auth: { include: { user: true } } } });
  if (!version || !identity || (!identity.auth.user || identity.auth.user.disabledAt) || identity.authId !== version.authId || credentialHash(identity.providerData) !== version.credential) {
    // The framework has not returned this session ID yet; throwing prevents it
    // from escaping to a login that verified an obsolete credential.
    throw new HttpError(401, 'Invalid credentials');
  }
};
