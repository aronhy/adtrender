// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceLocaleProvider } from './workspace-i18n/locale';
import { translate } from './workspace-i18n/messages';
import type { AdHistoryResult } from '../ad-history/api-types';
import type { AdEvidenceResult } from '../ad-history/evidence';

const fixture = vi.hoisted(() => ({ response: null as AdHistoryResult | null, next: null as AdHistoryResult | null, scoped: null as AdHistoryResult | null, queries: [] as Array<Record<string, unknown>>, evidence: {} as Record<string, AdEvidenceResult | undefined>, evidenceQueries: [] as Array<Record<string, unknown>> }));
vi.mock('wasp/client/operations', () => ({ getPublicAdHistory: 'history', getPublicAdHistoryEvidence: 'evidence', useQuery: (operation: unknown, query: Record<string, unknown>) => {
  if (operation === 'evidence') {
    fixture.evidenceQueries.push(query);
    return { data: fixture.evidence[String(query.observationId)], error: null, isLoading: false, isFetching: false, refetch: async () => ({ isSuccess: true }) };
  }
  fixture.queries.push(query);
  return { data: query.scopeHash ? fixture.scoped : query.eventCursor ? fixture.next : fixture.response, error: null, isLoading: false, isFetching: false, refetch: async () => ({ isSuccess: true }) };
} }));
vi.mock('./App', () => ({
  Field: ({ label, children }: { label: string; children: ReactNode }) => createElement('label', null, label, children),
  Empty: ({ title, children }: { title: string; children: ReactNode }) => createElement('div', null, title, children),
  Loading: ({ label }: { label: string }) => createElement('div', null, label),
}));
import { AdHistoryPanel, HistoryEvidence } from './AdHistoryPanel';

let container: HTMLDivElement;
let root: Root;
const scopes = [{ hash: 'scope-us', kind: 'DISCOVERY' as const, sourceKey: 'meta', queryCountry: 'US', queryLanguage: 'en' }, { hash: 'scope-gb', kind: 'HISTORY_RECHECK' as const, sourceKey: 'meta', queryCountry: 'GB', queryLanguage: null }];
const observed = { day: '2026-10-08', scopeHash: 'scope-us', observationState: 'OBSERVED' as const, checkState: 'UNKNOWN' as const, sourceStatus: 'UNKNOWN' as const, hasStateConflict: false, observationCount: 2, lastObservedAt: '2026-10-08T01:00:00Z', latestObservationId: 'observation-day', body: 'Historic copy only', headline: 'Historic headline', cta: 'Historic CTA' };
const missing = { ...observed, day: '2026-10-07', observationState: 'NO_OBSERVATION' as const, observationCount: 0, lastObservedAt: null, latestObservationId: null, body: null, headline: null, cta: null };
const event = { id: 'event-new', type: 'BODY_CHANGED' as const, observedAt: '2026-10-08T01:00:00Z', scopeHash: 'scope-us', beforeObservationId: 'before-id', afterObservationId: 'after-id' };
const result = (): AdHistoryResult => ({ timezone: 'Asia/Shanghai', asOf: '2026-10-08T02:00:00Z', from: '2026-10-01', to: '2026-10-08', scopes, days: [observed, missing], events: [event], nextEventCursor: 'next-events', projectionPending: false, summary: { observedDays: 2, activeObservedDays: 0, conflictDays: 0, firstObservedAt: observed.lastObservedAt, lastObservedAt: observed.lastObservedAt, sourceStartedAt: null, sourceEndedAt: null, sourceDateSpanDays: null, spanEndAt: null, spanBasis: null, scope: 'selected-window' } });
const evidenceResult = (): AdEvidenceResult => ({ observationId: 'observation-day', observedAt: observed.lastObservedAt, advertiserName: 'Historic advertiser', advertiserId: 'source-advertiser-9', body: observed.body, headline: observed.headline, cta: observed.cta, landingPageUrl: 'https://landing.example/historic', reportedCountries: ['FR', 'DE'], publisherPlatforms: ['facebook', 'instagram'], adLanguages: ['fr', 'de'], sourceStartedAt: '2026-09-30', sourceEndedAt: '2026-10-08T02:30:00Z', media: [] });
const captures = (): AdEvidenceResult['media'] => [
  { id: 'image-capture', sha256: 'a'.repeat(64), type: 'IMAGE', mimeType: 'image/png', sizeBytes: '4567', downloadedAt: '2026-10-08T01:05:00Z', recordedAt: '2026-10-08T01:06:00Z', association: 'SOURCE_URL_MATCH', displayUrl: 'https://preview.example/captured.png?signature=temporary', displayUrlExpiresAt: '2026-10-08T02:06:00Z' },
  { id: 'video-capture', sha256: 'b'.repeat(64), type: 'VIDEO', mimeType: 'video/mp4', sizeBytes: '8901', downloadedAt: '2026-10-08T04:00:00Z', recordedAt: '2026-10-08T04:01:00Z', association: 'SOURCE_URL_MATCH', displayUrl: 'https://preview.example/captured.mp4?signature=temporary', displayUrlExpiresAt: '2026-10-08T05:01:00Z' },
];

