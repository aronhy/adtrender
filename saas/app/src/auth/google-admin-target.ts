import type { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { adminWebOrigin } from '../server/admin-web';

type Environment = Record<string, string | undefined>;
export const googleAdminCookieName = 'adthrender_google_target';
const lifetimeMs = 10 * 60 * 1000;
const purpose = 'google_admin_return_v1';

function cookieOptions(env: Environment) {
  return { httpOnly: true, secure: env.NODE_ENV === 'production' || env.WASP_SERVER_URL?.startsWith('https://') === true, sameSite: 'lax' as const, path: '/' };
}
function signingKey(env: Environment) {
  const key = env.JWT_SECRET?.trim();
  if (!key || key.length < 32) throw new Error('ADMIN_GOOGLE_TARGET_REQUIRES_JWT_SECRET');
  return key;
}
function signature(payload: string, env: Environment) {
  return createHmac('sha256', signingKey(env)).update(payload).digest('base64url');
}
function validState(state: unknown): state is string {
  return typeof state === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(state);
}

/** Observe Wasp's final provider Location after it has created its PKCE/state.
 * The extra marker chooses a client; it neither replaces native validation nor
 * changes the provider redirect_uri, profile, identity, or session. */
export function bindGoogleAdminStart(req: Request, res: Response, env: Environment = process.env, now = Date.now()): void {
  res.clearCookie(googleAdminCookieName, cookieOptions(env));
  const target = adminWebOrigin(env);
  if (req.query.app !== 'admin' || !target) return;
  signingKey(env);
  const setHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: string | number | readonly string[]) => {
    if (name.toLowerCase() === 'location' && typeof value === 'string') {
      let provider: URL | undefined;
      try { provider = new URL(value); } catch { /* Only native Google provider redirects carry a marker. */ }
      const states = provider?.searchParams.getAll('state') ?? [];
      if (provider?.origin === 'https://accounts.google.com' && provider.pathname === '/o/oauth2/v2/auth' && states.length === 1 && validState(states[0])) {
        const encoded = Buffer.from(JSON.stringify({ purpose, state: states[0], target, issuedAt: now, expiresAt: now + lifetimeMs })).toString('base64url');
        res.cookie(googleAdminCookieName, `${encoded}.${signature(encoded, env)}`, { ...cookieOptions(env), maxAge: lifetimeMs });
      }
    }
    return setHeader(name, value);
  }) as Response['setHeader'];
}

export function resolveGoogleAdminCallback(req: Request, res: Response, env: Environment = process.env, now = Date.now()): {targetOrigin?: string; invalid: boolean} {
  res.clearCookie(googleAdminCookieName, cookieOptions(env));
  const markers = (req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(googleAdminCookieName + '='));
  if (markers.length === 0) return { invalid: false };
  try {
    if (markers.length !== 1 || !validState(req.query.state)) throw new Error();
    const value = decodeURIComponent(markers[0].slice(googleAdminCookieName.length + 1));
    if (value.length > 2048) throw new Error();
    const parts = value.split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) throw new Error();
    const expected = Buffer.from(signature(parts[0], env));
    const actual = Buffer.from(parts[1]);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const payload: unknown = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
    const data = payload as Record<string, unknown>;
    const target = adminWebOrigin(env);
    if (!target || data.purpose !== purpose || data.target !== target || data.state !== req.query.state ||
      !Number.isSafeInteger(data.issuedAt) || !Number.isSafeInteger(data.expiresAt) ||
      (data.issuedAt as number) > now || (data.expiresAt as number) !== (data.issuedAt as number) + lifetimeMs ||
      (data.expiresAt as number) <= now) throw new Error();
    return { targetOrigin: target, invalid: false };
  } catch {
    return { invalid: true };
  }
}
