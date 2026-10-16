// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSeedAdminView, seedAdminParams, seedDateLabel, seedErrorLabel, seedLedgerWindow, seedStateView } from './state-view';
const fixture = vi.hoisted(() => ({ commands: [] as Array<Record<string, unknown>>, queries: [] as Array<{ operation: string; args: Record<string, unknown> }>, isAdmin: true, conflict: false, expectedStatus: null as string | null, result: {} as Record<string, unknown>, data: {} as Record<string, unknown> }));
vi.mock('wasp/client/operations', () => ({
  getSeedOverview: 'overview', getSeedPage: 'page', getSeedDetail: 'detail', getSeedDispatchPage: 'dispatch', getSeedCoverage: 'coverage', getSeedRules: 'rules', getSeedImportPreview: 'import', getAdminPage: 'admin', getGrowthOverview: 'growth',
  seedCommand: async (input: { payload: Record<string, unknown> }) => { fixture.commands.push(input); if (fixture.conflict) throw new Error('SEED_REVISION_CONFLICT'); if (fixture.expectedStatus && input.payload.status !== fixture.expectedStatus) throw new Error('SEED_STATE_INVALID'); return { message: '已保存草稿。', ...fixture.result }; },
  useQuery: (operation: string, args: Record<string, unknown>) => { fixture.queries.push({ operation, args }); return { data: fixture.data[operation], error: null, isLoading: false, isFetching: false, refetch: async () => undefined }; },
}));
vi.mock('../App', () => ({
  useApp: () => ({ state: { user: { isAdmin: fixture.isAdmin }, admin: { sources: [], users: [], tasks: [], runs: [], customers: [], feedback: [], health: [] } }, refresh: async () => undefined }),
  Field: ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => createElement('label', null, label, children, hint),
  Empty: ({ title, children }: { title: string; children?: ReactNode }) => createElement('section', null, createElement('h3', null, title), children),
  Loading: ({ label }: { label: string }) => createElement('p', null, label),
  SourceLink: ({ url, children }: { url: string; children: ReactNode }) => createElement('a', { href: url }, children),
  PageHeader: ({ title }: { title: string }) => createElement('h1', null, title),
  errorLabel: () => '暂时无法读取',
  formText: (data: FormData, key: string) => String(data.get(key) ?? '').trim(),
}));
import { SeedAdminModule } from './SeedAdminModule';
import { AdminPage } from '../AdminPage';
beforeEach(() => {
  fixture.commands = [];
  fixture.queries = [];
  fixture.isAdmin = true;
  fixture.conflict = false;
  fixture.expectedStatus = null;
  fixture.result = {};
  fixture.data = {
    overview: { seedCounts: {}, ledger: [], publications: [], nodes: [] },
    page: { items: [], total: 0, nextCursor: null, asOf: '2026-10-11T00:00:00Z' },
    dispatch: { items: [], total: 0, nextCursor: null }, coverage: { rows: [], scopeLabel: '仅已验证范围' },
    rules: { capabilities: [], sourceControls: [], publications: [], scanPlans: [] },
  };
});
let domRoot: Root | undefined;
let container: HTMLElement | undefined;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => { if (domRoot) await act(async () => domRoot!.unmount()); domRoot = undefined; container?.remove(); container = undefined; });
function LocationProbe() { const location = useLocation(); return createElement('output', { 'data-route': true }, location.search); }
async function mount(url: string) {
  container = document.createElement('div'); document.body.append(container); domRoot = createRoot(container);
  await act(async () => domRoot!.render(createElement(MemoryRouter, { initialEntries: [url] }, createElement(SeedAdminModule), createElement(LocationProbe))));
  return container;
}
async function clickText(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll('button')].find(button => button.textContent === text);
  expect(button).toBeDefined(); await act(async () => button!.click());
}
function renderView(view: string) {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [`/app/admin?module=seeds&view=${view}`] }, createElement(SeedAdminModule)));
}

