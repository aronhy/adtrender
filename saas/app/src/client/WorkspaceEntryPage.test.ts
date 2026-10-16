import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from './types';

const fixture = vi.hoisted(() => ({ state: { organizations: [], selectedWorkspace: null } as unknown as AppState, redirects: [] as string[] }));
vi.mock('react-router', async importOriginal => ({
  ...await importOriginal<typeof import('react-router')>(),
  Navigate: ({ to }: { to: string }) => { fixture.redirects.push(to); return null; },
}));
vi.mock('./App', () => ({
  useApp: () => ({ state: fixture.state }),
  PageHeader: ({ title }: { title: string }) => createElement('h1', null, title),
  CommandForm: ({ children }: { children: ReactNode }) => createElement('form', null, children),
  Field: ({ label, children }: { label: string; children: ReactNode }) => createElement('label', null, label, children),
  Empty: () => null, Status: () => null, formText: () => '', workspaceHref: () => '/app',
}));
vi.mock('./workspace-i18n/locale', () => ({
  useWorkspaceLocale: () => ({ t: (key: string) => key, href: (path: string) => path }),
}));
import { WorkspaceEntryPage, workspaceEntryDestination } from './WorkspacePages';

beforeEach(() => { fixture.redirects.length = 0; });
describe('workspace entry routing', () => {
  it('opens the ad library and retains language, search and current workspace scope', () => {
    const destination = new URL(workspaceEntryDestination('?workspace=stale&lang=es&q=shoes&country=US', 'current'), 'https://example.test');
    expect(destination.pathname).toBe('/app/ads');
    expect(Object.fromEntries(destination.searchParams)).toEqual({ workspace: 'current', lang: 'es', q: 'shoes', country: 'US' });
  });
  it('keeps pending invitation and plan actions reachable from the app entry', () => {
    const invitation = new URL(workspaceEntryDestination('?invite=synthetic-invitation&lang=zh-TW&plan=plan-id', 'current'), 'https://example.test');
    expect(invitation.pathname + invitation.hash).toBe('/app/settings#team');
    expect(invitation.searchParams.get('invite')).toBe('synthetic-invitation');
    expect(invitation.searchParams.get('plan')).toBe('plan-id');
    const billing = new URL(workspaceEntryDestination('?plan=plan-id&lang=en', 'current'), 'https://example.test');
    expect(billing.pathname + billing.hash).toBe('/app/settings#billing');
    expect(billing.searchParams.get('plan')).toBe('plan-id');
  });
  it('redirects returning members using the selected authorized workspace', () => {
    fixture.state = { selectedWorkspace: { id: 'authorized' } } as AppState;
    renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/app?lang=en#saved-position'] }, createElement(WorkspaceEntryPage)));
    expect(fixture.redirects).toEqual(['/app/ads?lang=en&workspace=authorized#saved-position']);
  });
  it('retains new-team onboarding and invitation form when no workspace is available', () => {
    fixture.state = { organizations: [], selectedWorkspace: null } as unknown as AppState;
    const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/app?lang=es&plan=plan-id'] }, createElement(WorkspaceEntryPage)));
    expect(fixture.redirects).toEqual([]);
    expect(html).toContain('workspace.setupTitle');
    expect(html).toContain('name="workspaceName"');
    expect(html).toContain('workspace.inviteTitle');
  });
});
