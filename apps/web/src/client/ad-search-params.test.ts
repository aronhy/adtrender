import { describe, expect, it } from 'vitest';
import { adSearchParams, readAdSearchFilters, searchReturnHref, sourceDateLabel, startedDateRange } from './ad-search-params';

describe('ad discovery filters', () => {
  it('submits combined filters without carrying an old cursor or invitation', () => {
    const form = new FormData();
    for (const [key, value] of Object.entries({ q: '  shoes ', platform: 'instagram', media: 'VIDEO', country: 'us', startedFrom: '2026-10-01', startedTo: '2026-10-07', cursor: 'stale', invite: 'private', period: '7' })) form.set(key, value);
    const params = adSearchParams(form, 'space-a', 'es');
    expect(Object.fromEntries(params)).toEqual({ workspace: 'space-a', lang: 'es', q: 'shoes', platform: 'instagram', media: 'VIDEO', country: 'US', startedFrom: '2026-10-01', startedTo: '2026-10-07' });
    expect(readAdSearchFilters(params, 'space-a')).toMatchObject({ query: 'shoes', platform: 'instagram', mediaType: 'VIDEO', country: 'US', startedFrom: '2026-10-01', startedTo: '2026-10-07', limit: 24 });
  });
  it('keeps all-country searches unfiltered and retains legacy observation ranges', () => {
    const params = new URLSearchParams('country=&from=2026-09-01&to=2026-09-30');
    expect(readAdSearchFilters(params, 'space')).toMatchObject({ country: undefined, observedFrom: '2026-09-01', observedTo: '2026-09-30', startedFrom: undefined });
    expect(readAdSearchFilters(new URLSearchParams('country=ALL'), 'space').country).toBe('ALL');
  });
  it('returns from details with filters but always in the current workspace', () => {
    const url = new URL(searchReturnHref('?workspace=other&platform=facebook&startedFrom=2026-10-01&country=GB&media=VIDEO&cursor=page-two&token=private&redirect=https://elsewhere.test', 'current'), 'https://local.test');
    expect(Object.fromEntries(url.searchParams)).toEqual({ workspace: 'current', platform: 'facebook', media: 'VIDEO', country: 'GB', startedFrom: '2026-10-01', cursor: 'page-two' });
    expect(searchReturnHref('https://elsewhere.test/?q=unsafe', 'current')).toBe('/app/ads?workspace=current');
  });
  it('uses inclusive UTC calendar dates for seven and thirty day ranges', () => {
    const now = new Date('2026-10-07T23:59:59Z');
    expect(startedDateRange(7, now)).toEqual({ from: '2026-10-01', to: '2026-10-07' });
    expect(startedDateRange(30, now)).toEqual({ from: '2026-09-08', to: '2026-10-07' });
    expect(startedDateRange(7, new Date('2026-01-03T00:00:00Z'))).toEqual({ from: '2025-12-28', to: '2026-01-03' });
  });
  it('displays the same source calendar date as the UTC filter boundary', () => {
    const value = '2026-09-20T23:59:59.999Z';
    expect(new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'Asia/Hong_Kong' }).format(new Date(value))).toBe('Sep 21, 2026');
    expect(sourceDateLabel(value, 'en', 'Unknown')).toBe('Sep 20, 2026');
    expect(sourceDateLabel('2026-09-20T00:00:00.000Z', 'en', 'Unknown')).toBe('Sep 20, 2026');
    expect(sourceDateLabel(null, 'es', 'Sin fecha')).toBe('Sin fecha');
    expect(sourceDateLabel('invalid', 'es', 'Sin fecha')).toBe('Sin fecha');
  });
});

describe('Google discovery scope', () => {
  it('defaults ordinary views to available content and preserves the incomplete view', () => {
    expect(readAdSearchFilters(new URLSearchParams(), 'space').contentStatus).toBe('available');
    expect(readAdSearchFilters(new URLSearchParams('content=missing'), 'space').contentStatus).toBe('missing');
  });
  it('keeps an explicit all-format Google search while defaulting its entry to text', () => {
    expect(readAdSearchFilters(new URLSearchParams('source=google'), 'space').mediaType).toBe('TEXT');
    expect(readAdSearchFilters(new URLSearchParams('source=google&media=ALL'), 'space').mediaType).toBeUndefined();
    const form = new FormData(); form.set('source','google'); form.set('media','ALL');
    expect(readAdSearchFilters(adSearchParams(form,'space','zh-CN'),'space').mediaType).toBeUndefined();
  });
  it('round-trips source, channel, domain, business and copy state without carrying a cursor', () => {
    const form = new FormData();
    for (const [key,value] of Object.entries({source:'google',channel:'SEARCH',domain:'bellezaproductos.com',business:'ECOMMERCE',content:'preview',media:'TEXT',exact:'true',exclude:'sale',cursor:'old'})) form.set(key,value);
    const params=adSearchParams(form,'space','zh-CN');
    expect(params.has('cursor')).toBe(false);
    expect(readAdSearchFilters(params,'space')).toMatchObject({source:'google',channel:'SEARCH',domain:'bellezaproductos.com',business:'ECOMMERCE',contentStatus:'preview',mediaType:'TEXT',exact:true,exclude:'sale'});
    const back=new URL(searchReturnHref('?'+params,'space'),'https://example.test');
    expect(back.searchParams.get('content')).toBe('preview');
    expect(back.searchParams.get('source')).toBe('google');
  });
});
