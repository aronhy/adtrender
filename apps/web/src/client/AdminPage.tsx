import { useEffect, useRef, useState } from 'react';
import { getAdminPage, useQuery } from 'wasp/client/operations';
import { useSearchParams } from 'react-router';
import { CommandButton, CommandForm, dateLabel, Empty, errorLabel, Field, formText, Loading, PageHeader, Status, useApp } from './App';
import type { AdminCustomerView, AdminPageKind, AdminPageResult, AdminView } from './types';
import { GrowthOverview } from './GrowthOverview';
import { SeedAdminModule } from './admin-seeds/SeedAdminModule';

type CollectionKind = 'tasks' | 'runs' | 'mediaFailures';
export function AdminPage() {
  const { state, refresh } = useApp(); const admin = state.admin;
  const [params, setParams] = useSearchParams();
  const selectedModule = params.get('module');
  const tab = ['collection', 'seeds', 'customers', 'accounts', 'feedback', 'system'].includes(selectedModule ?? '') ? selectedModule! : 'collection';
  const setTab = (module: string) => { const next = new URLSearchParams(params); next.set('module', module); if (module !== 'seeds') { next.delete('view'); next.delete('seedId'); next.delete('cursor'); } setParams(next); };
  const [collectionKind, setCollectionKind] = useState<CollectionKind>('tasks');
  const [feedbackKind, setFeedbackKind] = useState<'organizationFeedback' | 'accountSupport'>('organizationFeedback');
  const [reload, setReload] = useState(0); const [refreshing, setRefreshing] = useState(false);
  if (!state.user.isAdmin || !admin) return <Empty title="此页面仅供平台管理员使用">客户工作区权限不会自动授予平台管理权限。</Empty>;
  const kind: AdminPageKind = tab === 'collection' ? collectionKind : tab === 'customers' ? 'customers' : tab === 'accounts' ? 'users' : feedbackKind;
  return <><PageHeader eyebrow="平台运营" title="平台管理" description="管理来源与采集、处理客户问题，并查看真实运行状态。" action={<button className="button secondary" disabled={refreshing} onClick={async () => { setRefreshing(true); setReload(value => value + 1); try { await refresh(); } finally { setRefreshing(false); } }}>{refreshing ? '刷新中…' : '刷新并回到首页'}</button>} />
    <div className="tabs" role="tablist" aria-label="平台管理分类">{[['collection', '来源与采集'], ['seeds', '种子库'], ['customers', '客户与权益'], ['accounts', '账号状态'], ['feedback', '问题反馈'], ['system', '系统与使用']].map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}</button>)}</div>
    {tab === 'collection' && <div className="tabs" role="tablist" aria-label="采集管理记录">{([['tasks', '来源与任务'], ['runs', '最近运行与历史批次'], ['mediaFailures', '失败素材']] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={collectionKind === key} onClick={() => setCollectionKind(key)}>{label}</button>)}</div>}
    {tab === 'feedback' && <div className="tabs" role="tablist" aria-label="反馈归属"><button role="tab" aria-selected={feedbackKind === 'organizationFeedback'} onClick={() => setFeedbackKind('organizationFeedback')}>组织反馈</button><button role="tab" aria-selected={feedbackKind === 'accountSupport'} onClick={() => setFeedbackKind('accountSupport')}>账号支持与删除申请</button></div>}
    {tab === 'seeds' ? <SeedAdminModule key={`seeds:${reload}`} /> : tab === 'system' ? <><GrowthOverview key={`growth:${reload}`} /><AdminData admin={{ ...admin, runs: [], customers: [] }} tab={tab} collectionKind={collectionKind} /></> : <AdminRecords key={`${kind}:${reload}`} kind={kind} tab={tab} collectionKind={collectionKind} />}
  </>;
}

