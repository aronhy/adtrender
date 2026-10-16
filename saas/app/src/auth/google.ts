import { z } from 'zod';

type Environment = Record<string, string | undefined>;
export function validateGoogleAuthConfig(env: Environment) {
  if (env.GOOGLE_AUTH_ENABLED && !['true', 'false'].includes(env.GOOGLE_AUTH_ENABLED)) throw new Error('INVALID_GOOGLE_AUTH_ENABLED');
  if (env.GOOGLE_AUTH_ENABLED === 'true' && (!env.GOOGLE_CLIENT_ID?.trim().endsWith('.apps.googleusercontent.com') || !env.GOOGLE_CLIENT_SECRET?.trim())) throw new Error('GOOGLE_AUTH_CONFIGURATION_REQUIRED');
}
export function googleAuthEnabled(env: Environment = process.env) {
  validateGoogleAuthConfig(env);
  return env.GOOGLE_AUTH_ENABLED === 'true';
}
const profileSchema = z.object({
  sub: z.string().min(1).max(255), email: z.email(), email_verified: z.literal(true),
  hd: z.string().trim().min(1).optional(), name: z.string().optional(),
});
export function googleProfile(value: unknown) {
  const parsed = profileSchema.safeParse(value);
  if (!parsed.success) throw new Error('GOOGLE_EMAIL_REQUIRES_VERIFICATION');
  const profile = parsed.data, email = profile.email.trim().toLowerCase();
  // Google is not authoritative for third-party mailboxes without a Workspace
  // hd claim, even when email_verified was true when the account was created.
  if (!email.endsWith('@gmail.com') && !profile.hd) throw new Error('GOOGLE_EMAIL_REQUIRES_VERIFICATION');
  return { sub: profile.sub, email, displayName: profile.name?.trim().slice(0, 80) || undefined };
}
export async function readGoogleProfile(accessToken: string, fetcher: typeof fetch = fetch) {
  let value: unknown;
  try {
    const response = await fetcher('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error();
    value = await response.json();
  } catch { throw new Error('GOOGLE_PROFILE_UNAVAILABLE'); }
  return googleProfile(value);
}
export function getGoogleAuthConfig() { return { scopes: ['openid', 'email', 'profile'] }; }
