import { describe, expect, it } from 'vitest';
import { buildHomeSearchHref, clearHomeSearchIntent, consumeHomeSearchIntent, rememberHomeSearchIntent } from './home-search-intent';
import { consumePricingIntent, rememberPricingIntent } from './pricing-intent';
import { loginDestination } from './app-surface';

const now = 1791150000000;
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, values };
}

describe('homepage search through authentication', () => {
  it('keeps the public Google query and locale while removing identifiers and redirect targets', () => {
    const store = storage();
    const params = new URLSearchParams('q=+zapatos+%E4%BA%A7%E5%93%81+&platform=google&source=google&media=TEXT&lang=es&workspace=private&token=secret&returnTo=https://evil.test&organization=private');
    expect(buildHomeSearchHref(params)).toBe('/app/ads?q=zapatos+%E4%BA%A7%E5%93%81&platform=google&source=google&media=TEXT&lang=es');
    rememberHomeSearchIntent(params, store, now);
    expect([...store.values.values()][0]).not.toMatch(/private|secret|evil/);
    expect(consumeHomeSearchIntent(store, now + 60000)).toBe('/app/ads?q=zapatos+%E4%BA%A7%E5%93%81&platform=google&source=google&media=TEXT&lang=es');
    expect(consumeHomeSearchIntent(store, now + 60000)).toBeNull();
    expect(store.values.size).toBe(0);
  });
  it.each(['facebook', 'instagram', 'messenger', 'audience_network', 'pinterest', 'google', 'youtube', 'tiktok', 'snapchat'])('retains a supported %s platform', platform => {
    expect(buildHomeSearchHref(new URLSearchParams({ platform, media: 'ALL', lang: 'zh-TW' })))
      .toBe(`/app/ads?platform=${platform}&media=ALL&lang=zh-TW`);
  });
  it('drops unsupported filter values and treats external text as an encoded query on the fixed route', () => {
    expect(buildHomeSearchHref(new URLSearchParams('q=//evil.test/admin&platform=javascript:alert(1)&media=BOGUS&source=https://evil.test&lang=unsupported&returnTo=//evil.test')))
      .toBe('/app/ads?q=%2F%2Fevil.test%2Fadmin');
    expect(buildHomeSearchHref(new URLSearchParams())).toBe('/app/ads');
  });
  it.each([
    [-1, null],
    [30 * 60000 - 1, '/app/ads?q=shoes&platform=facebook&media=VIDEO&lang=en'],
    [30 * 60000, null],
    [30 * 60000 + 1, null],
  ] as const)('uses the 30 minute boundary and rejects clock rollback at offset %s', (offset, expected) => {
    const store = storage();
    rememberHomeSearchIntent(new URLSearchParams('q=shoes&platform=facebook&media=VIDEO&lang=en'), store, now);
    expect(consumeHomeSearchIntent(store, now + offset)).toBe(expected);
    expect(consumeHomeSearchIntent(store, now)).toBeNull();
  });
  it('replaces the prior homepage query with the latest search', () => {
    const store = storage();
    rememberHomeSearchIntent(new URLSearchParams('q=old'), store, now);
    rememberHomeSearchIntent(new URLSearchParams('q=new&platform=instagram'), store, now + 1000);
    expect(consumeHomeSearchIntent(store, now + 1001)).toBe('/app/ads?q=new&platform=instagram');
  });
  it('clears a search that reached the authenticated library without deleting a pending plan', () => {
    const store = storage();
    const planId = '830c7d10-afda-4bdb-87b6-66d97308b947';
    rememberPricingIntent(planId, store, now);
    rememberHomeSearchIntent(new URLSearchParams('q=already-opened'), store, now);
    clearHomeSearchIntent(store);
    expect(consumeHomeSearchIntent(store, now)).toBeNull();
    expect(consumePricingIntent(store, now)).toBe(`/app/settings?plan=${planId}#billing`);
  });
  it('revalidates storage rather than trusting a saved redirect', () => {
    const store = storage();
    rememberHomeSearchIntent(new URLSearchParams('q=shoes'), store, now);
    for (const key of store.values.keys()) store.values.set(key, JSON.stringify({ query: 'q=shoes&workspace=private&token=secret&returnTo=https://evil.test', href: 'https://evil.test', createdAt: now }));
    expect(consumeHomeSearchIntent(store, now)).toBe('/app/ads?q=shoes');
  });
  it.each(['{broken', 'null', '[]', '{"query":42,"createdAt":1791150000000}', '{"query":"q=shoes","createdAt":"1791150000000"}', '{"query":"q=shoes","createdAt":null}', '{"href":"https://evil.test","createdAt":1791150000000}'])('clears malformed storage: %s', raw => {
    const store = storage();
    rememberHomeSearchIntent(new URLSearchParams('q=shoes'), store, now);
    for (const key of store.values.keys()) store.values.set(key, raw);
    expect(consumeHomeSearchIntent(store, now)).toBeNull();
    expect(store.values.size).toBe(0);
  });
  it('does not interrupt authentication when browser storage is unavailable', () => {
    const denied = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); }, removeItem() { throw Error('denied'); } };
    expect(() => rememberHomeSearchIntent(new URLSearchParams('q=shoes'), denied, now)).not.toThrow();
    expect(consumeHomeSearchIntent(denied, now)).toBeNull();
    expect(loginDestination('', 'customer', () => '/app', () => consumeHomeSearchIntent(denied, now))).toBe('/app');
  });
  it('does not consume search or plan on admin login, then restores search once before the pending plan', () => {
    const store = storage();
    const planId = '830c7d10-afda-4bdb-87b6-66d97308b947';
    rememberPricingIntent(planId, store, now);
    rememberHomeSearchIntent(new URLSearchParams('q=shoes&platform=facebook'), store, now);
    const pricing = () => consumePricingIntent(store, now + 1000);
    const search = () => consumeHomeSearchIntent(store, now + 1000);
    expect(loginDestination('?lang=es&returnTo=https://evil.test', 'admin', pricing, search)).toBe('/app/admin?lang=es');
    expect(store.values.size).toBe(2);
    expect(loginDestination('', 'customer', pricing, search)).toBe('/app/ads?q=shoes&platform=facebook');
    expect(loginDestination('', 'customer', pricing, search)).toBe(`/app/settings?plan=${planId}#billing`);
    expect(loginDestination('', 'customer', pricing, search)).toBe('/app');
  });
  it('falls back to the existing billing intent when the homepage query is expired', () => {
    const store = storage();
    const planId = '830c7d10-afda-4bdb-87b6-66d97308b947';
    rememberHomeSearchIntent(new URLSearchParams('q=expired'), store, now);
    rememberPricingIntent(planId, store, now + 1000);
    expect(loginDestination('', 'customer', () => consumePricingIntent(store, now + 30 * 60000), () => consumeHomeSearchIntent(store, now + 30 * 60000)))
      .toBe(`/app/settings?plan=${planId}#billing`);
  });
});
