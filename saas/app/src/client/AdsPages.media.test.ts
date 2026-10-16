// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdDetailResult, AdView, AppState, MediaView, ResearchPageResult, SearchResult } from './types';
import { WorkspaceLocaleProvider } from './workspace-i18n/locale';
import { translate } from './workspace-i18n/messages';
import type { Locale } from './landing/messages';

const fixture = vi.hoisted(() => ({
  state: null as AppState | null,
  search: null as SearchResult | null,
  detail: null as AdDetailResult | null,
  research: null as ResearchPageResult | null,
  related: { ads: [], total: 0, nextCursor: null, asOf: '2026-10-08T00:00:00Z', anchorIdentity: null } as import('./types').RelatedAdsResult,
  history: { timezone: 'Asia/Shanghai', asOf: '2026-10-08T00:00:00Z', from: '2026-10-01', to: '2026-10-08', scopes: [], days: [], events: [], nextEventCursor: null, projectionPending: false, summary: { observedDays: 0, activeObservedDays: 0, conflictDays: 0, firstObservedAt: null, lastObservedAt: null, sourceStartedAt: null, sourceEndedAt: null, sourceDateSpanDays: null, spanEndAt: null, spanBasis: null, scope: 'selected-window' } },
  download: vi.fn(),
  recover: vi.fn(),
  revision: 1,
  refetch: vi.fn(async () => ({ isSuccess: true })),
}));
vi.mock('wasp/client/operations', () => ({
  searchPublicAds: 'search', getPublicAd: fixture.recover, getResearchPage: 'research', getPublicAdHistory: 'history', getPublicAdHistoryEvidence: 'evidence', getPublicRelatedAds: 'related', getPublicAdMediaDownload: fixture.download,
  useQuery: (operation: 'search' | 'research' | 'related' | 'history' | typeof fixture.recover) => ({
    data: typeof operation === 'function' ? fixture.detail : fixture[operation], dataUpdatedAt: fixture.revision, refetch: fixture.refetch,
    isLoading: false, isFetching: false, error: null,
  }),
}));
vi.mock('./App', () => ({
  useApp: () => ({ state: fixture.state, refresh: async () => undefined, commandVersion: 0 }),
  canEdit: () => true,
  workspaceHref: (path: string, workspaceId: string) => `${path}?workspace=${workspaceId}`,
  formText: (data: FormData, key: string) => String(data.get(key) ?? '').trim(),
  track: vi.fn(),
  Field: ({ label, children }: { label: string; children: ReactNode }) => createElement('label', null, label, children),
  PageHeader: ({ title }: { title: string }) => createElement('h1', null, title),
  Status: ({ value }: { value?: string }) => createElement('span', null, value),
  SourceLink: ({ children }: { children: ReactNode }) => createElement('span', null, children),
  CommandForm: ({ children }: { children: ReactNode }) => createElement('form', null, children),
  CommandButton: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => createElement('button', { disabled }, children),
  Loading: () => createElement('p', null, 'Loading'),
  Empty: ({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) => createElement('section', null, title, children, action),
}));
import { AdDetailPage, AdsPage, MediaPlayer } from './AdsPages';
import { ResearchPage } from './ResearchPage';
import { WorkspacePage } from './WorkspacePages';

const video: MediaView = { id: 'video', type: 'VIDEO', status: 'READY', displayUrl: 'https://media.example.test/creative.mp4?signature=synthetic', displayUrlExpiresAt: '2099-01-01T00:00:00Z' };
const image: MediaView = { id: 'image', type: 'IMAGE', status: 'READY', displayUrl: 'https://media.example.test/creative.jpg?signature=synthetic', displayUrlExpiresAt: '2099-01-01T00:00:00Z' };
const ad: AdView = {
  id: 'ad', sourceAdId: 'source', advertiserName: null, headline: 'Actual creative headline', copy: 'Actual creative copy',
  sourceUrl: 'https://source.example.test/ad', publisherPlatforms: ['facebook'], status: 'ACTIVE',
  firstObservedAt: '2026-10-01T00:00:00Z', lastObservedAt: '2026-10-07T00:00:00Z', media: [video],
};
let container: HTMLDivElement;
let root: Root;
function app(node: ReactNode, locale: Locale = 'en', path = '/app/ads') {
  return createElement(MemoryRouter, { key: `${locale}:${path}`, initialEntries: [`${path}?workspace=workspace&lang=${locale}`] },
    createElement(WorkspaceLocaleProvider, null, createElement(Routes, null,
      createElement(Route, { path: '/app/ads/:adId', element: node }),
      createElement(Route, { path: '*', element: node }))));
}
async function render(node: ReactNode, locale: Locale = 'en', path = '/app/ads') {
  await act(async () => root.render(app(node, locale, path)));
}
async function dispatch(element: Element, event: string) {
  await act(async () => element.dispatchEvent(new Event(event, { bubbles: true })));
}
const detailLinks = () => Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href*="/app/ads/ad?"]'));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  localStorage.clear();
  fixture.refetch.mockReset().mockResolvedValue({ isSuccess: true });
  fixture.download.mockReset().mockResolvedValue({ url: 'http://unsafe.example.test/creative', expiresAt: new Date(Date.now() + 60000).toISOString() });
  fixture.revision = 1;
  fixture.related = { ads: [], total: 0, nextCursor: null, asOf: '2026-10-08T00:00:00Z', anchorIdentity: null };
  const workspace = { id: 'workspace', organizationId: 'org', name: 'Real workspace name' };
  const saved = { id: 'saved', adId: ad.id, advertiserName: null, copy: ad.copy, savedAt: '2026-10-07T00:00:00Z' };
  fixture.state = {
    user: { id: 'member', email: 'member@example.test', displayName: 'Member', isAdmin: false },
    role: 'EDITOR', organizations: [], workspaces: [workspace], selectedWorkspace: workspace,
    overview: { savedCount: 1, analysisCount: 1, pendingAnalysisCount: 0, dataUpdatedAt: null, sourceHealth: { status: 'HEALTHY' } },
    research: { folders: [], savedAds: [saved], notes: [], analyses: [] }, billing: null, members: [],
  };
  fixture.search = { ads: [{ ...ad, media: [{ ...video }] }], nextCursor: null, summary: { total: 1, images: 0, videos: 1 }, sourceHealth: { status: 'HEALTHY' } };
  fixture.detail = { ad: { ...ad }, media: [{ ...video }], observations: [], advertiserSummary: null };
  fixture.recover.mockReset().mockImplementation(async () => fixture.detail);
  fixture.research = {
    kind: 'saved', total: 1, asOf: '2026-10-07T00:00:00Z', nextCursor: null,
    savedAds: [{ ...saved, notes: [] }],
    analyses: [{ id: 'analysis', adId: ad.id, advertiserName: null, status: 'SUCCEEDED', createdAt: saved.savedAt, result: { facts: 'Actual analysis facts' } }],
  };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('media rendering from public DTOs', () => {
  it.each(['Facebook', 'Instagram', 'TikTok', 'Snapchat'])('renders the observed %s advertiser logo separately from the platform in results and detail', async platform => {
    const logo = 'https://cdn.example/observed-advertiser-logo.png';
    const branded = { ...ad, advertiserName: 'Observed Brand', advertiserAvatarUrl: logo, publisherPlatforms: [platform] };
    fixture.search!.ads[0] = branded;
    await render(createElement(AdsPage));
    expect(container.querySelector('.ad-card .ad-brand-logo img')?.getAttribute('src')).toBe(logo);
    expect(container.querySelector('.ad-card .ad-platform-logos img')?.getAttribute('alt')).toBe(platform);
    fixture.detail!.ad = branded;
    await render(createElement(AdDetailPage), 'en', '/app/ads/ad');
    expect(container.querySelector('.ws-detail-identity .ad-brand-logo img')?.getAttribute('src')).toBe(logo);
    expect(container.querySelector('.ws-detail-identity .ad-platform-logos img')?.getAttribute('alt')).toBe(platform);
  });

  it('keeps a decoded image visible after its signature expires during a long stay', async () => {
    vi.useFakeTimers();
    try {
      const media = { ...image, displayUrlExpiresAt: new Date(Date.now() + 300_000).toISOString() };
      await render(createElement(MediaPlayer, { media, compact: true }));
      const preview = container.querySelector('.media-view img')!;
      await dispatch(preview, 'load');
      vi.advanceTimersByTime(301_000);
      await render(createElement(MediaPlayer, { media, compact: true, revision: 2 }));
      expect(container.querySelector('.media-view img')).toBe(preview);
      expect(preview.closest('.media-view')?.classList.contains('media-loaded')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('retains the loaded video and playback position when a manual refresh supplies another signature', async () => {
    await render(createElement(MediaPlayer, { media: video, revision: 1 }));
    const preview = container.querySelector('video')!;
    preview.currentTime = 17;
    await dispatch(preview, 'loadedmetadata');
    await render(createElement(MediaPlayer, { media: { ...video, displayUrl: 'https://media.example.test/creative.mp4?signature=renewed' }, revision: 2 }));
    expect(container.querySelector('video')).toBe(preview);
    expect(preview.currentTime).toBe(17);
    expect(preview.getAttribute('src')).toBe(video.displayUrl);
    expect(container.querySelector('.media-loading')).toBeNull();
  });

  it('keeps a failed card local without querying new signatures or disturbing another decoded preview', async () => {
    fixture.search!.ads = [
      { ...ad, id: 'ad', media: [{ ...image }] },
      { ...ad, id: 'other', media: [{ ...image, id: 'other-image', displayUrl: 'https://media.example.test/other.jpg?signature=synthetic' }] },
    ];
    fixture.detail!.media = [{ ...image, displayUrl: 'https://media.example.test/creative.jpg?signature=renewed' }];
    await render(createElement(AdsPage));
    const previews = container.querySelectorAll('.media-view img');
    await dispatch(previews[1], 'load');
    await dispatch(previews[0], 'error');
    expect(fixture.recover).not.toHaveBeenCalled();
    expect(fixture.refetch).not.toHaveBeenCalled();
    expect(container.querySelector('.ad-card .media-unavailable')).not.toBeNull();
    expect(container.querySelector('.media-view img')).toBe(previews[1]);
    expect(previews[1].closest('.media-view')?.classList.contains('media-loaded')).toBe(true);
  });

  it('uses an already renewed signature if the retained video later needs another network request', async () => {
    await render(createElement(MediaPlayer, { media: video }));
    await dispatch(container.querySelector('video')!, 'loadedmetadata');
    await render(createElement(MediaPlayer, { media: { ...video, displayUrl: 'https://media.example.test/creative.mp4?signature=renewed' }, revision: 2 }));
    await dispatch(container.querySelector('video')!, 'error');
    expect(container.querySelector('video')?.getAttribute('src')).toContain('signature=renewed');
  });

  it('replaces a loaded preview when the actual asset changes rather than just its signature', async () => {
    await render(createElement(MediaPlayer, { media: image, compact: true }));
    const original = container.querySelector('.media-view img')!;
    await dispatch(original, 'load');
    await render(createElement(MediaPlayer, { media: { ...image, displayUrl: 'https://media.example.test/new-asset.jpg?signature=new' }, compact: true, revision: 2 }));
    expect(container.querySelector('.media-view img')).not.toBe(original);
    expect(container.querySelector('.media-view img')?.getAttribute('src')).toContain('/new-asset.jpg');
    expect(container.querySelector('.media-loaded')).toBeNull();
  });

  it('keeps expired lazy media idle for ten minutes until the user refreshes', async () => {
    vi.useFakeTimers();
    try {
      fixture.search!.ads[0].media = [{ ...image, displayUrlExpiresAt: new Date(Date.now() - 1).toISOString() }];
      await render(createElement(AdsPage));
      vi.advanceTimersByTime(601_000);
      await render(createElement(AdsPage));
      expect(container.querySelector('.media-view img')).toBeNull();
      expect(fixture.recover).not.toHaveBeenCalled();
      expect(fixture.refetch).not.toHaveBeenCalled();
      await dispatch(container.querySelector('.results-heading button')!, 'click');
      expect(fixture.refetch).toHaveBeenCalledTimes(1);
      fixture.search!.ads[0].media = [{ ...image, displayUrl: 'https://media.example.test/creative.jpg?signature=manual', displayUrlExpiresAt: new Date(Date.now() + 300_000).toISOString() }];
      fixture.revision++;
      await render(createElement(AdsPage));
      expect(container.querySelector('.media-view img')?.getAttribute('src')).toContain('signature=manual');
    } finally { vi.useRealTimers(); }
  });

  it('keeps expired detail media idle and preserves its manual refresh action', async () => {
    fixture.detail!.media = [{ ...image, displayUrlExpiresAt: '2020-01-01T00:00:00Z' }];
    await render(createElement(AdDetailPage), 'en', '/app/ads/ad');
    expect(container.querySelector('.detail-media-stage img')).toBeNull();
    expect(fixture.refetch).not.toHaveBeenCalled();
    await dispatch(container.querySelector('.media-toolbar button')!, 'click');
    expect(fixture.refetch).toHaveBeenCalledTimes(1);
  });

  it('shows a detail loading timeout without automatically refetching', async () => {
    vi.useFakeTimers();
    try {
      await render(createElement(AdDetailPage), 'en', '/app/ads/ad');
      await act(async () => vi.advanceTimersByTime(20_001));
      expect(container.querySelector('.detail-media-stage .media-unavailable')).not.toBeNull();
      expect(fixture.refetch).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('shows an already decoded cached image on mount and after query refresh without a second load event', async () => {
    const complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    const width = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(1400);
    try {
      await render(createElement(MediaPlayer, { media: image, compact: true, revision: 1 }));
      expect(container.querySelector('.media-view')?.classList.contains('media-loaded')).toBe(true);
      expect(container.querySelector('.media-loading')).toBeNull();
      await render(createElement(MediaPlayer, { media: image, compact: true, revision: 2 }));
      expect(container.querySelector('.media-view')?.classList.contains('media-loaded')).toBe(true);
      expect(container.querySelector('.media-loading')).toBeNull();
    } finally { complete.mockRestore(); width.mockRestore(); }
  });

  it('shows a cached video frame without waiting for a repeated loadeddata event', async () => {
    const state = vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(2);
    try {
      await render(createElement(MediaPlayer, { media: video, compact: true }));
      expect(container.querySelector('.video-preview')?.classList.contains('media-loaded')).toBe(true);
    } finally { state.mockRestore(); }
  });

  it('renders a READY video without a poster as an inline muted first-frame preview without autoplay', async () => {
    await render(createElement(AdsPage));
    const preview = container.querySelector<HTMLVideoElement>('.ad-card video')!;
    expect(preview).not.toBeNull();
    expect(preview.muted).toBe(true);
    expect(preview.playsInline).toBe(true);
    expect(preview.preload).toBe('metadata');
    expect(preview.autoplay).toBe(false);
    expect(preview.controls).toBe(false);
    expect(preview.getAttribute('src')).toBe(`${video.displayUrl}#t=0.1`);
    expect(preview.closest('.video-preview')?.textContent).toContain(translate('en', 'ads.videoCreative'));
    await dispatch(preview, 'loadeddata');
    expect(preview.closest('.media-view')?.classList.contains('media-loaded')).toBe(true);
    expect(fixture.refetch).not.toHaveBeenCalled();
  });

  it('falls back from a broken optional poster to the real video without refreshing the query', async () => {
    await render(createElement(MediaPlayer, { media: { ...video, posterUrl: 'https://media.example.test/poster.jpg' }, compact: true }));
    await dispatch(container.querySelector('.media-view img')!, 'error');
    expect(container.querySelector('.media-view img')).toBeNull();
    expect(container.querySelector('video')?.getAttribute('src')).toBe(`${video.displayUrl}#t=0.1`);
    expect(fixture.refetch).not.toHaveBeenCalled();
  });

  it('prefers a READY image over failed/video entries, then exposes the next usable asset on request failure', async () => {
    fixture.search!.ads[0].media = [{ id: 'failed', type: 'IMAGE', status: 'FAILED' }, { ...video }, { ...image }];
    await render(createElement(AdsPage));
    expect(container.querySelector('.ad-card .ad-card-media img')?.getAttribute('src')).toBe(image.displayUrl);
    await dispatch(container.querySelector('.ad-card .ad-card-media img')!, 'error');
    expect(container.querySelector('.ad-card video')?.getAttribute('src')).toBe(`${video.displayUrl}#t=0.1`);
    expect(fixture.recover).not.toHaveBeenCalled();
    expect(fixture.refetch).not.toHaveBeenCalled();
    await dispatch(container.querySelector('.ad-card video')!, 'error');
    expect(container.querySelector('.ad-card .media-unavailable')).not.toBeNull();
    expect(fixture.recover).not.toHaveBeenCalled();
  });

  it('accepts a manually refreshed URL without automatically querying when any replacement fails', async () => {
    fixture.search!.ads[0].media = [{ ...image }];
    await render(createElement(AdsPage));
    await dispatch(container.querySelector('.ad-card .ad-card-media img')!, 'error');
    fixture.search!.ads[0].media = [{ ...image, displayUrl: 'https://media.example.test/creative.jpg?signature=synthetic-new' }];
    fixture.revision++;
    await render(createElement(AdsPage));
    expect(container.querySelector('.ad-card .ad-card-media img')?.getAttribute('src')).toContain('synthetic-new');
    await dispatch(container.querySelector('.ad-card .ad-card-media img')!, 'error');
    expect(fixture.recover).not.toHaveBeenCalled();
    const refresh = container.querySelector('.results-heading button')!;
    await dispatch(refresh, 'click');
    expect(fixture.refetch).toHaveBeenCalledTimes(1);
    fixture.revision++;
    await render(createElement(AdsPage));
    expect(container.querySelector('.ad-card .ad-card-media img')).not.toBeNull();
    await dispatch(container.querySelector('.ad-card .ad-card-media img')!, 'error');
    expect(fixture.refetch).toHaveBeenCalledTimes(1);
    expect(fixture.recover).not.toHaveBeenCalled();
  });

  it('does not refresh an expired list DTO automatically and retains accessible manual refresh', async () => {
    fixture.search!.ads[0].media = [{ ...image, displayUrlExpiresAt: '2020-01-01T00:00:00Z' }];
    await render(createElement(AdsPage));
    expect(container.querySelector('.ad-card .ad-card-media img')).toBeNull();
    expect(fixture.recover).not.toHaveBeenCalled();
    fixture.revision++;
    await render(createElement(AdsPage));
    expect(fixture.recover).not.toHaveBeenCalled();
    expect(fixture.refetch).not.toHaveBeenCalled();
    expect(container.querySelector('.results-heading button')?.textContent).toBe(translate('en', 'ads.refreshMedia'));
  });

  it('opens detail on the best usable asset and preserves an explicit selection of a failed asset', async () => {
    fixture.detail!.media = [{ id: 'failed', type: 'IMAGE', status: 'FAILED' }, { ...video }, { ...image }];
    await render(createElement(AdDetailPage), 'en', '/app/ads/ad');
    expect(container.querySelector('.detail-media-stage img')?.getAttribute('src')).toBe(image.displayUrl);
    expect(container.querySelectorAll('.media-picker button')[2].getAttribute('aria-pressed')).toBe('true');
    await dispatch(container.querySelectorAll('.media-picker button')[0], 'click');
    expect(container.querySelector('.detail-media-stage .media-unavailable')).not.toBeNull();
    fixture.detail = { ...fixture.detail!, media: [...fixture.detail!.media] };
    fixture.revision++;
    await render(createElement(AdDetailPage), 'en', '/app/ads/ad');
    expect(container.querySelectorAll('.media-picker button')[0].getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.detail-media-stage .media-unavailable')).not.toBeNull();
  });
});

describe('missing advertiser names retain usable navigation', () => {
  it('omits empty card headings and retains detail links in all four languages', async () => {
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'es'] as const) {
      await render(createElement(AdsPage), locale);
      expect(container.querySelector('.ad-card h3')).toBeNull();
      expect(container.querySelector('.ad-card-media')?.getAttribute('aria-label')).toBe(translate(locale, 'ads.viewDetails'));
      expect(detailLinks().length).toBeGreaterThan(0);
      for (const link of detailLinks()) expect(link.href).toContain(`lang=${locale}`);
    }
  });

  it('uses the creative headline, or a translated detail title, when the advertiser is absent', async () => {
    await render(createElement(AdDetailPage), 'en', '/app/ads/ad');
    expect(container.querySelector('h1')?.textContent).toBe(ad.headline);
    fixture.detail!.ad.headline = '  ';
    await render(createElement(AdDetailPage), 'es', '/app/ads/ad');
    expect(container.querySelector('h1')?.textContent).toBe(translate('es', 'ads.detail'));
  });

  it('keeps saved, analysis and recent-saved links readable without invented advertiser names', async () => {
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'es'] as const) {
      await render(createElement(ResearchPage), locale, '/app/research');
      expect(container.querySelector('.saved-heading h3')).toBeNull();
      expect(detailLinks()[0].textContent).toBe(ad.copy);
      await dispatch(container.querySelectorAll('[role="tab"]')[1], 'click');
      expect(detailLinks()[0].textContent).toBe(translate(locale, 'research.viewDetails'));
      await render(createElement(WorkspacePage), locale, '/app/overview');
      expect(detailLinks()[0].textContent).toContain(ad.copy);
    }
    fixture.research!.savedAds[0].copy = null;
    fixture.state!.research.savedAds[0].copy = null;
    await render(createElement(ResearchPage), 'en', '/app/research');
    expect(detailLinks()[0].textContent).toBe(translate('en', 'research.viewDetails'));
    await render(createElement(WorkspacePage), 'en', '/app/overview');
    expect(detailLinks()[0].querySelector('strong')?.textContent).toBe(translate('en', 'ads.viewDetails'));
  });

  it('still presents actual advertiser names received from the server', async () => {
    fixture.search!.ads[0].advertiserName = 'Actual advertiser';
    await render(createElement(AdsPage));
    expect(container.querySelector('.ad-card h3')?.textContent).toBe('Actual advertiser');
    fixture.detail!.ad.advertiserName = 'Actual advertiser';
    await render(createElement(AdDetailPage), 'en', '/app/ads/ad');
    expect(container.querySelector('h1')?.textContent).toBe('Actual advertiser');
  });
});

describe('ad library fact boundaries', () => {
  it('normalizes source status and keeps unavailable advertiser counts distinct from zero', async () => {
    fixture.detail!.ad.status = 'active';
    await render(createElement(AdDetailPage), 'en', '/app/ads/ad');
    expect(container.querySelector('.ws-detail-status-strip')?.textContent).toContain('active');
    expect(container.querySelector('.ws-detail-advertiser-missing')?.textContent).toContain(translate('en', 'ads.detail.advertiserUnavailable'));
    expect(container.querySelector('.ws-detail-advertiser .ws-detail-metrics')).toBeNull();
  });

  it('keeps the selected creative mounted while navigating history and related tabs', async () => {
    await render(createElement(AdDetailPage), 'en', '/app/ads/ad');
    const stage = container.querySelector('.detail-media-stage');
    const tabs = container.querySelectorAll('[role="tab"]');
    expect(container.querySelector('.ws-ad-history')).toBeNull();
    await dispatch(tabs[1], 'click');
    expect(container.querySelector('.ws-ad-history')).not.toBeNull();
    expect(container.querySelector('.detail-media-stage')).toBe(stage);
    await dispatch(tabs[2], 'click');
    expect(container.querySelector('.ws-detail-related')).not.toBeNull();
    expect(container.querySelector('.detail-media-stage')).toBe(stage);
    expect(container.querySelector('.ws-ad-history')).toBeNull();
    await dispatch(tabs[0], 'click');
    expect(container.querySelector('.ws-detail-facts')).not.toBeNull();
  });

  it('requests a permission-checked attachment and refuses unsafe download links', async () => {
    fixture.detail!.media = [{ ...image }];
    await render(createElement(AdDetailPage), 'en', '/app/ads/ad');
    const download = container.querySelector<HTMLButtonElement>('.ws-detail-download')!;
    expect(download.disabled).toBe(false);
    expect(container.querySelector('a[download]')).toBeNull();
    await dispatch(download, 'click');
    expect(fixture.download).toHaveBeenCalledWith({ workspaceId: 'workspace', adId: 'ad', mediaId: image.id });
    expect(container.querySelector('.ws-detail-copy-notice[role="alert"]')?.textContent).toBe(translate('en', 'error.unavailable'));
  });

  it('hides related ads when the collector has reassigned the advertiser or source and offers detail refresh', async () => {
    Object.assign(fixture.detail!.ad, { advertiserId: 'advertiser-A', dataSourceKey: 'meta' });
    fixture.related = { ads: [{ ...ad, id: 'other-ad', headline: 'Unrelated advertiser creative' }], total: 1, nextCursor: null, asOf: '2026-10-08T00:00:00Z', anchorIdentity: { sourceAdvertiserId: 'advertiser-B', dataSourceKey: 'meta' } };
    await render(createElement(AdDetailPage), 'en', '/app/ads/ad');
    await dispatch(container.querySelectorAll('[role="tab"]')[2], 'click');
    expect(container.textContent).toContain(translate('en', 'ads.detail.relatedChanged'));
    expect(container.querySelector('.ws-detail-related-card')).toBeNull();
    const refresh = Array.from(container.querySelectorAll('button')).find(button => button.textContent === translate('en', 'ads.detail.refreshDetail'))!;
    await dispatch(refresh, 'click');
    expect(fixture.refetch).toHaveBeenCalled();
    fixture.related.anchorIdentity = { sourceAdvertiserId: 'advertiser-A', dataSourceKey: 'google' };
    await render(createElement(AdDetailPage), 'en', '/app/ads/ad');
    expect(container.querySelector('.ws-detail-related-card')).toBeNull();
    fixture.related.anchorIdentity = { sourceAdvertiserId: 'advertiser-A', dataSourceKey: 'meta' };
    await render(createElement(AdDetailPage), 'en', '/app/ads/ad');
    expect(container.querySelector('.ws-detail-related-card')?.textContent).toContain('Unrelated advertiser creative');
  });

  it('does not offer download for an unavailable asset or ask the server for its source URL', async () => {
    fixture.detail!.media = [{ ...image, status: 'FAILED' }];
    await render(createElement(AdDetailPage), 'en', '/app/ads/ad');
    expect(container.querySelector<HTMLButtonElement>('.ws-detail-download')?.disabled).toBe(true);
    expect(fixture.download).not.toHaveBeenCalled();
  });

  it('offers every supported publishing platform while preserving existing media rendering', async () => {
    await render(createElement(AdsPage));
    expect(Array.from(container.querySelectorAll('select[name="platform"] option')).map(option => (option as HTMLOptionElement).value)).toEqual(['', 'facebook', 'instagram', 'messenger', 'audience_network', 'google', 'youtube', 'tiktok', 'pinterest', 'snapchat']);
  });

  it('distinguishes source-reported countries and date spans from query country and lifetime observed days', async () => {
    Object.assign(fixture.detail!.ad, { dataSourceKey: 'meta', advertiserId: 'advertiser-actual', reportedCountries: ['US'], cta: 'Shop now', statusObservedAt: '2026-10-07T00:00:00Z', deliverySummary: { sourceDateSpanDays: 7, observedDays: 2, activeObservedDays: 1 } });
    fixture.detail!.observations = [{ id: 'observation', observedAt: '2026-10-07T00:00:00Z', sourceStatus: 'ACTIVE', queryCountry: 'GB' }];
    await render(createElement(AdDetailPage), 'en', '/app/ads/ad');
    const values = new Map(Array.from(container.querySelectorAll('.detail-information .metadata-list > div')).map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent]));
    expect(values.get(translate('en', 'ads.reportedCountries'))).toBe('United States');
    expect(values.get(translate('en', 'ads.source'))).toBe('meta');
    expect(values.get(translate('en', 'ads.advertiserId'))).toBe('advertiser-actual');
    expect(values.get(translate('en', 'ads.callToAction'))).toBe('Shop now');
    expect(values.get(translate('en', 'ads.sourceDateSpan'))).toBe('7 days');
    expect(values.get(translate('en', 'ads.detail.observedDays'))).toBe('2 days');
    expect(values.get(translate('en', 'ads.detail.activeObservedDays'))).toBe('1 day');
    expect(container.querySelector('.ws-observations tbody tr')?.lastElementChild?.textContent).toBe('GB');
    fixture.detail!.ad.deliverySummary = undefined;
    await render(createElement(AdDetailPage), 'en', '/app/ads/ad');
    const unknownValues = new Map(Array.from(container.querySelectorAll('.ws-detail-facts .metadata-list > div')).map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent]));
    expect(unknownValues.get(translate('en', 'ads.sourceDateSpan'))).toBe(translate('en', 'ads.unknown'));
    expect(unknownValues.get(translate('en', 'ads.detail.observedDays'))).toBe(translate('en', 'ads.unknown'));
    expect(unknownValues.get(translate('en', 'ads.detail.activeObservedDays'))).toBe(translate('en', 'ads.unknown'));
  });
});

