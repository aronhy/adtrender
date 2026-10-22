// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider, useQuery as useReactQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdView, AppCommand, AppState, ResearchPageResult } from '../types';

const rpc = vi.hoisted(() => ({
  state: null as AppState | null,
  studio: { preferences: { defaultDays: 14, defaultStartPage: 'ads', brandChanges: true, emailDigest: false, weeklySummary: true, collectionUpdates: false }, subscriptionEvents: [] },
  research: null as ResearchPageResult | null,
  getCustomerSnapshot: vi.fn().mockName('snapshot'), getAppState: vi.fn().mockName('app'), getStudioState: vi.fn().mockName('studio'),
  getResearchPage: vi.fn().mockName('research'), searchPublicAds: vi.fn().mockName('search'),
  getStudioCatalog: vi.fn().mockName('catalog'), getPublicAd: vi.fn().mockName('ad'),
  getPublicAdHistory: vi.fn().mockName('history'), getPublicRelatedAds: vi.fn().mockName('related'),
  command: vi.fn(), studioCommand: vi.fn(),
}));
vi.mock('wasp/client/auth', () => ({ useAuth: () => ({ data: { id: 'user' }, isLoading: false, error: null }), logout: vi.fn() }));
vi.mock('wasp/client/operations', () => ({
  getExtensionConnections: vi.fn(async () => ({ extensionId: null, storeUrl: null, tokens: [] })),
  getCustomerSnapshot:rpc.getCustomerSnapshot, getAppState: rpc.getAppState, getStudioState: rpc.getStudioState, getResearchPage: rpc.getResearchPage,
  searchPublicAds: rpc.searchPublicAds, getStudioCatalog: rpc.getStudioCatalog,
  getPublicAd: rpc.getPublicAd, getPublicAdHistory: rpc.getPublicAdHistory, getPublicRelatedAds: rpc.getPublicRelatedAds,
  appCommand: rpc.command, studioCommand: rpc.studioCommand,
  useQuery: (operation: (args: unknown) => Promise<unknown>, args: unknown, options = {}) => useReactQuery({
    queryKey: [operation === rpc.getCustomerSnapshot?'snapshot':operation === rpc.getAppState ? 'app' : operation === rpc.getStudioState ? 'studio' : operation === rpc.getResearchPage ? 'research' : operation === rpc.searchPublicAds ? 'search' : operation === rpc.getStudioCatalog ? 'catalog' : operation === rpc.getPublicAd ? 'ad' : operation === rpc.getPublicAdHistory ? 'history' : 'related', args], queryFn: () => operation(args), ...options,
  }),
}));
vi.mock('../app-surface', async importOriginal => ({ ...await importOriginal<typeof import('../app-surface')>(), appSurface: () => 'customer', surfaceDestination: () => null }));
vi.mock('../site-analytics/SiteAnalytics', () => ({ SiteAnalytics: ({ children }: { children: ReactNode }) => children }));
import { App } from '../App';
import { StudioAdsPage, StudioAdDetailPage } from './StudioAds';
import { StudioAccountPage, StudioCollectionsPage, StudioCollectionDetailPage, StudioTeamPage, StudioSettingsPage, StudioBillingPage } from './StudioAccount';

