import type { Response } from 'express';

const errorCodes = new Set(['EMAIL_ACCOUNT_EXISTS', 'GOOGLE_UNAVAILABLE', 'GOOGLE_SIGN_IN_FAILED', 'ACCOUNT_DISABLED', 'INVITATION_REQUIRED', 'GOOGLE_EMAIL_REQUIRES_VERIFICATION', 'GOOGLE_EMAIL_CHANGED']);
export function googleFailureUrl(code: string, origin = process.env.WASP_WEB_CLIENT_URL ?? 'http://localhost:3000') {
  const target = new URL('/login', origin);
  target.searchParams.set('oauth_error', errorCodes.has(code) ? code : 'GOOGLE_SIGN_IN_FAILED');
  return target.href;
}
export function googleCallbackRedirect(value: string, origin = process.env.WASP_WEB_CLIENT_URL ?? 'http://localhost:3000', targetOrigin = origin) {
  const expected = new URL(origin);
  let original: URL;
  try { original = new URL(value); } catch { return googleFailureUrl('GOOGLE_SIGN_IN_FAILED', targetOrigin); }
  if (original.origin !== expected.origin || original.pathname !== '/oauth/callback') return googleFailureUrl('GOOGLE_SIGN_IN_FAILED', targetOrigin);
  if (original.searchParams.has('error')) {
    const error = original.searchParams.get('error') ?? '';
    // Native signup wraps field errors with this exact prefix.
    const message = error.startsWith('Validation failed: ') ? error.slice('Validation failed: '.length) : error;
    return googleFailureUrl(message.split(':')[0], targetOrigin);
  }
  if (!original.hash || original.search) return googleFailureUrl('GOOGLE_SIGN_IN_FAILED', targetOrigin);
  const target = new URL('/login/google/callback', targetOrigin); target.hash = original.hash;
  return target.href;
}
/** Wasp handles PKCE/state and obtains the profile. Only its final app redirect
 * is adapted, so provider errors never become rendered text or URL parameters. */
export function useGoogleCallbackRedirect(res: Response, options?: {nativeOrigin?: string; targetOrigin?: string}) {
  // Wasp's helper writes Location directly rather than calling res.redirect.
  // Intercept the shared header boundary, including Express redirects.
  const setHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: string | number | readonly string[]) => setHeader(
    name, name.toLowerCase() === 'location' ? googleCallbackRedirect(String(value), options?.nativeOrigin, options?.targetOrigin) : value,
  )) as Response['setHeader'];
}