function AdminRecords({ kind, tab, collectionKind }: { kind: AdminPageKind; tab: string; collectionKind: CollectionKind }) {
  const { state, commandVersion } = useApp();
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const query = useQuery(getAdminPage, { kind, cursor: cursors.at(-1), limit: 20 });
  const previousCommand = useRef(commandVersion);
  useEffect(() => { if (previousCommand.current !== commandVersion) { previousCommand.current = commandVersion; void query.refetch(); } }, [commandVersion, query.refetch]);
  const page = query.data as AdminPageResult | undefined;
  if (query.isLoading) return <Loading label="正在读取管理记录…" />;
  if (query.error || !page) return <Empty title="暂时无法读取管理记录" action={<button className="button secondary" onClick={() => void query.refetch()}>重试</button>}>{errorLabel(query.error)}</Empty>;
  const admin = { ...state.admin!, users: page.users, customers: page.customers, tasks: page.tasks, runs: page.runs, feedback: page.feedback, mediaFailures: page.mediaFailures };
  return <><p className="small-note">共 {page.total} 条 · 按创建时间从新到旧，每页最多20条；新增记录请刷新首页查看。</p><AdminData admin={admin} tab={tab} collectionKind={collectionKind} />
    <div className="pagination" aria-label="管理记录分页"><button className="button secondary" disabled={query.isFetching || cursors.length === 1} onClick={() => setCursors(history => history.slice(0, -1))}>上一页</button><span>第 {cursors.length} 页</span><button className="button secondary" disabled={query.isFetching || !page.nextCursor} onClick={() => { if (page.nextCursor) setCursors(history => [...history, page.nextCursor!]); }}>下一页</button></div>
  </>;
}

