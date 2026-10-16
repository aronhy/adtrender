import { defineUserSignupFields } from 'wasp/auth/providers/types';
import { HttpError, prisma } from 'wasp/server';
import { googleAuthEnabled, googleProfile } from './google';
import { assertRegistrationAllowed } from './registration';

export const getGoogleUserFields = defineUserSignupFields({
  email: async data => {
    if (!googleAuthEnabled()) throw new HttpError(403, 'GOOGLE_UNAVAILABLE');
    let profile;
    try { profile = googleProfile(data.profile); } catch { throw new HttpError(403, 'GOOGLE_EMAIL_REQUIRES_VERIFICATION'); }
    await assertRegistrationAllowed(prisma, profile.email);
    // Never merge an existing email account based only on a matching claim.
    if (await prisma.user.findFirst({ where: { email: { equals: profile.email, mode: 'insensitive' } } })) throw new HttpError(409, 'EMAIL_ACCOUNT_EXISTS');
    return profile.email;
  },
  displayName: data => googleProfile(data.profile).displayName,
});