let container: HTMLDivElement, root: Root, client: QueryClient;
function ad(id = 'ad-1'): AdView {
  return { id, sourceAdId: 'source-' + id, dataSourceKey: 'meta', advertiserId: 'brand', advertiserName: 'Actual brand', headline: 'Creative ' + id, copy: 'Original copy ' + id, publisherPlatforms: ['facebook'], status: 'active', mediaType: 'IMAGE', media: [], sourceUrl: 'https://example.test/ads/' + id, landingPageUrl: 'https://shop.example.test/item', firstObservedAt: '2026-10-01T00:00:00Z', lastObservedAt: '2026-10-21T00:00:00Z' } as AdView;
}
function LocationProbe() { const location = useLocation(); return createElement('output', { 'data-location': true }, location.pathname + location.search); }
function page(path: string) {
  const routes = [
    ['/app/ads', StudioAdsPage], ['/app/ads/:adId', StudioAdDetailPage], ['/app/account', StudioAccountPage],
    ['/app/collections', StudioCollectionsPage], ['/app/collections/:folderId', StudioCollectionDetailPage],
    ['/app/team', StudioTeamPage], ['/app/settings', StudioSettingsPage], ['/app/billing', StudioBillingPage],
  ].map(([routePath, Component]) => createElement(Route, { key: String(routePath), path: String(routePath), element: createElement(Component as () => ReactNode) }));
  return createElement(QueryClientProvider, { client }, createElement(MemoryRouter, { key: path, initialEntries: [path] },
    createElement(LocationProbe), createElement(Routes, null, createElement(Route, { element: createElement(App) }, ...routes))));
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  throw new Error('UI condition did not settle: ' + container.textContent?.slice(-700));
}
async function render(path: string, selector = 'h1') { await act(async () => root.render(page(path))); await until(() => Boolean(container.querySelector(selector))); }
function button(text: string, scope: ParentNode = container) { const found = Array.from(scope.querySelectorAll('button')).find(node => node.textContent?.trim() === text); if (!found) throw new Error('Button missing: ' + text); return found; }
async function click(text: string, scope: ParentNode = container) { await act(async () => button(text, scope).click()); }
function submit(form: HTMLFormElement) { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  await act(async () => element.dispatchEvent(new Event('input', { bubbles: true })));
}
function locationParams() { return new URL(container.querySelector('[data-location]')!.textContent!, 'https://example.test').searchParams; }
function deferred() { let resolve!: (value?: unknown) => void, reject!: (reason: unknown) => void; const promise = new Promise((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; }
function subscribed(cancelAtPeriodEnd = false) { rpc.state!.billing = { ...rpc.state!.billing!, planName: 'Actual subscription', status: 'ACTIVE', hasProviderSubscription: true, providerMode: 'sandbox', periodEnd: '2099-11-22T00:00:00Z', cancelAtPeriodEnd }; }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  for (const operation of [rpc.getCustomerSnapshot,rpc.getAppState, rpc.getStudioState, rpc.getResearchPage, rpc.searchPublicAds, rpc.getStudioCatalog, rpc.getPublicAd, rpc.getPublicAdHistory, rpc.getPublicRelatedAds, rpc.command, rpc.studioCommand]) operation.mockReset();
  rpc.state = {
    user: { id: 'user', email: 'user@example.test', displayName: 'Actual user', isAdmin: false, emailNotifications: true },
    organizations: [{ id: 'org', name: 'My team', role: 'OWNER' }], workspaces: [{ id: 'workspace', organizationId: 'org', name: 'My workspace' }], selectedWorkspace: { id: 'workspace', organizationId: 'org', name: 'My workspace' }, role: 'OWNER',
    overview: { savedCount: 0, analysisCount: 0, pendingAnalysisCount: 0, dataUpdatedAt: null, sourceHealth: { status: 'READY' } },
    research: { folders: [{ id: 'folder', name: 'Actual folder' }], savedAds: [], notes: [], analyses: [] },
    billing: { organizationId: 'org', planName: null, status: 'NONE', periodEnd: null, cancelAtPeriodEnd: false, checkoutEnabled: false, hasProviderSubscription: false, providerMode: 'unconfigured', entitlements: [], plans: [], invoices: [] },
    members: [{ id: 'user', displayName: 'Actual user', email: 'user@example.test', organizationRole: 'OWNER' }, { id: 'member', displayName: 'Member', email: 'member@example.test', organizationRole: 'MEMBER', workspaceRole: 'VIEWER' }], invitations: [],
  };
  rpc.studio = { preferences: { defaultDays: 14, defaultStartPage: 'ads', brandChanges: true, emailDigest: false, weeklySummary: true, collectionUpdates: false }, subscriptionEvents: [] };
  rpc.research = { kind: 'saved', asOf: '2026-10-22T00:00:00Z', savedAds: [], analyses: [], total: 0, nextCursor: null };
  rpc.getCustomerSnapshot.mockResolvedValue({enabled:false,snapshotId:null,asOf:null});
  rpc.getAppState.mockImplementation(async () => rpc.state); rpc.getStudioState.mockImplementation(async () => rpc.studio); rpc.getResearchPage.mockImplementation(async () => rpc.research);
  rpc.searchPublicAds.mockImplementation(async (args: { cursor?: string }) => ({ ads: [ad(args.cursor ? 'ad-2' : 'ad-1')], nextCursor: args.cursor ? null : 'next-real', summary: { total: 25 } }));
  rpc.getStudioCatalog.mockImplementation(async (args: { page: number }) => ({ ads: [ad('domain-' + args.page)], page: args.page, pageCount: 2, total: 25 }));
  rpc.getPublicAd.mockResolvedValue({ ad: ad(), media: [] }); rpc.getPublicAdHistory.mockResolvedValue({ days: [] }); rpc.getPublicRelatedAds.mockResolvedValue({ ads: [] });
  rpc.command.mockResolvedValue({}); rpc.studioCommand.mockResolvedValue({});
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.setAttribute('open', ''); } });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, cacheTime: 0 }, mutations: { retry: false } } });
  localStorage.clear(); sessionStorage.clear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Studio ad browsing DOM interactions', () => {
  it('searches trimmed text and clears the old cursor without losing the selected filters', async () => {
    await render('/app/ads?workspace=workspace&q=old&channel=facebook&format=video&status=inactive&cursor=older', '.sa-ad-card');
    await input(container.querySelector('.sa-search input')!, '  new creative  ');
    await act(async () => submit(container.querySelector('.sa-search')!));
    await until(() => rpc.searchPublicAds.mock.calls.at(-1)?.[0].query === 'new creative');
    expect(locationParams().get('cursor')).toBeNull();
    expect(rpc.searchPublicAds.mock.calls.at(-1)?.[0]).toMatchObject({ workspaceId: 'workspace', query: 'new creative', platform: 'facebook', mediaType: 'video', status: 'inactive', cursor: undefined });
  });
  it('resets legacy filter aliases and pagination while retaining the selected workspace', async () => {
    await render('/app/ads?workspace=workspace&platform=facebook&mediaType=video&status=active&q=old&cursor=older&page=3', '.sa-ad-card');
    await click('重置筛选');
    await until(() => locationParams().get('q') === null);
    expect(Array.from(locationParams().entries())).toEqual([['workspace', 'workspace']]);
    expect((container.querySelector('.sa-search input') as HTMLInputElement).value).toBe('');
    expect(rpc.searchPublicAds.mock.calls.at(-1)?.[0]).toMatchObject({ query: undefined, platform: undefined, mediaType: undefined, status: undefined, cursor: undefined });
  });
  it('replaces the visible page before exporting only that page', async () => {
    const createUrl = vi.fn((_blob: Blob) => 'blob:current-page'); vi.stubGlobal('URL', class extends URL { static createObjectURL = createUrl; static revokeObjectURL = vi.fn(); });
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await render('/app/ads?workspace=workspace', '.sa-ad-card'); await click('下一页');
    await until(() => container.textContent?.includes('Creative ad-2') === true);
    expect(container.textContent).not.toContain('Creative ad-1');
    vi.useFakeTimers();
    await click('导出当前页');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    vi.useRealTimers();
    const blob = createUrl.mock.calls[0][0] as Blob;
    const content = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });
    expect(content).toContain('\"ad-2\"'); expect(content).not.toContain('\"ad-1\"'); expect(content).not.toContain('source-ad-'); expect(download).toHaveBeenCalledTimes(1);
    expect(button('下一页').disabled).toBe(true); await click('返回第一页');
    await until(() => container.textContent?.includes('Creative ad-1') === true); expect(locationParams().get('cursor')).toBeNull();
  });
  it('uses domain catalog paging and removes both a typed domain and the stale page when clearing it', async () => {
    await render('/app/ads?workspace=workspace&q=shop.example.test&page=2&format=image&status=active', '.sa-ad-card');
    expect(rpc.searchPublicAds).not.toHaveBeenCalled(); expect(container.textContent).toContain('Creative domain-2'); expect(button('下一页').disabled).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="移除域名筛选"]')!.click());
    await until(() => container.textContent?.includes('Creative ad-1') === true);
    expect(locationParams().get('q')).toBeNull(); expect(locationParams().get('page')).toBeNull();
    expect(rpc.searchPublicAds.mock.calls.at(-1)?.[0]).toMatchObject({ mediaType: 'image', status: 'active' });
  });
  it('hides stale cards and export after a failed request and makes retry usable', async () => {
    await render('/app/ads?workspace=workspace', '.sa-ad-card');
    rpc.searchPublicAds.mockRejectedValueOnce(new Error('NETWORK_DOWN'));
    await act(async () => { await client.invalidateQueries({ queryKey: ['search'] }); });
    await until(() => Boolean(container.querySelector('.sa-error')));
    expect(container.querySelector('.sa-ad-card')).toBeNull(); expect(Array.from(container.querySelectorAll('button')).some(node => node.textContent === '导出当前页')).toBe(false);
    await click('重新加载'); await until(() => Boolean(container.querySelector('.sa-ad-card'))); expect(container.querySelector('.sa-error')).toBeNull();
  });
  it('keeps the originating search and page through detail tabs and the return link', async () => {
    await render('/app/ads?workspace=workspace&q=chair&channel=facebook&format=image&cursor=next-real', '.sa-ad-card');
    await act(async () => container.querySelector<HTMLAnchorElement>('.sa-ad-card footer a')!.click());
    await until(() => Boolean(container.querySelector('.sa-detail-hero'))); await click('广告文案');
    const back = new URL(container.querySelector<HTMLAnchorElement>('.sa-back')!.href);
    expect(back.pathname).toBe('/app/ads'); expect(Object.fromEntries(back.searchParams)).toEqual({ workspace: 'workspace', q: 'chair', channel: 'facebook', format: 'image', cursor: 'next-real' });
    await act(async () => container.querySelector<HTMLAnchorElement>('.sa-back')!.click());
    await until(() => Boolean(container.querySelector('.sa-ad-card'))); expect(locationParams().get('cursor')).toBe('next-real');
  });
  it('opens the associated advertiser record when the source identity is hidden', async () => {
    rpc.getPublicAd.mockResolvedValueOnce({ ad: { ...ad(), advertiserId: null, advertiserRecordId: 'record-uuid' }, media: [] });
    await render('/app/ads/ad-1?workspace=workspace', '.sa-detail-hero');
    const link = Array.from(container.querySelectorAll<HTMLAnchorElement>('.sa-detail-actions a')).find(node => node.textContent?.includes('广告主详情'));
    expect(link).toBeDefined(); expect(new URL(link!.href).pathname + new URL(link!.href).search).toBe('/app/advertisers/record-uuid?workspace=workspace');
  });
  it('prefers the associated record over a source advertiser id and preserves the source-id fallback', async () => {
    rpc.getPublicAd.mockResolvedValueOnce({ ad: { ...ad(), advertiserId: 'source-page', advertiserRecordId: 'record-uuid' }, media: [] });
    await render('/app/ads/ad-1?workspace=workspace', '.sa-detail-hero');
    let link = Array.from(container.querySelectorAll<HTMLAnchorElement>('.sa-detail-actions a')).find(node => node.textContent?.includes('广告主详情'))!;
    expect(new URL(link.href).pathname + new URL(link.href).search).toBe('/app/advertisers/record-uuid?workspace=workspace');
    rpc.getPublicAd.mockResolvedValue({ ad: { ...ad(), advertiserId: 'source-page' }, media: [] });
    await act(async () => client.invalidateQueries({ queryKey: ['ad'] }));
    await until(() => Array.from(container.querySelectorAll<HTMLAnchorElement>('.sa-detail-actions a')).some(node => node.href.includes('/advertisers/source-page')));
    link = Array.from(container.querySelectorAll<HTMLAnchorElement>('.sa-detail-actions a')).find(node => node.textContent?.includes('广告主详情'))!;
    expect(new URL(link.href).pathname + new URL(link.href).search).toBe('/app/advertisers/source-page?workspace=workspace&source=meta');
  });
  it('keeps an ad without either advertiser identity readable without inventing an advertiser link', async () => {
    rpc.getPublicAd.mockResolvedValueOnce({ ad: { ...ad(), advertiserId: null, advertiserRecordId: null }, media: [] });
    await render('/app/ads/ad-1?workspace=workspace', '.sa-detail-hero');
    expect(container.textContent).toContain('Creative ad-1');
    expect(Array.from(container.querySelectorAll('.sa-detail-actions a')).some(node => node.textContent?.includes('广告主详情'))).toBe(false);
  });
  it('uses the same associated advertiser record from an ad card with a hidden source identity', async () => {
    rpc.searchPublicAds.mockResolvedValueOnce({ ads: [{ ...ad(), advertiserId: null, advertiserRecordId: 'record-uuid' }], nextCursor: null, summary: { total: 1 } });
    await render('/app/ads?workspace=workspace', '.sa-ad-card');
    const identity = container.querySelector<HTMLAnchorElement>('.sa-ad-card a.sa-ad-identity');
    expect(identity).not.toBeNull(); expect(new URL(identity!.href).pathname + new URL(identity!.href).search).toBe('/app/advertisers/record-uuid?workspace=workspace');
  });
  it('ignores an external detail return URL and keeps the active workspace', async () => {
    await render('/app/ads/ad-1?workspace=workspace&returnTo=https%3A%2F%2Fevil.example%2Fapp%2Fads', '.sa-detail-hero');
    const back = new URL(container.querySelector<HTMLAnchorElement>('.sa-back')!.href); expect(back.pathname + back.search).toBe('/app/ads?workspace=workspace');
  });
});

