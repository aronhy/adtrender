import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router';
import { ArrowRight, Bookmark, FileText, FolderPlus, Search, Users } from 'lucide-react';
import { CommandForm, Empty, errorLabel, Field, formText, Loading, PageHeader, Status, useApp, workspaceHref } from './App';
import { getStudioState, useQuery } from 'wasp/client/operations';
import { useWorkspaceLocale } from './workspace-i18n/locale';
import type { AppState, SourceHealth } from './types';
import { advertiserName } from './ad-media';

export function workspaceEntryDestination(search: string, workspaceId: string, hash = '', defaultStartPage = 'ads') {
  const params = new URLSearchParams(search);
  params.set('workspace', workspaceId);
  if (params.has('invite')) return `/app/settings?${params}#team`;
  if (params.has('plan')) return `/app/settings?${params}#billing`;
  const hasSearch = Boolean(params.get('q')?.trim() || params.get('domain')?.trim());
  const path = hasSearch || defaultStartPage === 'ads' ? '/app/ads' : defaultStartPage === 'advertisers' ? '/app/advertisers' : defaultStartPage === 'tracking' ? '/app/tracking' : '/app/overview';
  return `${path}?${params}${hash}`;
}

export function WorkspaceEntryPage() {
  const { state } = useApp(); const { href } = useWorkspaceLocale(); const location = useLocation();
  if (!state.selectedWorkspace) return <WorkspacePage />;
  const params = new URLSearchParams(location.search);
  if (params.has('invite') || params.has('plan')) return <Navigate to={href(workspaceEntryDestination(location.search, state.selectedWorkspace.id, location.hash))} replace />;
  return <PreferredWorkspaceEntry key={state.selectedWorkspace.id} workspaceId={state.selectedWorkspace.id} />;
}
function PreferredWorkspaceEntry({ workspaceId }: { workspaceId: string }) {
  const { href } = useWorkspaceLocale(); const location = useLocation();
  const query = useQuery(getStudioState, { workspaceId });
  if (query.error) return <Empty title="偏好读取失败" action={<button className="button secondary" onClick={() => void query.refetch()}>重试</button>}>{errorLabel(query.error)}</Empty>;
  if (query.isLoading || !query.data) return <Loading />;
  return <Navigate to={href(workspaceEntryDestination(location.search, workspaceId, location.hash, query.data.preferences.defaultStartPage))} replace />;
}

