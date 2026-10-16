import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from './types';

const fixture = vi.hoisted(() => ({
  surface: 'customer' as 'customer' | 'admin',
  authLoading: false,
  authError: null as Error | null,
  data: undefined as AppState | undefined,
  queryLoading: false,
  queryError: null as Error | null,
  queries: [] as Array<Record<string, unknown>>,
  destination: null as { type: 'internal' | 'external'; to: string } | null,
  analyticsMounts: 0,
}));
vi.mock('wasp/client/auth', () => ({ logout: vi.fn(), useAuth: () => ({ isLoading: fixture.authLoading, error: fixture.authError, data: { id: 'operator' }, refetch: vi.fn() }) }));
vi.mock('wasp/client/operations', () => ({
  getAppState: vi.fn(), appCommand: vi.fn(),
  useQuery: (_operation: unknown, args: Record<string, unknown>) => { fixture.queries.push(args); return { data: fixture.data, isLoading: fixture.queryLoading, error: fixture.queryError, refetch: vi.fn() }; },
}));
vi.mock('./app-surface', () => ({ appSurface: () => fixture.surface, surfaceDestination: () => fixture.destination }));
vi.mock('./site-analytics/SiteAnalytics', () => ({ SiteAnalytics: ({ children }: { children?: ReactNode }) => { fixture.analyticsMounts++; return createElement('div', { 'data-site-analytics': true }, children); } }));
import { App, useApp } from './App';

function appState(isAdmin = true): AppState {
  return {
    user: { id: 'operator', email: 'operator@example.test', displayName: 'SYNTHETIC operator', isAdmin },
    organizations: [{ id: 'org', name: 'SYNTHETIC customer organization', role: 'OWNER' }],
    workspaces: [{ id: 'workspace', organizationId: 'org', name: 'SYNTHETIC customer workspace' }],
    selectedWorkspace: { id: 'workspace', organizationId: 'org', name: 'SYNTHETIC customer workspace' }, role: 'OWNER',
    overview: { savedCount: 0, analysisCount: 0, pendingAnalysisCount: 0, dataUpdatedAt: null, sourceHealth: { status: 'READY' } },
    research: { folders: [], savedAds: [], notes: [], analyses: [] }, billing: null, members: [],
  };
}
function ContextProbe() { return createElement('section', { 'data-admin-module': true }, useApp().state.user.email); }
function render(path: string) {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] },
    createElement(Routes, null, createElement(Route, { element: createElement(App) },
      createElement(Route, { path: '/app/ads', element: createElement(ContextProbe) }),
      createElement(Route, { path: '/app/admin', element: createElement(ContextProbe) })))));
}
beforeEach(() => {
  fixture.surface = 'customer'; fixture.authLoading = false; fixture.authError = null;
  fixture.queryLoading = false; fixture.queryError = null; fixture.data = appState(); fixture.queries = [];
  fixture.destination = null; fixture.analyticsMounts = 0;
});

describe('separate customer and platform administration shells', () => {
  it('never renders a platform administration entry in the customer shell, including for admins', () => {
    const html = render('/app/ads?lang=zh-CN&workspace=workspace');
    for (const path of ['/app/ads', '/app/overview', '/app/research', '/app/settings']) expect(html).toContain(path);
    expect(html).not.toContain('/app/admin');
    expect(html).not.toContain('平台管理');
    expect(fixture.analyticsMounts).toBe(1);
  });

  it('loads the admin identity with no workspace or organization scope and provides the existing app context', () => {
    fixture.surface = 'admin';
    const html = render('/app/admin?lang=zh-CN&workspace=untrusted&organization=untrusted');
    expect(fixture.queries).toEqual([{}]);
    expect(html).toContain('admin-shell');
    expect(html).toContain('data-admin-module');
    expect(html).toContain('operator@example.test');
    expect(html).not.toContain('workspace-select');
    expect(html).not.toContain('workspace-topline-switch');
    for (const path of ['/app/ads', '/app/overview', '/app/research', '/app/settings', '/pricing', '/signup']) expect(html).not.toContain(path);
    expect(html).not.toContain('SYNTHETIC customer organization');
    expect(html).not.toContain('SYNTHETIC customer workspace');
    expect(fixture.analyticsMounts).toBe(0);
  });

  it('keeps administrator loading and errors in their own shell without rendering protected children', () => {
    fixture.surface = 'admin'; fixture.queryLoading = true;
    let html = render('/app/admin?lang=zh-CN');
    expect(html).toContain('admin-shell'); expect(html).toContain('role="status"'); expect(html).not.toContain('data-admin-module');
    fixture.queryLoading = false; fixture.queryError = new Error('SYNTHETIC_REQUEST_FAILED');
    html = render('/app/admin?lang=zh-CN');
    expect(html).toContain('admin-shell'); expect(html).toContain('role="alert"'); expect(html).not.toContain('data-admin-module');
  });

  it('shows no-permission state for non-admins and rejected account requests', () => {
    fixture.surface = 'admin'; fixture.data = appState(false);
    let html = render('/app/admin?lang=zh-CN');
    expect(html).toContain('没有访问权限'); expect(html).not.toContain('data-admin-module');
    fixture.data = appState(true); fixture.queryError = new Error('ACCOUNT_DISABLED');
    html = render('/app/admin?lang=zh-CN');
    expect(html).toContain('没有访问权限'); expect(html).not.toContain('data-admin-module');
  });

  it('uses the admin shell while authenticating and preserves language and sign-out controls', () => {
    fixture.surface = 'admin'; fixture.authLoading = true;
    const html = render('/app/admin?lang=en');
    expect(fixture.queries).toEqual([]);
    expect(html).toContain('admin-shell'); expect(html).toContain('Language'); expect(html).toContain('role="status"');
    expect(html).not.toContain('workspace-select');
  });

  it('applies the surface redirect before mounting customer scope or analytics on an old admin bookmark', () => {
    fixture.destination = { type: 'external', to: 'https://admin.example.test/app/admin?module=users' };
    const html = render('/app/admin?workspace=untrusted');
    expect(html).toBe('');
    expect(fixture.queries).toEqual([]);
    expect(fixture.analyticsMounts).toBe(0);
  });
});