describe('Studio research and account command interactions', () => {
  it('keeps a failed folder name for retry and resets it only after a successful save', async () => {
    rpc.command.mockRejectedValueOnce(new Error('NETWORK_DOWN'));
    await render('/app/collections?workspace=workspace', '.sa-inline-form');
    const form = container.querySelector<HTMLFormElement>('.sa-inline-form')!, name = form.querySelector<HTMLInputElement>('[name="name"]')!;
    name.value = 'Research'; await act(async () => submit(form)); await until(() => Boolean(form.querySelector('[role="alert"]')));
    expect(name.value).toBe('Research'); expect(form.querySelector('fieldset')!.disabled).toBe(false);
    await act(async () => submit(form)); await until(() => name.value === ''); expect(form.querySelector('[role="alert"]')).toBeNull();
    expect(rpc.command.mock.calls.map(([command]) => command)).toEqual([{ type: 'CREATE_FOLDER', workspaceId: 'workspace', name: 'Research' }, { type: 'CREATE_FOLDER', workspaceId: 'workspace', name: 'Research' }]);
  });
  it('does not submit disabled collection and team forms for a viewer', async () => {
    rpc.state!.role = 'VIEWER'; rpc.state!.organizations[0].role = 'MEMBER';
    await render('/app/collections?workspace=workspace', '.sa-inline-form');
    expect(container.querySelector<HTMLFieldSetElement>('.sa-inline-form fieldset')!.disabled).toBe(true);
    await act(async () => submit(container.querySelector('.sa-inline-form')!)); expect(rpc.command).not.toHaveBeenCalled();
    await act(async () => root.render(page('/app/team?workspace=workspace'))); await until(() => Boolean(container.querySelector('.sa-invite-form')));
    expect(container.querySelector<HTMLFieldSetElement>('.sa-invite-form fieldset')!.disabled).toBe(true);
    await act(async () => submit(container.querySelector('.sa-invite-form')!)); expect(rpc.command).not.toHaveBeenCalled();
  });
  it('submits account changes with immutable email and protects a pending save from duplicate submits', async () => {
    const pending = deferred(); rpc.command.mockReturnValueOnce(pending.promise);
    await render('/app/account?workspace=workspace', 'input[name="displayName"]');
    const form = container.querySelector<HTMLFormElement>('.command-form')!; form.querySelector<HTMLInputElement>('[name="displayName"]')!.value = 'Updated user'; form.querySelector<HTMLInputElement>('[name="emailNotifications"]')!.checked = false;
    expect(form.querySelector<HTMLInputElement>('[type="email"]')!.readOnly).toBe(true);
    await act(async () => { submit(form); submit(form); }); expect(rpc.command).toHaveBeenCalledTimes(1); expect(form.querySelector('fieldset')!.disabled).toBe(true);
    expect(rpc.command.mock.calls[0][0]).toEqual({ type: 'UPDATE_PROFILE', displayName: 'Updated user', emailNotifications: false });
    await act(async () => pending.resolve({})); await until(() => !form.querySelector('fieldset')!.disabled);
  });
  it('retains an unsuccessful invitation and resets it only after the same team-scoped retry succeeds', async () => {
    rpc.command.mockRejectedValueOnce(new Error('NETWORK_DOWN'));
    await render('/app/team?workspace=workspace', '.sa-invite-form');
    const form = container.querySelector<HTMLFormElement>('.sa-invite-form')!, email = form.querySelector<HTMLInputElement>('[name="email"]')!;
    email.value = 'new@example.test'; form.querySelector<HTMLSelectElement>('[name="role"]')!.value = 'EDITOR';
    await act(async () => submit(form)); await until(() => Boolean(form.querySelector('[role="alert"]')));
    expect(email.value).toBe('new@example.test'); expect(form.querySelector<HTMLSelectElement>('[name="role"]')!.value).toBe('EDITOR');
    await act(async () => submit(form)); await until(() => email.value === '');
    expect(rpc.command.mock.calls.map(([command]) => command)).toEqual([{ type: 'INVITE_MEMBER', workspaceId: 'workspace', email: 'new@example.test', role: 'EDITOR' }, { type: 'INVITE_MEMBER', workspaceId: 'workspace', email: 'new@example.test', role: 'EDITOR' }]);
  });
  it('keeps edited collection notes after a failed save and requires confirmation before deletion', async () => {
    rpc.research = { kind: 'saved', asOf: '2026-10-22T00:00:00Z', total: 1, nextCursor: null, analyses: [], savedAds: [{ id: 'saved-real', adId: 'ad-1', advertiserName: 'Actual brand', folderId: 'folder', savedAt: '2026-10-22T00:00:00Z', notes: [{ id: 'note-real', savedAdId: 'saved-real', body: 'Original note', updatedAt: '2026-10-22T00:00:00Z' }] }] };
    rpc.command.mockRejectedValueOnce(new Error('NETWORK_DOWN'));
    await render('/app/collections/folder?workspace=workspace', '.sa-saved-record');
    const form = container.querySelector<HTMLFormElement>('.sa-note .command-form')!, body = form.querySelector<HTMLTextAreaElement>('[name="body"]')!;
    body.value = 'Updated note'; await act(async () => submit(form)); await until(() => Boolean(form.querySelector('[role="alert"]'))); expect(body.value).toBe('Updated note');
    await act(async () => submit(form)); await until(() => !form.querySelector('[role="alert"]'));
    expect(rpc.command.mock.calls[1][0]).toEqual({ type: 'SAVE_NOTE', workspaceId: 'workspace', savedAdId: 'saved-real', noteId: 'note-real', body: 'Updated note' });
    const confirmation = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await click('删除笔记'); expect(confirmation).toHaveBeenCalledTimes(1); expect(rpc.command).toHaveBeenCalledTimes(2);
    await click('删除笔记'); await until(() => rpc.command.mock.calls.length === 3);
    expect(rpc.command.mock.calls[2][0]).toEqual({ type: 'DELETE_NOTE', workspaceId: 'workspace', noteId: 'note-real' });
  });
  it('shows empty research without presenting data from a nonexistent folder', async () => {
    await render('/app/collections?workspace=workspace', '.sa-pagination'); expect(container.textContent).toContain('还没有收藏广告'); expect(button('下一页').disabled).toBe(true);
    await act(async () => root.render(page('/app/collections/missing?workspace=workspace'))); await until(() => container.textContent?.includes('收藏夹不存在') === true);
    expect(container.querySelector('.sa-saved-record')).toBeNull();
  });
  it('retains a detail note after an RPC failure and retries against the saved-ad identity', async () => {
    rpc.state!.research.savedAds = [{ id: 'saved-real', adId: 'ad-1', advertiserName: 'Actual brand', savedAt: '2026-10-22T00:00:00Z' }]; rpc.command.mockRejectedValueOnce(new Error('NETWORK_DOWN'));
    await render('/app/ads/ad-1?workspace=workspace&tab=notes', '.sa-note-form');
    const form = container.querySelector<HTMLFormElement>('.sa-note-form')!, body = form.querySelector<HTMLTextAreaElement>('textarea')!;
    await input(body, '  Actual research note  '); await act(async () => submit(form)); await until(() => Boolean(form.querySelector('[role="status"]')?.textContent));
    expect(body.value).toBe('  Actual research note  '); expect(form.textContent).not.toContain('研究笔记已保存');
    await act(async () => submit(form)); await until(() => form.textContent?.includes('研究笔记已保存') === true);
    expect(rpc.command.mock.calls[1][0]).toEqual({ type: 'SAVE_NOTE', workspaceId: 'workspace', savedAdId: 'saved-real', body: 'Actual research note' });
  });
  it('saves an unsaved ad before its note and prevents duplicate note submission while pending', async () => {
    const pending = deferred(); rpc.command.mockImplementation(async (command: AppCommand) => {
      if (command.type === 'SAVE_AD') { await pending.promise; rpc.state = { ...rpc.state!, research: { ...rpc.state!.research, savedAds: [{ id: 'saved-new', adId: 'ad-1', advertiserName: 'Actual brand', savedAt: '2026-10-22T00:00:00Z' }] } }; }
      return {};
    });
    await render('/app/ads/ad-1?workspace=workspace&tab=notes', '.sa-note-form'); const form = container.querySelector<HTMLFormElement>('.sa-note-form')!;
    await input(form.querySelector('textarea')!, 'Draft note'); await act(async () => { submit(form); submit(form); });
    expect(rpc.command).toHaveBeenCalledTimes(1); expect(form.querySelector('textarea')!.disabled).toBe(true);
    await act(async () => pending.resolve({})); await until(() => form.textContent?.includes('研究笔记已保存') === true);
    expect(rpc.command.mock.calls.map(([command]) => command)).toEqual([{ type: 'SAVE_AD', workspaceId: 'workspace', adId: 'ad-1' }, { type: 'SAVE_NOTE', workspaceId: 'workspace', savedAdId: 'saved-new', body: 'Draft note' }]);
  });
  it('does not save whitespace-only detail notes or submit a viewer note form', async () => {
    await render('/app/ads/ad-1?workspace=workspace&tab=notes', '.sa-note-form'); let form = container.querySelector<HTMLFormElement>('.sa-note-form')!;
    await input(form.querySelector('textarea')!, '   '); await act(async () => submit(form)); expect(rpc.command).not.toHaveBeenCalled();
    rpc.state = { ...rpc.state!, role: 'VIEWER' }; await act(async () => client.invalidateQueries({ queryKey: ['app'] })); await until(() => button('保存笔记').disabled);
    form = container.querySelector<HTMLFormElement>('.sa-note-form')!; await input(form.querySelector('textarea')!, 'Read only note'); await act(async () => submit(form)); expect(rpc.command).not.toHaveBeenCalled();
  });
});

