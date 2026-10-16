import { useState, type FormEvent } from 'react';
import { getGrowthOverview, useQuery } from 'wasp/client/operations';
import { Empty, Field, Loading } from './App';
import type { GrowthCounts, GrowthSummary, GrowthSummaryQuery } from '../growth/summary';

const DAY_MS = 86_400_000;
function defaultRange(): GrowthSummaryQuery {
  const local = new Date(Date.now() + 8 * 3_600_000);
  return { from: new Date(local.getTime() - 29 * DAY_MS).toISOString().slice(0, 10), to: local.toISOString().slice(0, 10) };
}
const number = (value: number) => value.toLocaleString('zh-CN');
const label = (value: string | null) => value || '未标注';
const rate = (numerator: number, denominator: number) => denominator ? `${(numerator / denominator * 100).toFixed(1)}%` : '—';
const columns = <><th>同意访客</th><th>点击访客</th><th>注册账号</th><th>验证账号</th><th>首次收藏账号</th><th>访客注册率</th><th>账号首次收藏率</th></>;
function CountCells({ values }: { values: GrowthCounts }) {
  return <><td>{number(values.visitors)}</td><td>{number(values.clickedVisitors)}</td><td>{number(values.registeredUsers)}</td><td>{number(values.verifiedUsers)}</td><td>{number(values.firstUseUsers)}</td><td>{rate(values.registeredVisitors, values.visitors)}</td><td>{rate(values.firstUseUsers, values.registeredUsers)}</td></>;
}

export function GrowthOverview() {
  const [range, setRange] = useState<GrowthSummaryQuery>(defaultRange);
  const [draft, setDraft] = useState(range);
  const [inputError, setInputError] = useState('');
  const query = useQuery(getGrowthOverview, range);
  const report = query.data as GrowthSummary | undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const start = new Date(`${draft.from}T00:00:00+08:00`).getTime();
    const end = new Date(`${draft.to}T00:00:00+08:00`).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start >= 90 * DAY_MS || draft.to > defaultRange().to) {
      setInputError('请选择不超过今天的有效日期，范围最多 90 天。'); return;
    }
    setInputError(''); setRange({ ...draft });
    if (draft.from === range.from && draft.to === range.to) void query.refetch();
  };
  return <section className="section-block" aria-labelledby="growth-overview-title">
    <div className="section-title"><h2 id="growth-overview-title">官网来源与转化</h2><span className="muted">UTC+8 · 仅平台管理员</span></div>
    <form className="compact-form" onSubmit={submit}>
      <Field label="首次访问开始日"><input type="date" required value={draft.from} max={defaultRange().to} onChange={event => setDraft(current => ({ ...current, from: event.target.value }))} /></Field>
      <Field label="首次访问结束日"><input type="date" required value={draft.to} max={defaultRange().to} onChange={event => setDraft(current => ({ ...current, to: event.target.value }))} /></Field>
      <button className="button secondary" type="submit" disabled={query.isFetching}>{query.isFetching ? '正在查询…' : '查看此批访客'}</button>
      {inputError && <p className="inline-error" role="alert">{inputError}</p>}
    </form>
    <p className="small-note">按所选日期首次访问的同一批匿名浏览器凭据统计，不代表真实独立人数。点击按访客去重；注册、验证和首次收藏按账号去重，包含这批访客截至查询时的后续转化。</p>
    <p className="small-note">只统计同意后的第一方记录，默认排除验收流量。撤回或凭据到期后不再增加转化，之前已收集的访问及转化保留在原批次中；不补算历史未采集流量。</p>
    {query.isLoading ? <Loading label="正在读取官网来源与转化…" /> : query.error || !report ? <Empty title="暂时无法读取来源统计" action={<button className="button secondary" onClick={() => void query.refetch()}>重试</button>}>请检查日期范围和平台管理员权限后重试。</Empty> : <>
      {!report.collectionEnabled && <p className="notice">来源转化采集当前未启用；下方仅显示已经保存的记录。</p>}
      <div className="fact-strip">
        <div className="fact"><span>同意访客</span><strong>{number(report.totals.visitors)}</strong></div>
        <div className="fact"><span>点击按钮访客</span><strong>{number(report.totals.clickedVisitors)}</strong></div>
        <div className="fact"><span>完成验证账号</span><strong>{number(report.totals.verifiedUsers)}</strong></div>
        <div className="fact"><span>首次收藏账号</span><strong>{number(report.totals.firstUseUsers)}</strong></div>
      </div>
      <p className="small-note">公开页面浏览 {number(report.totals.pageViews)} 次；注册访客 {number(report.totals.registeredVisitors)} 个，创建账号 {number(report.totals.registeredUsers)} 个。首次使用定义为“首次成功收藏一条公开广告”，重复收藏不重复计算。</p>
      <p className="small-note">访客注册率 {rate(report.totals.registeredVisitors, report.totals.visitors)}（注册访客 ÷ 同意访客）；新注册账号首次收藏率 {rate(report.totals.firstUseUsers, report.totals.registeredUsers)}（首次收藏账号 ÷ 注册账号）。</p>
      {report.totals.visitors === 0 ? <Empty title="这批日期暂无已同意的访客记录">零记录不代表没有访问；拒绝统计、验收流量和上线前访问不会计入。</Empty> : <>
        <div className="section-title"><h3>来源与分发内容</h3><span className="muted">按访客数排序</span></div>
        <div className="table-wrap"><table><thead><tr><th>来源</th><th>媒介</th><th>活动</th><th>内容标签</th>{columns}</tr></thead><tbody>{report.bySource.map((row, index) => <tr key={index}><td>{label(row.source)}</td><td>{label(row.medium)}</td><td>{label(row.campaign)}</td><td>{label(row.content)}</td><CountCells values={row} /></tr>)}</tbody></table></div>
        {report.sourceRowsTruncated && <p className="small-note">当前显示访客数最多的 100 组来源；顶部总数仍包含完整范围。</p>}
        <div className="section-title"><h3>首次落地页</h3></div>
        <div className="table-wrap"><table><thead><tr><th>页面</th>{columns}</tr></thead><tbody>{report.byLanding.map(row => <tr key={row.landingPath}><td>{row.landingPath}</td><CountCells values={row} /></tr>)}</tbody></table></div>
        <details><summary>按首次访问日查看</summary><div className="table-wrap"><table><thead><tr><th>首次访问日</th>{columns}</tr></thead><tbody>{report.byDay.map(row => <tr key={row.day}><td>{row.day}</td><CountCells values={row} /></tr>)}</tbody></table></div></details>
      </>}
      <p className="small-note">地区未采集、未与本地账号关联。可在 <a href="https://analytics.google.com/analytics/web/#/a357925781p557903388/reports/reportinghub" target="_blank" rel="noopener noreferrer">GA4</a> 查看其自身口径的地区数据，两边人数不能直接相加。</p>
      <p className="small-note">查询时间：{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(report.asOf))}（UTC+8）。</p>
    </>}
  </section>;
}