describe('seed administration uses observed state rather than inferred execution', () => {
  it('keeps all six views addressable and falls back safely for unknown view', () => {
    for (const view of ['overview', 'library', 'discovery', 'dispatch', 'coverage', 'rules']) expect(parseSeedAdminView(new URLSearchParams({ view }))).toBe(view);
    expect(parseSeedAdminView(new URLSearchParams({ view: 'unknown' }))).toBe('overview');
  });
  it('resets pagination when a filter changes while retaining language and app context', () => {
    const result = seedAdminParams(new URLSearchParams('lang=en&workspace=ws&view=library&cursor=old&seedId=seed'), { country: 'US' });
    expect(result.get('module')).toBe('seeds'); expect(result.get('view')).toBe('library');
    expect(result.get('country')).toBe('US'); expect(result.has('cursor')).toBe(false);
    expect(result.get('lang')).toBe('en'); expect(result.get('workspace')).toBe('ws');
  });
  it('clears old detail and pagination on view change', () => {
    const result = seedAdminParams(new URLSearchParams('view=library&seedId=seed&cursor=old&status=ACTIVE&seedKind=NAME'), { view: 'dispatch' });
    expect(result.get('view')).toBe('dispatch'); expect(result.has('seedId')).toBe(false); expect(result.has('cursor')).toBe(false);
    expect(result.has('status')).toBe(false); expect(result.has('seedKind')).toBe(false);
  });
  it('opens a detail without losing the current list cursor', () => {
    const result = seedAdminParams(new URLSearchParams('view=library&cursor=old&sourceKey=meta_ad_library'), { seedId: 'seed' }, false);
    expect(result.get('seedId')).toBe('seed'); expect(result.get('cursor')).toBe('old'); expect(result.get('sourceKey')).toBe('meta_ad_library');
  });
  it('clears unsupported country when opening coverage while retaining source and app context', () => {
    const result = seedAdminParams(new URLSearchParams('view=library&country=DE&sourceKey=meta_ad_library&lang=en&workspace=ws&cursor=old'), { view: 'coverage' });
    expect(result.get('view')).toBe('coverage'); expect(result.has('country')).toBe(false);
    expect(result.get('sourceKey')).toBe('meta_ad_library'); expect(result.get('lang')).toBe('en'); expect(result.get('workspace')).toBe('ws');
  });
  it('does not turn a published revision into applied, executed or committed state', () => {
    const state = seedStateView({ publication: { id: 'pub', revision: 4, status: 'PUBLISHED' } });
    expect(state.publication).toContain('已发布'); expect(state.application).toBe('等待应用回执');
    expect(state.execution).toBe('尚无执行记录'); expect(state.completion).toBe('尚未确认入库');
  });
  it('shows a downloaded receipt separately from an applied receipt', () => {
    const state = seedStateView({ publication: { id: 'pub', revision: 4, status: 'PUBLISHED' }, receipts: [{ publicationId: 'pub', applyStatus: 'DOWNLOADED' }] });
    expect(state.download).toContain('已下载'); expect(state.application).toBe('等待应用回执');
  });
  it('ignores an applied receipt for a different publication', () => {
    const state = seedStateView({ publication: { id: 'new', revision: 5, status: 'PUBLISHED' }, receipts: [{ publicationId: 'old', applyStatus: 'APPLIED' }] });
    expect(state.application).toBe('等待应用回执');
  });
  it('reports received application evidence without claiming all nodes applied', () => {
    const state = seedStateView({ publication: { id: 'pub', revision: 4, status: 'PUBLISHED' }, receipts: [{ publicationId: 'pub', applyStatus: 'APPLIED' }, { publicationId: 'pub', applyStatus: 'REJECTED' }] });
    expect(state.application).toContain('已应用回执 1'); expect(state.application).toContain('拒绝 1'); expect(state.application).not.toContain('全部');
  });
  it('keeps a running stop request distinct from stopped or committed', () => {
    const state = seedStateView({ runtime: [{ executionState: 'STOP_REQUESTED' }], attempts: [{ state: 'COMMIT_PENDING', startedAt: '2026-10-11T01:00:00Z' }] });
    expect(state.stop).toBe('等待停止确认'); expect(state.completion).toBe('尚未确认入库');
  });
  it('does not infer reliable no-results from a zero count or successful fetch', () => {
    const state = seedStateView({ attempts: [{ outcome: 'SUCCEEDED', fetchedCount: 0 }] });
    expect(state.execution).not.toContain('可靠无结果'); expect(state.completion).toBe('尚未确认入库');
  });
  it('shows explicit reliable no-results and known committed evidence', () => {
    const state = seedStateView({ attempts: [{ outcome: 'NO_RESULTS', commitStatus: 'COMMITTED', runId: 'run' }], attributionQuality: 'UNATTRIBUTED' });
    expect(state.execution).toBe('可靠无结果'); expect(state.completion).toBe('已确认入库'); expect(state.attribution).toContain('归因缺失');
  });
  it('formats observations in the declared Hong Kong timezone', () => {
    expect(seedDateLabel('2026-10-10T23:00:00Z')).toContain('2026年10月11日');
    expect(seedDateLabel(null)).toBe('未接入');
  });
  it('uses an inclusive selected Hong Kong day with an exclusive next-day UTC endpoint', () => {
    expect(seedLedgerWindow('2026-10-10', '2026-10-10')).toEqual({ from: '2026-10-09T16:00:00.000Z', to: '2026-10-10T16:00:00.000Z' });
    expect(() => seedLedgerWindow('2026-10-11', '2026-10-10')).toThrow();
    expect(() => seedLedgerWindow('2026-02-30', '2026-03-01')).toThrow();
  });
  it('explains revision conflicts without dropping the current editor input', () => {
    expect(seedErrorLabel(new Error('SEED_REVISION_CONFLICT'))).toContain('保留');
    expect(seedErrorLabel(new Error('PLATFORM_ADMIN_REQUIRED'))).toContain('管理员');
  });
});

