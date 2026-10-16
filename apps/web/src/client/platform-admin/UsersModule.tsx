import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { AdminConfirm, AdminDrawer, AdminEmpty, AdminError, AdminKpis, AdminNotice, AdminPagination, AdminSkeleton, AdminStatus, Button, adminDate, useAdminResource, type AdminModuleProps } from './shared';
import { LineTrend, BarRanking, RatioBar } from './charts';
import { permissionError } from './navigation';
import { quotaNames, quotaShortNames, quotaSummary } from './users-view';
import { useAdminCopy } from './admin-i18n';
import { usersCopy } from './users-copy';
import type { AdminEntitlement, PlatformAdminUsersResult, PlatformAdminUserRow, PlatformAdminOrganizationRow, PlatformAdminUserDetail, PlatformAdminOrganizationDetail } from '../../server/platform-admin-users';
import './users-module.css';

type Section = 'users' | 'organizations';
const roleNames: Record<string, string> = { OWNER: '所有者', ADMIN: '管理员', MEMBER: '成员', EDITOR: '编辑者', VIEWER: '查看者' };
const requestNames: Record<string, string> = { FEEDBACK: '问题反馈', DELETION_REQUEST: '删除申请', GENERAL: '使用问题', DATA_REQUEST: '数据申请', BUG: '功能异常', BILLING: '订阅问题' };
const subscriptionNames: Record<string, string> = { TRIALING: '试用中', ACTIVE: '有效', PAST_DUE: '逾期', CANCELED: '已取消', INACTIVE: '未生效', UNCONFIGURED: '未配置' };
const quotaKeys = ['WORKSPACES', 'MEMBERS', 'SAVED_ADS', 'ANALYSES'] as const;
const commandErrors: Record<string, string> = { SELF_DISABLE_FORBIDDEN: '不能停用当前登录的管理员账号。', LAST_PLATFORM_ADMIN: '这是最后一个有效的平台管理员，请先设置其他管理员。', LAST_ACTIVE_OWNER: '这是组织最后一个有效所有者，请先完成所有权转移。', ACCOUNT_CONFIRMATION_MISMATCH: '邮箱确认与当前账号不匹配，请核对后重试。', ENTITLEMENT_EXPIRED: '该权益记录已过期或尚未生效，请先核对订阅周期。', ORGANIZATION_FORBIDDEN: '该组织当前无法调整权益，请刷新并核对组织状态。', INVALID_ADMIN_COMMAND: '请完整填写有效的调整内容和原因。' };

