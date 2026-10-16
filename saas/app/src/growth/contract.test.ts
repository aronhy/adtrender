import { describe, expect, it } from 'vitest';
import { consentInput, eventInput, assertGrowthOrigin, readGrowthCookie, activeGrowthToken, growthCookie, clearGrowthCookie, normalizeAttribution } from './contract';
import { growthContext, currentGrowthToken, growthContextMiddleware } from './context';

const token = 'A'.repeat(43);
describe('first-party consent boundary', () => {
  it('uses complete UTM labels first, marks partial labels unknown, and identifies safe external referrals', () => {
    expect(normalizeAttribution({ landingPath: '/', source: 'newsletter', medium: 'email', referrerOrigin: 'https://google.com' })).toMatchObject({ source: 'newsletter', medium: 'email' });
    expect(normalizeAttribution({ landingPath: '/', source: 'newsletter' })).toMatchObject({ source: 'newsletter', medium: 'unknown' });
    expect(normalizeAttribution({ landingPath: '/', medium: 'paid' })).toMatchObject({ source: 'unknown', medium: 'paid' });
    for (const host of ['google.com', 'www.google.co.uk', 'www.google.com.hk']) expect(normalizeAttribution({ landingPath: '/', referrerOrigin: `https://${host}` })).toMatchObject({ source: 'google', medium: 'organic' });
    expect(normalizeAttribution({ landingPath: '/', referrerOrigin: 'https://www.bing.com' })).toMatchObject({ source: 'bing', medium: 'organic' });
    expect(normalizeAttribution({ landingPath: '/', referrerOrigin: 'https://cn.bing.com' })).toMatchObject({ source: 'bing', medium: 'organic' });
    expect(normalizeAttribution({ landingPath: '/', referrerOrigin: 'https://google.com.evil.test' })).toMatchObject({ source: 'google.com.evil.test', medium: 'referral' });
    for (const origin of [undefined, 'https://adtrender.com', 'https://www.adtrender.com']) expect(normalizeAttribution({ landingPath: '/', referrerOrigin: origin })).toMatchObject({ source: 'direct', medium: 'none' });
  });
  it('accepts only a deliberate same-origin consent request and public attribution', () => {
    expect(consentInput.parse({ choice: 'accepted', attribution: { landingPath: '/pricing', source: 'google', medium: 'cpc', campaign: 'launch', referrerOrigin: 'https://www.google.com' } }).choice).toBe('accepted');
    expect(() => assertGrowthOrigin({ origin: 'https://adtrender.com', 'sec-fetch-site': 'same-origin' })).not.toThrow();
    for (const origin of [undefined, 'null', 'http://adtrender.com', 'https://adtrender.com.evil.test', 'https://api.adtrender.com']) expect(() => assertGrowthOrigin({ origin })).toThrow();
    expect(() => assertGrowthOrigin({ origin: 'https://adtrender.com', 'sec-fetch-site': 'cross-site' })).toThrow();
  });
  it.each([
    { landingPath: '/app' }, { landingPath: '/?email=a@example.test' },
    { landingPath: '/', source: 'person@example.test' }, { landingPath: '/', campaign: 'a'.repeat(64) },
    { landingPath: '/', referrerOrigin: 'https://example.test/private?token=secret' },
    { landingPath: '/', referrerOrigin: 'https://user:secret@example.test' },
    { landingPath: '/', workspace: 'private' },
  ])('rejects sensitive or unrecognized attribution %#', attribution => {
    expect(consentInput.safeParse({ choice: 'accepted', attribution }).success).toBe(false);
  });
  it('never treats an ordinary auth cookie or forged client conversion as consent', () => {
    expect(readGrowthCookie(`session=x; __Host-adtrender-growth=${token}`)).toBe(token);
    expect(activeGrowthToken(`session=x; __Host-adtrender-growth=${token}`)).toBeUndefined();
    expect(activeGrowthToken(`adtrender_analytics_consent=v2.accepted; __Host-adtrender-growth=${token}`)).toBe(token);
    expect(activeGrowthToken(`adtrender_analytics_consent=v2.accepted; __Host-adtrender-growth=${token}; __Host-adtrender-growth=${token}`)).toBeUndefined();
    expect(eventInput.safeParse({ name: 'ACCOUNT_CREATED', pathname: '/', requestNonce: 'c5712813-5554-4c30-a3b7-f8244c936def' }).success).toBe(false);
    expect(eventInput.safeParse({ name: 'CTA_CLICK', pathname: '/', target: 'signup', userId: 'forged', requestNonce: 'c5712813-5554-4c30-a3b7-f8244c936def' }).success).toBe(false);
  });
  it('uses a host-only secure HttpOnly cookie and clears the identical scope', () => {
    expect(growthCookie(token)).toContain('Secure; HttpOnly; SameSite=Lax; Path=/');
    expect(growthCookie(token)).not.toContain('Domain=');
    expect(clearGrowthCookie()).toContain('Max-Age=0');
  });
  it('keeps request-local consent isolated across overlapping asynchronous work', async () => {
    const values = await Promise.all([
      growthContext.run({ token }, async () => { await Promise.resolve(); return currentGrowthToken(); }),
      growthContext.run({}, async () => { await Promise.resolve(); return currentGrowthToken(); }),
    ]);
    expect(values).toEqual([token, undefined]);
    expect(currentGrowthToken()).toBeUndefined();
  });
  it('requires same-origin writes while allowing the top-level Google callback to carry prior consent', () => {
    const cookie = `adtrender_analytics_consent=v2.accepted; __Host-adtrender-growth=${token}`;
    const observed: Array<string | undefined> = [];
    for (const req of [
      { method: 'POST', headers: { cookie, origin: 'https://evil.test' } },
      { method: 'POST', headers: { cookie } },
      { method: 'POST', headers: { cookie, origin: 'https://adtrender.com' } },
      { method: 'GET', headers: { cookie } },
    ]) growthContextMiddleware(req as any, {} as any, () => { observed.push(currentGrowthToken()); });
    expect(observed).toEqual([undefined, undefined, token, token]);
  });
});
