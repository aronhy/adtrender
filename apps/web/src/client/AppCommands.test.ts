// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ command: vi.fn(), refetch: vi.fn() }));
vi.mock('wasp/client/auth', () => ({
  logout: vi.fn(),
  useAuth: () => ({ data: { id: 'test' }, isLoading: false }),
}));
vi.mock('wasp/client/operations', () => ({
  getAppState: vi.fn(),
  appCommand: (c: unknown) => fixture.command(c),
  useQuery: (_op: unknown, args: { workspaceId?: string }) => ({
    data: state(args.workspaceId || 'a'),
    refetch: fixture.refetch,
  }),
}));
vi.mock('./app-surface', () => ({
  appSurface: () => 'customer',
  surfaceDestination: () => null,
}));
vi.mock('./site-analytics/SiteAnalytics', () => ({
  SiteAnalytics: ({ children }: { children: import('react').ReactNode }) =>
    h('div', null, children),
}));
import { App, useApp } from './App';
function state(id: string) {
  return {
    user: { email: 'example@example.test' },
    organizations: [{ id: 'org', name: 'Example' }],
    workspaces: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ],
    selectedWorkspace: { id, name: id, organizationId: 'org' },
    role: 'OWNER',
    overview: {},
    research: { folders: [], savedAds: [], analyses: [], notes: [] },
  };
}
let root: Root, host: HTMLDivElement;
function Probe() {
  const { run } = useApp(),
    navigate = useNavigate(),
    location = useLocation();
  return h(
    'section',
    null,
    h('output', null, location.search),
    h(
      'button',
      {
        onClick: () =>
          void run({
            type: 'SAVE_AD',
            workspaceId: 'a',
            adId: 'ad',
            idempotencyKey: 'operation',
          }).catch(() => {}),
      },
      'Save'
    ),
    h(
      'button',
      { onClick: () => navigate('/app/ads?workspace=b&lang=en') },
      'Switch'
    )
  );
}
async function click(text: string) {
  await act(async () => {
    Array.from(host.querySelectorAll('button'))
      .find((b) => b.textContent === text)!
      .click();
  });
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.command.mockReset();
  fixture.refetch.mockReset().mockResolvedValue({});
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      h(
        MemoryRouter,
        { initialEntries: ['/app/ads?workspace=a&lang=en'] },
        h(
          Routes,
          null,
          h(
            Route,
            { element: h(App) },
            h(Route, { path: '/app/ads', element: h(Probe) })
          )
        )
      )
    )
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it('does not redirect or refresh the previous workspace when an old command resolves', async () => {
  let resolve!: (value: unknown) => void;
  fixture.command.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  await click('Save');
  await click('Switch');
  await act(async () => resolve({ workspaceId: 'a' }));
  expect(host.querySelector('output')?.textContent).toContain('workspace=b');
  expect(fixture.refetch).not.toHaveBeenCalled();
  expect(host.querySelector('.ui-toast-success')).toBeNull();
});
it('reports an accepted mutation with failed readback separately from command failure', async () => {
  fixture.command.mockResolvedValue({});
  fixture.refetch.mockResolvedValue({
    isError: true,
    error: new Error('offline'),
  });
  await click('Save');
  expect(host.querySelector('.ui-toast-info')?.textContent).toContain(
    'refresh'
  );
  expect(host.querySelector('.ui-toast-error')).toBeNull();
  expect(host.querySelector('.ui-toast-action')).not.toBeNull();
});
