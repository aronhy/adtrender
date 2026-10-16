export type SeedAdminView = 'overview' | 'library' | 'discovery' | 'dispatch' | 'coverage' | 'rules';
export type SeedRow = Record<string, unknown>;
export type SeedStateInput = { publication?: SeedRow | null; receipts?: SeedRow[]; runtime?: SeedRow[]; attempts?: SeedRow[]; attributionQuality?: unknown };
export const seedAdminViews: Array<[SeedAdminView, string]> = [['overview', '总览'], ['library', '种子管理'], ['discovery', '发现与关系'], ['dispatch', '平台分发'], ['coverage', '效果与覆盖'], ['rules', '规则与记录']];
export const seedSources = [['meta_ad_library', 'Meta'], ['google_ads_transparency', 'Google / YouTube'], ['snapchat_ads_gallery', 'Snapchat'], ['tiktok_commercial_library', 'TikTok'], ['pinterest_ads_repository', 'Pinterest']] as const;
export function seedRow(value: unknown): SeedRow { return value && typeof value === 'object' && !Array.isArray(value) ? value as SeedRow : {}; }
export function seedRows(value: unknown): SeedRow[] { return Array.isArray(value) ? value.map(seedRow) : []; }
export function seedText(value: unknown, fallback = '未接入'): string { return typeof value === 'string' && value ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback; }
export function seedNumber(value: unknown): string { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value.toLocaleString('zh-CN') : '未接入'; }
export function parseSeedAdminView(params: URLSearchParams): SeedAdminView {
  const value = params.get('view'); return seedAdminViews.some(([key]) => key === value) ? value as SeedAdminView : 'overview';
}
export function seedAdminParams(params: URLSearchParams, changes: Record<string, string | null>, resetCursor = true): URLSearchParams {
  const next = new URLSearchParams(params); next.set('module', 'seeds');
  for (const [key, value] of Object.entries(changes)) { if (value) next.set(key, value); else next.delete(key); }
  if (resetCursor) next.delete('cursor');
  if (changes.view && changes.view !== params.get('view')) { next.delete('seedId'); next.delete('status'); next.delete('seedKind'); }
  if (next.get('view') === 'coverage') next.delete('country');
  return next;
}
export function seedStatusLabel(value: unknown): string {
  const labels: Record<string, string> = {
    DRAFT: '草稿', ACTIVE: '启用', PAUSED: '暂停', ARCHIVED: '已归档', MERGED: '已合并',
    CANDIDATE: '待核验', VERIFIED: '已核验', CONFLICT: '有冲突', REJECTED: '已拒绝', PENDING: '待核对', CONFIRMED: '已确认',
    PUBLISHED: '已发布', DOWNLOADED: '已下载', VALIDATED: '已校验', APPLIED: '已应用',
    QUEUED: '已排队', LEASED: '已领取', RUNNING: '执行中', STOP_REQUESTED: '等待停止确认', STOPPED: '已停止',
    COMMIT_PENDING: '等待提交入库', COMMITTED: '已确认入库', COMPLETED: '执行已完成',
    SUCCEEDED: '执行成功', PARTIAL: '部分结果', FAILED: '执行失败', NO_RESULTS: '可靠无结果', RELIABLE_NO_RESULTS: '可靠无结果', UNKNOWN_EMPTY: '未知空结果',
    IDENTITY_FOUND: '发现来源身份', RATE_LIMITED: '来源限流', RECOVERING: '恢复中', RECOVERY_BLOCKED: '恢复受阻',
    REGISTERED:'已登记', STANDBY_READY:'已核验待命', DISABLED:'已停用', EXPIRED:'已过期', STALE:'心跳失联', NO_HEARTBEAT:'尚无心跳', EXACT_QUERY:'查询精确归因',
    UNSUPPORTED_MODE: '检索方式不支持', UNVERIFIED_COUNTRY: '地域待验证', NEEDS_RESOLUTION: '等待核对',
    READY: '可用', DORMANT: '未启用', DRAINING: '退出中',
    UNREACHABLE: '失联', DIRECTORY_ONLY: '仅历史目录',
    LEGACY_QUEUE: '旧队列', CONFIG_QUEUE: '配置队列', TASK_CLAIM: '任务领取',
  };
  return typeof value === 'string' ? labels[value] ?? value : '未接入';
}
export function seedStateView(input: SeedStateInput): { publication: string; download: string; application: string; execution: string; completion: string; stop: string; attribution: string } {
  const publication = input.publication;
  const receipts = (input.receipts ?? []).filter(receipt => publication && (
    (typeof publication.id === 'string' && receipt.publicationId === publication.id)
    || (publication.revision !== undefined && receipt.publicationRevision === publication.revision)
  ));
  const downloaded = receipts.filter(receipt => ['DOWNLOADED', 'VALIDATED', 'APPLIED'].includes(String(receipt.applyStatus))).length;
  const applied = receipts.filter(receipt => receipt.applyStatus === 'APPLIED').length;
  const rejected = receipts.filter(receipt => receipt.applyStatus === 'REJECTED').length;
  const attempts = [...(input.attempts ?? [])].sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
  const latest = attempts[0]; const runtime = input.runtime ?? [];
  return {
    publication: publication ? `${seedStatusLabel(publication.status)}${publication.revision !== undefined ? ` · 版本 ${seedText(publication.revision)}` : ''}` : '尚未发布',
    download: downloaded ? `已下载回执 ${downloaded} 份` : '等待下载回执',
    application: applied || rejected ? `${applied ? `已应用回执 ${applied} 份` : '等待应用回执'}${rejected ? ` · 拒绝 ${rejected} 份` : ''}` : '等待应用回执',
    execution: latest ? seedStatusLabel(latest.state ?? latest.outcome ?? latest.status) : '尚无执行记录',
    completion: latest?.commitStatus === 'COMMITTED' ? '已确认入库' : '尚未确认入库',
    stop: runtime.some(row => row.executionState === 'STOP_REQUESTED') ? '等待停止确认' : runtime.some(row => row.executionState === 'STOPPED') ? '已有停止确认' : '尚无停止回执',
    attribution: ['UNATTRIBUTED', 'HISTORICAL_QUERY', 'LEGACY_UNATTRIBUTED'].includes(String(input.attributionQuality)) ? '历史种子归因缺失' : input.attributionQuality==='EXACT_QUERY'?'查询精确归因':seedText(input.attributionQuality, '归因未接入'),
  };
}
export function seedDateLabel(value: unknown): string {
  if (!(typeof value === 'string' || value instanceof Date)) return '未接入';
  const date = new Date(value); return Number.isFinite(date.valueOf()) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Hong_Kong', dateStyle: 'long', timeStyle: 'short' }).format(date) : '时间未知';
}
export function seedErrorLabel(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error ?? '');
  if (/REVISION|CONFLICT|409/.test(code)) return '记录已被其他管理员更新。本次输入已保留，请读取最新记录后核对再提交。';
  if (/PLATFORM_ADMIN|FORBIDDEN|AUTH_REQUIRED|ACCOUNT_DISABLED|403/.test(code)) return '需要有效的平台管理员权限，请重新登录或刷新账号状态。';
  if (/EXPIRED/.test(code)) return '预览或操作已过期，请重新校验。';
  if (/UNSUPPORTED|UNVERIFIED|NOT_CONFIGURED/.test(code)) return '此来源能力或执行器尚未接入，请查看平台分发原因。';
  if (/INVALID|VALIDATION|400/.test(code)) return '内容未通过校验，请检查类型、语言、地域和来源。';
  return '操作未完成，请重试；当前内容仍保留。';
}
export function seedLedgerWindow(from: string, to: string): { from: string; to: string } {
  if (![from, to].every(value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value) || from > to) throw new Error('INVALID_SEED_DATE_RANGE');
  return { from: new Date(`${from}T00:00:00+08:00`).toISOString(), to: new Date(new Date(`${to}T00:00:00+08:00`).getTime() + 86400000).toISOString() };
}
