// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { focusManager, onlineManager, QueryClient, QueryClientProvider, useQuery as useReactQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, SearchResult } from './types';
import { WorkspaceLocaleProvider } from './workspace-i18n/locale';

const network = vi.hoisted(() => ({ search: vi.fn(), state: null as AppState | null }));
// Keep React Query's focus, reconnect and refetch behavior real; replace only RPC.
vi.mock('wasp/client/operations', () => ({
  searchPublicAds: network.search,
  getPublicAd: vi.fn(), getPublicAdMediaDownload: vi.fn(), getPublicRelatedAds: vi.fn(), getPublicAdHistory: vi.fn(), getPublicAdHistoryEvidence: vi.fn(),
  useQuery: (operation: (args: unknown) => Promise<SearchResult>, args: unknown, options: object) => useReactQuery({ queryKey: ['ads', args], queryFn: () => operation(args), ...options }),
}));
vi.mock('./App', () => ({
  useApp: () => ({ state: network.state }), canEdit: () => false,
  workspaceHref: (path: string, workspaceId: string) => `${path}?workspace=${workspaceId}`,
  Field: ({ label, children }: { label: string; children: import('react').ReactNode }) => createElement('label', null, label, children),
  Status: ({ value }: { value: string }) => createElement('span', null, value),
  CommandButton: () => null,
  Loading: () => createElement('p', null, 'Loading'),
  Empty: () => createElement('p', null, 'Unavailable'),
}));
vi.mock('./WorkspacePages', () => ({ HealthNotice: () => null, WorkspaceRequired: () => null }));
import { AdsPage } from './AdsPages';

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  focusManager.setFocused(true); onlineManager.setOnline(true);
  network.state = { selectedWorkspace: { id: 'workspace' }, role: 'VIEWER' } as AppState;
  network.search.mockReset().mockResolvedValue({
    ads: [{ id: 'ad', advertiserName: null, publisherPlatforms: [], status: 'ACTIVE', media: [], copy: 'Original copy' }],
    nextCursor: null, summary: { total: 1 }, sourceHealth: { status: 'HEALTHY' },
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(QueryClientProvider, { client },
    createElement(MemoryRouter, { initialEntries: ['/app/ads?workspace=workspace&lang=en'] },
      createElement(WorkspaceLocaleProvider, null, createElement(AdsPage))))));
  await settle();
  expect(container.querySelector('.ad-card')).not.toBeNull();
  expect(network.search).toHaveBeenCalledTimes(1);
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); container.remove();
  focusManager.setFocused(undefined); onlineManager.setOnline(true); vi.unstubAllGlobals();
});

describe('stable ad browsing', () => {
  it('keeps the result set when the user returns to the tab', async () => {
    const card = container.querySelector('.ad-card');
    await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await settle();
    expect(network.search).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.ad-card')).toBe(card);
  });

  it('keeps the result set when the network reconnects, while manual refresh still works', async () => {
    await act(async () => { onlineManager.setOnline(false); onlineManager.setOnline(true); });
    await settle();
    expect(network.search).toHaveBeenCalledTimes(1);
    await act(async () => container.querySelector<HTMLButtonElement>('.results-heading button')!.click());
    await settle();
    expect(network.search).toHaveBeenCalledTimes(2);
  });
});
