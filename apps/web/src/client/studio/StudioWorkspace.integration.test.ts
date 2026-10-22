// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../types';

const fixture = vi.hoisted(() => ({
  state: undefined as AppState | undefined,
  authenticated: true,
  loading: false,
  studioLoading: false,
  error: null as Error | null,
  preferences: { defaultDays: 14, defaultStartPage: 'ads', brandChanges: true, emailDigest: false, weeklySummary: true, collectionUpdates: false },
  refetch: vi.fn(async () => undefined),
  command: vi.fn(async () => ({})),
}));
// Only the SDK network boundary is mocked. App, its provider, routes and the
// actual settings consumer must agree on the same workspace context instance.
vi.mock('wasp/client/auth', () => ({ useAuth: () => ({ data: fixture.authenticated ? { id: 'user' } : null, isLoading: false, error: null }), logout: vi.fn() }));
vi.mock('wasp/client/operations', () => ({
  getExtensionConnections: vi.fn(async () => ({extensionId:null,storeUrl:null,tokens:[]})),
  getCustomerSnapshot:'customer-snapshot', getAppState: 'app-state', getStudioState: 'studio-state', getResearchPage: 'research',
  appCommand: fixture.command, studioCommand: fixture.command,
  useQuery: (operation: string) => operation === 'customer-snapshot'?{data:{enabled:false,snapshotId:null,asOf:null},isLoading:false,error:null,refetch:fixture.refetch}: operation === 'app-state'
    ? { data: fixture.state, isLoading: fixture.loading, error: fixture.error, refetch: fixture.refetch }
    : { data: fixture.studioLoading ? undefined : { preferences: fixture.preferences, subscriptionEvents: [] }, isLoading: fixture.studioLoading, error: null, refetch: fixture.refetch },
}));
vi.mock('../app-surface', async importOriginal => ({...await importOriginal<typeof import('../app-surface')>(), appSurface: () => 'customer', surfaceDestination: () => null }));
vi.mock('../site-analytics/SiteAnalytics', () => ({ SiteAnalytics: ({ children }: { children: ReactNode }) => children }));
import { App, useApp } from '../App';
import { loginDestination } from '../app-surface';
import { StudioSettingsPage, StudioTeamPage, StudioBillingPage } from './StudioAccount';
import { WorkspaceEntryPage } from '../WorkspacePages';
import { useApp as useStableApp } from '../app-context';