describe('format-aware library presentation',()=>{
 it('keeps a complete text-only detail free of missing-media and download controls',async()=>{
  fixture.detail={ad:{...ad,mediaType:'TEXT',headline:'Native search headline',copy:'Native description',media:[]},media:[],observations:[],advertiserSummary:null};
  await render(createElement(AdDetailPage),'en','/app/ads/ad');
  expect(container.querySelector('.media-unavailable')).toBeNull();
  expect(container.querySelector('.ws-detail-download')).toBeNull();
  expect(container.querySelector('.ws-detail-fact-columns')?.textContent).toContain('Text ads');
 });
 it('uses native text content without an unavailable-media placeholder',async()=>{
  fixture.search!.ads=[{...ad,mediaType:'TEXT',headline:'Native search headline',copy:'Native description',media:[]}];
  await render(createElement(AdsPage));
  expect(container.querySelector('.ad-card-text')?.textContent).toContain('Native search headline');
  expect(container.querySelector('.ad-card .media-unavailable')).toBeNull();
 });
 it('shows a complete original preview when text fields are unavailable',async()=>{
  fixture.search!.ads=[{...ad,mediaType:'TEXT',headline:null,copy:null,media:[image]}];
  await render(createElement(AdsPage));
  expect(container.querySelector('.ad-card-original-preview img')).not.toBeNull();
  expect(container.querySelector('.ad-card')?.textContent).toContain('Original preview');
 });
});