describe('seed administration pages', () => {
  it.each([
    ['overview', '主库与运行记录'], ['library', '新建草稿'], ['discovery', '待核对关系'],
    ['dispatch', '查询与执行'], ['coverage', '查询效果'], ['rules', '发布与导入'],
  ])('renders the working surface for %s', (view, heading) => {
    expect(renderView(view)).toContain(heading);
  });
  it('denies ordinary customer roles instead of showing platform commands', () => {
    fixture.isAdmin = false; const html = renderView('library');
    expect(html).toContain('平台管理员'); expect(html).not.toContain('保存草稿');
  });
  it('shows missing overview metrics as unconnected instead of zero', () => {
    const html = renderView('overview'); expect(html).toContain('未接入'); expect(html).not.toContain('首次入库广告 0');
  });
  it('keeps imports unavailable for commit before a validated preview exists', () => {
    const html = renderView('rules'); expect(html).toContain('先校验预览');
    expect(html).not.toMatch(/<button[^>]*>(?:提交导入|确认发布)<\/button>/);
  });
  it('opens the seeds module from the existing protected admin route URL', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/app/admin?module=seeds&view=library'] }, createElement(AdminPage)));
    expect(html).toContain('平台管理'); expect(html).toContain('新建草稿');
  });
  it('provides explicit scan date policy controls without a synthetic brand keyword query', () => {
    const html = renderView('rules');
    expect(html).toContain('保存扫描修订'); expect(html).toContain('滚动窗口天数'); expect(html).toContain('扫描期望状态');
    expect(html).toContain('国家与日期扫描'); expect(html).not.toContain('品牌关键词扫描');
  });
  it('uses real query state filters on dispatch instead of catalog seed states', () => {
    const html = renderView('dispatch'); expect(html).toContain('value="READY"'); expect(html).toContain('value="DORMANT"'); expect(html).not.toContain('value="ACTIVE"');
  });
  it('shows the actual server source control mode and manual pause', () => {
    fixture.data.rules = { capabilities: [], sourceControls: [{ sourceKey: 'meta_ad_library', controlMode: 'CONFIG_QUEUE', manualPause: true, notBefore: '2026-10-12T00:00:00Z', reason: '核对来源访问' }], publications: [], scanPlans: [] };
    const html = renderView('rules'); expect(html).toContain('配置队列'); expect(html).toContain('来源暂停');
  });
});

