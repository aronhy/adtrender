import {landingPageUrl} from './ad-links';
import { Brand } from './brand/Brand';
import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { logout, useAuth } from 'wasp/client/auth';
import { appCommand, getAppState, useQuery } from 'wasp/client/operations';
import { ArrowUpRight, Bookmark, CircleHelp, FolderSearch, LayoutDashboard, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Search, Settings, X } from 'lucide-react';
import type { AppCommand, AppState, CommandResult, DateValue } from './types';
import { continuePricingAfterSetup } from './pricing-intent';
import { clearHomeSearchIntent } from './home-search-intent';
import { SiteAnalytics } from './site-analytics/SiteAnalytics';
import './style.css';
import './workspace.css';
import { WorkspaceLanguagePicker, WorkspaceLocaleProvider, useWorkspaceLocale } from './workspace-i18n/locale';
import { commandNoticeKey } from './workspace-i18n/messages';
import { appSurface } from './app-surface';
import { SurfaceBoundary } from './SurfaceBoundary';
import { AdminShell } from './AdminShell';

type AppContextValue = { state: AppState; commandVersion: number; refresh: () => Promise<unknown>; run: (command: AppCommand) => Promise<CommandResult> };
const AppContext = createContext<AppContextValue | null>(null);
export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('Workspace context is required');
  return context;
}
export const canEdit = (state: AppState) => ['OWNER', 'ADMIN', 'EDITOR'].includes(state.role);
export const canManage = (state: AppState) => ['OWNER', 'ADMIN'].includes(state.role);
export const workspaceHref = (path: string, workspaceId?: string | null) => workspaceId ? `${path}?workspace=${encodeURIComponent(workspaceId)}` : path;
export function dateLabel(value?: DateValue, withTime = false) {
  if (!value) return '暂无记录';
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', ...(withTime ? { timeStyle: 'short' as const } : {}) }).format(date) : '时间未知';
}
export function moneyLabel(amount: number | null | undefined, currency?: string | null) {
  if (amount == null || !currency) return '价格待公布';
  try { const formatter = new Intl.NumberFormat('zh-CN', { style: 'currency', currency }); const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2; return formatter.format(amount / (10 ** digits)); } catch { return '价格待确认'; }
}
export function externalUrl(value?: string | null) {
  try { const url = new URL(value ?? ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
export function errorLabel(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (/SOURCE_CAPABILITY_UNVERIFIED/.test(raw)) return '此查询尚未通过真实来源验证，或验证已过期。请先完成来源验证再启用。';
  if (/WORKSPACE_ROLE_INHERITED/.test(raw)) return '此成员通过组织角色访问工作区，不能单独撤销一个工作区的权限。';
  if (/ANALYSIS_ATTEMPT_LIMIT/.test(raw)) return '这次分析已达到重试上限，请通过反馈说明问题。';
  if (/ANALYSIS_NOT_RETRYABLE|ANALYSIS_RETRY_KEY_USED/.test(raw)) return '分析状态或重试请求已更新，请刷新状态后查看结果。';
  if (/FORBIDDEN|AUTH_REQUIRED|ACCOUNT_DISABLED|403/.test(raw)) return '当前账号没有此操作权限，或成员权限已发生变化。请刷新后重试。';
  if (/QUOTA|LIMIT|ENTITLEMENT/.test(raw)) return '当前套餐额度不足。请查看用量或联系组织所有者。';
  if (/NOT_CONFIGURED|DISABLED|UNAVAILABLE|NOT_ENABLED/.test(raw)) return '此服务尚未就绪。你的资料仍然保留，请稍后重试或提交反馈。';
  if (/EXPIRED/.test(raw)) return '链接或操作已过期，请刷新页面后重试。';
  if (/OWNER|LAST_OWNER/.test(raw)) return '组织至少需要一位所有者，请先完成所有权转移。';
  if (/RATE|429/.test(raw)) return '操作较频繁，请稍等片刻再试。';
  if (/INVALID|VALIDATION|400/.test(raw)) return '提交内容未通过校验，请检查必填项和填写格式。';
  return '操作未完成，请稍后重试。若问题持续，请通过设置页提交反馈。';
}
export function Status({ value }: { value?: string | null }) {
  const { status } = useWorkspaceLocale();
  const code = value ?? 'UNKNOWN';
  return <span className={`status ${['active', 'inactive', 'unknown'].includes(code) ? `status-source-${code}` : ''} ${['FAILED', 'DEGRADED', 'DELAYED', 'PAST_DUE'].includes(code) ? 'status-attention' : ''}`}>{status(value)}</span>;
}
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-mark" aria-hidden="true"><FolderSearch size={24} /></span><h3>{title}</h3>{children && <p>{children}</p>}{action}</div>;
}
export function Loading({ label }: { label?: string }) { const { t } = useWorkspaceLocale(); return <div className="loading-state" role="status"><span className="spinner" />{label ?? t('common.loading')}</div>; }
export function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <header className="page-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</header>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export const formText = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
export function CommandForm({ build, children, label, disabled = false, className = '', reset = false }: {
  build: (data: FormData) => AppCommand; children: ReactNode; label?: string; disabled?: boolean; className?: string; reset?: boolean;
}) {
  const { run } = useApp(); const { t, error: describeError } = useWorkspaceLocale(); const pending = useRef(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (pending.current || disabled) return;
    const form = event.currentTarget; pending.current = true; setBusy(true); setError(null);
    try { await run(build(new FormData(form))); if (reset) form.reset(); } catch (reason) { setError(reason); } finally { pending.current = false; setBusy(false); }
  };
  return <form onSubmit={submit} className={`command-form ${className}`} aria-busy={busy}><fieldset disabled={busy || disabled}>{children}<div className="form-actions"><button className="button primary" type="submit">{busy ? t('common.saving') : label ?? t('common.save')}</button>{disabled && <span className="muted">{t('common.unavailableAction')}</span>}</div></fieldset>{error !== null && <p className="inline-error" role="alert">{describeError(error)}</p>}</form>;
}
export function CommandButton({ command, children, disabled = false, className = 'button secondary', confirmText }: {
  command: AppCommand; children: ReactNode; disabled?: boolean; className?: string; confirmText?: string;
}) {
  const { run } = useApp(); const { t, error: describeError } = useWorkspaceLocale(); const pending = useRef(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<unknown>(null);
  return <div className="command-action"><button className={className} disabled={busy || disabled} onClick={async () => {
    if (pending.current || disabled) return;
    if (confirmText && !window.confirm(confirmText)) return;
    pending.current = true;
    setBusy(true); setError(null); try { await run(command); } catch (reason) { setError(reason); } finally { pending.current = false; setBusy(false); }
  }}>{busy ? t('common.working') : children}</button>{error !== null && <span className="inline-error" role="alert">{describeError(error)}</span>}</div>;
}
export function SourceLink({ url, children, onClick, allowHttp = false }: { url?: string | null; children: ReactNode; onClick?: () => void; allowHttp?: boolean }) {
  const { t } = useWorkspaceLocale();
  const href = allowHttp ? landingPageUrl(url) : externalUrl(url);
  return href ? <a href={href} target="_blank" rel="noopener noreferrer" className="external-link" onClick={onClick}>{children}<ArrowUpRight size={15} aria-hidden="true" /></a> : <span className="muted">{t('common.sourceMissing')}</span>;
}
export function track(command: Extract<AppCommand, { type: 'PRODUCT_EVENT' }>) { void appCommand(command).catch(() => {}); }

function PublicLayout() {
  const location = useLocation();
  if (location.pathname === '/' || ['/login', '/signup', '/request-password-reset', '/password-reset', '/email-verification', '/login/google/callback'].includes(location.pathname.replace(/\/+$/, ''))) return <Outlet />;
  return <div className="public-site"><header className="site-header"><Brand /><nav aria-label="官网导航"><NavLink to="/pricing">套餐</NavLink><NavLink to="/help">帮助</NavLink><Link to="/login">登录</Link><Link className="button primary compact" to="/signup">开始使用</Link></nav></header><Outlet /><footer className="site-footer"><Brand /><p>公开广告，有据可查。团队研究，各自保留。</p><nav aria-label="页脚导航"><Link to="/help">帮助中心</Link><Link to="/terms">服务条款</Link><Link to="/privacy">隐私说明</Link></nav><small>已开放注册 · 正式服务与价格以发布说明为准</small></footer></div>;
}
function WorkspaceLayout() {
  const { t, href, locale, error: describeError } = useWorkspaceLocale();
  const [params] = useSearchParams(); const navigate = useNavigate(); const location = useLocation();
  const workspaceId = params.get('workspace') || undefined;
  const organizationId = params.get('organization') || undefined;
  const query = useQuery(getAppState, { workspaceId, organizationId }); const state = query.data as AppState | undefined;
  const [menuOpen, setMenuOpen] = useState(false); const [notice, setNotice] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('adthrender.workspace.sidebarCollapsed') === 'true'; }
    catch { return false; }
  });
  const [commandVersion, setCommandVersion] = useState(0);
  const menuRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    try { localStorage.setItem('adthrender.workspace.sidebarCollapsed', String(sidebarCollapsed)); }
    catch { /* Sidebar controls remain usable when storage is unavailable. */ }
  }, [sidebarCollapsed]);
  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.activeElement;
    const panel = menuRef.current;
    const focusable = () => Array.from(panel?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), select:not([disabled]), input:not([disabled])') ?? []).filter(el => el.getClientRects().length > 0);
    focusable()[0]?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); }
      if (event.key === 'Tab') {
        const nodes = focusable(), first = nodes[0], last = nodes.at(-1);
        if (event.shiftKey && (document.activeElement === first || !panel?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !panel?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKey);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', handleKey); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [menuOpen]);
  useEffect(() => {
    if (!window.matchMedia) return;
    const wide = window.matchMedia('(min-width: 961px)');
    const closeWideMenu = () => { if (wide.matches) setMenuOpen(false); };
    wide.addEventListener('change', closeWideMenu);
    return () => wide.removeEventListener('change', closeWideMenu);
  }, []);
  const run = async (command: AppCommand): Promise<CommandResult> => {
    const result = (await appCommand(command)) as CommandResult;
    setCommandVersion(version => version + 1);
    setNotice(commandNoticeKey(command.type));
    if (result && Object.hasOwn(result, 'workspaceId')) {
      const nextWorkspaceId = result.workspaceId ?? undefined;
      const nextOrganizationId = nextWorkspaceId ? undefined : result.organizationId;
      const pricingDestination = continuePricingAfterSetup(command.type, nextWorkspaceId, params.get('plan'));
      navigate(href(pricingDestination ?? (nextWorkspaceId ? workspaceHref('/app', nextWorkspaceId) : nextOrganizationId ? `/app?organization=${encodeURIComponent(nextOrganizationId)}` : '/app')), { replace: true });
      if (workspaceId === nextWorkspaceId && organizationId === nextOrganizationId) await query.refetch();
    } else await query.refetch();
    if (result?.redirectUrl) {
      const target = new URL(result.redirectUrl, window.location.origin);
      if (target.protocol === 'https:' || target.origin === window.location.origin) window.location.assign(target.href);
    }
    return result ?? {};
  };
  const selected = state?.selectedWorkspace;
  const contextHref = (path: string) => href(selected ? workspaceHref(path, selected.id) : state?.billing?.organizationId ? `${path}?organization=${encodeURIComponent(state.billing.organizationId)}` : path);
  const navigation = [
    ['/app/ads', 'nav.ads', Search], ['/app/overview', 'nav.overview', LayoutDashboard],
    ['/app/research', 'nav.research', Bookmark], ['/app/settings', 'nav.settings', Settings],
  ] as const;
  const currentTitle = t(navigation.find(([path]) => location.pathname.startsWith(path))?.[1] ?? (selected ? 'nav.ads' : 'nav.start'));
  const switchWorkspace = (id: string) => { setMenuOpen(false); navigate(href(workspaceHref('/app', id))); };
  useEffect(() => { const original = document.title; document.title = `${currentTitle} · AdThrender`; return () => { document.title = original; }; }, [currentTitle]);
  return <div className={`workspace-shell${location.pathname.replace(/\/+$/, '') === '/app/ads' ? ' workspace-library-shell' : ''}${location.pathname.startsWith('/app/ads') ? ' workspace-ads-shell' : ''}${sidebarCollapsed ? ' workspace-collapsed' : ''}`} lang={locale} data-locale={locale}>
    <a href="#main-content" className="workspace-skip">{t('nav.skip')}</a>
    <header className="mobile-bar"><Brand to={contextHref('/app')} />{location.pathname.replace(/\/+$/, '') === '/app/ads' && <><div className="library-header-title"><strong>{t(params.get('source') === 'google' || params.get('platform') === 'google' ? 'ads.library.googleTitle' : 'ads.title')}</strong><span>{t('ads.description')}</span></div><WorkspaceLanguagePicker /></>}<button ref={toggleRef} className="icon-button workspace-menu-toggle" onClick={() => setMenuOpen(!menuOpen)} aria-label={t(menuOpen ? 'nav.close' : 'nav.open')} aria-expanded={menuOpen} aria-controls="workspace-navigation">{menuOpen ? <X /> : <Menu />}</button></header>
    {menuOpen && <button className="nav-scrim" aria-label={t('nav.close')} onClick={() => setMenuOpen(false)} tabIndex={-1} />}
    <aside id="workspace-navigation" ref={menuRef} className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`} role={menuOpen ? 'dialog' : undefined} aria-modal={menuOpen || undefined} aria-label={t('nav.label')}>
      <div className="workspace-sidebar-brand" onClick={() => setMenuOpen(false)}><Brand to={contextHref('/app')} /><button className="icon-button sidebar-close" aria-label={t('nav.close')} onClick={() => setMenuOpen(false)}><X size={20} /></button></div>
      <div className="workspace-switch"><label htmlFor="workspace-select">{t('nav.workspace')}</label><select id="workspace-select" value={selected?.id ?? ''} disabled={!state?.workspaces.length} onChange={event => switchWorkspace(event.target.value)}><option value="" disabled>{t('nav.noWorkspace')}</option>{state?.workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select>{state && state.role !== 'NONE' && <Status value={state.role} />}</div>
      <button type="button" className="sidebar-collapse" aria-label={t(sidebarCollapsed ? 'nav.expandSidebar' : 'nav.collapseSidebar')} title={t(sidebarCollapsed ? 'nav.expandSidebar' : 'nav.collapseSidebar')} aria-expanded={!sidebarCollapsed} aria-controls="workspace-navigation" onClick={() => setSidebarCollapsed(value => !value)}>{sidebarCollapsed ? <PanelLeftOpen size={19} aria-hidden="true" /> : <PanelLeftClose size={19} aria-hidden="true" />}<span>{t('nav.collapseSidebar')}</span></button>
      <nav aria-label={t('nav.label')}>{navigation.map(([path, key, Icon]) => <NavLink key={path} to={contextHref(path)} onClick={() => setMenuOpen(false)} aria-label={t(key)} title={t(key)}><Icon size={19} aria-hidden="true" /><span className="sidebar-link-label">{t(key)}</span></NavLink>)}</nav>
      <div className="sidebar-bottom"><Link to={href('/help')} className="support-link" aria-label={t('nav.help')} title={t('nav.help')}><CircleHelp size={19} aria-hidden="true" /><span className="sidebar-link-label">{t('nav.help')}</span></Link>{state && <div className="account-line"><span className="avatar" aria-hidden="true">{(state.user.displayName || state.user.email).slice(0, 1).toUpperCase()}</span><div><strong>{state.user.displayName || t('nav.account')}</strong><small>{state.user.email}</small></div><button onClick={() => void logout()} className="icon-button workspace-signout" aria-label={t('nav.signOut')} title={t('nav.signOut')}><LogOut size={17} aria-hidden="true" /></button></div>}</div>
    </aside>
    <main className="workspace-main" id="main-content" tabIndex={-1} inert={menuOpen || undefined}><div className="workspace-topline"><div className="workspace-context"><div><span>{state?.organizations.find(org => org.id === (selected?.organizationId ?? state?.billing?.organizationId))?.name ?? t('nav.start')}</span><span className="workspace-breadcrumb"> / {currentTitle}</span></div><select className="workspace-topline-switch" aria-label={t('nav.workspace')} title={t('nav.workspace')} value={selected?.id ?? ''} disabled={!state?.workspaces.length} onChange={event => switchWorkspace(event.target.value)}><option value="" disabled>{t('nav.noWorkspace')}</option>{state?.workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></div><WorkspaceLanguagePicker /></div>
      {notice && <div className="notice" role="status">{t(notice)}<button className="icon-button" onClick={() => setNotice('')} aria-label={t('common.dismiss')}><X size={16} /></button></div>}
      {query.isLoading ? <Loading label={t('common.workspaceLoading')} /> : query.error || !state ? <Empty title={t('common.workspaceError')} action={<button className="button secondary" onClick={() => void query.refetch()}>{t('common.reconnect')}</button>}>{query.error ? describeError(query.error) : t('common.workspaceErrorBody')}</Empty> : <AppContext.Provider key={`${selected?.id ?? 'new'}:${location.pathname.startsWith('/app/admin') ? 'admin' : 'app'}`} value={{ state, commandVersion, run, refresh: query.refetch }}><Outlet /></AppContext.Provider>}
    </main></div>;
}
function AdminLayout() {
  const query = useQuery(getAppState, {}); const state = query.data as AppState | undefined;
  const [commandVersion, setCommandVersion] = useState(0);
  const run = async (command: AppCommand): Promise<CommandResult> => {
    const result = (await appCommand(command)) as CommandResult;
    setCommandVersion(version => version + 1);
    await query.refetch();
    return result ?? {};
  };
  return <AdminShell state={state} loading={query.isLoading} error={query.error} onRetry={() => void query.refetch()} onSignOut={() => void logout()}>
    {state && <AppContext.Provider value={{ state, commandVersion, run, refresh: query.refetch }}><Outlet /></AppContext.Provider>}
  </AdminShell>;
}
function WorkspaceSession() {
  const auth = useAuth(); const { t, href } = useWorkspaceLocale();
  const { pathname } = useLocation();
  const surface = appSurface();
  useEffect(() => {
    // A homepage search may start before session lookup finishes. Once the
    // customer reaches the library, it must not affect a later login.
    if (surface === 'customer' && auth.data && /^\/app\/ads\/?$/.test(pathname)) clearHomeSearchIntent();
  }, [surface, auth.data, pathname]);
  if (surface === 'admin') {
    if (auth.isLoading || auth.error) return <AdminShell loading={auth.isLoading} error={auth.error} onRetry={() => void auth.refetch()} onSignOut={() => void logout()} />;
    if (!auth.data) return <Navigate to={href('/login')} replace />;
    return <AdminLayout />;
  }
  if (auth.isLoading) return <div className="workspace-session"><Loading label={t('common.sessionLoading')} /></div>;
  if (auth.error) return <div className="workspace-session"><Empty title={t('common.sessionError')} action={<button className="button secondary" onClick={() => void auth.refetch()}>{t('common.retry')}</button>}>{t('common.networkHint')}</Empty></div>;
  if (!auth.data) return <Navigate to={href('/login')} replace />;
  return <WorkspaceLayout />;
}
export function App() {
  const location = useLocation();
  const content = location.pathname.startsWith('/app') ? <WorkspaceLocaleProvider><WorkspaceSession /></WorkspaceLocaleProvider> : <PublicLayout />;
  return <SurfaceBoundary>{appSurface() === 'admin' ? content : <SiteAnalytics>{content}</SiteAnalytics>}</SurfaceBoundary>;
}