function AdminData({ admin, tab, collectionKind }: { admin: Omit<AdminView, 'runs' | 'customers'> & { runs: AdminPageResult['runs']; customers: AdminCustomerView[] }; tab: string; collectionKind: CollectionKind }) {
  const { state } = useApp();
  return <>
    {tab === 'collection' && collectionKind === 'tasks' && <><section className="section-block"><div className="section-title"><h2>数据源</h2></div>{admin.sources.length ? <div className="source-list">{admin.sources.map(source => <article key={source.id}><div><strong>{source.name}</strong><p>最近成功 {dateLabel(source.lastSuccessAt, true)}</p><p>{source.verifiedProfiles?.length?source.verifiedProfiles.join('；'):'尚无有效验证范围，不能启用。'}</p></div><Status value={source.status} /><CommandButton command={{ type: 'SET_DATA_SOURCE_STATUS', dataSourceId: source.id, status: source.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' }}>{source.status === 'ACTIVE' ? '暂停来源' : '启用来源'}</CommandButton></article>)}</div> : <Empty title="尚未配置数据源">请先完成来源服务配置，再建立采集任务。</Empty>}</section>
      <section className="section-block"><div className="section-title"><h2>新建采集任务</h2><span className="muted">先验证小范围来源，再启用周期计划</span></div><CommandForm className="task-form" label="保存采集任务" disabled={!admin.sources.length} build={data => ({ type: 'CREATE_COLLECTION_TASK', dataSourceId: formText(data, 'dataSourceId'), name: formText(data, 'name'), query: formText(data, 'query'), country: formText(data, 'country').toUpperCase(), mediaType: formText(data, 'mediaType'), intervalMinutes: Number(formText(data, 'intervalMinutes')) || null })}><Field label="任务名称"><input name="name" required maxLength={80} placeholder="说明本次采集范围" /></Field><Field label="来源"><select name="dataSourceId" required defaultValue=""><option value="" disabled>选择数据源</option>{admin.sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select></Field><Field label="查询关键词"><input name="query" required maxLength={200} /></Field><Field label="查询国家"><input name="country" required defaultValue="ALL" maxLength={3} /></Field><Field label="素材类型"><select name="mediaType"><option value="ALL">全部</option><option value="IMAGE">图片</option><option value="VIDEO">视频</option></select></Field><Field label="周期计划"><select name="intervalMinutes"><option value="0">仅手动运行</option><option value="240">每 4 小时</option><option value="720">每 12 小时</option><option value="1440">每天</option></select></Field><p className="small-note">新任务保存后先保持暂停，须匹配有效验证范围才能启用；首批每次最多 3 条。</p></CommandForm></section>
      <section className="section-block"><div className="section-title"><h2>任务配置</h2></div>{admin.tasks.length ? <div className="table-wrap"><table><thead><tr><th>任务</th><th>查询范围</th><th>周期</th><th>状态</th><th>操作</th></tr></thead><tbody>{admin.tasks.map(task => <tr key={task.id}><td><strong>{task.name}</strong></td><td>{task.query} · {task.country}</td><td>{task.intervalMinutes ? `${task.intervalMinutes} 分钟` : '仅手动'}</td><td><Status value={task.status} /></td><td><div className="row-actions"><CommandButton command={{ type: 'RUN_COLLECTION_TASK', taskId: task.id, idempotencyKey: crypto.randomUUID() }}>运行一次</CommandButton><CommandButton command={{ type: 'SET_TASK_STATUS', taskId: task.id, status: task.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' }} className="text-button">{task.status === 'ACTIVE' ? '暂停计划' : '启用计划'}</CommandButton></div></td></tr>)}</tbody></table></div> : <Empty title="还没有采集任务">添加少量明确的查询范围，再观察来源返回与素材质量。</Empty>}</section></>}
    {tab === 'collection' && collectionKind === 'runs' && <><section className="section-block"><div className="section-title"><h2>最近运行与历史批次</h2><span className="muted">暂停计划只影响未来批次，取消在途任务需执行器确认。</span></div>{admin.runs.length ? <div className="table-wrap"><table><thead><tr><th>任务</th><th>开始时间</th><th>状态</th><th>获取条数</th><th>处理</th></tr></thead><tbody>{admin.runs.map(run => <tr key={run.id}><td>{run.taskName}</td><td>{dateLabel(run.startedAt, true)}</td><td><Status value={run.status} />{run.errorCode && <small className="table-note">本轮未完整完成，请检查来源状态。</small>}</td><td>{run.fetchedCount}<small className="table-note">新增 {run.createdCount??0} · 更新 {run.updatedCount??0}</small>{run.restrictedReason&&<small className="table-note">受限：{run.restrictedReason}</small>}{run.errorCode&&<small className="table-note">{run.errorCode}</small>}<small className="table-note">{run.coverage==='success'||run.coverage==='no-results'?'当前查询完整返回':run.coverage==='partial'?'部分返回':'覆盖范围未知'}</small></td><td>{['QUEUED', 'RUNNING'].includes(run.status) && <CommandButton command={{ type: 'CANCEL_COLLECTION_RUN', runId: run.id }} className="text-button">申请取消</CommandButton>}</td></tr>)}</tbody></table></div> : <Empty title="尚无运行记录">执行任务后，这里会显示真实批次状态和获取数量。</Empty>}</section></>}
    {tab === 'customers' && <><section className="section-block"><div className="section-title"><h2>客户组织</h2></div>{admin.customers.length ? <CustomerTable customers={admin.customers} /> : <Empty title="尚无客户组织">客户创建团队后会出现在这里。</Empty>}</section><section className="section-block"><div className="section-title"><h2>人工权益调整</h2><span className="muted">选择本页组织，其他组织请翻页定位。</span></div><CommandForm key={admin.customers.map(customer => customer.id).join(':')} className="compact-form" label="记录并调整权益" disabled={!admin.customers.length} build={data => ({ type: 'ADJUST_ENTITLEMENT', organizationId: formText(data, 'organizationId'), key: formText(data, 'key'), limit: Number(formText(data, 'limit')), reason: formText(data, 'reason') })}><Field label="目标组织"><select name="organizationId" required defaultValue=""><option value="" disabled>选择组织</option>{admin.customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></Field><Field label="权益项"><select name="key"><option value="ANALYSES">每月分析次数</option><option value="SAVED_ADS">收藏数量</option><option value="WORKSPACES">工作区数量</option><option value="MEMBERS">成员席位</option></select></Field><Field label="调整后的上限"><input name="limit" type="number" min={0} max={1000000} required /></Field><Field label="调整原因" hint="此操作会记录审计。"><textarea name="reason" required maxLength={500} rows={3} /></Field></CommandForm></section></>}
    {tab === 'accounts' && <section className="section-block"><div className="section-title"><h2>账号状态</h2><span className="muted">停用即时撤销会话；最后所有者需先完成转移。</span></div>{admin.users?.map(user=><article className="section-block" key={user.id}><h3>{user.email??'无邮箱账号'}</h3><p>{user.isAdmin?'平台管理员 · ':''}{user.disabledAt?'已停用':'正常'}</p><CommandForm className="compact-form" label={user.disabledAt?'恢复账号':'停用账号'} disabled={user.id===state.user.id} build={data=>({type:'SET_ACCOUNT_STATUS',targetUserId:user.id,disabled:!user.disabledAt,reason:formText(data,'reason')})}><Field label="操作原因"><input name="reason" required maxLength={500}/></Field></CommandForm></article>)}</section>}
    {tab === 'feedback' && <section className="section-block"><div className="section-title"><h2>客户反馈</h2></div>{admin.feedback.length ? <div className="feedback-list">{admin.feedback.map(feedback => <article key={feedback.id}><header><span>{feedback.category === 'DELETION_REQUEST' ? '隐私与数据' : feedback.category === 'BUG' ? '功能异常' : feedback.category === 'DATA_REQUEST' ? '缺失来源' : '使用问题'}</span><Status value={feedback.status} /><small>{dateLabel(feedback.createdAt, true)}</small></header><FeedbackIdentity feedback={feedback} /><p>{feedback.message}</p><CommandButton command={{ type: 'RESOLVE_FEEDBACK', feedbackId: feedback.id, scope:feedback.scope, status: 'RESOLVED' }} disabled={feedback.status === 'RESOLVED'}>{feedback.status === 'RESOLVED' ? '已处理' : '标记已处理'}</CommandButton></article>)}</div> : <Empty title="暂无待查看的反馈">用户提交的问题会保存在这里。</Empty>}</section>}
    {tab === 'collection' && collectionKind === 'mediaFailures' && <section className="section-block"><div className="section-title"><h2>下载失败的素材</h2></div>{admin.mediaFailures?.length?<div className="source-list">{admin.mediaFailures.map(media=><article key={media.id}><div><strong>广告 {media.adId.slice(0,8)}</strong><p>{media.errorCode==='MEDIA_HTTP_FAILED'?'来源素材已失效或拒绝访问':media.errorCode==='MEDIA_TOO_LARGE'?'素材超过大小上限':'下载或存储未完成'}</p></div><CommandButton command={{type:'RETRY_MEDIA',mediaId:media.id}}>重试下载</CommandButton></article>)}</div>:<p className="muted">暂无下载失败记录。</p>}</section>}
    {tab === 'system' && <><section className="section-block"><div className="section-title"><h2>系统状态</h2></div>{admin.health.length ? <div className="system-status-list">{admin.health.map(item => <article key={item.key}><strong>{item.label}</strong><Status value={item.status} /><p>{item.message || '暂无额外说明'}</p></article>)}</div> : <Empty title="尚未取得系统检查结果">没有检查结果不能视作服务正常。</Empty>}</section><section className="section-block"><div className="section-title"><h2>产品使用事件</h2></div><p className="small-note">仅统计本工作台的使用行为，不是竞品广告平台的真实点击、曝光或播放成绩。</p>{admin.productEvents?.length ? <div className="table-wrap"><table><thead><tr><th>行为</th><th>事件数</th><th>组织数</th></tr></thead><tbody>{admin.productEvents.map(event => <tr key={event.name}><td>{({ ad_detail_open: '打开广告详情', source_link_click: '跳转广告来源', media_play: '播放素材' } as Record<string, string>)[event.name] || '其他产品行为'}</td><td>{event.count}</td><td>{event.organizationCount}</td></tr>)}</tbody></table></div> : <p className="muted">尚无已汇总的产品使用事件。</p>}</section></>}
  </>;
}


function FeedbackIdentity({ feedback }: { feedback: AdminView['feedback'][number] }) {
  const subject = feedback.subject === '删除申请：ORGANIZATION' ? '组织删除申请' : feedback.subject;
  return <div className="small-note" style={{ overflowWrap: 'anywhere' }}>
    {subject && <p><strong>{subject}</strong></p>}
    <p>申请人：{feedback.requester?.email ?? (feedback.requester ? '该账号未记录邮箱' : '历史记录未保留申请人，请先核实身份')}</p>
    {feedback.organization && <p>团队：{feedback.organization.name}</p>}
    {feedback.workspace && <p>工作区：{feedback.workspace.name}</p>}
    {feedback.scope === 'ACCOUNT' && <p>范围：账号支持{feedback.category === 'DELETION_REQUEST' ? ' · 账号删除申请' : ''}</p>}
    <details><summary>核对申请与归属编号</summary>
      <p>申请编号：<code>{feedback.id}</code></p>
      {feedback.requester && <p>账号编号：<code>{feedback.requester.id}</code></p>}
      {feedback.organization && <p>团队编号：<code>{feedback.organization.id}</code></p>}
      {feedback.workspace && <p>工作区编号：<code>{feedback.workspace.id}</code></p>}
    </details>
    {feedback.category === 'DELETION_REQUEST' && <p>处理前需核实申请人和删除范围；“标记已处理”只更新申请状态，不会删除资料。</p>}
  </div>;
}

function CustomerTable({ customers }: { customers: AdminCustomerView[] }) {
  const quotaLabels = { WORKSPACES: '工作区', MEMBERS: '成员席位', SAVED_ADS: '收藏', ANALYSES: '分析次数' };
  return <div className="table-wrap"><table className="customer-table"><thead><tr><th>组织</th><th>组织状态</th><th>套餐与订阅状态</th><th>周期与取消安排</th><th>当前有效额度</th></tr></thead><tbody>{customers.map(customer => <tr key={customer.id}>
    <td><strong>{customer.name}</strong><small className="table-note">组织成员 {customer.memberCount} 位</small></td>
    <td><Status value={customer.status} /></td>
    <td>{customer.subscription ? <><strong>{customer.planName || '套餐名称未提供'}</strong><div><Status value={customer.subscription.status} /></div></> : <span className="muted">没有订阅记录</span>}</td>
    <td>{customer.subscription ? <>
      <p>当前周期：{dateLabel(customer.subscription.currentPeriodStart, true)} 至 {dateLabel(customer.subscription.currentPeriodEnd, true)}</p>
      {customer.subscription.trialEndsAt && <p>试用截止：{dateLabel(customer.subscription.trialEndsAt, true)}</p>}
      <p>{customer.subscription.cancelAtPeriodEnd ? `已安排周期末取消${customer.subscription.currentPeriodEnd ? `：${dateLabel(customer.subscription.currentPeriodEnd, true)}` : '，截止时间未提供'}` : '未安排周期末取消'}</p>
    </> : <span className="muted">未提供周期</span>}</td>
    <td>{customer.entitlements.map(({ key, current }) => <div key={key} className="small-note">
      <strong>{quotaLabels[key]}</strong>{current ? <>
        <p>已用 {current.used} · 预留 {current.reserved} · 上限 {current.limit}</p>
        <p>{current.source === 'MANUAL' ? '人工调整' : current.source === 'PLAN' ? '套餐额度' : current.source === 'STRIPE' ? '已付订阅' : '额度来源未标明'} · {current.validUntil ? `有效至 ${dateLabel(current.validUntil, true)}` : '未设置到期时间'}</p>
        {key === 'ANALYSES' && <p>计数周期：{dateLabel(current.periodStart, true)} 至 {current.periodEnd ? dateLabel(current.periodEnd, true) : '未提供'}</p>}
      </> : <p>无有效额度；未配置、已过期或尚未生效的记录不作为当前额度。</p>}
    </div>)}<small className="table-note">额度核对时间：{dateLabel(customer.quotaCheckedAt, true)}。预留尚未结算，不代表已完成分析；已用数可在降级后超过上限。</small></td>
  </tr>)}</tbody></table></div>;
}
