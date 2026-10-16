import { useEffect, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ArrowUpRight, CreditCard, MessageSquare, RefreshCw, ShieldAlert, UserRound, UsersRound } from 'lucide-react';
import { clearPricingIntent } from './pricing-intent';
import { canManage, CommandButton, CommandForm, Field, formText, PageHeader, SourceLink, Status, useApp } from './App';
import { BillingSummary, WorkspaceSetup, InvitationForm } from './WorkspacePages';
import { useWorkspaceLocale } from './workspace-i18n/locale';
import './workspace-settings.css';

export function SettingsPage() {
  const { state, refresh } = useApp();
  const { t, href, date, money } = useWorkspaceLocale();
  const workspace = state.selectedWorkspace;
  const [params] = useSearchParams();
  const navigate = useNavigate();
  useEffect(() => clearPricingIntent(), []);
  const billing = state.billing;
  const organization = state.organizations.find(org => org.id === (workspace?.organizationId ?? billing?.organizationId));
  const isOwner = organization?.role === 'OWNER';
  const requestedPlan = params.get('plan');
  const selectedPlanId = billing?.plans.some(plan => plan.id === requestedPlan) ? requestedPlan! : '';
  const managedOrganizations = state.organizations.filter(org => org.role === 'OWNER' || org.role === 'ADMIN');
  const roleOptions = (allowAdmin = true) => <><option value="VIEWER">{t('settings.role.viewer')}</option><option value="EDITOR">{t('settings.role.editor')}</option><option value="ADMIN" disabled={!allowAdmin}>{t('settings.role.admin')}</option></>;

  return <div className="workspace-settings">
    <PageHeader title={t('settings.title')} description={t('settings.description')} />
    <div className="settings-layout">
      <nav className="settings-index" aria-label={t('settings.navigation')}>
        <p>{t('settings.navigation')}</p>
        <a href="#profile"><UserRound size={17} aria-hidden="true" />{t('settings.profile.title')}</a>
        <a href="#team"><UsersRound size={17} aria-hidden="true" />{t('settings.team.title')}</a>
        <a href="#billing"><CreditCard size={17} aria-hidden="true" />{t('settings.billing.title')}</a>
        <a href="#feedback"><MessageSquare size={17} aria-hidden="true" />{t('settings.feedback.title')}</a>
        <a className="settings-index-danger" href="#danger"><ShieldAlert size={17} aria-hidden="true" />{t('settings.danger.title')}</a>
        {organization && <div className="settings-current-team"><span>{t('settings.currentOrganization')}</span><strong>{organization.name}</strong><Status value={organization.role} /></div>}
      </nav>
      <div className="settings-content">
        <span id="account" className="settings-anchor" aria-hidden="true" />
        <SettingsSection id="profile" title={t('settings.profile.title')} description={t('settings.profile.description')} icon={<UserRound size={20} aria-hidden="true" />}>
          <CommandForm className="settings-profile-form" label={t('settings.profile.save')} build={data => ({ type: 'UPDATE_PROFILE', displayName: formText(data, 'displayName'), emailNotifications: data.has('emailNotifications') })}>
            <div className="settings-form-grid">
              <Field label={t('settings.profile.name')}><input name="displayName" defaultValue={state.user.displayName || ''} required maxLength={80} /></Field>
              <Field label={t('settings.profile.email')}><input type="email" value={state.user.email} readOnly /></Field>
            </div>
            <label className="checkbox-field"><input type="checkbox" name="emailNotifications" defaultChecked={state.user.emailNotifications} /><span>{t('settings.profile.notifications')}</span></label>
            <Link className="settings-password-link" to={href('/request-password-reset')}>{t('settings.profile.resetPassword')}<ArrowUpRight size={16} aria-hidden="true" /></Link>
          </CommandForm>
        </SettingsSection>

        <SettingsSection id="team" title={t('settings.team.title')} description={t('settings.team.description')} icon={<UsersRound size={20} aria-hidden="true" />}>
          {!workspace ? <WorkspaceSetup /> : <>
            <div className="settings-form-grid">
              <div className="settings-form-panel"><h3>{t('settings.team.newWorkspace')}</h3>
                <CommandForm label={t('settings.team.createWorkspace')} disabled={!canManage(state)} build={data => ({ type: 'CREATE_WORKSPACE', organizationId: workspace.organizationId, name: formText(data, 'name') })}>
                  <Field label={t('settings.team.workspaceName')}><input name="name" required maxLength={80} placeholder={t('settings.team.workspacePlaceholder')} /></Field>
                </CommandForm>
              </div>
              <div className="settings-form-panel"><h3>{t('settings.team.inviteHeading')}</h3>
                <CommandForm label={t('settings.team.invite')} disabled={!canManage(state)} reset build={data => ({ type: 'INVITE_MEMBER', workspaceId: workspace.id, email: formText(data, 'email'), role: formText(data, 'role') as 'ADMIN' | 'EDITOR' | 'VIEWER' })}>
                  <Field label={t('settings.team.memberEmail')}><input name="email" type="email" required placeholder="name@company.com" /></Field>
                  <Field label={t('settings.team.invitationRole')}><select name="role" defaultValue="VIEWER">{roleOptions()}</select></Field>
                </CommandForm>
              </div>
            </div>
            <div className="settings-subheading"><h3>{t('settings.team.members')}</h3><span>{t('settings.team.memberCount', { count: state.members.length })}</span></div>
            {state.members.length ? <div className="settings-member-list">{state.members.map(member => <article key={member.id}>
              <div className="settings-member-main"><span className="settings-avatar" aria-hidden="true">{(member.displayName || member.email).slice(0, 1).toUpperCase()}</span><div className="member-identity"><strong>{member.displayName || member.email}</strong><small>{member.email}</small></div>
                {member.organizationRole === 'MEMBER' && !member.workspaceRole ? <span className="muted">{t('settings.team.unassigned')}</span> : <Status value={member.organizationRole === 'OWNER' || member.organizationRole === 'ADMIN' ? member.organizationRole : member.workspaceRole} />}
              </div>
              {member.organizationRole !== 'OWNER' ? <div className="settings-member-controls">
                <CommandForm className="inline-form" label={t('settings.team.updateRole')} disabled={!canManage(state)} build={data => {
                  const role = formText(data, 'role');
                  return { type: 'UPDATE_MEMBER', workspaceId: workspace.id, memberId: member.id, organizationRole: role === 'ADMIN' ? 'ADMIN' : 'MEMBER', workspaceRole: role === 'VIEWER' ? 'VIEWER' : 'EDITOR' };
                }}><Field label={t('settings.team.role')} hint={!isOwner ? t('settings.team.adminOwnerOnly') : undefined}><select name="role" required defaultValue={member.organizationRole === 'ADMIN' ? isOwner ? 'ADMIN' : '' : member.workspaceRole || 'VIEWER'}><option value="" disabled>{t('settings.team.selectRole')}</option>{roleOptions(isOwner)}</select></Field></CommandForm>
                <div className="settings-member-removals">
                  {member.organizationRole === 'MEMBER' && member.workspaceRole && <CommandButton command={{ type: 'REMOVE_WORKSPACE_MEMBER', organizationId: workspace.organizationId, workspaceId: workspace.id, memberId: member.id }} disabled={!canManage(state)} className="text-button" confirmText={t('settings.team.revokeConfirm', { member: member.displayName || member.email, workspace: workspace.name })}>{t('settings.team.revokeWorkspace')}</CommandButton>}
                  <CommandButton command={{ type: 'REMOVE_MEMBER', workspaceId: workspace.id, memberId: member.id }} disabled={!canManage(state)} className="text-button settings-danger-text" confirmText={t('settings.team.removeConfirm')}>{t('settings.team.removeMember')}</CommandButton>
                </div>
              </div> : <p className="small-note settings-owner-note">{t('settings.team.ownerNote')}</p>}
            </article>)}</div> : <p className="settings-empty">{t('settings.team.empty')}</p>}
            {state.invitations?.length ? <div className="settings-invitations"><div className="settings-subheading"><h3>{t('settings.team.invitations')}</h3></div><div className="table-wrap"><table><thead><tr><th>{t('settings.team.invitedEmail')}</th><th>{t('settings.team.role')}</th><th>{t('settings.status')}</th><th>{t('settings.team.expires')}</th></tr></thead><tbody>{state.invitations.map(invitation => <tr key={invitation.id}><td>{invitation.email}</td><td><Status value={invitation.role} /></td><td><Status value={invitation.status} /></td><td>{date(invitation.expiresAt)}</td></tr>)}</tbody></table></div></div> : null}
          </>}
          <InvitationForm />
        </SettingsSection>

        <SettingsSection id="billing" title={t('settings.billing.title')} description={t('settings.billing.description')} icon={<CreditCard size={20} aria-hidden="true" />}>
          {managedOrganizations.length > 0 && <div className="settings-organization-picker"><Field label={t('settings.billing.viewOrganization')}><select value={organization?.id ?? ''} onChange={event => {
            const next = new URLSearchParams(params);
            next.delete('workspace'); next.set('organization', event.target.value);
            navigate(href(`/app/settings?${next}#billing`));
          }}><option value="" disabled>{t('settings.billing.chooseOrganization')}</option>{organization?.role === 'MEMBER' && <option value={organization.id} disabled>{organization.name} · {t('settings.billing.member')}</option>}{managedOrganizations.map(org => <option key={org.id} value={org.id}>{org.name} · {t(org.role === 'OWNER' ? 'settings.billing.owner' : 'settings.billing.admin')}</option>)}</select></Field></div>}
          {requestedPlan && !selectedPlanId && <p className="notice">{t('settings.billing.unavailableSelection')}</p>}
          <div className="settings-form-grid">
            <div className="settings-billing-summary"><BillingSummary state={state} />{billing?.providerMode === 'sandbox' && <p className="notice">{t('settings.billing.sandbox')}</p>}{billing?.providerMode === 'unconfigured' && <p className="small-note">{t('settings.billing.unconfigured')}</p>}</div>
            {organization && billing && <div className="settings-form-panel"><h3>{t('settings.billing.choosePlan')}</h3><CommandForm key={`${organization.id}:${selectedPlanId}`} label={t(billing.hasProviderSubscription ? 'settings.billing.schedulePlan' : 'settings.billing.checkout')} disabled={!isOwner || !billing.checkoutEnabled || !billing.plans.length || (Boolean(billing.hasProviderSubscription) && !billing.canChangePlan)} build={data => ({ type: billing.hasProviderSubscription ? 'CHANGE_PLAN' : 'CHECKOUT', organizationId: organization.id, planVersionId: formText(data, 'planVersionId') })}>
              <Field label={t('settings.billing.plan')}><select name="planVersionId" required defaultValue={selectedPlanId}><option value="" disabled>{t('settings.billing.choosePublished')}</option>{billing.plans.map(plan => <option key={plan.id} value={plan.id} disabled={plan.priceMinor == null || !plan.currency}>{plan.name} · {money(plan.priceMinor, plan.currency)}</option>)}</select></Field>
              <p className="small-note">{t(billing.hasProviderSubscription && !billing.canChangePlan ? 'settings.billing.changePending' : 'settings.billing.changeTiming')}</p>
            </CommandForm></div>}
          </div>
          {billing?.plans.length ? <div className="settings-plan-list">{billing.plans.map(plan => <article key={plan.id}><h3>{plan.name}</h3><strong>{money(plan.priceMinor, plan.currency)}</strong><small>{t(plan.interval === 'month' || plan.interval === 'MONTH' ? 'settings.billing.monthly' : 'settings.billing.interval')}</small><p>{plan.description}</p><ul>{plan.features.map(feature => <li key={feature}>{feature}</li>)}</ul></article>)}</div> : <p className="settings-empty">{t('settings.billing.noPlans')}</p>}
          {organization && billing && billing.hasProviderSubscription && <div className="settings-action-row"><div><strong>{t(billing.cancelAtPeriodEnd ? 'settings.billing.ending' : 'settings.billing.cancelRenewal')}</strong><p>{t('settings.billing.cancelDescription')}</p></div><CommandButton command={{ type: 'CANCEL_SUBSCRIPTION', organizationId: organization.id }} disabled={!isOwner || billing.cancelAtPeriodEnd} confirmText={t('settings.billing.cancelConfirm')}>{t(billing.cancelAtPeriodEnd ? 'settings.billing.canceled' : 'settings.billing.cancel')}</CommandButton></div>}
          <div className="settings-subheading"><h3>{t('settings.billing.invoices')}</h3></div>
          {billing?.invoices?.length ? <div className="table-wrap"><table><thead><tr><th>{t('settings.billing.date')}</th><th>{t('settings.billing.number')}</th><th>{t('settings.billing.amount')}</th><th>{t('settings.billing.files')}</th></tr></thead><tbody>{billing.invoices.map(invoice => <tr key={invoice.id}><td>{date(invoice.issuedAt)}</td><td>{invoice.number || t('settings.billing.notProvided')}</td><td>{money(invoice.totalMinor, invoice.currency)}</td><td><div className="row-actions">{invoice.invoiceUrl && <SourceLink url={invoice.invoiceUrl}>{t('settings.billing.invoice')}</SourceLink>}{invoice.receiptUrl && <SourceLink url={invoice.receiptUrl}>{t('settings.billing.receipt')}</SourceLink>}</div></td></tr>)}</tbody></table></div> : <p className="settings-empty">{t(billing?.invoiceStatus === 'UNAVAILABLE' ? 'settings.billing.invoiceUnavailable' : 'settings.billing.noInvoices')}</p>}
          <p className="small-note">{t('settings.billing.taxNote')}</p>
        </SettingsSection>

        <SettingsSection id="feedback" title={t('settings.feedback.title')} description={t('settings.feedback.description')} icon={<MessageSquare size={20} aria-hidden="true" />}>
          <CommandForm className="settings-feedback-form" label={t('settings.feedback.submit')} reset build={data => ({ type: 'SUBMIT_FEEDBACK', workspaceId: workspace?.id, category: formText(data, 'category'), message: formText(data, 'message') })}>
            <Field label={t('settings.feedback.category')}><select name="category"><option value="GENERAL">{t('settings.feedback.general')}</option><option value="DATA_REQUEST">{t('settings.feedback.data')}</option><option value="BUG">{t('settings.feedback.bug')}</option><option value="BILLING">{t('settings.billing.title')}</option></select></Field>
            <Field label={t('settings.feedback.message')} hint={t('settings.feedback.secretHint')}><textarea name="message" required rows={5} maxLength={5000} /></Field>
          </CommandForm>
          <div className="settings-subheading"><h3>{t('settings.feedback.history')}</h3><button type="button" className="text-button settings-refresh" onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" />{t('settings.feedback.refresh')}</button></div>
          <p className="small-note">{t('settings.feedback.historyNote')}</p>
          {state.organizationSupportRequests?.length ? <div className="settings-feedback-list">{state.organizationSupportRequests.map(request => <article key={request.id}><header><strong>{request.subject}</strong><Status value={request.status} /><small>{t('settings.feedback.submitted', { date: date(request.createdAt, true) })}</small></header><p className="small-note">{request.organization.name} / {request.workspace ? request.workspace.name : t('settings.feedback.organizationRequest')}</p><p className="support-body">{request.body}</p><p className="small-note">{t('settings.feedback.requestId', { id: request.id })}{request.resolvedAt ? ` · ${t('settings.feedback.resolved', { date: date(request.resolvedAt, true) })}` : ''}</p></article>)}</div> : null}
          {state.supportRequests?.length ? <div className="settings-feedback-list">{state.supportRequests.map(request => <article key={request.id}><header><strong>{t(request.kind === 'DELETION_REQUEST' ? 'settings.feedback.accountDeletion' : 'settings.feedback.accountFeedback')}</strong><Status value={request.status} /><small>{t('settings.feedback.submitted', { date: date(request.createdAt, true) })}</small></header><p className="support-body">{request.body}</p><p className="small-note">{t('settings.feedback.requestId', { id: request.id })}{request.resolvedAt ? ` · ${t('settings.feedback.resolved', { date: date(request.resolvedAt, true) })}` : ''}</p></article>)}</div> : null}
          {!state.supportRequests?.length && !state.organizationSupportRequests?.length && <p className="settings-empty">{t('settings.feedback.empty')}</p>}
          <p className="small-note"><a href="#danger">{t('settings.feedback.deletionLink')}</a></p>
        </SettingsSection>

        <SettingsSection id="danger" title={t('settings.danger.title')} description={t('settings.danger.description')} icon={<ShieldAlert size={20} aria-hidden="true" />} danger>
          {workspace && <div className="settings-danger-block"><div className="settings-action-row"><div><h3>{t('settings.danger.archive', { workspace: workspace.name })}</h3><p>{t('settings.danger.archiveDescription')}</p></div><CommandButton command={{ type: 'ARCHIVE_WORKSPACE', organizationId: workspace.organizationId, workspaceId: workspace.id }} disabled={!canManage(state)} className="button secondary settings-danger-button" confirmText={t('settings.danger.archiveConfirm', { workspace: workspace.name })}>{t('settings.danger.archiveAction')}</CommandButton></div></div>}
          {workspace && isOwner && <details className="settings-danger-block settings-ownership"><summary>{t('settings.danger.transfer')}</summary>
            <CommandForm className="compact-form" label={t('settings.danger.transferAction')} disabled={state.members.filter(member => member.organizationRole !== 'OWNER').length === 0} build={data => ({ type: 'TRANSFER_OWNERSHIP', organizationId: workspace.organizationId, memberId: formText(data, 'memberId') })}>
              <Field label={t('settings.danger.newOwner')}><select name="memberId" required defaultValue=""><option value="" disabled>{t('settings.danger.selectMember')}</option>{state.members.filter(member => member.organizationRole !== 'OWNER').map(member => <option key={member.id} value={member.id}>{member.displayName || member.email}</option>)}</select></Field>
              <label className="checkbox-field"><input type="checkbox" required /><span>{t('settings.danger.transferConfirm')}</span></label>
            </CommandForm>
          </details>}
          <div className="settings-danger-block"><h3>{t('settings.danger.deletionTitle')}</h3>
            <CommandForm className="compact-form" label={t('settings.danger.deletionAction')} build={data => ({ type: 'REQUEST_DELETION', scope: formText(data, 'scope') as 'ACCOUNT' | 'ORGANIZATION', organizationId: formText(data, 'scope') === 'ORGANIZATION' ? organization?.id : undefined, reason: formText(data, 'reason') })}>
              <Field label={t('settings.danger.scope')}><select name="scope"><option value="ACCOUNT">{t('settings.danger.accountScope')}</option>{isOwner && <option value="ORGANIZATION">{t('settings.danger.organizationScope')}</option>}</select></Field>
              <Field label={t('settings.danger.reason')}><textarea name="reason" required rows={4} maxLength={2000} /></Field>
              <p className="small-note">{t('settings.danger.deletionNote')}</p>
            </CommandForm>
          </div>
        </SettingsSection>
      </div>
    </div>
  </div>;
}

function SettingsSection({ id, title, description, icon, danger = false, children }: {
  id: string; title: string; description: string; icon: ReactNode; danger?: boolean; children: ReactNode;
}) {
  return <section className={`settings-card${danger ? ' settings-card-danger' : ''}`} id={id} aria-labelledby={`settings-${id}-title`}>
    <header><span className="settings-section-icon">{icon}</span><div><h2 id={`settings-${id}-title`}>{title}</h2><p>{description}</p></div></header>
    <div className="settings-card-body">{children}</div>
  </section>;
}
