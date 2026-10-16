import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';
import { googleCallbackRedirect, googleFailureUrl, useGoogleCallbackRedirect } from './oauth-http';

describe('Google final browser redirects', () => {
  const origin = 'https://research.example.test';
  it('keeps the one-time code only in the fragment of a fixed same-origin page', () => {
    expect(googleCallbackRedirect(origin + '/oauth/callback#fixture.code.value', origin)).toBe(origin + '/login/google/callback#fixture.code.value');
  });
  it('maps only known errors and strips any provider details', () => {
    expect(googleCallbackRedirect(origin + '/oauth/callback?error=INVITATION_REQUIRED:private-data', origin)).toBe(origin + '/login?oauth_error=INVITATION_REQUIRED');
    expect(googleCallbackRedirect(origin + '/oauth/callback?error=private-token%26email%3Dtest', origin)).toBe(origin + '/login?oauth_error=GOOGLE_SIGN_IN_FAILED');
    expect(googleFailureUrl('untrusted-secret', origin)).not.toContain('untrusted-secret');
    expect(googleCallbackRedirect(origin + '/oauth/callback?error=Validation%20failed:%20EMAIL_ACCOUNT_EXISTS', origin)).toBe(origin + '/login?oauth_error=EMAIL_ACCOUNT_EXISTS');
    expect(googleCallbackRedirect(origin + '/oauth/callback?error=Validation%20failed:%20private-token', origin)).toBe(origin + '/login?oauth_error=GOOGLE_SIGN_IN_FAILED');
  });
  it('intercepts the Location header written by the native Wasp helper', () => {
    const origin = process.env.WASP_WEB_CLIENT_URL ?? 'http://localhost:3000';
    const setHeader = vi.fn();
    const res = { setHeader } as unknown as Response;
    useGoogleCallbackRedirect(res);
    res.setHeader('Location', origin + '/oauth/callback#fixture.code.value');
    expect(setHeader).toHaveBeenCalledWith('Location', origin + '/login/google/callback#fixture.code.value');
    res.setHeader('Cache-Control', 'no-store');
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
  it.each(['https://attacker.test/oauth/callback#token','https://research.example.test/elsewhere#token','javascript:alert(1)','https://research.example.test/oauth/callback?returnTo=evil#token'])('rejects unexpected destination %s', url => {
    expect(googleCallbackRedirect(url, origin)).toBe(origin + '/login?oauth_error=GOOGLE_SIGN_IN_FAILED');
  });
});