describe('local seed administration interactions', () => {
  it('uses the retained published head as parent after twenty newer preview rows', async () => {
    const head = { id: 'published-head', revision: 41, status: 'PUBLISHED', receipts: [] };
    const drafts = Array.from({ length: 20 }, (_, index) => ({ id: `preview-${index}`, revision: 42 + index, status: 'DRAFT', receipts: [] }));
    fixture.data.rules = { capabilities: [], sourceControls: [], scanPlans: [], publications: [...drafts, head] };
    const container = await mount('/app/admin?module=seeds&view=rules');
    const form = [...container.querySelectorAll('button')].find(button => button.textContent === '检查分发')!.closest('form')!;
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(fixture.commands[0]).toMatchObject({ type: 'PREVIEW_SEED_PUBLICATION', expectedRevision: 41, payload: { parentRevision: 41 } });
  });
  it('clears the country URL and does not send a country filter to coverage', async () => {
    const container = await mount('/app/admin?module=seeds&view=library&country=DE&sourceKey=meta_ad_library');
    expect(fixture.queries.find(query => query.operation === 'page')?.args.country).toBe('DE');
    await clickText(container, '效果与覆盖');
    expect(container.querySelector('output')!.textContent).not.toContain('country=');
    expect(container.querySelector('output')!.textContent).toContain('sourceKey=meta_ad_library');
    expect(container.querySelector('input[name="country"]')).toBeNull();
    const coverage = fixture.queries.filter(query => query.operation === 'coverage').at(-1)!.args;
    expect(coverage).not.toHaveProperty('country'); expect(coverage.sourceKey).toBe('meta_ad_library');
    expect(coverage.from).toMatch(/T.*Z$/); expect(coverage.to).toMatch(/T.*Z$/);
  });
  it('cleans a direct coverage URL without changing the library country filter', async () => {
    const container = await mount('/app/admin?module=seeds&view=coverage&country=DE');
    expect(container.querySelector('output')!.textContent).not.toContain('country=');
    expect(fixture.queries.filter(query => query.operation === 'coverage').every(query => !Object.hasOwn(query.args, 'country'))).toBe(true);
    await clickText(container, '种子管理');
    expect(container.querySelector('input[name="country"]')).not.toBeNull();
    expect(seedAdminParams(new URLSearchParams('view=library'), { country: 'DE' }).get('country')).toBe('DE');
  });
  it('imports the code catalog as drafts without publishing or activating it', async () => {
    const container = await mount('/app/admin?module=seeds&view=rules');
    const button = [...container.querySelectorAll('button')].find(button => button.textContent === '导入代码主库为草稿');
    expect(button).toBeDefined(); const form = button!.closest('form')!;
    form.querySelector<HTMLInputElement>('input[name="reason"]')!.value = '迁入现有主库待审核';
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.commands[0]).toMatchObject({ type: 'IMPORT_STATIC_SEED_BASELINE', reason: '迁入现有主库待审核', payload: {} });
    expect(container.textContent).toContain('导入后逐项审核；不会自动启用或发布');
  });
  it('requires original same-source identity proof before exposing native verification', async () => {
    fixture.data.detail = { seed: { id: 'native', revision: 3, kind: 'NATIVE_ADVERTISER', rawValue: '123', namespace: 'meta_ad_library', language: 'und', status: 'DRAFT', verificationStatus: 'CANDIDATE', targetPlatforms: ['meta_ad_library'], targetScope: { kind: 'CONFIGURED_MARKETS' } }, evidence: [{ id: 'directory', originKind: 'DIRECTORY_ONLY', role: 'NAME_CLUE', rawValue: '123' }], relations: [], bindings: [], attempts: [] };
    expect(renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/app/admin?module=seeds&view=library&seedId=native'] }, createElement(SeedAdminModule)))).not.toContain('依据来源证据核验身份');
    fixture.data.detail = { ...(fixture.data.detail as Record<string, unknown>), evidence: [{ id: 'proof', originKind: 'ORIGINAL_SOURCE_IDENTITY', role: 'SOURCE_IDENTITY', rawValue: '123', runId: 'run', evidenceSha256: 'a'.repeat(64), source: { key: 'meta_ad_library' } }, { id: 'other-source', originKind: 'ORIGINAL_SOURCE_IDENTITY', role: 'SOURCE_IDENTITY', rawValue: '123', runId: 'run', evidenceSha256: 'b'.repeat(64), source: { key: 'google_ads_transparency' } }] };
    const container = await mount('/app/admin?module=seeds&view=library&seedId=native');
    const button = [...container.querySelectorAll('button')].find(button => button.textContent === '依据来源证据核验身份');
    expect(button).toBeDefined(); const form = button!.closest('form')!;
    form.querySelector<HTMLInputElement>('input[name="reason"]')!.value = '核对公开来源原生编号';
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(fixture.commands).toHaveLength(1);expect(fixture.commands[0]).toMatchObject({ type: 'VERIFY_NATIVE_SEED', targetId: 'native', expectedRevision: 3, payload: { evidenceIds: ['proof'] } });
  });
  it('drops a relation cursor when switching to newly discovered clues', async () => {
    const container = await mount('/app/admin?module=seeds&view=discovery&cursor=relation-cursor');
    await clickText(container, '发现线索');
    expect(container.querySelector('output')!.textContent).not.toContain('cursor=');
  });
  it('drops an audit cursor when switching to publication records', async () => {
    const container = await mount('/app/admin?module=seeds&view=rules&cursor=audit-cursor');
    await clickText(container, '发布历史');
    expect(container.querySelector('output')!.textContent).not.toContain('cursor=');
  });
  it('preserves entered draft text after the server reports a concurrent revision conflict', async () => {
    fixture.conflict = true; const container = await mount('/app/admin?module=seeds&view=library');
    const input = container.querySelector<HTMLInputElement>('input[name="rawValue"]')!; input.value = 'Coffee';
    const reason = container.querySelector<HTMLInputElement>('input[name="reason"]')!; reason.value = '证据核对';
    await act(async () => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(container.textContent).toContain('本次输入已保留'); expect(input.value).toBe('Coffee');
    expect([...container.querySelectorAll('button')].find(button => button.textContent === '保存草稿')!.disabled).toBe(false);
  });
  it('keeps an enabled seed enabled when saving an edited content revision', async () => {
    fixture.expectedStatus = 'ACTIVE'; fixture.data.detail = { seed: { id: 'seed', revision: 3, kind: 'NAME', rawValue: 'Existing Coffee', namespace: 'public', language: 'en', status: 'ACTIVE', targetPlatforms: ['meta_ad_library'], targetScope: { kind: 'CONFIGURED_MARKETS' } }, evidence: [], relations: [], bindings: [], attempts: [] };
    const container = await mount('/app/admin?module=seeds&view=library&seedId=seed');
    const form = container.querySelector('aside form')!; form.querySelector<HTMLInputElement>('input[name="reason"]')!.value = '更新名称';
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(container.textContent).toContain('已保存草稿。'); expect(container.textContent).not.toContain('内容未通过校验');
  });
  it('preserves an active scan plan status while editing its date policy', async () => {
    fixture.expectedStatus = 'ACTIVE'; fixture.data.rules = { capabilities: [], sourceControls: [], publications: [], scanPlans: [{ id: 'plan', revision: 4, sourceKey: 'pinterest_ads_repository', status: 'ACTIVE', targetScope: { kind: 'CONFIGURED_MARKETS' }, datePolicy: { kind: 'ROLLING', windowDays: 7 }, evidence: {} }] };
    const container = await mount('/app/admin?module=seeds&view=rules');
    const chooser = [...container.querySelectorAll('select')].find(select => select.options[0]?.text === '新建扫描草稿')!;
    await act(async () => { chooser.value = 'plan'; chooser.dispatchEvent(new Event('change', { bubbles: true })); });
    const form = container.querySelector('form.task-form')!; form.querySelector<HTMLInputElement>('input[name="reason"]')!.value = '核对滚动窗口';
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(container.textContent).toContain('已保存草稿。'); expect(container.textContent).not.toContain('内容未通过校验');
  });
  it('shows real publication differences and unsupported decisions before confirmation', async () => {
    fixture.result = { targetId: 'preview', diff: { newQueryKeys: ['a', 'b'], reusedQueryKeys: ['c'], disabledQueryKeys: [] }, decisions: [{ ownerId: 'draft-seed', sourceKey: 'tiktok_commercial_library', country: 'US', decision: 'UNSUPPORTED_MODE', reason: 'PUBLIC_NAME_CANNOT_SWEEP' }] };
    const container = await mount('/app/admin?module=seeds&view=rules');
    const form = [...container.querySelectorAll('button')].find(button => button.textContent === '检查分发')!.closest('form')!;
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(container.textContent).toContain('新增查询 2'); expect(container.textContent).toContain('复用查询 1'); expect(container.textContent).toContain('未启用查询 0');
    expect(container.textContent).toContain('检索方式不支持'); expect(container.textContent).toContain('PUBLIC_NAME_CANNOT_SWEEP'); expect(container.textContent).toContain('确认发布');
  });
});