let container: HTMLDivElement;
let root: Root;
function ContextProbe() { return createElement('p', { 'data-workspace-context': true }, useApp().state.selectedWorkspace?.id); }
function LoginProbe(){const navigate=useNavigate();return createElement('button',{onClick:()=>{fixture.authenticated=true;navigate(loginDestination('', 'customer'),{replace:true});}},'Synthetic sign in');}
function tree(path: string) {
  return createElement(MemoryRouter, { initialEntries: [path] }, createElement(Routes, null,
    createElement(Route, { element: createElement(App) },
      createElement(Route, { path: '/login', element: createElement(LoginProbe) }),
      createElement(Route, { path: '/app', element: createElement(WorkspaceEntryPage) }),
      createElement(Route, { path: '/app/channels/:channel', element: createElement(ContextProbe) }),
      createElement(Route, { path: '/app/landing', element: createElement(ContextProbe) }),
      createElement(Route, { path: '/app/research', element: createElement(ContextProbe) }),
      createElement(Route, { path: '/app/overview', element: createElement(ContextProbe) }),
      createElement(Route, { path: '/app/tracking', element: createElement(ContextProbe) }),
      createElement(Route, { path: '/app/team', element: createElement(StudioTeamPage) }),
      createElement(Route, { path: '/app/billing', element: createElement(StudioBillingPage) }),
      createElement(Route, { path: '/app/settings', element: createElement(StudioSettingsPage) }),
      createElement(Route, { path: '/app/ads', element: createElement(ContextProbe) }),
      createElement(Route, { path: '/app/ads/:adId', element: createElement(ContextProbe) }),
      createElement(Route, { path: '/app/advertisers', element: createElement(ContextProbe) }),
      createElement(Route, { path: '/app/advertisers/:advertiserId', element: createElement(ContextProbe) }),
    )));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.state = {
    user: { id: 'user', email: 'user@example.test', displayName: 'Actual user', isAdmin: false, emailNotifications: true },
    organizations: [{ id: 'org', name: 'My team', role: 'OWNER' }],
    workspaces: [{ id: 'workspace', organizationId: 'org', name: 'My workspace' }],
    selectedWorkspace: { id: 'workspace', organizationId: 'org', name: 'My workspace' }, role: 'OWNER',
    overview: { savedCount: 0, analysisCount: 0, pendingAnalysisCount: 0, dataUpdatedAt: null, sourceHealth: { status: 'READY' } },
    research: { folders: [], savedAds: [], notes: [], analyses: [] }, billing: null, members: [], invitations: [],
  };
  fixture.authenticated = true; sessionStorage.clear(); fixture.loading = false; fixture.studioLoading = false; fixture.preferences.defaultStartPage = 'ads'; fixture.error = null; fixture.command.mockClear(); fixture.refetch.mockClear();
  localStorage.clear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('real workspace shell and settings route integration', () => {
  it('keeps the existing App facade bound to the stable context module', () => {
    expect(useApp).toBe(useStableApp);
  });
  it('mounts the actual settings route with persisted preferences and submits in the selected workspace', async () => {
    await act(async () => root.render(tree('/app/settings?workspace=workspace')));
    expect(container.querySelector('h1')?.textContent).toBe('偏好设置');
    expect((container.querySelector('[name="defaultDays"]') as HTMLSelectElement).value).toBe('14');
    expect((container.querySelector('[name="defaultStartPage"]') as HTMLSelectElement).value).toBe('ads');
    expect(container.querySelector('#site-footer')).toBeNull();
    await act(async () => container.querySelector('form.sa-settings-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(fixture.command).toHaveBeenCalledWith({ workspaceId: 'workspace', type: 'UPDATE_PREFERENCES', preferences: fixture.preferences });
    expect(container.textContent).toContain('偏好已保存。');
  });
  it.each([['dashboard', '数据总览'], ['ads', '广告资料库'], ['advertisers', '广告主'], ['tracking', '品牌监控']])('routes /app to the persisted %s homepage after preferences resolve', async (preference, title) => {
    fixture.studioLoading = true; fixture.preferences.defaultStartPage = preference;
    await act(async () => root.render(tree('/app?workspace=workspace')));
    expect(container.querySelector('[data-workspace-context]')).toBeNull();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    fixture.studioLoading = false;
    await act(async () => root.render(tree('/app?workspace=workspace')));
    expect(container.querySelector('[data-workspace-context]')?.textContent).toBe('workspace');
    expect(document.title).toBe(`${title} · AdTrender`);
  });
  it.each(['account', 'profile', 'team', 'billing', 'feedback', 'danger'])('keeps the original #%s settings content reachable', async section => {
    await act(async () => root.render(tree(`/app/settings?workspace=workspace#${section}`)));
    expect(container.querySelector('#'+section)).not.toBeNull();
    expect(container.querySelector('form.sa-settings-form')).toBeNull();
  });
  it('submits feedback through the existing authenticated command form', async () => {
    await act(async () => root.render(tree('/app/settings?workspace=workspace#feedback')));
    const form = container.querySelector('.settings-feedback-form') as HTMLFormElement;
    expect(form).not.toBeNull();
    (form.querySelector('[name="message"]') as HTMLTextAreaElement).value='Synthetic local feedback';
    await act(async () => form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(fixture.command).toHaveBeenCalledWith({type:'SUBMIT_FEEDBACK',workspaceId:'workspace',category:'GENERAL',message:'Synthetic local feedback'});
  });
  it.each([['legacy settings','/app/settings?invite='+ 'a'.repeat(64)], ['team','/app/team?invite='+ 'a'.repeat(64)]])('keeps first-time invitations reachable without creating a workspace: %s', async (_label,path) => {
    fixture.state!.selectedWorkspace=null; fixture.state!.organizations=[]; fixture.state!.workspaces=[];
    await act(async () => root.render(tree(path)));
    expect(container.querySelector('.workspace-invitation input[name="token"]')).not.toBeNull();
    expect(container.querySelector('.workspace-invitation')?.hasAttribute('open')).toBe(true);
    expect(fixture.command).not.toHaveBeenCalled();
  });
  it('keeps an organization billing link usable without an existing workspace', async () => {
    fixture.state!.selectedWorkspace=null; fixture.state!.workspaces=[];
    fixture.state!.billing={organizationId:'org',planName:null,status:'NONE',periodEnd:null,cancelAtPeriodEnd:false,checkoutEnabled:false,entitlements:[],plans:[{id:'plan-real',name:'Actual published plan',priceMinor:1200,currency:'USD',interval:'month',features:[]}]};
    await act(async () => root.render(tree('/app/billing?organization=org&plan=plan-real#billing')));
    expect(container.querySelector('#billing')).not.toBeNull();
    expect((container.querySelector('[name="planVersionId"]') as HTMLSelectElement).value).toBe('plan-real');
    expect(fixture.command).not.toHaveBeenCalled();
  });
  it('keeps archive, ownership transfer, deletion and workspace-only revocation available in full settings', async () => {
    fixture.state!.members=[{id:'member',email:'member@example.test',displayName:'Member',organizationRole:'MEMBER',workspaceRole:'VIEWER'}];
    await act(async () => root.render(tree('/app/settings?workspace=workspace&advanced=1#danger')));
    expect(container.querySelector('.settings-ownership')).not.toBeNull();
    expect(container.querySelector('[name="scope"]')).not.toBeNull();
    expect(container.querySelector('#team input[name="name"]')).not.toBeNull();
    expect(container.textContent).toContain('撤销此工作区访问');
    expect(container.textContent).toContain('归档此工作区');
    expect(fixture.command).not.toHaveBeenCalled();
  });
  it('keeps unconnected extension bookmarks on general settings without issuing a token', async () => {
    const original=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:vi.fn()});
    try {
      await act(async () => root.render(tree('/app/settings?workspace=workspace#extension-connections-title')));
      expect(container.querySelector('#profile')).not.toBeNull();
      expect(container.querySelector('.extension-connections')).toBeNull();
      expect(fixture.command).not.toHaveBeenCalled();
    } finally {
      if(original)Object.defineProperty(HTMLElement.prototype,'scrollIntoView',original);
      else delete (HTMLElement.prototype as unknown as {scrollIntoView?:unknown}).scrollIntoView;
    }
  });
  it('retains an invitation across login for a first-time member and accepts only after explicit submit', async () => {
    const syntheticToken='a'.repeat(64);fixture.authenticated=false;
    fixture.state!.selectedWorkspace=null;fixture.state!.organizations=[];fixture.state!.workspaces=[];
    await act(async () => root.render(tree('/app/settings?invite='+syntheticToken)));
    const signIn=Array.from(container.querySelectorAll('button')).find(button=>button.textContent==='Synthetic sign in');
    expect(signIn).toBeTruthy();expect(fixture.command).not.toHaveBeenCalled();
    await act(async () => signIn!.click());
    const form=container.querySelector('.workspace-invitation form') as HTMLFormElement;
    expect(form).not.toBeNull();expect((form.querySelector('[name="token"]') as HTMLInputElement).value).toBe(syntheticToken);
    expect(fixture.command).not.toHaveBeenCalled();
    await act(async () => form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(fixture.command).toHaveBeenCalledWith({type:'ACCEPT_INVITATION',token:syntheticToken});
  });
  it('keeps protected settings unmounted until workspace loading and errors are resolved', async () => {
    fixture.loading = true;
    await act(async () => root.render(tree('/app/settings?workspace=workspace')));
    expect(container.querySelector('form.sa-settings-form')).toBeNull();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    fixture.loading = false; fixture.error = new Error('Network unavailable');
    await act(async () => root.render(tree('/app/settings?workspace=workspace')));
    expect(container.querySelector('form.sa-settings-form')).toBeNull();
    expect(container.textContent).toContain('暂时无法读取工作区');
  });
  it.each([
    ['/app/channels/instagram', '渠道研究'], ['/app/landing', '落地页研究'], ['/app/research', '收藏与研究笔记'],
    ['/app/ads', '广告资料库'], ['/app/ads/creative-real', '广告详情'],
    ['/app/advertisers', '广告主'], ['/app/advertisers/brand-real', '广告主详情'],
  ])('provides the existing useApp facade and precise breadcrumb for %s', async (path, title) => {
    await act(async () => root.render(tree(`${path}?workspace=workspace`)));
    expect(container.querySelector('[data-workspace-context]')?.textContent).toBe('workspace');
    expect(container.querySelector('.studio-breadcrumb strong')?.textContent).toBe(title);
    expect(document.title).toBe(`${title} · AdTrender`);
  });
});
