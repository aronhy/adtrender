import { useAdminCopy } from './admin-i18n';
import { activityCopy } from './activity-copy';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { ActivityFilters, ActivityRow, ActivityTab, ActivityView } from '../../server/platform-admin-activity';
import { AdminConfirm, AdminDrawer, AdminEmpty, AdminKpis, AdminNotice, useAdminResource, type AdminModuleProps } from './shared';
import { BarRanking, LineTrend, ResultDonut, StackedBars } from './charts';
import { activityError, activityClearParams, activityFilterParams, activityFiltersFromParams, activityPeriodParams, activityTabParams, activityLabels, activityMetric, activityTableColumns, activityValue, isActivityPermissionError } from './activity-view';
const analyticsCaveat = '产品事件（ad_detail_open、source_link_click、media_play）只用于分析本产品的使用情况，不得呈现为广告效果。';
const emailCaveat = '邮件正文与其中的链接不可在后台查看；邮件链接与 token 不入日志、不在后台展示、不在导出中出现。';
function defaultDates(days = 7) { const day = (offset: number) => new Date(Date.now() + 8 * 3600000 - offset * 86400000).toISOString().slice(0, 10); return { from: day(days - 1), to: day(0) }; }
function ActivityModule({ tabs, notice, ...props }: AdminModuleProps & {
    tabs: ActivityTab[];
    notice?: string;
}) {
    const { t, locale } = useAdminCopy(activityCopy);
    const [params, setParams] = useSearchParams();
    const requested = params.get('tab') as ActivityTab | null;
    const tab = requested && tabs.includes(requested) ? requested : tabs[0];
    const setTab = (nextTab: ActivityTab) => setParams(previous => activityTabParams(previous,nextTab));
    const allDates=activityFiltersFromParams(tab,params).allDates===true;
    const defaults = defaultDates();
    const range = props.range ?? { from: params.get('from') ?? defaults.from, to: params.get('to') ?? defaults.to };
    const setRange = (nextRange: {
        from: string;
        to: string;
    }) => setParams(previous => activityPeriodParams(previous,nextRange));
    const [pending, setPending] = useState<{
        feedback: number;
        requests: number;
    }>();
    return <>{notice && <AdminNotice>{t(notice)}</AdminNotice>}
 <div className="pa-toolbar">{tabs.length > 1 && <div className="pa-tabs" role="tablist" aria-label={t("管理记录分类")}>{tabs.map(key => <button type="button" role="tab" aria-selected={key === tab} key={key} onClick={() => setTab(key)}>{t(activityLabels[key])}{(key === 'feedback' || key === 'requests') && Boolean(pending?.[key]) && <span className="pa-badge">{pending?.[key]}</span>}</button>)}</div>}
 <div className="pa-range-controls"><label>{t("时间范围")}<select aria-label={t("时间范围")} onChange={event => {
            if(event.target.value==='all')setParams(previous=>{const next=new URLSearchParams(previous);next.set('pending','all');next.delete('cursor');return next;});
            else setRange(event.target.value==='custom'?range:defaultDates(Number(event.target.value)));
        }} value={allDates?'all':range.from===defaults.from&&range.to===defaults.to?'7':range.from===defaultDates(30).from&&range.to===defaults.to?'30':'custom'}>{['feedback','requests','email'].includes(tab)&&<option value="all">{t("全部日期")}</option>}<option value="7">{t("近 7 天")}</option><option value="30">{t("近 30 天")}</option><option value="custom">{t("自定义")}</option></select></label><label>{t("开始")}<input aria-label={t("开始日期")} type="date" disabled={allDates} value={range.from} max={range.to} onChange={e => setRange({ ...range, from: e.target.value })}/></label><label>{t("结束")}<input aria-label={t("结束日期")} type="date" disabled={allDates} value={range.to} min={range.from} max={defaultDates().to} onChange={e => setRange({ ...range, to: e.target.value })}/></label></div></div>
 <ActivityScreen key={tab} {...props} tab={tab} range={range} onPending={setPending}/></>;
}
export function AnalyticsModule(props: AdminModuleProps) { const { t, locale } = useAdminCopy(activityCopy); return <ActivityModule {...props} tabs={['visits', 'product', 'usage']} notice={analyticsCaveat}/>; }
export function OperationsModule(props: AdminModuleProps) { const { t, locale } = useAdminCopy(activityCopy); return <ActivityModule {...props} tabs={['feedback', 'requests', 'audit']}/>; }
export function EmailModule(props: AdminModuleProps) { const { t, locale } = useAdminCopy(activityCopy); return <ActivityModule {...props} tabs={['email']} notice={emailCaveat}/>; }
function ActivityScreen({ load, execute, reload, tab, range, onPending }: AdminModuleProps & {
    tab: ActivityTab;
    range: {
        from: string;
        to: string;
    };
    onPending: (value: {
        feedback: number;
        requests: number;
    }) => void;
}) {
    const { t, locale } = useAdminCopy(activityCopy);
    const [params, setParams] = useSearchParams();
    const filters = activityFiltersFromParams(tab, params);
    const [search, setSearch] = useState(filters.search ?? '');
    const [organizationDraft, setOrganizationDraft] = useState(filters.organizationId ?? '');
    const [actorDraft, setActorDraft] = useState(filters.actorUserId ?? '');
    const [conflict, setConflict] = useState(false);
    const [pageState, setPageState] = useState<{
        scope: string;
        cursors: Array<string | undefined>;
    }>({ scope: '', cursors: [undefined] });
    const payloadFilters = { ...filters, ...range };
    const scope = JSON.stringify(payloadFilters);
    const cursors = pageState.scope === scope ? pageState.cursors : [undefined];
    const resource = useAdminResource<ActivityView>(load, { tab, filters: payloadFilters, cursor: cursors.at(-1) }, reload);
    const [detail, setDetail] = useState<ActivityRow | null>(null);
    const [confirm, setConfirm] = useState<ActivityRow | null>(null);
    const [exporting, setExporting] = useState(false);
    const [localError, setLocalError] = useState('');
    const view = resource.data;
    const readonly = ['visits', 'product', 'usage', 'audit'].includes(tab);
    const canExport = ['visits', 'product', 'usage'].includes(tab);
    useEffect(() => {
        if (view?.pending)
            onPending(view.pending);
    }, [view?.pending, onPending]);
    useEffect(() => {
        if (view && detail) {
            const fresh = view.rows.find(row => row.id === detail.id);
            if (fresh && JSON.stringify(fresh) !== JSON.stringify(detail))
                setDetail(fresh);
        }
    }, [view, detail]);
    useEffect(() => { setSearch(filters.search ?? ''); setOrganizationDraft(filters.organizationId ?? ''); setActorDraft(filters.actorUserId ?? ''); }, [filters.search, filters.organizationId, filters.actorUserId]);
    const updateFilter = (key: keyof ActivityFilters, value: string) => setParams(previous => activityFilterParams(previous, key, value));
    const clearFilters = () => {
        setParams(previous => activityClearParams(previous,tab));
        setSearch('');
        setOrganizationDraft('');
        setActorDraft('');
    };
    if (isActivityPermissionError(resource.error))
        return <AdminEmpty title={t("没有访问权限")}>{t("当前身份没有有效的平台管理员权限，请联系平台负责人。导出与写操作已停用。")}</AdminEmpty>;
    async function exportRows() {
        setExporting(true);
        setLocalError('');
        try {
            const result = await load({ tab, filters: payloadFilters, export: true, locale }) as {
                filename: string;
                csv: string;
            };
            const url = URL.createObjectURL(new Blob([result.csv], { type: 'text/csv;charset=utf-8' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = result.filename;
            link.click();
            URL.revokeObjectURL(url);
        }
        catch (error) {
            setLocalError(isActivityPermissionError(error) ? t("没有访问权限，导出已停用。") : t(activityError(error)));
            resource.refresh();
        }
        finally {
            setExporting(false);
        }
    }
    async function submit(reason: string) {
        if (!confirm)
            return;
        try {
            await execute({ command: tab === 'email' ? 'retry-email' : tab === 'feedback' ? 'resolve-feedback' : 'resolve-request', id: confirm.id, reason, expectedStatus: confirm.cells.status, identityVerified: confirm.cells.kind === 'DELETION_REQUEST' || confirm.cells.category === 'DELETION_REQUEST' });
            setConfirm(null);
            setDetail(null);
            setPageState({ scope, cursors: [undefined] });
            resource.refresh();
        }
        catch (error) {
            resource.refresh();
            if (/ADMIN_ACTIVITY_CONFLICT/.test(error instanceof Error ? error.message : JSON.stringify(error))) {
                setConflict(true);
                try {
                    const latest = await load({ tab, filters: { ...payloadFilters, status: undefined }, detailId: confirm.id }) as ActivityView;
                    const row = latest.rows[0];
                    if (row)
                        setDetail(row);
                }
                catch { /* Main resource refresh reports access and read failures. */ }
            }
            const errorMessage=error instanceof Error?error.message:String(error??'');
            const safeEmailCode=tab==='email'?errorMessage.match(/\bEMAIL_[A-Z0-9_]+\b/)?.[0]:undefined;
            throw new Error(t(activityError(error))+(safeEmailCode?` (${safeEmailCode})`:''));
        }
    }
    return <>
 <form className="pa-toolbar" onSubmit={event => { event.preventDefault(); updateFilter('search', search); }}>
 {['feedback', 'requests', 'audit', 'email'].includes(tab) && <><input type="search" aria-label={tab === 'email' ? t("搜索收件邮箱") : tab === 'audit' ? t("搜索对象标识") : t("搜索主题或正文")} placeholder={tab === 'email' ? t("搜索收件邮箱") : tab === 'audit' ? t("搜索对象标识") : t("搜索主题或正文")} value={search} onChange={e => setSearch(e.target.value)}/><button type="submit" className="button secondary small">{t("搜索")}</button></>}
 {['feedback', 'requests', 'usage', 'email'].includes(tab) && <select aria-label={t("状态筛选")} value={filters.status ?? ''} onChange={e => updateFilter('status', e.target.value)}><option value="">{t("状态：全部")}</option>{(tab === 'email' ? ['SENT', 'QUEUED', 'SENDING', 'FAILED', 'UNKNOWN', 'EXPIRED'] : tab === 'usage' ? ['RESERVED', 'SETTLED', 'RELEASED'] : ['OPEN', 'RESOLVED']).map(value => <option key={value} value={value}>{activityValue('status', value, locale)}</option>)}</select>}
 {['feedback', 'requests'].includes(tab) && <select aria-label={t("类别筛选")} value={filters.category ?? ''} onChange={e => updateFilter('category', e.target.value)}><option value="">{t("类别：全部")}</option>{(tab === 'feedback' ? ['GENERAL', 'BUG', 'DATA_REQUEST', 'DELETION_REQUEST'] : ['FEEDBACK', 'DATA_REQUEST', 'DELETION_REQUEST']).map(value => <option key={value} value={value}>{activityValue('category', value, locale)}</option>)}</select>}
 {tab === 'product' && <select aria-label={t("事件名筛选")} value={filters.eventName ?? ''} onChange={e => updateFilter('eventName', e.target.value)}><option value="">{t("事件名：全部")}</option>{['ad_detail_open', 'source_link_click', 'media_play'].map(value => <option key={value}>{value}</option>)}</select>}
 {tab === 'visits' && <select aria-label={t("渠道维度")} value={filters.channel ?? 'source'} onChange={e => updateFilter('channel', e.target.value)}><option value="source">{t("渠道：source")}</option><option value="medium">{t("渠道：medium")}</option><option value="campaign">{t("渠道：campaign")}</option></select>}
 {tab === 'email' && <input aria-label={t("模板筛选")} placeholder={t("模板 key（精确）")} value={filters.templateKey ?? ''} onChange={e => updateFilter('templateKey', e.target.value)}/>}
 {!['visits', 'requests', 'audit'].includes(tab) && <input aria-label={t("组织筛选")} placeholder={t("组织 ID（精确）")} value={organizationDraft} onChange={e => setOrganizationDraft(e.target.value)} onBlur={() => {
                if (!organizationDraft || /^[0-9a-f-]{36}$/i.test(organizationDraft))
                    updateFilter('organizationId', organizationDraft);
                else
                    setLocalError(t("请输入完整的组织 ID。"));
            }}/>}
 {tab === 'audit' && <><input aria-label={t("动作筛选")} placeholder={t("动作（精确）")} value={filters.action ?? ''} onChange={e => updateFilter('action', e.target.value)}/><input aria-label={t("操作者筛选")} placeholder={t("操作者 ID（精确）")} value={actorDraft} onChange={e => setActorDraft(e.target.value)} onBlur={() => {
                if (!actorDraft || /^[0-9a-f-]{36}$/i.test(actorDraft))
                    updateFilter('actorUserId', actorDraft);
                else
                    setLocalError(t("请输入完整的操作者 ID。"));
            }}/></>}
 {Object.values(filters).some(Boolean) && <button type="button" className="button ghost small" onClick={clearFilters}>{t("清除筛选")}</button>}
 {canExport && <button type="button" className="button secondary small" disabled={exporting || !view || resource.loading} onClick={() => void exportRows()}>{exporting ? t("导出中…") : t("导出当前筛选结果")}</button>}
 </form>
 {(resource.error || localError) && <AdminNotice tone="error">{localError || t(activityError(resource.error))} <button type="button" className="button secondary small" onClick={() => { setLocalError(''); resource.refresh(); }}>{t("重试")}</button></AdminNotice>}
 {resource.loading && !view ? <><div className="pa-chart-skeleton" aria-label={t("正在读取指标与图表")}/><div className="pa-table-wrap"><table className="pa-table"><thead><tr>{activityTableColumns[tab].map(c => <th key={c.key} className={['conversions','quantity','attempts'].includes(c.key)?'numeric':undefined}>{t(c.label)}</th>)}</tr></thead><tbody>{Array.from({ length: 5 }, (_, index) => <tr key={index}>{activityTableColumns[tab].map(c => <td key={c.key}><span className="pa-skeleton">{t("正在读取")}</span></td>)}</tr>)}</tbody></table></div></> : view?.readiness?.configured === false ? <AdminEmpty title={t("邮件服务尚未配置")}>{t("请联系平台负责人完成邮件服务配置，再查看投递记录。")}</AdminEmpty> : view ? <>
 {view.metrics.length > 0 && <AdminKpis items={view.metrics.map(item => ({ label: t(filters.allDates&&item.key==='total'?'记录总数':item.label), value: item.value === null ? <span className="pa-kpi-unavailable">{activityMetric(item.key, item.value, locale)}</span> : activityMetric(item.key, item.value, locale), note: item.note?t(item.note):undefined }))}/>}
 {filters.allDates&&<p className="pa-caveat">{t("当前显示全部日期的记录，包含历史待处理或失败记录；选择近 7 天、近 30 天或自定义可恢复日期筛选。")}</p>}
 {view.caveats.length > 0 && <p className="pa-caveat">{view.caveats.filter(text => tab !== 'email' || text !== emailCaveat).map(text => t(text)).join(' ')}</p>}
 {tab==='audit'?<p className="pa-result-note">{t('共 {total} 条 · 按创建时间从新到旧 · 每页 20 条',{total:view.total.toLocaleString(locale)})}</p>:<details className="pa-chart-disclosure"><summary>{t("趋势与分布（点击展开）")} <span className="pa-caveat">{t('共 {total} 条 · 按创建时间从新到旧 · 每页 20 条',{total:view.total.toLocaleString(locale)})}</span></summary><ActivityCharts view={view} allDates={filters.allDates}/></details>}
 <div className="pa-table-wrap"><table className="pa-table"><thead><tr>{activityTableColumns[tab].map(c => <th key={c.key} className={['conversions','quantity','attempts'].includes(c.key)?'numeric':undefined}>{t(c.label)}</th>)}{!['visits', 'product', 'usage'].includes(tab) && <th>{t("操作")}</th>}</tr></thead><tbody>{view.rows.map(row => <tr key={row.id} className={['visits', 'product', 'usage'].includes(tab) ? undefined : 'pa-detail-row'}>{activityTableColumns[tab].map(c => <td key={c.key} className={typeof row.cells[c.key]==='number'?'numeric':undefined} title={activityValue(c.key, row.cells[c.key], locale)}>{c.key === 'status' ? <span className={activityBadgeClass(row.cells[c.key])}>{activityValue(c.key, row.cells[c.key], locale)}</span> : c.key === 'isTest' ? row.cells.isTest ? <span className="pa-badge">{t("测试流量")}</span> : <span>—</span> : <span className="pa-cell-text">{activityValue(c.key, row.cells[c.key], locale)}</span>}{c.key === 'requester' || c.key === 'actor' ? <small>{activityValue('email', row.cells.email, locale)}</small> : c.key === 'organization' && tab === 'feedback' ? <small>{activityValue('workspace', row.cells.workspace, locale)}</small> : c.key === 'targetType' ? <small>{activityValue('targetId', row.cells.targetId, locale)}</small> : null}</td>)}{!['visits', 'product', 'usage'].includes(tab) && <td><button type="button" className="button ghost small pa-row-open" onClick={() => setDetail(row)}>{t("查看")}</button>{!readonly && <button type="button" className="button ghost small pa-row-action" disabled={tab === 'email' ? !row.canRetry : row.cells.status !== 'OPEN'} title={row.retryReason ? t(row.retryReason) : undefined} onClick={() => setConfirm(row)}>{tab === 'email' ? t("重试") : t("处理")}</button>}</td>}</tr>)}</tbody></table></div>
 {!view.rows.length && <AdminEmpty title={filters.status === 'OPEN' && tab === 'feedback' ? t("没有待处理的反馈") : filters.status === 'OPEN' && tab === 'requests' ? t("没有待处理的账号申请") : tab === 'email' ? t("这个周期没有邮件记录") : t("这个周期没有记录")}>{t("可调整时间范围或筛选条件。")}{filters.status === 'OPEN' && <button type="button" className="button ghost" onClick={() => updateFilter('status', '')}>{t("查看全部")}</button>}</AdminEmpty>}
 <div className="pagination" aria-label={t("记录分页")}><span>{t('第 {page} 页',{page:cursors.length})}</span><button type="button" className="button secondary small" disabled={resource.loading || cursors.length === 1} onClick={() => setPageState({ scope, cursors: cursors.slice(0, -1) })}>{t("上一页")}</button><button type="button" className="button secondary small" disabled={resource.loading || !view.nextCursor} onClick={() => setPageState({ scope, cursors: [...cursors, view.nextCursor!] })}>{t("下一页")}</button></div>
 </> : !resource.loading && !resource.error ? <AdminEmpty title={t("当前没有可显示的记录")}>{t("可调整筛选条件后重试。")}</AdminEmpty> : null}
 {detail && <AdminDrawer title={tab === 'feedback' ? String(detail.cells.subject ?? t("反馈详情")) : tab === 'email' ? String(detail.cells.recipientEmail) : t('{type}详情', { type: t(activityLabels[tab]) })} onClose={() => setDetail(null)} footer={!readonly ? <button type="button" className={`button ${tab === 'email' ? 'secondary' : 'primary'}`} disabled={tab === 'email' ? !detail.canRetry : detail.cells.status !== 'OPEN'} onClick={() => setConfirm(detail)}>{tab === 'email' ? t("立即重试") : t("标记为已处理")}</button> : undefined}>
 {(detail.cells.kind === 'DELETION_REQUEST' || detail.cells.category === 'DELETION_REQUEST') && <AdminNotice tone="warning">{t("提交申请不会自动删除资料；需人员核验身份，权限及需保留的记录另行处理。")}</AdminNotice>}
 {['feedback', 'requests'].includes(tab) && <AdminNotice>{t("「已处理」是支持记录状态，不代表已执行数据删除或系统变更。")}</AdminNotice>}
 {tab === 'email' && <><AdminKpis items={[{ label: t("尝试次数"), value: String(detail.cells.attempts) }, { label: t("下次尝试时间"), value: activityValue('nextAttemptAt', detail.cells.nextAttemptAt, locale) }, { label: t("载荷过期时间"), value: activityValue('payloadExpiresAt', detail.cells.payloadExpiresAt, locale) }, { label: t("记录过期时间"), value: activityValue('expiresAt', detail.cells.expiresAt, locale) }]}/>{detail.retryReason && <AdminNotice>{t(detail.retryReason)}</AdminNotice>}</>}
 <dl className="pa-detail-grid">{Object.entries(detail.cells).filter(([key]) => !['summary', 'idempotencyKey'].includes(key)).map(([key, value]) => <div key={key}><dt>{t(fieldName(key))}</dt><dd>{activityValue(key, value, locale)}{['providerMessageId', 'targetId'].includes(key) && value && <button type="button" className="button ghost small" onClick={() => void navigator.clipboard?.writeText(String(value))}>{t("复制")}</button>}</dd></div>)}</dl>
 {detail.metadata && Object.keys(detail.metadata).length > 0 && <><h3>{tab === 'audit' ? t("变更摘要") : tab === 'email' ? t("安全模板信息") : t("处理记录")}</h3><dl className="pa-detail-grid">{Object.entries(detail.metadata).map(([key, value]) => <div key={key}><dt>{t(key)}</dt><dd>{typeof value === 'object' ? JSON.stringify(value, null, 2) : key==='处理时间'&&typeof value==='string'?activityValue('createdAt',value,locale):typeof value==='boolean'?activityValue(key,value,locale):String(value??'—')}</dd></div>)}</dl></>}
 </AdminDrawer>}
 {confirm && <AdminConfirm title={conflict ? t('记录已变更：{status}，请关闭后核对', { status: activityValue('status', detail?.cells.status, locale) }) : (tab === 'email' ? t("确认立即重试") : t("确认标记为已处理"))} onClose={() => { setConfirm(null); setConflict(false); }} onConfirm={submit} disabled={conflict} identityRequired={confirm.cells.kind === 'DELETION_REQUEST' || confirm.cells.category === 'DELETION_REQUEST'}/>}
 </>;
}
function activityBadgeClass(value: string | number | boolean | null | undefined) { const status=String(value); return `pa-badge${['SENT','RESOLVED','SETTLED'].includes(status)?' pa-badge-active':status==='FAILED'?' pa-badge-conflict':['OPEN','QUEUED','SENDING','UNKNOWN','RESERVED'].includes(status)?' pa-badge-unknown':''}`; }
function fieldName(key: string) { return ({ createdAt: '创建时间', updatedAt: '更新时间', resolvedAt: '处理时间', category: '类别', kind: '类型', subject: '主题', body: '完整正文', status: '状态', organization: '组织', workspace: '工作区', requester: '申请人', email: '邮箱', recipientEmail: '收件邮箱', templateKey: '模板', attempts: '尝试次数', sentAt: '发送时间', lastErrorCode: '最近错误码', provider: '服务商', providerMessageId: '服务商消息标识', username: '用户', nextAttemptAt: '下次尝试', payloadExpiresAt: '载荷过期时间', expiresAt: '记录过期时间', leased: '租约被占用', action: '动作', targetType: '对象类型', targetId: '对象标识', actor: '操作者' } as Record<string, string>)[key] ?? key; }
function ActivityCharts({ view, allDates }: {
    view: ActivityView;
    allDates?:boolean;
}) {
    const { t, locale } = useAdminCopy(activityCopy);
    const caveat = t(allDates?'全部日期记录，时区 Asia/Hong_Kong；':'统计周期内记录，时区 Asia/Hong_Kong；') + t(view.caveats[0] ?? '');
    return <div className="pa-chart-grid">{view.tab === 'visits' ? <><LineTrend title={t("每日访问与注册")} data={view.daily} series={[{ key: 'visits', label: t("访问") }, { key: 'registrations', label: t("注册") }]} caveat={caveat}/><BarRanking title={t("落地路径 Top")} data={view.distribution} caveat={caveat}/><BarRanking title={t("来源渠道")} data={view.secondaryDistribution ?? []} caveat={caveat}/></> : view.tab === 'product' ? <><LineTrend title={t("每日产品事件数")} data={view.daily} series={[{ key: 'events', label: t("事件数") }]} caveat={caveat}/><BarRanking title={t("各事件名计数")} data={view.distribution} caveat={caveat}/></> : view.tab === 'usage' ? <StackedBars title={t("每日分析用量")} data={view.daily} series={[{ key: 'settled', label: t("已结算"), color: 'var(--status-active)' }, { key: 'reserved', label: t("预占中"), color: 'var(--status-unknown)' }, { key: 'released', label: t("已释放"), color: 'var(--status-inactive)' }]} caveat={caveat}/> : view.tab === 'feedback' || view.tab === 'requests' ? <LineTrend title={t("每日新增与已处理")} data={view.daily} series={[{ key: 'added', label: t("新增") }, { key: 'resolved', label: t("已处理") }]} caveat={caveat + ' ' + t('新增按提交日、已处理按实际处理日计数。')}/> : view.tab === 'email' ? <><ResultDonut title={t("投递结果构成")} data={(view.secondaryDistribution ?? []).map((row, index) => ({ ...row, label:t(row.label), color: ['var(--status-active)', 'var(--status-conflict)', 'var(--status-unknown)'][index] }))} caveat={caveat}/><LineTrend title={t("每日投递量")} data={view.daily} series={[{ key: 'deliveries', label: t("投递量") }]} caveat={caveat}/><BarRanking title={t("各模板发送量")} data={view.distribution} caveat={caveat}/></> : null}</div>;
}