export function WorkspaceRequired() {
  const { t, href } = useWorkspaceLocale();
  return <Empty title={t('workspace.required')} action={<Link className="button primary" to={href('/app')}>{t('workspace.createAction')}</Link>}>{t('workspace.requiredBody')}</Empty>;
}
export function CreateOrganization() {
  const { t } = useWorkspaceLocale();
  return <section className="onboarding-panel"><div className="workspace-welcome-copy"><span className="workspace-welcome-icon"><FolderPlus size={28} aria-hidden="true" /></span><p className="eyebrow">{t('workspace.setupEyebrow')}</p><h2>{t('workspace.setupTitle')}</h2><p>{t('workspace.setupBody')}</p><small>{t('workspace.setupNote')}</small></div>
    <CommandForm label={t('workspace.createEnter')} build={data => ({ type: 'CREATE_ORGANIZATION', name: formText(data, 'name'), workspaceName: formText(data, 'workspaceName') })}>
      <Field label={t('workspace.teamLabel')}><input name="name" required maxLength={80} placeholder={t('workspace.teamPlaceholder')} autoComplete="organization" /></Field>
      <Field label={t('workspace.firstLabel')}><input name="workspaceName" required maxLength={80} placeholder={t('workspace.spacePlaceholder')} /></Field>
    </CommandForm>
  </section>;
}
export function WorkspaceSetup() {
  const { state } = useApp(); const [params, setParams] = useSearchParams(); const { t, href } = useWorkspaceLocale();
  const managed = state.organizations.filter(organization => ['OWNER', 'ADMIN'].includes(organization.role));
  const organization = managed.find(item => item.id === state.billing?.organizationId) ?? managed[0];
  if (!state.organizations.length) return <CreateOrganization />;
  if (!organization) return <Empty title={t('workspace.noAccess')}>{t('workspace.noAccessBody')}</Empty>;
  return <section className="section-block workspace-existing-setup"><div className="section-title"><h2>{t('workspace.existingTitle')}</h2></div><p className="muted">{t('workspace.existingBody')}</p>
    {managed.length > 1 && <Field label={t('workspace.organization')}><select value={organization.id} onChange={event => { const next = new URLSearchParams(params); next.delete('workspace'); next.set('organization', event.target.value); setParams(next); }}>{managed.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>}
    <CommandForm key={organization.id} className="compact-form" label={t('workspace.createEnter')} build={data => ({ type: 'CREATE_WORKSPACE', organizationId: organization.id, name: formText(data, 'name') })}>
      <Field label={t('workspace.organization')}><input readOnly value={organization.name} /></Field>
      <Field label={t('workspace.newLabel')}><input name="name" required maxLength={80} placeholder={t('workspace.spacePlaceholder')} /></Field>
    </CommandForm><p className="small-note">{t('workspace.quotaHint')} <Link to={href(`/app/settings?organization=${encodeURIComponent(organization.id)}#billing`)}>{t('workspace.viewPlan')} →</Link></p>
  </section>;
}
export function InvitationForm() {
  const { run } = useApp(); const { t, error: describeError } = useWorkspaceLocale();
  const [params, setParams] = useSearchParams(); const [token, setToken] = useState(params.get('invite') ?? '');
  const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false); const pending = useRef(false);
  useEffect(() => { if (params.has('invite')) { const next = new URLSearchParams(params); next.delete('invite'); setParams(next, { replace: true }); } }, []);
  return <details className="section-block workspace-invitation" open={token ? true : undefined}><summary><span><Users size={20} aria-hidden="true" />{t('workspace.inviteTitle')}</span><ArrowRight size={17} aria-hidden="true" /></summary><p className="muted">{t('workspace.inviteBody')}</p>
    <form className="command-form compact-form" onSubmit={async event => {
      event.preventDefault(); if (pending.current) return; pending.current = true; setBusy(true); setError(null);
      try { await run({ type: 'ACCEPT_INVITATION', token }); setToken(''); } catch (reason) { setError(reason); } finally { pending.current = false; setBusy(false); }
    }}><fieldset disabled={busy}><Field label={t('workspace.inviteLabel')} hint={t('workspace.inviteHint')}><input name="token" type="password" autoComplete="off" required value={token} onChange={event => setToken(event.target.value)} /></Field><button className="button primary" type="submit">{t(busy ? 'workspace.accepting' : 'workspace.accept')}</button></fieldset>{error !== null && <p className="inline-error" role="alert">{describeError(error)}</p>}</form>
  </details>;
}
export function Fact({ label, value }: { label: string; value: ReactNode }) { return <div className="fact"><span>{label}</span><strong>{value ?? '—'}</strong></div>; }
export function HealthNotice({ health }: { health: SourceHealth }) {
  const { t } = useWorkspaceLocale(); const healthy = ['ACTIVE', 'HEALTHY', 'SUCCEEDED'].includes(health.status);
  return <div className={`source-health ${healthy ? '' : 'source-delayed'}`}><span className="health-dot" aria-hidden="true" /><Status value={health.status} /><p>{t(healthy ? 'workspace.healthGood' : 'workspace.healthLimited')}</p></div>;
}
export function BillingSummary({ state }: { state: AppState }) {
  const { t, date } = useWorkspaceLocale(); const billing = state.billing;
  if (!billing) return <Empty title={t('workspace.noPlan')}>{t('workspace.noPlanBody')}</Empty>;
  const quotaLabel = (key: string, fallback: string) => ['WORKSPACES', 'MEMBERS', 'SAVED_ADS', 'ANALYSES'].includes(key) ? t(`workspace.quota.${key.toLowerCase()}`) : fallback;
  return <><div className="billing-current"><strong>{billing.planName || t('workspace.noPlanSelected')}</strong><Status value={billing.status} /></div>
    {billing.periodEnd && <p className="muted">{t(billing.cancelAtPeriodEnd ? 'workspace.accessUntil' : 'workspace.periodEnds', { date: date(billing.periodEnd) })}</p>}
    <div className="quota-list">{billing.entitlements.map(entitlement => <div key={entitlement.key}><div><span>{quotaLabel(entitlement.key, entitlement.label)}</span><strong>{entitlement.status === 'UNAVAILABLE' ? t('workspace.quotaUnavailable') : `${entitlement.used} / ${entitlement.limit ?? t('workspace.unlimited')}`}</strong></div>
      {entitlement.status === 'ACTIVE' && entitlement.limit != null && entitlement.limit > 0 && <progress value={Math.min(entitlement.used, entitlement.limit)} max={entitlement.limit} aria-label={t('workspace.quotaUsed', { label: quotaLabel(entitlement.key, entitlement.label) })} />}
      {entitlement.status === 'ACTIVE' && entitlement.resetAt && <small>{t('workspace.validUntil', { date: date(entitlement.resetAt) })}</small>}</div>)}</div>
    {!billing.entitlements.length && <p className="muted">{t('workspace.noQuota')}</p>}</>;
}
export function WorkspacePage() {
  const { state } = useApp(); const workspace = state.selectedWorkspace; const { t, href, date } = useWorkspaceLocale();
  if (!workspace) return <><PageHeader eyebrow={t('nav.space')} title={t('workspace.welcome')} description={t('workspace.welcomeBody')} /><WorkspaceSetup /><InvitationForm /></>;
  const next = [
    { key: 'Find', to: '/app/ads', icon: Search }, { key: 'Save', to: '/app/research', icon: Bookmark }, { key: 'Analyze', to: '/app/research', icon: FileText },
  ];
  const firstVisit = state.overview.savedCount === 0 && state.overview.analysisCount === 0;
  return <><div className="overview-hero"><PageHeader eyebrow={workspace.name} title={t('workspace.overview')} description={t('workspace.overviewBody')} action={<Link className="button primary" to={href(workspaceHref('/app/ads', workspace.id))}>{t('workspace.search')} <ArrowRight size={16} /></Link>} /></div>
    <div className="fact-strip"><Fact label={t('workspace.saved')} value={state.overview.savedCount} /><Fact label={t('workspace.analyses')} value={state.overview.analysisCount} /><Fact label={t('workspace.processing')} value={state.overview.pendingAnalysisCount} /><Fact label={t('workspace.updated')} value={date(state.overview.dataUpdatedAt)} /></div>
    <HealthNotice health={state.overview.sourceHealth} />
    {firstVisit && <section className="section-block workspace-first-steps"><div className="section-title"><div><h2>{t('workspace.startTitle')}</h2><p className="muted">{t('workspace.startBody')}</p></div></div><div className="onboarding-steps">{next.map(({ key, to, icon: Icon }) => <Link key={key} to={href(workspaceHref(to, workspace.id))}><span className="step-number"><Icon size={22} aria-hidden="true" /></span><h3>{t(`workspace.step${key}`)}</h3><p>{t(`workspace.step${key}Body`)}</p><ArrowRight size={17} aria-hidden="true" /></Link>)}</div></section>}
    <div className="overview-columns"><section className="section-block"><div className="section-title"><h2>{t('workspace.recent')}</h2><Link to={href(workspaceHref('/app/research', workspace.id))}>{t('workspace.viewAll')} →</Link></div>
      {state.research.savedAds.length ? <div className="activity-list">{state.research.savedAds.slice(0, 5).map(ad => <Link key={ad.id} to={href(workspaceHref(`/app/ads/${encodeURIComponent(ad.adId)}`, workspace.id))}><Bookmark size={19} aria-hidden="true" /><div><strong>{advertiserName(ad.advertiserName) || ad.copy?.trim() || t('ads.viewDetails')}</strong>{advertiserName(ad.advertiserName) && <small>{ad.copy || t('workspace.noCopy')}</small>}</div><span>{date(ad.savedAt)}</span></Link>)}</div>
        : <Empty title={t('workspace.noSaved')} action={<Link to={href(workspaceHref('/app/ads', workspace.id))}>{t('workspace.search')} →</Link>}>{t('workspace.noSavedBody')}</Empty>}
    </section><section className="section-block"><div className="section-title"><h2>{t('workspace.plan')}</h2><Link to={href(workspaceHref('/app/settings', workspace.id) + '#billing')}>{t('workspace.manage')} →</Link></div><BillingSummary state={state} /></section></div>
  </>;
}