async function render(node: ReactNode, locale = 'en') { await act(async () => root.render(createElement(MemoryRouter, { key: locale, initialEntries: [`/app?lang=${locale}`] }, createElement(WorkspaceLocaleProvider, null, node)))); }
async function click(element: Element) { await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true }))); }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); fixture.queries = [];
  fixture.response = result(); fixture.next = { ...result(), events: [event, { ...event, id: 'event-old', observedAt: '2026-10-01T00:00:00Z', type: 'CTA_CHANGED' }], nextEventCursor: null };
  fixture.scoped = { ...result(), days: [{ ...observed, scopeHash: 'scope-gb', hasStateConflict: true, sourceStatus: 'ACTIVE' }], events: [], nextEventCursor: null };
  fixture.evidence = { 'observation-day': evidenceResult() }; fixture.evidenceQueries = [];
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('historic ad evidence presentation', () => {
  it('separates missing observation days, unknown source status and unknown check completion in four languages', async () => {
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'es'] as const) {
      await render(createElement(HistoryEvidence, { data: result(), onSelect: () => {} }), locale);
      const rows = container.querySelectorAll('tbody tr');
      expect(rows[0].textContent).toContain(translate(locale, 'ads.history.observed'));
      expect(rows[0].textContent).toContain(translate(locale, 'ads.history.statusUnknown'));
      expect(rows[0].children[3].textContent).toBe(translate(locale, 'ads.history.checkUnknown'));
      expect(rows[1].textContent).toContain(translate(locale, 'ads.history.missing'));
      expect(rows[1].children[2].textContent).toBe('—');
      expect(rows[1].querySelector('button')).toBeNull();
      expect(container.textContent).not.toContain(translate(locale, 'ads.inactive'));
      expect(container.querySelector('video, img')).toBeNull();
    }
  });
  it('shows the selected day copy, CTA and observation ID without borrowing current creative facts', async () => {
    await render(createElement(AdHistoryPanel, { workspaceId: 'workspace', adId: 'ad' }));
    await click(container.querySelector('tbody button')!);
    const evidence = container.querySelector('.ws-history-evidence')!;
    expect(evidence.textContent).toContain('Historic copy only');
    expect(evidence.textContent).toContain('Historic CTA');
    expect(evidence.textContent).toContain('observation-day');
    expect(evidence.textContent).toContain(translate('en', 'ads.history.historicMediaNote'));
    expect(evidence.querySelector('video, img')).toBeNull();
    expect(container.querySelector('.ws-history-events details')?.textContent).toContain('before-id');
    expect(container.querySelector('.ws-history-events details')?.textContent).toContain('after-id');
  });
  it('deduplicates event pages and resets pagination, selected day and events when the scope changes', async () => {
    await render(createElement(AdHistoryPanel, { workspaceId: 'workspace', adId: 'ad' }));
    await click(container.querySelector('tbody button')!);
    await click(container.querySelector('.ws-history-more')!);
    expect(container.querySelectorAll('.ws-history-events li')).toHaveLength(2);
    expect(fixture.queries.at(-1)?.eventCursor).toBe('next-events');
    const select = container.querySelectorAll('select')[1];
    await act(async () => { select.value = 'scope-gb'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(fixture.queries.at(-1)).toMatchObject({ scopeHash: 'scope-gb', eventCursor: undefined });
    expect(container.querySelector('.ws-history-evidence')).toBeNull();
    expect(container.querySelectorAll('.ws-history-events li')).toHaveLength(0);
    expect(container.querySelector('tbody tr')?.textContent).toContain(translate('en', 'ads.history.conflict'));
    expect(container.querySelector('.ws-history-more')).toBeNull();
  });
  it('resets event pagination when the date range changes', async () => {
    await render(createElement(AdHistoryPanel, { workspaceId: 'workspace', adId: 'ad' }));
    await click(container.querySelector('.ws-history-more')!);
    const previousFrom = fixture.queries.at(-1)?.from;
    const select = container.querySelector('select')!;
    await act(async () => { select.value = '7'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(fixture.queries.at(-1)?.eventCursor).toBeUndefined();
    expect(fixture.queries.at(-1)?.from).not.toBe(previousFrom);
    expect(container.querySelectorAll('.ws-history-events li')).toHaveLength(1);
  });
  it('labels selected-window days separately from the independent source date span and preserves unknown values', async () => {
    Object.assign(fixture.response!, { summary: { observedDays: 2, activeObservedDays: 1, sourceDateSpanDays: null } });
    await render(createElement(AdHistoryPanel, { workspaceId: 'workspace', adId: 'ad' }));
    const summary = container.querySelector('.ws-history-summary')!;
    expect(summary.textContent).toContain(translate('en', 'ads.history.observedDays'));
    expect(summary.textContent).toContain(translate('en', 'ads.history.activeObservedDays'));
    expect(Array.from(summary.querySelectorAll('dd')).map(node => node.textContent)).toEqual(['2 days', '1 day', translate('en', 'ads.unknown')]);
  });
  it('does not call unfinished daily projection a missing observation', async () => {
    fixture.response = { ...result(), projectionPending: true };
    await render(createElement(AdHistoryPanel, { workspaceId: 'workspace', adId: 'ad' }));
    expect(container.querySelector('.ws-history-pending')?.textContent).toBe(translate('en', 'ads.history.projectionPending'));
    expect(container.querySelectorAll('tbody tr')[1].textContent).toContain(translate('en', 'ads.history.awaitingProjection'));
    expect(container.querySelectorAll('tbody tr')[1].textContent).not.toContain(translate('en', 'ads.history.missing'));
  });
  it('shows selected source fields and separate image and video captures in four languages', async () => {
    fixture.evidence['observation-day'] = { ...evidenceResult(), media: captures() };
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'es'] as const) {
      await render(createElement(AdHistoryPanel, { workspaceId: 'workspace', adId: 'ad' }), locale);
      await click(container.querySelector('tbody button')!);
      const evidence = container.querySelector('.ws-history-evidence')!;
      expect(evidence.textContent).toContain('Historic advertiser');
      expect(evidence.textContent).toContain('source-advertiser-9');
      expect(evidence.textContent).toContain('FR, DE');
      expect(evidence.textContent).toContain('facebook, instagram');
      expect(evidence.textContent).toContain('fr, de');
      expect(evidence.textContent).toContain('https://landing.example/historic');
      expect(evidence.textContent).toContain('2026-09-30');
      expect(evidence.textContent).toContain('2026-10-08T02:30:00Z');
      expect(evidence.querySelector('img')?.getAttribute('src')).toBe('https://preview.example/captured.png?signature=temporary');
      expect(evidence.querySelector('video')?.getAttribute('src')).toBe('https://preview.example/captured.mp4?signature=temporary');
      const versions = evidence.querySelectorAll('.ws-history-media-capture');
      expect(versions).toHaveLength(2);
      expect(versions[0].textContent).toContain('a'.repeat(64));
      expect(versions[1].textContent).toContain('b'.repeat(64));
      expect(versions[0].textContent).toContain('image/png');
      expect(versions[1].textContent).toContain('video/mp4');
      expect(versions[0].querySelector('.ws-history-download-time time')?.getAttribute('datetime')).toBe('2026-10-08T01:05:00Z');
      expect(versions[1].querySelector('.ws-history-download-time time')?.getAttribute('datetime')).toBe('2026-10-08T04:00:00Z');
      for (const key of ['ads.history.historicMediaNote', 'ads.history.archiveMedia', 'ads.history.downloadedAt', 'ads.history.recordedAt', 'ads.history.sourceUrlMatch']) expect(evidence.textContent).toContain(translate(locale, key));
      expect(evidence.textContent).not.toMatch(/ads\.history\.[A-Za-z]+/);
      expect(evidence.textContent).not.toContain('signature=temporary');
      expect(fixture.evidenceQueries.at(-1)).toEqual({ workspaceId: 'workspace', adId: 'ad', observationId: 'observation-day' });
    }
  });
  it('keeps unknown download time separate from archive recording time', async () => {
    fixture.evidence['observation-day'] = { ...evidenceResult(), media: [{ ...captures()[0], downloadedAt: null, displayUrl: null, displayUrlExpiresAt: null }] };
    await render(createElement(AdHistoryPanel, { workspaceId: 'workspace', adId: 'ad' }));
    await click(container.querySelector('tbody button')!);
    const capture = container.querySelector('.ws-history-media-capture')!;
    expect(capture.querySelector('.ws-history-download-time dd')?.textContent).toBe('Unknown');
    expect(capture.querySelector('.ws-history-download-time time')).toBeNull();
    expect(capture.querySelector('.ws-history-recorded-time time')?.getAttribute('datetime')).toBe('2026-10-08T01:06:00Z');
    expect(capture.textContent).toContain(translate('en', 'ads.history.previewUnavailable'));
    expect(capture.querySelector('img, video')).toBeNull();
  });
  it('shows no archive for an older observation instead of reusing another selected day media', async () => {
    fixture.response = { ...result(), days: [observed, { ...observed, day: '2026-10-07', latestObservationId: 'observation-yesterday', body: 'Yesterday copy' }] };
    fixture.evidence['observation-day'] = { ...evidenceResult(), media: captures() };
    fixture.evidence['observation-yesterday'] = { ...evidenceResult(), observationId: 'observation-yesterday', advertiserName: null, advertiserId: null, reportedCountries: [], publisherPlatforms: [], adLanguages: [], landingPageUrl: null, sourceStartedAt: null, sourceEndedAt: null };
    await render(createElement(AdHistoryPanel, { workspaceId: 'workspace', adId: 'ad' }));
    await click(container.querySelectorAll('tbody button')[0]);
    expect(container.querySelectorAll('.ws-history-evidence img, .ws-history-evidence video')).toHaveLength(2);
    await click(container.querySelectorAll('tbody button')[1]);
    const evidence = container.querySelector('.ws-history-evidence')!;
    expect(evidence.textContent).toContain('Yesterday copy');
    expect(evidence.textContent).toContain(translate('en', 'ads.history.noArchivedMedia'));
    expect(evidence.querySelector('img, video')).toBeNull();
    expect(evidence.textContent).not.toContain('Historic advertiser');
    expect(evidence.textContent).not.toContain('FR, DE');
    expect(evidence.textContent).not.toContain('2026-09-30');
  });
  it('rejects cached evidence for a different observation', async () => {
    fixture.evidence['observation-day'] = { ...evidenceResult(), observationId: 'different-observation', media: captures() };
    await render(createElement(AdHistoryPanel, { workspaceId: 'workspace', adId: 'ad' }));
    await click(container.querySelector('tbody button')!);
    expect(container.querySelector('.ws-history-evidence img, .ws-history-evidence video')).toBeNull();
    expect(container.querySelector('.ws-history-evidence')?.textContent).not.toContain('Historic advertiser');
    expect(container.querySelector('.ws-history-evidence [role="alert"]')?.textContent).toContain(translate('en', 'ads.history.evidenceUnavailable'));
  });
  it('shows an explicit missing archive in all four languages', async () => {
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'es'] as const) {
      await render(createElement(AdHistoryPanel, { workspaceId: 'workspace', adId: 'ad' }), locale);
      await click(container.querySelector('tbody button')!);
      expect(container.querySelector('.ws-history-evidence')?.textContent).toContain(translate(locale, 'ads.history.noArchivedMedia'));
      expect(container.querySelector('.ws-history-evidence img, .ws-history-evidence video')).toBeNull();
    }
  });
  it('renders selected static evidence without a workspace or an API request', async () => {
    await render(createElement(HistoryEvidence, { data: result(), selectedKey: '2026-10-08:scope-us', onSelect: () => {} }));
    expect(container.querySelector('.ws-history-evidence')?.textContent).toContain('Historic copy only');
    expect(fixture.evidenceQueries).toEqual([]);
  });
  it('retains archive metadata when a signed preview fails to load', async () => {
    fixture.evidence['observation-day'] = { ...evidenceResult(), media: [captures()[0]] };
    await render(createElement(AdHistoryPanel, { workspaceId: 'workspace', adId: 'ad' }));
    await click(container.querySelector('tbody button')!);
    await act(async () => container.querySelector('.ws-history-media-capture img')!.dispatchEvent(new Event('error')));
    const capture = container.querySelector('.ws-history-media-capture')!;
    expect(capture.querySelector('img')).toBeNull();
    expect(capture.textContent).toContain(translate('en', 'ads.history.previewUnavailable'));
    expect(capture.textContent).toContain('a'.repeat(64));
    expect(capture.querySelector('.ws-history-download-time time')?.getAttribute('datetime')).toBe('2026-10-08T01:05:00Z');
  });
});
