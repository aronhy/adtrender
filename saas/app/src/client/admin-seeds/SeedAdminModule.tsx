import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { getSeedOverview, getSeedPage, getSeedDetail, getSeedDispatchPage, getSeedCoverage, getSeedRules, getSeedImportPreview, seedCommand, useQuery } from 'wasp/client/operations';
import { Empty, Field, formText, Loading, SourceLink, useApp } from '../App';
import { parseSeedAdminView, seedAdminParams, seedAdminViews, seedDateLabel, seedErrorLabel, seedLedgerWindow, seedNumber, seedRow, seedRows, seedSources, seedStateView, seedStatusLabel, seedText, type SeedRow } from './state-view';

type CommandType = 'VERIFY_NATIVE_SEED' | 'IMPORT_STATIC_SEED_BASELINE' | 'SAVE_SEED' | 'SAVE_SEED_SCAN_PLAN' | 'SET_SEED_STATUS' | 'CONFIRM_SEED_RELATION' | 'REJECT_SEED_RELATION' | 'PREVIEW_SEED_IMPORT' | 'COMMIT_SEED_IMPORT' | 'PREVIEW_SEED_PUBLICATION' | 'PUBLISH_SEED_CONFIG' | 'ROLLBACK_SEED_CONFIG';
type Command = { type: CommandType; targetId?: string; expectedRevision?: number; reason: string; payload: Record<string, unknown> };
type Commands = { busy: boolean; run: (command: Command) => Promise<SeedRow | undefined> };
type QueryState = { data?: unknown; error?: unknown; isLoading: boolean; isFetching: boolean; refetch: () => Promise<unknown> };
const revision = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
const sourceLabel = (value: unknown) => seedSources.find(([key]) => key === value)?.[1] ?? seedText(value);
const parts = (value: string) => [...new Set(value.split(/[;,；，\s]+/).map(part => part.trim()).filter(Boolean))];
function Badge({ value }: { value: unknown }) { return <span className={`status ${['FAILED', 'REJECTED', 'CONFLICT', 'RECOVERY_BLOCKED', 'UNREACHABLE'].includes(String(value)) ? 'status-attention' : ''}`}>{seedStatusLabel(value)}</span>; }
function DataTable({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return <div className="table-wrap"><table><thead><tr>{headers.map(header => <th key={header}>{header}</th>)}</tr></thead><tbody>{rows.map((cells, index) => <tr key={index}>{cells.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table></div>;
}
function QueryPanel({ query, version, children }: { query: QueryState; version: number; children: (data: SeedRow) => ReactNode }) {
  const last = useRef<unknown>(undefined); const previousVersion = useRef(version);
  if (query.data !== undefined) last.current = query.data;
  useEffect(() => { if (previousVersion.current !== version) { previousVersion.current = version; void query.refetch(); } }, [version, query.refetch]);
  const data = query.data ?? last.current;
  if (query.isLoading && data === undefined) return <Loading label="正在读取种子库…" />;
  if (data === undefined) return <Empty title="种子库暂时无法读取" action={<button className="button secondary" onClick={() => void query.refetch()}>重试</button>}>{seedErrorLabel(query.error)}</Empty>;
  return <>{!!query.error && <p className="inline-error" role="alert">{seedErrorLabel(query.error)} 下方保留上次读取的数据。</p>}{children(seedRow(data))}</>;
}
function PageControls({ page, fetching }: { page: SeedRow; fetching: boolean }) {
  const [params, setParams] = useSearchParams(); const [history, setHistory] = useState<Array<string | null>>([params.get('cursor')]);
  const next = typeof page.nextCursor === 'string' ? page.nextCursor : null;
  const go = (cursor: string | null) => setParams(seedAdminParams(params, { cursor }, false));
  return <><p className="small-note">共 {seedNumber(page.total)} 条 · 每页 20 条 · 查询时间 {seedDateLabel(page.asOf)}</p><div className="pagination" aria-label="种子记录分页">
    <button className="button secondary" disabled={fetching || (history.length === 1 && !params.get('cursor'))} onClick={() => { const previous = history.length > 1 ? history.slice(0, -1) : [null]; setHistory(previous); go(previous.at(-1) ?? null); }}>上一页</button>
    <span>第 {history.length} 页</span><button className="button secondary" disabled={fetching || !next} onClick={() => { if (next) { setHistory(current => [...current, next]); go(next); } }}>下一页</button>
  </div></>;
}

export function SeedAdminModule() {
  const { state } = useApp(); const [params, setParams] = useSearchParams();
  const [version, setVersion] = useState(0); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(''); const [error, setError] = useState<unknown>(null);
  const pending = useRef(false); const request = useRef<{ signature: string; key: string } | null>(null);
  const view = parseSeedAdminView(params);
  useEffect(() => {
    if (view === 'coverage' && params.has('country')) setParams(seedAdminParams(params, { country: null }, false), { replace: true });
  }, [view, params, setParams]);
  const commands: Commands = { busy, run: async command => {
    if (pending.current) return undefined;
    const signature = JSON.stringify(command);
    if (request.current?.signature !== signature) request.current = { signature, key: crypto.randomUUID() };
    pending.current = true; setBusy(true); setError(null); setNotice('');
    try {
      const result = seedRow(await seedCommand({ ...command, idempotencyKey: request.current.key }));
      request.current = null; setNotice(seedText(result.message, '操作已记录，请查看发布与执行回执。')); setVersion(current => current + 1); return result;
    } catch (reason) { setError(reason); return undefined; }
    finally { pending.current = false; setBusy(false); }
  } };
  if (!state.user.isAdmin) return <Empty title="此页面仅供平台管理员使用">组织管理员和工作区成员不能管理平台全局种子库。</Empty>;
  const filterKey = JSON.stringify(['query', 'status', 'seedKind', 'sourceKey', 'country'].map(key => params.get(key)));
  const openSeed = (seedId: unknown) => { if (typeof seedId === 'string') setParams(seedAdminParams(params, { seedId }, false)); };
  return <section aria-label="种子库管理">
    <div className="section-title"><h2>种子库</h2><span className="muted">平台全局数据 · Asia/Hong_Kong</span><button className="button secondary" disabled={busy} onClick={() => setVersion(current => current + 1)}>刷新记录</button></div>
    <p className="small-note">保存草稿后须检查并发布配置；下载、应用、停止和执行以各自回执为准。</p>
    <div className="tabs" role="tablist" aria-label="种子库分类">{seedAdminViews.map(([key, label]) => <button key={key} role="tab" aria-selected={view === key} onClick={() => setParams(seedAdminParams(params, { view: key }))}>{label}</button>)}</div>
    {notice && <p className="notice" role="status">{notice}</p>}{error !== null && <p className="inline-error" role="alert">{seedErrorLabel(error)}</p>}
    {view === 'overview' && <SeedOverview version={version} />}
    {view === 'library' && <><Filters key={filterKey} /><SeedList key={`library:${filterKey}`} version={version} commands={commands} onOpen={openSeed} /><SeedEditor commands={commands} /></>}
    {view === 'discovery' && <SeedDiscovery key={`discovery:${filterKey}`} version={version} commands={commands} onOpen={openSeed} />}
    {view === 'dispatch' && <><Filters key={filterKey} dispatch /><SeedDispatch key={`dispatch:${filterKey}`} version={version} /></>}
    {view === 'coverage' && <SeedCoverage version={version} />}
    {view === 'rules' && <SeedRules version={version} commands={commands} />}
    {params.get('seedId') && <SeedDetail key={params.get('seedId')} seedId={params.get('seedId')!} version={version} commands={commands} onClose={() => setParams(seedAdminParams(params, { seedId: null }, false))} />}
  </section>;
}
function Filters({ dispatch = false }: { dispatch?: boolean }) {
  const [params, setParams] = useSearchParams();
  return <form className="filter-row" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const data = new FormData(event.currentTarget); setParams(seedAdminParams(params, Object.fromEntries(['query', 'status', 'seedKind', 'sourceKey', 'country'].map(key => [key, formText(data, key)])))); }}>
    <Field label="检索线索"><input name="query" defaultValue={params.get('query') ?? ''} placeholder="名称、词或域名" maxLength={200} /></Field>
    <Field label={dispatch ? '查询配置状态' : '配置状态'}><select name="status" defaultValue={params.get('status') ?? ''}><option value="">全部状态</option>{(dispatch ? ['READY', 'DORMANT'] : ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED']).map(status => <option key={status} value={status}>{seedStatusLabel(status)}</option>)}</select></Field>
    {!dispatch && <Field label="线索类型"><select name="seedKind" defaultValue={params.get('seedKind') ?? ''}><option value="">全部类型</option><option value="KEYWORD">关键词</option><option value="NAME">名称</option><option value="DOMAIN">域名</option><option value="APP_REFERENCE">应用引用</option><option value="NATIVE_ADVERTISER">来源原生身份</option></select></Field>}
    <Field label="来源平台"><select name="sourceKey" defaultValue={params.get('sourceKey') ?? ''}><option value="">全部来源</option>{seedSources.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
    <Field label="查询地域"><input name="country" defaultValue={params.get('country') ?? ''} maxLength={2} placeholder="如 US" /></Field><button className="button secondary" type="submit">筛选</button>
  </form>;
}
function pageArgs(params: URLSearchParams, view: 'seeds' | 'discoveries' | 'relations' | 'publications' | 'audits') {
  return { view, query: params.get('query') || undefined, status: params.get('status') || undefined, seedKind: params.get('seedKind') || undefined, sourceKey: params.get('sourceKey') || undefined, country: params.get('country')?.toUpperCase() || undefined, cursor: params.get('cursor') || undefined, limit: 20 };
}
function SeedList({ version, commands, onOpen }: { version: number; commands: Commands; onOpen: (id: unknown) => void }) {
  const [params] = useSearchParams(); const query = useQuery(getSeedPage, pageArgs(params, 'seeds'));
  return <QueryPanel query={query} version={version}>{page => <section className="section-block"><div className="section-title"><h3>种子列表</h3></div>{seedRows(page.items).length ? <DataTable headers={['种子', '类型与语言', '配置 / 核验', '修订', '操作']} rows={seedRows(page.items).map(seed => [<strong>{seedText(seed.rawValue)}</strong>, <>{seedText(seed.kind)} · {seedText(seed.language)}</>, <><Badge value={seed.status} /><br /><Badge value={seed.verificationStatus} /></>, seedText(seed.revision), <button className="text-button" disabled={commands.busy} onClick={() => onOpen(seed.id)}>查看 / 编辑</button>])} /> : <Empty title="暂无匹配的种子">调整筛选条件，或先保存一条草稿。</Empty>}<PageControls page={page} fetching={query.isFetching} /></section>}</QueryPanel>;
}
function SeedEditor({ seed, commands }: { seed?: SeedRow; commands: Commands }) {
  const [kind, setKind] = useState(seedText(seed?.kind, 'KEYWORD')); const [scopeKind, setScopeKind] = useState(seedText(seedRow(seed?.targetScope).kind, 'CONFIGURED_MARKETS'));
  const [nativeSource, setNativeSource] = useState(seedText(seed?.namespace, 'meta_ad_library'));
  const purposeTags = seedRows(seed?.purposeTags); const targetPlatforms = Array.isArray(seed?.targetPlatforms) ? seed.targetPlatforms : seedSources.map(([source]) => source);
  return <section className="section-block"><div className="section-title"><h3>{seed ? '编辑草稿' : '新建草稿'}</h3><span className="muted">保存不改变已发布版本</span></div>
    <form className="command-form task-form" onSubmit={async event => {
      event.preventDefault(); const data = new FormData(event.currentTarget);
      const countries = parts(formText(data, 'countries').toUpperCase());
      await commands.run({ type: 'SAVE_SEED', ...(seed?.id ? { targetId: String(seed.id), expectedRevision: revision(seed.revision) } : {}), reason: formText(data, 'reason'), payload: {
        kind, rawValue: formText(data, 'rawValue'), language: formText(data, 'language'), namespace: kind === 'NATIVE_ADVERTISER' ? nativeSource : formText(data, 'namespace'),
        purposeTags: (['ECOMMERCE', 'GAMES', 'COMICS'] as const).flatMap(family => [...new Set(formText(data, `purpose_${family}`).split(/[;；]+/).map(category => category.trim()).filter(Boolean))].map(category => ({ family, category }))),
        targetScope: scopeKind === 'EXPLICIT_COUNTRIES' ? { kind: scopeKind, countries } : { kind: scopeKind },
        targetPlatforms: kind === 'NATIVE_ADVERTISER' ? [nativeSource] : data.getAll('targetPlatforms').map(String), status: seed?.status ?? 'DRAFT', priority: typeof seed?.priority === 'number' ? seed.priority : 0,
      } });
    }}><fieldset disabled={commands.busy}>
      <Field label="线索类型"><select value={kind} onChange={event => setKind(event.target.value)}><option value="KEYWORD">关键词</option><option value="NAME">名称</option><option value="DOMAIN">域名</option><option value="APP_REFERENCE">应用引用</option><option value="NATIVE_ADVERTISER">来源原生身份</option></select></Field>
      <Field label="原始值"><input name="rawValue" required maxLength={2000} defaultValue={seedText(seed?.rawValue, '')} /></Field>
      <Field label="查询语言"><input name="language" required defaultValue={seedText(seed?.language, 'und')} maxLength={35} placeholder="en、zh-CN；未知填 und" /></Field>
      {kind === 'NATIVE_ADVERTISER' ? <Field label="身份所属来源" hint="原生身份需关联真实来源证据后才能通过核验与分发。"><select value={nativeSource} onChange={event => setNativeSource(event.target.value)}>{seedSources.map(([source, label]) => <option key={source} value={source}>{label}</option>)}</select></Field> : <Field label="线索来源分组"><input name="namespace" required defaultValue={seedText(seed?.namespace, 'public')} maxLength={128} /></Field>}
      {([['ECOMMERCE', '电商类目'], ['GAMES', '游戏类目'], ['COMICS', '漫剧类目']] as const).map(([family, label]) => <Field key={family} label={label} hint="可留空；多个类目用分号分隔。"><input name={`purpose_${family}`} defaultValue={purposeTags.filter(tag => tag.family === family).map(tag => seedText(tag.category, '')).join(';')} /></Field>)}
      <Field label="目标查询地域"><select value={scopeKind} onChange={event => setScopeKind(event.target.value)}><option value="CONFIGURED_MARKETS">当前已验证市场</option><option value="EXPLICIT_COUNTRIES">明确国家</option><option value="SOURCE_GLOBAL">来源全局范围（须已验证）</option></select></Field>
      {scopeKind === 'EXPLICIT_COUNTRIES' && <Field label="国家代码"><input name="countries" required placeholder="US;DE" defaultValue={Array.isArray(seedRow(seed?.targetScope).countries) ? (seedRow(seed?.targetScope).countries as string[]).join(';') : ''} /></Field>}
      {kind !== 'NATIVE_ADVERTISER' && <div className="field"><span>目标来源</span>{seedSources.map(([source, label]) => <label key={source} className="check-label"><input name="targetPlatforms" type="checkbox" value={source} defaultChecked={targetPlatforms.includes(source)} />{label}</label>)}</div>}
      <Field label="修改原因"><input name="reason" required maxLength={500} /></Field><div className="form-actions"><button className="button primary" type="submit">{commands.busy ? '正在保存…' : '保存草稿'}</button></div>
    </fieldset></form>
  </section>;
}
function ReasonAction({ commands, label, command }: { commands: Commands; label: string; command: Omit<Command, 'reason'> }) {
  return <form className="compact-form" onSubmit={event => { event.preventDefault(); void commands.run({ ...command, reason: formText(new FormData(event.currentTarget), 'reason') }); }}><fieldset disabled={commands.busy}><Field label={`${label}原因`}><input name="reason" required maxLength={500} /></Field><button className="button secondary" type="submit">{label}</button></fieldset></form>;
}
function SeedDetail({ seedId, version, commands, onClose }: { seedId: string; version: number; commands: Commands; onClose: () => void }) {
  const query = useQuery(getSeedDetail, { seedId });
  return <aside className="section-block" aria-label="种子详情"><div className="section-title"><h3>种子详情</h3><button className="text-button" onClick={onClose}>关闭详情</button></div><QueryPanel query={query} version={version}>{detail => {
    const seed = seedRow(detail.seed); const identityProofs = seedRows(detail.evidence).filter(e => e.originKind === 'ORIGINAL_SOURCE_IDENTITY' && e.role === 'SOURCE_IDENTITY' && e.rawValue === seed.rawValue && seedRow(e.source).key === seed.namespace && e.runId && e.evidenceSha256); const bindings = seedRows(detail.bindings); const attempts = seedRows(detail.attempts);
    return <><p><strong>{seedText(seed.rawValue)}</strong> · <Badge value={seed.status} /> · <Badge value={seed.verificationStatus} /></p>
      <SeedEditor key={`${seedId}:${seedText(seed.revision)}`} seed={seed} commands={commands} />
      <div className="section-title"><h4>启停与归档</h4><span className="muted">更新草稿期望；发布后再观察停止或应用回执</span></div>
      <div className="settings-columns">{[['PAUSED', '暂停草稿配置'], ['ACTIVE', '恢复草稿配置'], ['ARCHIVED', '归档草稿配置']].map(([status, label]) => <ReasonAction key={status} commands={commands} label={label} command={{ type: 'SET_SEED_STATUS', targetId: seedId, expectedRevision: revision(seed.revision), payload: { status } }} />)}</div>
      <h4>来源与证据</h4>{seedRows(detail.evidence).length ? <DataTable headers={['来源', '公开证据', '原始批次', '观察时间']} rows={seedRows(detail.evidence).map(evidence => [seedText(evidence.originKind), <SourceLink url={seedText(evidence.sourceUrl, '')}>查看公开来源</SourceLink>, seedText(evidence.runId), seedDateLabel(evidence.observedAt)])} /> : <p className="muted">尚无关联证据，不能据此确认原生身份。</p>}
      {seed.kind === 'NATIVE_ADVERTISER' && seed.verificationStatus !== 'VERIFIED' && (identityProofs.length ? <ReasonAction commands={commands} label="依据来源证据核验身份" command={{ type: 'VERIFY_NATIVE_SEED', targetId: seedId, expectedRevision: revision(seed.revision), payload: { evidenceIds: identityProofs.map(e => e.id) } }} /> : <p className="small-note">原生身份待核验：需要同一来源的原始广告批次证明。</p>)}
      <h4>关系</h4><RelationTable relations={seedRows(detail.relations)} commands={commands} />
      <h4>平台绑定</h4>{bindings.length ? <DataTable headers={['来源查询', '参与状态', '内容修订']} rows={bindings.map(binding => [seedText(binding.queryId), <Badge value={binding.participationStatus} />, seedText(binding.ownerRevision ?? binding.seedRevision)])} /> : <p className="muted">尚未建立有效平台绑定。</p>}
      <h4>实际执行</h4><AttemptTable attempts={attempts} />
    </>;
  }}</QueryPanel></aside>;
}
function SeedDiscovery({ version, commands, onOpen }: { version: number; commands: Commands; onOpen: (id: unknown) => void }) {
  const [kind, setKind] = useState<'discoveries' | 'relations'>('relations'); const [params, setParams] = useSearchParams();
  const selectKind = (next: 'discoveries' | 'relations') => { setKind(next); setParams(seedAdminParams(params, { cursor: null }, false)); };
  const query = useQuery(getSeedPage, pageArgs(params, kind));
  return <section className="section-block"><div className="section-title"><h3>待核对关系</h3></div><p className="small-note">名称相同只作为线索；确认关系须有公开证据，拒绝关系会保留来源广告与种子。</p><div className="tabs"><button aria-pressed={kind === 'relations'} onClick={() => selectKind('relations')}>待核对关系</button><button aria-pressed={kind === 'discoveries'} onClick={() => selectKind('discoveries')}>发现线索</button></div>
    <QueryPanel key={kind} query={query} version={version}>{page => <>{kind === 'relations' ? <RelationTable relations={seedRows(page.items)} commands={commands} /> : seedRows(page.items).length ? <DataTable headers={['线索', '来源', '核验', '详情']} rows={seedRows(page.items).map(item => [seedText(item.rawValue), sourceLabel(item.sourceKey ?? item.namespace), <Badge value={item.verificationStatus} />, <button className="text-button" onClick={() => onOpen(item.seedId ?? item.id)}>查看证据</button>])} /> : <Empty title="暂无新发现线索">只有已提交的公开批次和可验证资料会进入回流。</Empty>}<PageControls page={page} fetching={query.isFetching} /></>}</QueryPanel>
  </section>;
}
function RelationTable({ relations, commands }: { relations: SeedRow[]; commands: Commands }) {
  if (!relations.length) return <Empty title="暂无待核对关系">关系建议出现后，可查看证据再逐条确认。</Empty>;
  return <DataTable headers={['两端线索', '关系', '状态', '处理']} rows={relations.map(relation => [<>{seedText(seedRow(relation.fromSeed).rawValue, seedText(relation.fromSeedId))}<br />{seedText(seedRow(relation.toSeed).rawValue, seedText(relation.toSeedId))}</>, seedText(relation.relationType), <Badge value={relation.status} />, <div className="row-actions">{relation.status === 'PENDING' && <><ReasonAction commands={commands} label="确认关系" command={{ type: 'CONFIRM_SEED_RELATION', targetId: String(relation.id), expectedRevision: revision(relation.revision), payload: {} }} /><ReasonAction commands={commands} label="拒绝关系" command={{ type: 'REJECT_SEED_RELATION', targetId: String(relation.id), expectedRevision: revision(relation.revision), payload: {} }} /></>}</div>])} />;
}
function AttemptTable({ attempts }: { attempts: SeedRow[] }) {
  return attempts.length ? <DataTable headers={['开始时间', '结果', '首次入库 / 更新', '入库确认', '归因']} rows={attempts.map(attempt => [seedDateLabel(attempt.startedAt), <Badge value={attempt.state ?? attempt.outcome} />, <>{seedNumber(attempt.insertedCount)} / {seedNumber(attempt.updatedCount)}</>, seedStateView({ attempts: [attempt] }).completion, seedStateView({ attributionQuality: attempt.attributionQuality }).attribution])} /> : <p className="muted">尚无执行记录；未执行不等于无结果。</p>;
}
function SeedDispatch({ version }: { version: number }) {
  const [params] = useSearchParams(); const { view: _view, ...args } = pageArgs(params, 'seeds'); const query = useQuery(getSeedDispatchPage, args);
  return <QueryPanel query={query} version={version}>{page => <section className="section-block"><div className="section-title"><h3>查询与执行</h3></div><p className="small-note">同一有效查询可由多个种子共享。TikTok / Pinterest 按国家与日期扫描回流，不能当作品牌关键词执行。</p>{seedRows(page.items).length ? <DataTable headers={['来源 / 通道', '查询范围', '拥有者', '发布', '下载 / 应用', '执行 / 入库', '停止 / 限制']} rows={seedRows(page.items).map(item => {
    const runtime = seedRows(item.runtime); const state = seedStateView({ publication: seedRow(item.publication), receipts: seedRows(item.receipts), runtime, attempts: seedRows(item.attempts), attributionQuality: item.attributionQuality });
    const params = seedRow(item.params ?? item.normalizedParams);
    return [<>{sourceLabel(item.sourceKey)}<br />{seedText(item.channel)} · {seedText(item.mode)}</>, <>{seedText(params.keyword ?? params.term ?? params.publisher ?? params.advertiserId)}<br />查询地域 {seedText(params.country)}</>, `${seedRows(item.bindings).length} 个绑定`, state.publication, <>{state.download}<br />{state.application}</>, <>{state.execution}<br />{state.completion}</>, <>{state.stop}<br />{runtime.map(row => <p key={seedText(row.queryId)} className="small-note">可执行时间 {seedDateLabel(row.nextAllowedAt ?? row.notBefore)} · {seedText(row.reason ?? row.restrictionReason, '未记录限制')}</p>)}</>];
  })} /> : <Empty title="尚无可管理的分发查询">先保存草稿，检查来源能力，再预览并发布配置。</Empty>}<PageControls page={page} fetching={query.isFetching} /></section>}</QueryPanel>;
}
function LedgerTable({ rows }: { rows: SeedRow[] }) {
  return rows.length ? <DataTable headers={['来源 / 查询', '查询地域', '执行', '首次入库', '已有更新', '可靠无结果 / 未知空结果', '部分 / 失败 / 受限', '归因']} rows={rows.map(row => {
    const params = seedRow(row.params); return [<>{sourceLabel(row.sourceKey)}<br />{seedText(row.rawValue ?? params.keyword ?? params.term ?? params.publisher ?? row.queryId)} · {seedText(row.channel)}</>, seedText(params.country ?? row.country), seedNumber(row.executionCount), seedNumber(row.insertedCount), seedNumber(row.updatedCount), <>{seedNumber(row.reliableNoResultsCount)} / {seedNumber(row.unknownEmptyCount)}</>, <>{seedNumber(row.partialCount)} / {seedNumber(row.failedCount)} / {seedNumber(row.restrictedCount)}</>, seedStateView({ attributionQuality: row.attributionQuality }).attribution];
  })} /> : <Empty title="暂无当前范围的查询账本">尚未接入的历史归属会明确标注；不会补算为种子独占贡献。</Empty>;
}
function SeedOverview({ version }: { version: number }) {
  const query = useQuery(getSeedOverview, {});
  return <QueryPanel query={query} version={version}>{data => {
    const counts = seedRow(data.seedCounts); const nodes = seedRows(data.nodes);
    return <section className="section-block"><div className="section-title"><h3>主库与运行记录</h3></div><p className="small-note">执行统计窗口：{seedDateLabel(seedRow(data.window).from)} 至 {seedDateLabel(seedRow(data.window).to)}（结束时间不含）。</p><div className="fact-strip">{[['ACTIVE', '启用种子'], ['DRAFT', '草稿种子'], ['PAUSED', '暂停种子'], ['ARCHIVED', '归档种子']].map(([key, label]) => <div className="fact" key={key}><span>{label}</span><strong>{seedNumber(counts[key])}</strong></div>)}</div>
      <h4>执行节点</h4>{nodes.length ? <DataTable headers={['节点', '运行状态', '到期时间', '最近心跳']} rows={nodes.map(node => [seedText(node.displayName ?? node.nodeId ?? node.id), <Badge value={node.status ?? node.lifecycleState} />, node.expiresAt == null ? '到期待确认' : seedDateLabel(node.expiresAt), seedDateLabel(node.lastSeenAt ?? node.lastHeartbeatAt)])} /> : <p className="muted">节点运行回执未接入；登记或代码部署不能作为执行证明。</p>}
      <h4>查询账本</h4><LedgerTable rows={seedRows(data.ledger)} /><p className="small-note">首次入库与已有更新分别记录；共享查询行不能相加，历史缺少种子绑定时显示归因缺失。</p>
    </section>;
  }}</QueryPanel>;
}
function SeedCoverage({ version }: { version: number }) {
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); const weekAgo = new Date(Date.now() + 8 * 3600000 - 6 * 86400000).toISOString().slice(0, 10);
  const [range, setRange] = useState({ from: weekAgo, to: today }); const [rangeError, setRangeError] = useState(''); const [params] = useSearchParams();
  const query = useQuery(getSeedCoverage, { ...seedLedgerWindow(range.from, range.to), sourceKey: params.get('sourceKey') || undefined });
  return <section className="section-block"><div className="section-title"><h3>查询效果</h3></div><form className="filter-row" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); const next = { from: formText(data, 'from'), to: formText(data, 'to') }; try { seedLedgerWindow(next.from, next.to); setRange(next); setRangeError(''); } catch { setRangeError('请选择有效且先后顺序正确的日期。'); } }}><Field label="开始日期"><input name="from" type="date" required defaultValue={range.from} max={today} /></Field><Field label="结束日期"><input name="to" type="date" required defaultValue={range.to} max={today} min={range.from} /></Field><button className="button secondary" disabled={query.isFetching}>查看日期范围</button></form>{rangeError && <p className="inline-error" role="alert">{rangeError}</p>}
    <QueryPanel query={query} version={version}>{data => <><p className="small-note">{seedText(data.scopeLabel, '已验证范围内的查询执行证据；不是市场广告覆盖率。')}</p><LedgerTable rows={seedRows(data.rows)} /><p className="small-note">宽范围扫描只证明国家与日期范围执行，不能自动证明游戏或漫剧专题覆盖。请求账本未接入时，不计算每请求效率。</p></>}</QueryPanel>
  </section>;
}
function SeedRules({ version, commands }: { version: number; commands: Commands }) {
  const query = useQuery(getSeedRules, {});
  return <QueryPanel query={query} version={version}>{data => <section className="section-block"><div className="section-title"><h3>来源能力</h3></div>{seedRows(data.capabilities).length ? <DataTable headers={['来源 / 通道', '已验证方式', '已验证地域', '核验时间']} rows={seedRows(data.capabilities).map(capability => [<>{sourceLabel(capability.sourceKey)} · {seedText(capability.channel)}</>, Array.isArray(capability.modes) ? capability.modes.join('、') : seedText(capability.mode), Array.isArray(capability.countries) ? capability.countries.join('、') : '地域待验证', seedDateLabel(capability.verifiedAt)])} /> : <p className="muted">来源能力未接入，不能据主库国家目录宣称支持。</p>}
    <h4>来源限制</h4>{seedRows(data.sourceControls).length ? <DataTable headers={['来源', '控制状态', '下次允许时间', '原因']} rows={seedRows(data.sourceControls).map(control => [sourceLabel(control.sourceKey), <><Badge value={control.controlMode ?? control.status ?? control.mode} />{control.manualPause === true && <p className="inline-error">来源暂停</p>}</>, seedDateLabel(control.notBefore ?? control.cooldownUntil), seedText(control.reason)])} /> : <p className="muted">来源控制状态未接入。</p>}
    <ScanPlans plans={seedRows(data.scanPlans)} commands={commands} />
    <PublicationControls publications={seedRows(data.publications)} commands={commands} />
    <section className="section-block"><h4>迁入现有代码主库</h4><p className="small-note">导入后逐项审核；不会自动启用或发布。重复导入保留已编辑的状态和配置。</p><ReasonAction commands={commands} label="导入代码主库为草稿" command={{ type: 'IMPORT_STATIC_SEED_BASELINE', payload: {} }} /></section>
    <SeedImport commands={commands} version={version} />
    <Records version={version} />
  </section>}</QueryPanel>;
}
function ScanPlans({ plans, commands }: { plans: SeedRow[]; commands: Commands }) {
  const [selectedId, setSelectedId] = useState(''); const selected = plans.find(plan => plan.id === selectedId);
  return <section className="section-block"><div className="section-title"><h4>国家与日期扫描</h4></div><p className="small-note">TikTok / Pinterest 的扫描计划按国家和日期管理；专题关联由回流证据另行核对。</p>
    {plans.length ? <DataTable headers={['来源', '日期策略', '状态', '修订']} rows={plans.map(plan => [sourceLabel(plan.sourceKey), seedRow(plan.datePolicy).kind === 'ROLLING' ? `滚动 ${seedNumber(seedRow(plan.datePolicy).windowDays)} 天` : `${seedText(seedRow(plan.datePolicy).start)} 至 ${seedText(seedRow(plan.datePolicy).end)}`, <Badge value={plan.status} />, seedText(plan.revision)])} /> : <p className="muted">尚无扫描计划。</p>}
    <Field label="编辑扫描计划"><select value={selectedId} onChange={event => setSelectedId(event.target.value)}><option value="">新建扫描草稿</option>{plans.map(plan => <option key={String(plan.id)} value={String(plan.id)}>{sourceLabel(plan.sourceKey)} · 修订 {seedText(plan.revision)}</option>)}</select></Field>
    <ScanPlanEditor key={`${selectedId}:${seedText(selected?.revision)}`} plan={selected} commands={commands} />
  </section>;
}
function ScanPlanEditor({ plan, commands }: { plan?: SeedRow; commands: Commands }) {
  const datePolicy = seedRow(plan?.datePolicy); const scope = seedRow(plan?.targetScope);
  const [policyKind, setPolicyKind] = useState(seedText(datePolicy.kind, 'ROLLING')); const [scopeKind, setScopeKind] = useState(seedText(scope.kind, 'CONFIGURED_MARKETS'));
  return <form className="command-form task-form" onSubmit={event => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    void commands.run({ type: 'SAVE_SEED_SCAN_PLAN', ...(plan?.id ? { targetId: String(plan.id), expectedRevision: revision(plan.revision) } : {}), reason: formText(data, 'reason'), payload: {
      sourceKey: formText(data, 'sourceKey'), targetScope: scopeKind === 'EXPLICIT_COUNTRIES' ? { kind: scopeKind, countries: parts(formText(data, 'countries').toUpperCase()) } : { kind: scopeKind },
      datePolicy: policyKind === 'ROLLING' ? { kind: policyKind, windowDays: Number(formText(data, 'windowDays')) } : { kind: policyKind, start: formText(data, 'start'), end: formText(data, 'end') },
      category: 'ALL', status: formText(data, 'status'), evidence: seedRow(plan?.evidence),
    } });
  }}><fieldset disabled={commands.busy}>
    <Field label="扫描来源"><select name="sourceKey" defaultValue={seedText(plan?.sourceKey, 'tiktok_commercial_library')}><option value="tiktok_commercial_library">TikTok</option><option value="pinterest_ads_repository">Pinterest</option></select></Field>
    <Field label="扫描期望状态" hint="保存修订后，另行预览发布；节点应用后才改变采集。"><select name="status" defaultValue={seedText(plan?.status, 'DRAFT')}><option value="DRAFT">草稿</option><option value="ACTIVE">启用</option><option value="PAUSED">暂停</option><option value="ARCHIVED">归档</option></select></Field>
    <Field label="扫描地域"><select value={scopeKind} onChange={event => setScopeKind(event.target.value)}><option value="CONFIGURED_MARKETS">当前已验证市场</option><option value="EXPLICIT_COUNTRIES">明确国家</option></select></Field>
    {scopeKind === 'EXPLICIT_COUNTRIES' && <Field label="扫描国家代码"><input name="countries" required placeholder="US;DE" defaultValue={Array.isArray(scope.countries) ? scope.countries.join(';') : ''} /></Field>}
    <Field label="日期策略"><select value={policyKind} onChange={event => setPolicyKind(event.target.value)}><option value="ROLLING">滚动日期窗口</option><option value="FIXED">固定日期范围</option></select></Field>
    {policyKind === 'ROLLING' ? <Field label="滚动窗口天数"><input name="windowDays" type="number" min={1} required defaultValue={typeof datePolicy.windowDays === 'number' ? datePolicy.windowDays : ''} /></Field> : <><Field label="扫描开始日"><input name="start" type="date" required defaultValue={seedText(datePolicy.start, '')} /></Field><Field label="扫描结束日"><input name="end" type="date" required defaultValue={seedText(datePolicy.end, '')} /></Field></>}
    <Field label="扫描计划修改原因"><input name="reason" required maxLength={500} /></Field><button className="button primary" type="submit">保存扫描修订</button>
  </fieldset></form>;
}
function PublicationControls({ publications, commands }: { publications: SeedRow[]; commands: Commands }) {
  const head = publications.filter(publication => publication.status === 'PUBLISHED').sort((a, b) => Number(b.revision) - Number(a.revision))[0];
  const parentRevision = revision(head?.revision) ?? null; const [preview, setPreview] = useState<SeedRow | undefined>(); const [reason, setReason] = useState('');
  return <section className="section-block"><div className="section-title"><h3>发布与导入</h3></div><p className="small-note">先检查当前草稿，再显式发布。回滚创建更高发布版本，保留采集断点和来源冷却。</p>
    <form className="compact-form" onSubmit={async event => { event.preventDefault(); const result = await commands.run({ type: 'PREVIEW_SEED_PUBLICATION', reason, expectedRevision: parentRevision ?? undefined, payload: { parentRevision } }); if (result) setPreview({ ...result, parentRevision }); }}><fieldset disabled={commands.busy}><Field label="发布原因"><input required value={reason} onChange={event => setReason(event.target.value)} maxLength={500} /></Field><button className="button secondary">检查分发</button></fieldset></form>
    {preview && <div className="section-block"><p>预览记录 {seedText(preview.targetId)} · {seedText(preview.message)}</p><PublicationPreview preview={preview} /><button className="button primary" disabled={commands.busy || preview.parentRevision !== parentRevision} onClick={async () => { const result = await commands.run({ type: 'PUBLISH_SEED_CONFIG', targetId: seedText(preview.targetId, ''), expectedRevision: parentRevision ?? undefined, reason, payload: { previewId: preview.targetId, parentRevision } }); if (result) setPreview(undefined); }}>确认发布</button>{preview.parentRevision !== parentRevision && <p className="inline-error">发布头已变化，请重新检查分发。</p>}</div>}
    {publications.length ? <DataTable headers={['版本', '状态', '记录时间', '下载 / 应用', '恢复此配置']} rows={publications.map(publication => {
      const state = seedStateView({ publication, receipts: seedRows(publication.receipts) });
      return [seedText(publication.revision), <Badge value={publication.status} />, seedDateLabel(publication.createdAt), <>{state.download}<br />{state.application}</>, publication.status === 'PUBLISHED' && publication.id !== head?.id ? <ReasonAction commands={commands} label="创建恢复发布" command={{ type: 'ROLLBACK_SEED_CONFIG', targetId: String(publication.id), expectedRevision: parentRevision ?? undefined, payload: { parentRevision } }} /> : '—'];
    })} /> : <p className="muted">尚未发布配置；执行器等待接入。</p>}
  </section>;
}
function PublicationPreview({ preview }: { preview: SeedRow }) {
  const diff = seedRow(preview.diff); const decisions = seedRows(preview.decisions);
  const count = (key: string) => Array.isArray(diff[key]) ? seedNumber(diff[key].length) : '未接入';
  return <><p>新增查询 {count('newQueryKeys')} · 复用查询 {count('reusedQueryKeys')} · 未启用查询 {count('disabledQueryKeys')}</p>
    {decisions.length ? <DataTable headers={['线索 / 计划', '来源', '地域', '分发决定', '原因']} rows={decisions.map(decision => [seedText(decision.ownerId), sourceLabel(decision.sourceKey), seedText(decision.country, '未指定'), <Badge value={decision.decision} />, seedText(decision.reason, '—')])} /> : <p className="muted">本次预览未返回逐项分发决定。</p>}
  </>;
}
function SeedImport({ commands, version }: { commands: Commands; version: number }) {
  const [csv, setCsv] = useState(''); const [reason, setReason] = useState(''); const [jobId, setJobId] = useState<string | undefined>(); const [mode, setMode] = useState('SKIP_ERRORS'); const [fileError, setFileError] = useState('');
  return <section className="section-block"><h4>CSV 导入</h4><p className="small-note">先校验预览，再选择错误行处理方式并提交；每个错误行均保留结果。</p><form className="command-form" onSubmit={async event => { event.preventDefault(); const result = await commands.run({ type: 'PREVIEW_SEED_IMPORT', reason, payload: { csv } }); if (typeof result?.targetId === 'string') setJobId(result.targetId); }}><fieldset disabled={commands.busy}>
    <Field label="UTF-8 CSV 文件"><input type="file" accept=".csv,text/csv" onChange={async event => { setJobId(undefined); const file = event.target.files?.[0]; if (!file) return; if (file.size > 25 * 1024 * 1024) { setFileError('单次文件超过 25 MiB，请分批上传。'); return; } try { setCsv(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer())); setFileError(''); } catch { setFileError('文件不是有效 UTF-8，请转换编码后重试。'); } }} /></Field>
    <Field label="CSV 内容"><textarea rows={5} required value={csv} onChange={event => { setCsv(event.target.value); setJobId(undefined); }} placeholder="kind,value,language,family,category,countries,platform,native_id_type,source_url,reason" /></Field>
    <Field label="导入原因"><input required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></Field><button className="button secondary" type="submit" disabled={!!fileError}>校验预览</button>
  </fieldset></form>{fileError && <p className="inline-error" role="alert">{fileError}</p>}
    {jobId ? <ImportPreview jobId={jobId} version={version} commands={commands} reason={reason} mode={mode} setMode={setMode} /> : <p className="muted">先校验预览，查看新增、重复与错误行后才可提交导入。</p>}
  </section>;
}
function ImportPreview({ jobId, version, commands, reason, mode, setMode }: { jobId: string; version: number; commands: Commands; reason: string; mode: string; setMode: (mode: string) => void }) {
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]); const query = useQuery(getSeedImportPreview, { importId: jobId, cursor: cursors.at(-1), limit: 20 });
  return <QueryPanel query={query} version={version}>{data => <><p>预览状态 <Badge value={data.status} /> · 共 {seedNumber(data.total)} 行</p><DataTable headers={['行', '线索', '校验结果', '原因']} rows={seedRows(data.items).map(row => [seedText(row.row ?? row.line), seedText(row.rawValue ?? row.value), <Badge value={row.status} />, seedText(row.error ?? row.reason, '—')])} />
    <div className="pagination"><button className="button secondary" disabled={query.isFetching || cursors.length === 1} onClick={() => setCursors(current => current.slice(0, -1))}>上一页</button><button className="button secondary" disabled={query.isFetching || typeof data.nextCursor !== 'string'} onClick={() => setCursors(current => [...current, String(data.nextCursor)])}>下一页</button></div>
    <Field label="错误行处理方式"><select value={mode} onChange={event => setMode(event.target.value)}><option value="SKIP_ERRORS">跳过错误行并报告结果</option><option value="ALL_OR_NOTHING">发现错误则不提交</option></select></Field>
    <button className="button primary" disabled={commands.busy || !['PREVIEWED', 'VALIDATED', 'READY'].includes(String(data.status))} onClick={() => void commands.run({ type: 'COMMIT_SEED_IMPORT', targetId: jobId, reason, payload: { mode } })}>提交导入</button>
  </>}</QueryPanel>;
}
function Records({ version }: { version: number }) {
  const [kind, setKind] = useState<'publications' | 'audits'>('audits'); const [params, setParams] = useSearchParams(); const query = useQuery(getSeedPage, { view: kind, cursor: params.get('cursor') || undefined, limit: 20 });
  const selectKind = (next: 'publications' | 'audits') => { setKind(next); setParams(seedAdminParams(params, { cursor: null }, false)); };
  return <section className="section-block"><h4>规则与操作记录</h4><div className="tabs"><button aria-pressed={kind === 'audits'} onClick={() => selectKind('audits')}>操作审计</button><button aria-pressed={kind === 'publications'} onClick={() => selectKind('publications')}>发布历史</button></div><QueryPanel key={kind} query={query} version={version}>{page => <>{seedRows(page.items).length ? <DataTable headers={['时间', '操作 / 版本', '目标', '操作人 / 原因']} rows={seedRows(page.items).map(item => [seedDateLabel(item.createdAt), seedText(item.action ?? item.revision), seedText(item.targetId ?? item.id), <>{seedText(item.actorUserId ?? item.createdByUserId)}<br />{seedText(seedRow(item.metadata).reason ?? item.reason)}</>])} /> : <p className="muted">尚无此类记录。</p>}<PageControls page={page} fetching={query.isFetching} /></>}</QueryPanel></section>;
}
