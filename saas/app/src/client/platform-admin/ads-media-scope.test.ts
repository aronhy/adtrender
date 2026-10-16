import { describe, expect, it } from 'vitest';
import { adminAdsFilterParams, adminMediaFilterScope } from './ads-media-scope';

describe('global pending media navigation', () => {
  it('removes only date bounds for global pending records and keeps source scope', () => {
    const filters = { sourceId: 'source-id', dateFrom: '2026-10-04T00:00:00.000Z', dateTo: '2026-10-11T00:00:00.000Z' };
    expect(adminMediaFilterScope(new URLSearchParams('pending=all'), filters)).toEqual({ sourceId: 'source-id' });
    expect(adminMediaFilterScope(new URLSearchParams(), filters)).toEqual(filters);
  });
  it('leaves full-history mode on an explicit range change or tab switch', () => {
    const params = new URLSearchParams('pending=all&adsTab=media&status=FAILED&sourceId=source-id&cursor=old');
    for (const [key, value] of [['adsRange', '7'], ['adsRange', '30'], ['adsRange', 'custom'], ['from', '2026-10-01'], ['to', '2026-10-11'], ['adsTab', 'runs']]) {
      const next = adminAdsFilterParams(params, key, value);
      expect(next.has('pending')).toBe(false);
      expect(next.has('cursor')).toBe(false);
      expect(next.get('status')).toBe('FAILED');
    }
    expect(adminAdsFilterParams(params, 'sourceId', 'new-source').get('pending')).toBe('all');
  });
});