describe('Studio subscription and preference async dialogs', () => {
  it.each([false])('requires confirmation and guards a pending subscription command (scheduled=%s)', async scheduled => {
    subscribed(scheduled); const pending = deferred(); rpc.command.mockReturnValueOnce(pending.promise);
    await render('/app/billing?workspace=workspace', '.sa-current-subscription'); await click(scheduled ? '恢复续费' : '退订 / 取消自动续费');
    let dialog = container.querySelector<HTMLDialogElement>('dialog')!; expect(dialog.open).toBe(true); expect(rpc.command).not.toHaveBeenCalled();
    await click(scheduled ? '暂不恢复' : '保留订阅', dialog); expect(container.querySelector('dialog')).toBeNull(); expect(rpc.command).not.toHaveBeenCalled();
    await click(scheduled ? '恢复续费' : '退订 / 取消自动续费'); dialog = container.querySelector('dialog')!;
    const confirm = button(scheduled ? '确认恢复续费' : '确认退订', dialog);
    await act(async () => { confirm.click(); confirm.click(); }); expect(rpc.command).toHaveBeenCalledTimes(1); expect(confirm.disabled).toBe(true);
    const escape = new Event('cancel', { bubbles: false, cancelable: true }); await act(async () => dialog.dispatchEvent(escape)); expect(escape.defaultPrevented).toBe(true); expect(container.querySelector('dialog')).not.toBeNull();
    expect(rpc.command.mock.calls[0][0]).toEqual({ type: scheduled ? 'RESUME_SUBSCRIPTION' : 'CANCEL_SUBSCRIPTION', organizationId: 'org' });
    await act(async () => pending.resolve({})); await until(() => !container.querySelector('dialog'));
  });
  it.each([false])('retains a failed subscription dialog with a retry and closes only after success (scheduled=%s)', async scheduled => {
    subscribed(scheduled); rpc.command.mockRejectedValueOnce(new Error('NETWORK_DOWN'));
    const label = scheduled ? '确认恢复续费' : '确认退订';
    await render('/app/billing?workspace=workspace', '.sa-current-subscription'); await click(scheduled ? '恢复续费' : '退订 / 取消自动续费'); await click(label, container.querySelector('dialog')!);
    await until(() => Boolean(container.querySelector('dialog [role="alert"]'))); expect(button(label).disabled).toBe(false); expect(container.textContent).toContain(scheduled ? '自动续费已关闭' : '自动续费开启');
    await click(label, container.querySelector('dialog')!); await until(() => !container.querySelector('dialog')); expect(rpc.command).toHaveBeenCalledTimes(2);
  });
  it('keeps edited preferences after a failed save, prevents duplicates and retries the same choices', async () => {
    const pending = deferred(); rpc.studioCommand.mockReturnValueOnce(pending.promise);
    await render('/app/settings?workspace=workspace', '.sa-settings-form'); const form = container.querySelector<HTMLFormElement>('.sa-settings-form')!;
    form.querySelector<HTMLSelectElement>('[name="defaultDays"]')!.value = '7'; form.querySelector<HTMLSelectElement>('[name="defaultStartPage"]')!.value = 'tracking'; form.querySelector<HTMLInputElement>('[name="emailDigest"]')!.checked = true;
    await act(async () => { submit(form); submit(form); }); expect(rpc.studioCommand).toHaveBeenCalledTimes(1); expect(form.querySelector('fieldset')!.disabled).toBe(true);
    await act(async () => pending.reject(new Error('NETWORK_DOWN'))); await until(() => Boolean(form.querySelector('[role="alert"]')));
    expect(form.querySelector<HTMLSelectElement>('[name="defaultDays"]')!.value).toBe('7'); expect(form.textContent).not.toContain('偏好已保存');
    await act(async () => submit(form)); await until(() => form.textContent?.includes('偏好已保存') === true);
    expect(rpc.studioCommand.mock.calls[1][0]).toEqual({ workspaceId: 'workspace', type: 'UPDATE_PREFERENCES', preferences: { defaultDays: 7, defaultStartPage: 'tracking', brandChanges: true, emailDigest: true, weeklySummary: true, collectionUpdates: false } });
  });
});