export function UsersModule({ load, execute, reload, range, rangeControls }: AdminModuleProps) {
  const { t } = useAdminCopy(usersCopy);
  const [params, setParams] = useSearchParams();
  const section: Section = params.get('usersTab') === 'organizations' ? 'organizations' : 'users';
  const search = (params.get('search') ?? '').slice(0, 200);
  const allowedStatuses = section === 'users' ? ['ALL', 'VERIFIED', 'UNVERIFIED', 'DISABLED'] : ['ALL', 'ACTIVE', 'ARCHIVED'];
  const status = allowedStatuses.includes(params.get('status') ?? '') ? params.get('status')! : 'ALL';
  const [history, setHistory] = useState<Array<string | undefined>>([undefined]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState<PlatformAdminOrganizationRow | null>(null);
  const [account, setAccount] = useState<PlatformAdminUserRow | null>(null);
  const [notice, setNotice] = useState(''); const [localReload, setLocalReload] = useState(0);
  const [actionError, setActionError] = useState<unknown>();
  useEffect(() => { setDetailId(null); setNotice(''); }, [section]);
  useEffect(() => { setHistory([undefined]); }, [section, search, status, range?.from, range?.to]);
  const resource = useAdminResource<PlatformAdminUsersResult>(load, { section, search, status, ...range, cursor: history.at(-1) }, reload + localReload);
  const data = resource.data;
  const changeSection = (next: Section) => { const updated = new URLSearchParams(params); updated.set('usersTab', next); updated.delete('status'); updated.delete('search'); setParams(updated); };
  const changeFilters = (filters: { search?: string; status?: string }) => { const updated = new URLSearchParams(params); for (const [key, value] of Object.entries(filters)) { if (!value || value === 'ALL') updated.delete(key); else updated.set(key, value); } setParams(updated, { replace: true }); setHistory([undefined]); };
  const refreshAfterCommand = () => { setLocalReload(value => value + 1); resource.refresh(); };
  const issueCommand = async (payload: Record<string, unknown>) => { try { return await execute(payload); } catch (error) { if (permissionError(error)) setActionError(error); const message = error instanceof Error ? error.message : String(error); const code = Object.keys(commandErrors).find(key => message.includes(key)); if (code) throw new Error(t(commandErrors[code])); throw error; } };
  const forbidden = permissionError(resource.error) || permissionError(actionError);
  const currentData = data?.section === section ? data : undefined;
  return <>
    <div className="pa-toolbar pa-users-controls">
    <div className="pa-tabs pa-users-tabs" role="tablist" aria-label={t("用户与组织子页签")}>
      <button type="button" role="tab" aria-selected={section === 'users'} onClick={() => changeSection('users')}>{t("用户")}</button>
      <button type="button" role="tab" aria-selected={section === 'organizations'} onClick={() => changeSection('organizations')}>{t("组织")}</button>
    </div>
    <label className="pa-users-search">{section === 'users' ? t("用户搜索") : t("组织搜索")}<input type="search" value={search} maxLength={200} placeholder={section === 'users' ? t("邮箱或显示名") : t("组织名称")} onChange={event => changeFilters({ search: event.target.value })} /></label>
      <label>{t("状态")}<select value={status} onChange={event => changeFilters({ status: event.target.value })}><option value="ALL">{t("全部状态")}</option>{section === 'users' ? <><option value="VERIFIED">{t("已验证")}</option><option value="UNVERIFIED">{t("未验证")}</option><option value="DISABLED">{t("已停用")}</option></> : <><option value="ACTIVE">{t("启用")}</option><option value="ARCHIVED">{t("已归档")}</option></>}</select></label>
      {(search || status !== 'ALL') && <Button variant="ghost" size="sm" onClick={() => changeFilters({ search: '', status: 'ALL' })}>{t("清除筛选")}</Button>}
      {rangeControls}
    </div>
    {notice && <AdminNotice>{notice}</AdminNotice>}
    {!!resource.error && <AdminError error={resource.error} retry={resource.refresh} />}
    {!!actionError && <AdminError error={actionError} retry={() => { setActionError(undefined); resource.refresh(); }} />}
    {!forbidden && (resource.loading && !currentData ? <AdminSkeleton /> : currentData && <>
      <details className="pa-users-trend" key={section}>
        <summary><span>{section === 'users' ? t('查看注册趋势') : t('查看套餐分布')}</span><span className="pa-users-result"><strong>{t('共 {count} 条', { count: currentData.total })}</strong><span>{t("按创建时间从新到旧 · 每页 20 条")}</span></span></summary>
        {section === 'users' ? <LineTrend title={t(currentData.chart.label)} data={currentData.chart.points.map(point => ({ date: point.label, value: point.value }))} series={[{ key: 'value', label: t("注册用户") }]} caveat={t("按账号 ID 去重；注册日期按 Asia/Hong_Kong 汇总，状态与搜索筛选同步作用于趋势。")} /> : <BarRanking title={t(currentData.chart.label)} data={currentData.chart.points.map(point => ({ ...point, label: point.label === '未配置套餐' ? t(point.label) : point.label }))} caveat={t("按组织 ID 去重，套餐按组织的当前订阅记录归类；未配置套餐单独显示。")} />}
      </details>
      {currentData.rows.length ? section === 'users' ? <UserTable rows={currentData.rows as PlatformAdminUserRow[]} open={setDetailId} /> : <OrganizationTable rows={currentData.rows as PlatformAdminOrganizationRow[]} open={setDetailId} adjust={setAdjusting} /> : <AdminEmpty title={section === 'users' ? t("还没有注册用户") : t("还没有组织")}>{search || status !== 'ALL' || range ? t("当前筛选范围没有记录。可调整搜索、状态或时间范围。") : section === 'users' ? t("账号完成注册后会出现在这里。") : t("用户创建组织后会出现在这里。")}</AdminEmpty>}
      <p className="pa-caveat">{section === 'users' ? t("最近活动仅取本产品记录的最近一次产品事件，不代表最近登录；无记录显示「—」。") : t("表格额度为「已用 + 预留 / 上限」。预留尚未结算，不代表已完成分析；详情显示完整用量。")}<br />{t('时间范围按{kind}筛选 · Asia/Hong_Kong', { kind: section === 'users' ? t('注册时间') : t('组织创建时间') })}</p>
      <AdminPagination page={history.length} nextCursor={currentData.nextCursor} loading={resource.loading} onPrevious={() => setHistory(values => values.slice(0, -1))} onNext={() => { if (currentData.nextCursor) setHistory(values => [...values, currentData.nextCursor!]); }} />
    </>)}
    {!forbidden && detailId && <UserOrganizationDrawer load={load} execute={execute} reload={reload + localReload} section={section} detailId={detailId} onClose={() => setDetailId(null)} adjust={setAdjusting} account={setAccount} />}
    {!forbidden && adjusting && <EntitlementModal target={adjusting} execute={issueCommand} onClose={() => setAdjusting(null)} onSuccess={() => { setNotice(t('{name} 的权益已调整，已记录审计。', { name: adjusting.name })); refreshAfterCommand(); }} />}
    {!forbidden && account && <AdminConfirm title={t(account.disabledAt ? '恢复账号 — {email}' : '停用账号 — {email}', { email: account.email ?? t('未记录邮箱') })} danger={!account.disabledAt} match={!account.disabledAt ? account.email ?? undefined : undefined} onClose={() => setAccount(null)} onConfirm={async reason => {
      await issueCommand({ type: 'SET_ACCOUNT_STATUS', targetUserId: account.id, disabled: !account.disabledAt, reason, ...(!account.disabledAt ? { confirmationEmail: account.email } : {}) });
      setNotice(account.disabledAt ? t("账号已恢复，已记录审计。") : t("账号已停用。下一次受保护请求即被拒绝。")); refreshAfterCommand();
    }} />}
  </>;
}

function UserIdentity({ user }: { user: PlatformAdminUserRow }) {
  const { t } = useAdminCopy(usersCopy);
  const name = user.displayName || user.email || t("未填写显示名");
  return <span className="pa-user-identity"><span className="pa-user-avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span><span><strong>{user.displayName || t("未填写显示名")}</strong><small>{user.email || t("未记录邮箱")}</small></span></span>;
}
function UserTable({ rows, open }: { rows: PlatformAdminUserRow[]; open: (id: string) => void }) {
  const { t, locale } = useAdminCopy(usersCopy);
  return <div className="pa-table-wrap"><table className="pa-table pa-users-table"><thead><tr><th>{t("用户")}</th><th>{t("注册时间")}</th><th>{t("邮箱验证")}</th><th>{t("账号状态")}</th><th>{t("所属组织")}</th><th>{t("最近活动")}</th><th>{t("操作")}</th></tr></thead><tbody>{rows.map(user => <tr key={user.id} className="pa-users-clickable-row">
    <td><UserIdentity user={user} /></td>
    <td>{adminDate(user.createdAt, locale)}</td><td><span className={`pa-badge pa-badge-${user.emailVerified ? 'active' : 'neutral'}`}>{user.emailVerified ? t("已验证") : t("未验证")}</span></td>
    <td><span className={`pa-badge pa-badge-${user.disabledAt ? 'conflict' : 'neutral'}`}>{user.disabledAt ? t("已停用") : t("正常")}</span></td><td>{user.organizationCount || <span className="pa-caveat">{t("无")}</span>}</td><td>{adminDate(user.lastActivityAt, locale)}</td>
    <td><button type="button" className="pa-user-row-overlay" aria-label={t('查看用户 {name}', { name: user.email ?? user.displayName ?? user.id })} onClick={() => open(user.id)} /><span className="pa-user-row-view" aria-hidden="true">{t("查看")}</span></td>
  </tr>)}</tbody></table></div>;
}
function OrganizationTable({ rows, open, adjust }: { rows: PlatformAdminOrganizationRow[]; open: (id: string) => void; adjust: (row: PlatformAdminOrganizationRow) => void }) {
  const { t, locale } = useAdminCopy(usersCopy);
  return <div className="pa-table-wrap"><table className="pa-table pa-organizations-table"><thead><tr><th>{t("组织")}</th><th>{t("状态")}</th><th>{t("套餐")}</th><th>{t("当前周期")}</th><th>{t("取消安排")}</th><th>{t("额度")}</th><th>{t("操作")}</th></tr></thead><tbody>{rows.map(row => <tr key={row.id} className="pa-users-clickable-row">
    <td><span className="pa-user-detail-button"><strong>{row.name}</strong><small>{t('成员 {count} 位', { count: row.memberCount })}</small></span></td>
    <td><AdminStatus value={row.status} /></td><td>{row.planName || t("未配置套餐")}<small className="pa-users-subscription"><span className="pa-badge">{row.subscription ? t(subscriptionNames[row.subscription.status] ?? row.subscription.status) : t("无订阅记录")}</span></small></td>
    <td><span className="pa-date-line">{adminDate(row.subscription?.currentPeriodStart, locale)}</span><span className="pa-date-line">{adminDate(row.subscription?.currentPeriodEnd, locale)}</span></td>
    <td>{row.subscription?.cancelAtPeriodEnd ? t("周期末取消") : <span className="pa-caveat">{t("未安排")}</span>}</td>
    <td><div className="pa-quota-summary">{row.entitlements.map(item => { const summary = quotaSummary(item); return <span key={item.key} className={`pa-quota-${summary.tone}`} title={t('{name}：{summary}（已用 + 预留 / 上限）', { name: t(quotaNames[item.key]), summary: t(summary.text) })}><span>{t(quotaShortNames[item.key])}</span><strong>{t(summary.text)}</strong></span>; })}</div></td>
    <td><button type="button" className="pa-user-row-overlay" aria-label={t('查看组织 {name}', { name: row.name })} onClick={() => open(row.id)} /><Button className="pa-user-row-action" variant="ghost" size="sm" disabled={row.status !== 'ACTIVE'} onClick={event => { event.stopPropagation(); adjust(row); }}>{t("调整权益")}</Button></td>
  </tr>)}</tbody></table></div>;
}
function FieldList({ fields }: { fields: Array<[string, ReactNode]> }) {
  return <dl className="pa-users-fields">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>; }
function UserOrganizationDrawer({ load, execute: _execute, reload, section, detailId, onClose, adjust, account }: AdminModuleProps & { section: Section; detailId: string; onClose: () => void; adjust: (row: PlatformAdminOrganizationRow) => void; account: (row: PlatformAdminUserRow) => void }) {
  const { t } = useAdminCopy(usersCopy);
  const resource = useAdminResource<PlatformAdminUsersResult>(load, { section, detailId }, reload); const detail = resource.data?.detail;
  const footer = detail?.kind === 'USER' ? <Button variant={detail.disabledAt ? 'secondary' : 'destructive'} disabled={!detail.disabledAt && !detail.email} onClick={() => account(detail)}>{detail.disabledAt ? t("恢复账号") : t("停用账号")}</Button> : detail?.kind === 'ORGANIZATION' ? <Button disabled={detail.status !== 'ACTIVE'} onClick={() => adjust(detail)}>{t("调整权益")}</Button> : undefined;
  return <AdminDrawer title={detail?.kind === 'USER' ? detail.displayName || detail.email || t("用户详情") : detail?.kind === 'ORGANIZATION' ? detail.name : section === 'users' ? t("用户详情") : t("组织详情")} onClose={onClose} footer={permissionError(resource.error) ? undefined : footer}>
    {!!resource.error && <AdminError error={resource.error} retry={resource.refresh} />}{resource.loading && !detail ? <AdminSkeleton /> : !permissionError(resource.error) && detail && (detail.kind === 'USER' ? <UserDetail detail={detail} /> : <OrganizationDetail detail={detail} />)}
  </AdminDrawer>;
}
function UserDetail({ detail }: { detail: PlatformAdminUserDetail }) {
  const { t, locale } = useAdminCopy(usersCopy);
  return <><AdminKpis items={[{ label: t("所属组织数"), value: detail.organizationCount }, { label: t("收藏数"), value: detail.savedCount }, { label: t("分析任务数"), value: detail.analysisCount }, { label: t("支持申请数"), value: detail.supportCount }]} /><p className="pa-caveat">{t("组织按成员关系计数；收藏和分析按该用户提交的记录计数，支持含账号申请与组织反馈，不展示私人笔记或分析内容。")}</p>
    <section className="pa-users-detail-section"><h3>{t("账号")}</h3><FieldList fields={[[t("邮箱"), detail.email || t("未记录邮箱")], [t("显示名"), detail.displayName || t("未填写")], [t("邮箱验证"), detail.emailVerified ? t("已验证") : t("未验证")], [t("账号状态"), detail.disabledAt ? t("已停用") : t("正常")], [t("注册时间"), adminDate(detail.createdAt, locale)], [t("最近产品活动"), adminDate(detail.lastActivityAt, locale)]]} /><p className="pa-caveat">{t("停用不删除账号与数据；下一次受保护请求即被拒绝。")}</p></section>
    <section className="pa-users-detail-section"><h3>{t("组织关系")}</h3>{detail.organizations.length ? <div className="pa-table-wrap"><table className="pa-table"><thead><tr><th>{t("组织")}</th><th>{t("角色")}</th><th>{t("加入时间")}</th></tr></thead><tbody>{detail.organizations.map(item => <tr key={item.id}><td>{item.name}</td><td>{t(roleNames[item.role] ?? item.role)}</td><td>{adminDate(item.joinedAt, locale)}</td></tr>)}</tbody></table></div> : <p className="pa-caveat">{t("无组织关系。")}</p>}</section>
    <section className="pa-users-detail-section"><h3>{t("支持申请")}</h3><p className="pa-caveat">{t("展示最近 20 条申请；完整正文与处理在事务管理查看。")}</p>{detail.supportRequests.length ? <div className="pa-table-wrap"><table className="pa-table"><thead><tr><th>{t("申请")}</th><th>{t("归属")}</th><th>{t("状态")}</th><th>{t("时间")}</th></tr></thead><tbody>{detail.supportRequests.map(item => <tr key={`${item.scope}:${item.id}`}><td>{item.subject || t(requestNames[item.kind] || item.kind)}</td><td>{item.scope === 'ACCOUNT' ? t("账号") : t("组织")}</td><td><AdminStatus value={item.status} /></td><td>{adminDate(item.createdAt, locale)}</td></tr>)}</tbody></table></div> : <p className="pa-caveat">{t("该用户尚未提交支持申请。")}</p>}</section>
  </>;
}
function OrganizationDetail({ detail }: { detail: PlatformAdminOrganizationDetail }) {
  const { t, locale } = useAdminCopy(usersCopy);
  return <><AdminKpis items={[{ label: t("成员数"), value: detail.memberCount }, { label: t("工作区数"), value: detail.workspaceCount }, { label: t("收藏数"), value: detail.savedCount }, { label: t("本周期分析次数"), value: detail.periodAnalysisCount ?? '—' }]} /><p className="pa-caveat">{t("组织全局范围；工作区仅计未归档记录，分析按当前订阅周期内创建的任务计数；未配置周期时显示「—」。")}</p>
    <section className="pa-users-detail-section"><h3>{t("订阅")}</h3><FieldList fields={[[t("套餐版本"), detail.subscription ? `${detail.planName} · v${detail.subscription.planVersion}` : t("未配置")], [t("状态"), detail.subscription ? t(subscriptionNames[detail.subscription.status] ?? detail.subscription.status) : t("无订阅记录")], [t("当前周期"), `${adminDate(detail.subscription?.currentPeriodStart, locale)} — ${adminDate(detail.subscription?.currentPeriodEnd, locale)}`], [t("取消安排"), detail.subscription?.cancelAtPeriodEnd ? t('周期末取消：{time}', { time: adminDate(detail.subscription.currentPeriodEnd, locale) }) : t("未安排")], [t("供应商订阅标识"), detail.providerSubscriptionId || t("未配置")]]} /></section>
    <section className="pa-users-detail-section"><h3>{t("额度")}</h3>{detail.entitlements.map(item => <QuotaDetail key={item.key} item={item} />)}<p className="pa-caveat">{t("预留尚未结算，不代表已完成分析；已用数可在降级后超过上限。未配置、已过期或尚未生效的记录不作为当前额度。")}</p></section>
    <section className="pa-users-detail-section"><h3>{t("成员")}</h3>{detail.members.length ? <div className="pa-table-wrap"><table className="pa-table"><thead><tr><th>{t("成员")}</th><th>{t("组织角色")}</th><th>{t("工作区角色")}</th></tr></thead><tbody>{detail.members.map(member => <tr key={member.id}><td>{member.displayName || t("未填写显示名")}<small className="table-note">{member.email || t("未记录邮箱")}</small></td><td>{t(roleNames[member.organizationRole] ?? member.organizationRole)}</td><td>{['OWNER', 'ADMIN'].includes(member.organizationRole) ? t("全部工作区管理权限") : member.workspaceRoles.length ? member.workspaceRoles.map(workspace => `${workspace.name}：${t(roleNames[workspace.role] ?? workspace.role)}`).join('；') : t("未加入工作区")}</td></tr>)}</tbody></table></div> : <p className="pa-caveat">{t("该组织没有成员记录。")}</p>}</section>
    <section className="pa-users-detail-section"><h3>{t("用量账本")}</h3><p className="pa-caveat">{t("最近 20 条 UsageLedger；释放原因来自用量记录，不代表分析结果。")}</p>{detail.usageLedger.length ? <div className="pa-table-wrap"><table className="pa-table"><thead><tr><th>{t("时间")}</th><th>{t("权益项")}</th><th>{t("数量")}</th><th>{t("状态")}</th><th>{t("释放原因")}</th></tr></thead><tbody>{detail.usageLedger.map(item => <tr key={item.id}><td>{adminDate(item.createdAt, locale)}</td><td>{t(quotaNames[item.key as keyof typeof quotaNames] ?? item.key)}</td><td>{item.quantity}</td><td><AdminStatus value={item.status} /></td><td>{item.releaseReason || '—'}</td></tr>)}</tbody></table></div> : <p className="pa-caveat">{t("没有用量账本记录。")}</p>}</section>
  </>;
}
function QuotaDetail({ item }: { item: AdminEntitlement }) {
  const { t, locale } = useAdminCopy(usersCopy);
  return <div className="pa-quota-detail"><h4>{t(quotaNames[item.key])}</h4>{item.current ? <><p className="pa-caveat">{t('已用 {used} / 预留 {reserved} / 上限 {limit} / 有效至 {time}', { used: item.current.used, reserved: item.current.reserved, limit: item.current.limit, time: item.current.validUntil ? adminDate(item.current.validUntil, locale) : t('长期有效') })}</p><RatioBar used={item.current.used + item.current.reserved} limit={item.current.limit} /><span className="pa-caveat">{t("指示条按已用与预留合计展示。")}</span></> : <p className="pa-caveat">{t("当前无有效额度记录。")}</p>}</div>;
}
function EntitlementModal({ target, execute, onClose, onSuccess }: { target: PlatformAdminOrganizationRow; execute: AdminModuleProps['execute']; onClose: () => void; onSuccess: () => void }) {
  const { t, locale } = useAdminCopy(usersCopy);
  const [key, setKey] = useState<(typeof quotaKeys)[number]>('ANALYSES'); const [limit, setLimit] = useState('');
  const current = target.entitlements.find(item => item.key === key)?.current;
  const number = Number(limit);
  const valid = limit.trim() !== '' && Number.isSafeInteger(number) && number >= 0 && number <= 1_000_000 && !!current;
  return <AdminConfirm title={t('调整权益 — {name}', { name: target.name })} onClose={onClose} disabled={!valid} confirmLabel={t("记录并调整权益")} onConfirm={async reason => { if (!valid) throw new Error('INVALID_ADMIN_COMMAND'); await execute({ type: 'ADJUST_ENTITLEMENT', organizationId: target.id, key, limit: number, reason }); onSuccess(); }}>
    <FieldList fields={[[t("当前套餐"), target.planName || t("未配置套餐")], [t("周期"), `${adminDate(target.subscription?.currentPeriodStart, locale)} — ${adminDate(target.subscription?.currentPeriodEnd, locale)}`]]} />
    <label>{t("权益项")}<select value={key} onChange={event => { setKey(event.target.value as typeof key); setLimit(''); }}>{quotaKeys.map(item => <option value={item} key={item}>{t(quotaNames[item])}</option>)}</select></label>
    <p className="pa-caveat">{current ? t('已用 {used} / 预留 {reserved} / 上限 {limit}', { used: current.used, reserved: current.reserved, limit: current.limit }) : t("该项当前没有有效记录，不能调整。请先核对订阅周期。")}</p>
    <label>{t("调整后的上限 *")}<input type="number" min={0} max={1_000_000} step={1} value={limit} required onChange={event => setLimit(event.target.value)} /></label>
    {limit !== '' && !valid && <AdminNotice tone="warning">{t("上限需为 0 至 1,000,000 的整数，且该项有当前有效额度。")}</AdminNotice>}
    <p className="pa-caveat">{t("此操作会记录审计。已用与预留数保持不变；调整后的上限可低于现有用量。")}</p>
  </AdminConfirm>;
}
