import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { bindGoogleAdminStart, resolveGoogleAdminCallback, googleAdminCookieName } from './google-admin-target';
import { googleCallbackRedirect, useGoogleCallbackRedirect } from './oauth-http';

const env = { ADMIN_WEB_CLIENT_URL: 'https://admin.example.test', WASP_WEB_CLIENT_URL: 'https://research.example.test', WASP_SERVER_URL: 'https://api.example.test', JWT_SECRET: 'local-test-purpose-key-32-characters', NODE_ENV: 'production' };
const now = 1_800_000_000_000;
function response() { const headers = vi.fn(), cookie = vi.fn(), clearCookie = vi.fn(); return { res: { setHeader: headers, cookie, clearCookie } as unknown as Response, headers, cookie, clearCookie }; }
function request(query: Record<string, unknown>, cookie = '') { return { query, headers: { cookie } } as unknown as Request; }
function signedStart() {
  const result = response(); bindGoogleAdminStart(request({ app: 'admin', returnTo: 'https://evil.test' }), result.res, env, now);
  result.res.setHeader('Location', 'https://accounts.google.com/o/oauth2/v2/auth?state=native-state-1&code_challenge=native-pkce');
  return { ...result, signed: result.cookie.mock.calls[0][1] as string };
}
describe('admin return target is bound to native Google state', () => {
  it('signs only the configured target and leaves native PKCE Location untouched', () => {
    const result = signedStart();
    expect(result.cookie).toHaveBeenCalledWith(googleAdminCookieName, expect.any(String), expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600000 }));
    expect(result.headers).toHaveBeenCalledWith('Location', 'https://accounts.google.com/o/oauth2/v2/auth?state=native-state-1&code_challenge=native-pkce');
    expect(result.signed).not.toContain('evil.test');
  });
  it('returns only to the configured admin origin after matching state and clears marker', () => {
    const { signed } = signedStart(), result = response();
    const target = resolveGoogleAdminCallback(request({ state: 'native-state-1', app: 'customer' }, `${googleAdminCookieName}=${signed}`), result.res, env, now + 500);
    expect(target).toEqual({ targetOrigin: env.ADMIN_WEB_CLIENT_URL, invalid: false });
    expect(result.clearCookie).toHaveBeenCalledWith(googleAdminCookieName, expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }));
    useGoogleCallbackRedirect(result.res, { nativeOrigin: env.WASP_WEB_CLIENT_URL, targetOrigin: target.targetOrigin });
    result.res.setHeader('Location', env.WASP_WEB_CLIENT_URL + '/oauth/callback#one-use-code');
    expect(result.headers).toHaveBeenCalledWith('Location', env.ADMIN_WEB_CLIENT_URL + '/login/google/callback#one-use-code');
  });
  it.each(['tamper', 'wrong-state', 'expired', 'future-issued', 'duplicate', 'changed-target', 'changed-key', 'missing-key', 'array-state'])('fails closed before native callback for %s', scenario => {
    let { signed } = signedStart(); const result = response();
    if (scenario === 'tamper') signed += '1';
    const cookie = `${googleAdminCookieName}=${signed}` + (scenario === 'duplicate' ? `; ${googleAdminCookieName}=${signed}` : '');
    const actualEnv = scenario === 'changed-target' ? { ...env, ADMIN_WEB_CLIENT_URL: 'https://other-admin.example.test' } : scenario === 'changed-key' ? { ...env, JWT_SECRET: 'different-test-purpose-key-32-characters' } : scenario === 'missing-key' ? { ...env, JWT_SECRET: '' } : env;
    const state = scenario === 'array-state' ? ['native-state-1', 'other'] : scenario === 'wrong-state' ? 'different-state' : 'native-state-1';
    expect(resolveGoogleAdminCallback(request({ state }, cookie), result.res, actualEnv, scenario === 'expired' ? now + 600000 : scenario === 'future-issued' ? now - 1 : now + 500)).toEqual({ invalid: true });
    expect(result.clearCookie).toHaveBeenCalled();
  });
  it('never accepts app=admin on callback or an unconfigured administrator URL as authorization', () => {
    expect(resolveGoogleAdminCallback(request({ app: 'admin', state: 'native-state-1' }), response().res, env, now)).toEqual({ invalid: false });
    const result = response(); bindGoogleAdminStart(request({ app: 'admin' }), result.res, { ...env, ADMIN_WEB_CLIENT_URL: '' }, now);
    result.res.setHeader('Location', 'https://accounts.google.com/o/oauth2/v2/auth?state=native-state-1'); expect(result.cookie).not.toHaveBeenCalled();
  });
  it('a customer start clears an older admin marker', () => {
    const result = response(); bindGoogleAdminStart(request({ app: 'customer' }), result.res, env, now); expect(result.clearCookie).toHaveBeenCalled(); expect(result.cookie).not.toHaveBeenCalled();
  });
  it.each(['https://evil.test/o/oauth2/v2/auth?state=native-state-1', 'https://accounts.google.com/wrong?state=native-state-1', 'https://accounts.google.com/o/oauth2/v2/auth?state=native-state-1&state=native-state-2', 'https://accounts.google.com/o/oauth2/v2/auth'])('never signs an unexpected provider boundary %s', location => {
    const result = response(); bindGoogleAdminStart(request({ app: 'admin' }), result.res, env, now);
    result.res.setHeader('Location', location); expect(result.cookie).not.toHaveBeenCalled(); expect(result.headers).toHaveBeenCalledWith('Location', location);
  });
  it('keeps sanitized failures on the selected client, and rejects hostile native redirects', () => {
    expect(googleCallbackRedirect(env.WASP_WEB_CLIENT_URL + '/oauth/callback?error=private-provider-message', env.WASP_WEB_CLIENT_URL, env.ADMIN_WEB_CLIENT_URL)).toBe(env.ADMIN_WEB_CLIENT_URL + '/login?oauth_error=GOOGLE_SIGN_IN_FAILED');
    expect(googleCallbackRedirect('https://evil.test/oauth/callback#private', env.WASP_WEB_CLIENT_URL, env.ADMIN_WEB_CLIENT_URL)).toBe(env.ADMIN_WEB_CLIENT_URL + '/login?oauth_error=GOOGLE_SIGN_IN_FAILED');
  });
});
