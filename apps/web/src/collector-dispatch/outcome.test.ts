import { describe, expect, it } from 'vitest';
import { classifyNativeOutcome } from './outcome';
describe('native collection outcomes', () => {
  const raw = (extra: any) => ({ sourceKey: 'meta_ad_library', platform: 'META', version: 'meta-service-dom-1', query: { country: 'US', language: 'en', keyword: 'fixture', status: 'all', mediaType: 'all' }, status: 'NO_RESULTS', ads: [], coverage: {}, ...extra });
  it('requires explicit native empty-page evidence, including actual adapter reasons', () => {
    expect(classifyNativeOutcome(raw({ coverage: { reason: 'EXPLICIT_NO_RESULTS', exhausted: true } }), { fetchedCount: 0 })).toMatchObject({ outcome: 'RELIABLE_NO_RESULTS', exhausted: true });
    expect(classifyNativeOutcome(raw({ status: 'SUCCEEDED', coverage: { reason: 'SOURCE_EXPLICIT_NO_RESULTS' } }), { fetchedCount: 0 }).outcome).toBe('RELIABLE_NO_RESULTS');
    expect(classifyNativeOutcome(raw({ coverage: { reliableNoResults: true } }), { fetchedCount: 0 }).outcome).toBe('PARTIAL');
  });
  it.each(['META_HTTP_429', 'GOOGLE_HTTP_429', 'SNAP_HTTP_429', 'TIKTOK_HTTP_429', 'RATE_LIMITED'])('keeps restrictions ahead of partial or empty evidence (%s)', errorCode => {
    expect(classifyNativeOutcome(raw({ status: 'PARTIAL', errorCode, ads: [{ id: 'retained-result' }], coverage: { reason: 'EXPLICIT_NO_RESULTS', exhausted: true } }), { fetchedCount: 1 })).toMatchObject({ outcome: 'RATE_LIMITED', exhausted: false, partial: true });
  });
  it.each(['SNAP_TIMEOUT', 'TIKTOK_TIME_BUDGET', 'GOOGLE_SOURCE_CHALLENGE', 'META_LOGIN_REQUIRED', 'PIN_HTTP_403'])('does not report restricted/time-bound responses as reliable empty (%s)', errorCode => {
    expect(classifyNativeOutcome(raw({ errorCode, coverage: { reason: 'EXPLICIT_NO_RESULTS' } }), { fetchedCount: 0 }).outcome).toBe(/TIMEOUT|TIME_BUDGET/.test(errorCode) ? 'TIMEOUT' : 'FAILED');
  });
  it('recognizes Google DISCOVER advertiser identities without inventing ads', () => {
    const batch = { sourceKey: 'google_ads_transparency', platform: 'GOOGLE', version: 'google-service-dom-1', query: { kind: 'DISCOVER', country: 'US', language: 'en', term: 'fixture' }, status: 'SUCCEEDED', ads: [], advertisers: [{ advertiserId: 'AR123', advertiserName: 'Fixture' }], coverage: {} };
    expect(classifyNativeOutcome(batch, { fetchedCount: 0, coverage: { advertisersDiscovered: 1 } }).outcome).toBe('IDENTITY_FOUND');
    expect(classifyNativeOutcome({ ...batch, status: 'FAILED', errorCode: 'GOOGLE_HTTP_429' }, { fetchedCount: 0 }).outcome).toBe('RATE_LIMITED');
  });
  it('keeps successful result counts separate from exhaustion evidence', () => {
    expect(classifyNativeOutcome(raw({ status: 'SUCCEEDED', ads: [{ id: 'ad' }], coverage: { exhausted: true } }), { fetchedCount: 1 })).toMatchObject({ outcome: 'HAS_RESULTS', exhausted: true, partial: false });
  });
});