describe('Studio queries share the selected snapshot',()=>{
 it('pins app state, ad search and card links to the same publication',async()=>{
  rpc.getCustomerSnapshot.mockResolvedValue({enabled:true,snapshotId:'version-a',asOf:'2026-10-22T00:00:00Z'});
  const pending=deferred();rpc.searchPublicAds.mockReturnValue(pending.promise);
  await render('/app/ads?workspace=workspace');await until(()=>rpc.searchPublicAds.mock.calls.length>0);
  expect(rpc.getAppState.mock.calls.at(-1)?.[0]).toMatchObject({snapshotId:'version-a'});
  expect(rpc.searchPublicAds.mock.calls.at(-1)?.[0]).toMatchObject({snapshotId:'version-a'});
  expect(locationParams().get('snapshot')).toBe('version-a');
  await act(async()=>pending.resolve({ads:[ad()],nextCursor:null,summary:{total:1}}));
  const cardLink=()=>Array.from(container.querySelectorAll('a')).find(a=>a.href.includes('/app/ads/ad-1'));
  await until(()=>Boolean(cardLink()));
  expect(cardLink()!.getAttribute('href')).toContain('snapshot=version-a');
 });
 it('uses a linked old snapshot for detail, related ads, history and saved notes lookup',async()=>{
  rpc.getCustomerSnapshot.mockResolvedValue({enabled:true,snapshotId:'version-new',asOf:null});
  await render('/app/ads/ad-1?workspace=workspace&snapshot=version-old');await until(()=>rpc.getPublicAdHistory.mock.calls.length>0);
  expect(rpc.getAppState.mock.calls.at(-1)?.[0]).toMatchObject({snapshotId:'version-old'});
  expect(rpc.getPublicAd.mock.calls.at(-1)?.[0]).toMatchObject({snapshotId:'version-old'});
  expect(rpc.getPublicAdHistory.mock.calls.at(-1)?.[0]).toMatchObject({snapshotId:'version-old'});
  await until(()=>Array.from(container.querySelectorAll('button')).some(b=>b.textContent==='相关素材'));
  await click('相关素材');await until(()=>rpc.getPublicRelatedAds.mock.calls.length>0);
  expect(rpc.getPublicRelatedAds.mock.calls.at(-1)?.[0]).toMatchObject({snapshotId:'version-old'});
 });
 it('keeps collection contents in the same snapshot as app state',async()=>{
  rpc.getCustomerSnapshot.mockResolvedValue({enabled:true,snapshotId:'version-a',asOf:null});
  await render('/app/collections?workspace=workspace');await until(()=>rpc.getResearchPage.mock.calls.length>0);
  expect(rpc.getResearchPage.mock.calls.at(-1)?.[0]).toMatchObject({snapshotId:'version-a'});
 });
});
