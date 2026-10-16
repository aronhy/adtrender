import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { verifiedSourceProfiles } from '@ad-research/contracts';
import { DomainError, requirePlatformAdmin } from '../team/access';

export type AdminAdsFilter = { sourceId?: string; dateFrom?: string; dateTo?: string };
export type AdminAdsPageQuery = AdminAdsFilter & { cursor?: string; limit?: number; status?: string; errorCode?: string; type?: string };
export type AdminAdsPage<T> = { rows: T[]; total: number; nextCursor: string | null; asOf: string };
export type AdminSourceStats = { id: string; key: string; name: string; adCount: number; advertiserCount: number; added24h: number; mediaReady: number; mediaTotal: number; lastImportedAt: Date | null };
export type AdminAdsStats = { asOf: Date; timezone: 'Asia/Hong_Kong'; range: { from: string; to: string }; kpis: { ads: number; advertisers: number; added24h: number; added7d: number; readyMedia: number }; sources: AdminSourceStats[]; daily: { date: string; count: number }[] };
export type AdminSourceRow = { id: string; key: string; name: string; status: string; adapterVersion: string; capabilities: string[]; lastSuccessfulAt: Date | null; lastErrorCode: string | null; retryAt: Date | null };
export type AdminRunRow = { id: string; sourceId: string; sourceName: string; sourceKey: string; taskId: string; taskName: string; isArchive: boolean; time: Date; startedAt: Date | null; status: string; outcomeLabel: string; querySummary: string; fetchedCount: number; insertedCount: number; updatedCount: number; errorCode: string | null; retryAt: Date | null; cancelRequestedAt: Date | null };
export type AdminRunItem = { id: string; sourceAdId: string | null; status: string; errorCode: string | null; parserVersion: string; evidenceReference: string | null };
export type AdminRunDetail = AdminRunRow & { querySnapshot: unknown; coverage: unknown; restrictionReason: string | null; evidenceReference: string | null; adapterVersion: string; items: AdminAdsPage<AdminRunItem> };
export type AdminMediaRow = { id: string; adId: string; advertiser: string | null; sourceAdId: string; sourceId: string; sourceName: string; type: string; status: string; lastErrorCode: string | null; attempts: number; retryable: boolean };
export type AdminMediaPage = AdminAdsPage<AdminMediaRow> & { states: { status: string; count: number }[] };

const filterSchema = z.object({ sourceId: z.uuid().optional(), dateFrom: z.iso.datetime().optional(), dateTo: z.iso.datetime().optional() }).strict();
const pageSchema = filterSchema.extend({ cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(100).default(20), status: z.string().regex(/^[A-Z_-]{1,50}$/).optional(), errorCode: z.string().regex(/^[A-Z0-9_:-]{1,120}$/).optional(), type: z.enum(['IMAGE', 'VIDEO']).optional() });
export function parseAdminAdsFilter(input: unknown) {
  const parsed = filterSchema.safeParse(input);
  if (!parsed.success) throw new DomainError(400, 'INVALID_ADMIN_ADS_QUERY');
  const to = parsed.data.dateTo ? new Date(parsed.data.dateTo) : new Date();
  const from = parsed.data.dateFrom ? new Date(parsed.data.dateFrom) : new Date(to.getTime() - 7 * 86400_000);
  if (from >= to || to.getTime() - from.getTime() > 366 * 86400_000) throw new DomainError(400, 'INVALID_ADMIN_ADS_QUERY');
  return { ...parsed.data, from, to };
}
function parsePage(input: unknown) { const result = pageSchema.safeParse(input); if (!result.success) throw new DomainError(400, 'INVALID_ADMIN_ADS_QUERY'); if (result.data.dateFrom || result.data.dateTo) parseAdminAdsFilter({ sourceId: result.data.sourceId, dateFrom: result.data.dateFrom, dateTo: result.data.dateTo }); return result.data; }
const cursorSchema = z.object({ scope: z.string().regex(/^[a-f0-9]{64}$/), asOf: z.iso.datetime(), at: z.iso.datetime(), id: z.uuid() }).strict();
type AdsCursor = z.infer<typeof cursorSchema>;
export const encodeAdminAdsCursor = (cursor: AdsCursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');
export function decodeAdminAdsCursor(encoded: string | undefined, scope: string): AdsCursor | null {
  if (!encoded) return null;
  try { if (encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error(); const cursor = cursorSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))); if (cursor.scope !== scope || Date.parse(cursor.asOf) > Date.now() || Date.parse(cursor.at) > Date.parse(cursor.asOf)) throw new Error(); return cursor; } catch { throw new DomainError(400, 'INVALID_ADMIN_ADS_CURSOR'); }
}
const pageScope = (userId: string, kind: string, input: Record<string, unknown>) => createHash('sha256').update(JSON.stringify({ userId, kind, ...input, cursor: undefined })).digest('hex');
const code = (value: string | null) => value && /^[A-Z0-9_:-]{1,120}$/.test(value) ? value : value ? 'REDACTED_ERROR' : null;
/** Snapshots remain useful for tracing, but every credential field and all URL
 * query/hash parameters are removed recursively, including nested signed URLs. */
export function redactAdminEvidence(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[内容过深，已省略]';
  if (typeof value === 'string') {
    const stripUrl = (raw: string) => { try { const url = new URL(raw); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); } catch { return '[链接已移除]'; } };
    return value.slice(0, 4000).replace(/https?:\/\/[^\s<>"']+/gi, stripUrl).replace(/(?:token|secret|password|credential|signature|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '[敏感参数已移除]');
  }

  if (Array.isArray(value)) return value.slice(0, 200).map(item => redactAdminEvidence(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|secret|password|credential|signature|authorization|cookie|api.?key|signed|headers|raw|requestbody/i.test(key)).slice(0, 200).map(([key, item]) => [key, redactAdminEvidence(item, depth + 1)]));
  return value;
}
export function classifyAdminRun(row: { status: string; coverage: unknown; errorCode: string | null }): string {
  const outcome = row.coverage && typeof row.coverage === 'object' ? (row.coverage as Record<string, unknown>).outcome : null;
  if (outcome === 'restricted' || /(^|_)(403|429)($|_)/.test(row.errorCode ?? '') || /CHALLENGE|LOGIN_REQUIRED|RATE_LIMIT/.test(row.errorCode ?? '')) return '受限';
  if (/TIMEOUT/.test(row.errorCode ?? '')) return '超时';
  if (row.status === 'SUCCEEDED' && outcome === 'no-results') return '无结果';
  return ({ SUCCEEDED: '成功', PARTIAL: '部分返回', FAILED: '失败', QUEUED: '等待', RUNNING: '运行中', CANCELED: '已取消' } as Record<string, string>)[row.status] ?? row.status;
}
const allowedMediaMime = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm'];
export function isPersistedAdminMedia(media: { status: string; type: string; storageKey: string | null; sizeBytes: bigint | null; sha256: string | null; mimeType: string | null; expiresAt: Date | null }, at: Date): boolean {
  return media.status === 'READY' && !!media.storageKey && /^public-media\/[A-Za-z0-9_.-]+$/.test(media.storageKey) && !!media.sizeBytes && media.sizeBytes > 0n && !!media.sha256 && /^[a-f0-9]{64}$/.test(media.sha256) && !!media.mimeType && allowedMediaMime.includes(media.mimeType) && media.mimeType.startsWith(media.type === 'IMAGE' ? 'image/' : media.type === 'VIDEO' ? 'video/' : 'unsupported/') && (!media.expiresAt || media.expiresAt > at);
}
const sqlUtcTimestamp = (at: Date) => Prisma.sql`${at.toISOString()}::timestamp`;
const readySql = (at: Date) => Prisma.sql`m.status='READY' AND m."storageKey" ~ '^public-media/[A-Za-z0-9_.-]+$' AND m."sizeBytes">0 AND m."sha256" ~ '^[a-f0-9]{64}$' AND ((m.type='IMAGE' AND m."mimeType" IN ('image/jpeg','image/png','image/gif','image/webp')) OR (m.type='VIDEO' AND m."mimeType" IN ('video/mp4','video/webm'))) AND (m."expiresAt" IS NULL OR m."expiresAt">${sqlUtcTimestamp(at)})`;
const effectiveMediaStatusSql = (at: Date) => Prisma.sql`CASE WHEN m.status='READY' AND NOT COALESCE((${readySql(at)}),FALSE) THEN 'UNAVAILABLE' ELSE m.status END`;
export function fillAdminAdsDays(rows: { date: string; count: number }[], from: Date, to: Date) {
  if (!rows.some(row => row.count > 0)) return [];
  const offset = 8 * 3600_000; const first = new Date(from.getTime() + offset); first.setUTCHours(0, 0, 0, 0); const last = new Date(to.getTime() - 1 + offset); last.setUTCHours(0, 0, 0, 0); const indexed = new Map(rows.map(row => [row.date, row.count])); const days: { date: string; count: number }[] = [];
  for (let at = first.getTime(); at <= last.getTime(); at += 86400_000) { const date = new Date(at).toISOString().slice(0, 10); days.push({ date, count: indexed.get(date) ?? 0 }); }
  return days;
}
export async function loadPlatformAdminAdsStats(db: PrismaClient, userId: string, input: AdminAdsFilter = {}): Promise<AdminAdsStats> {
  const filter = parseAdminAdsFilter(input);
  return db.$transaction(async tx => {
    await requirePlatformAdmin(tx, userId);
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const now = clock.now;
    const sourceFilter = filter.sourceId ? Prisma.sql`WHERE s.id=${filter.sourceId}` : Prisma.empty;
    const sources = await tx.$queryRaw<AdminSourceStats[]>(Prisma.sql`
      SELECT s.id,s.key,s.name,COALESCE(a.n,0)::int AS "adCount",COALESCE(v.n,0)::int AS "advertiserCount",COALESCE(a.h24,0)::int AS "added24h",COALESCE(m.ready,0)::int AS "mediaReady",COALESCE(m.n,0)::int AS "mediaTotal",a.latest AS "lastImportedAt"
      FROM "DataSource" s
      LEFT JOIN (SELECT "dataSourceId",COUNT(*) n,COUNT(*) FILTER (WHERE "createdAt">=${sqlUtcTimestamp(new Date(now.getTime() - 86400_000))}) h24,MAX("createdAt") latest FROM "Ad" WHERE "createdAt"<=${sqlUtcTimestamp(now)} GROUP BY "dataSourceId") a ON a."dataSourceId"=s.id
      LEFT JOIN (SELECT "dataSourceId",COUNT(*) n FROM "Advertiser" WHERE "createdAt"<=${sqlUtcTimestamp(now)} GROUP BY "dataSourceId") v ON v."dataSourceId"=s.id
      LEFT JOIN (SELECT a."dataSourceId",COUNT(*) n,COUNT(*) FILTER (WHERE ${readySql(now)}) ready FROM "MediaObject" m JOIN "Ad" a ON a.id=m."adId" WHERE m.type IN ('IMAGE','VIDEO') AND m."createdAt"<=${sqlUtcTimestamp(now)} GROUP BY a."dataSourceId") m ON m."dataSourceId"=s.id ${sourceFilter} ORDER BY COALESCE(a.n,0) DESC,s.key,s.id`);
    const added7d = await tx.ad.count({ where: { ...(filter.sourceId ? { dataSourceId: filter.sourceId } : {}), createdAt: { gte: new Date(now.getTime() - 7 * 86400_000), lte: now } } });
    const daily = await tx.$queryRaw<Array<{ date: string; count: number }>>(Prisma.sql`SELECT to_char("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Hong_Kong','YYYY-MM-DD') date,COUNT(*)::int count FROM "Ad" WHERE "createdAt">=${sqlUtcTimestamp(filter.from)} AND "createdAt"<${sqlUtcTimestamp(filter.to)} ${filter.sourceId ? Prisma.sql`AND "dataSourceId"=${filter.sourceId}` : Prisma.empty} GROUP BY 1 ORDER BY 1`);
    // Advertiser has a source-native unique identity; same name across sources is
    // deliberately never merged. Ad similarly has (dataSourceId,sourceAdId).
    return { asOf: now, timezone: 'Asia/Hong_Kong', range: { from: filter.from.toISOString(), to: filter.to.toISOString() }, kpis: { ads: sources.reduce((n, s) => n + s.adCount, 0), advertisers: sources.reduce((n, s) => n + s.advertiserCount, 0), added24h: sources.reduce((n, s) => n + s.added24h, 0), added7d, readyMedia: sources.reduce((n, s) => n + s.mediaReady, 0) }, sources, daily: fillAdminAdsDays(daily, filter.from, filter.to) };
  });
}
function pageMeta<T extends { id: string; createdAt: Date }>(rows: T[], total: number, limit: number, scope: string, asOf: string): AdminAdsPage<T> { const last = rows[limit - 1]; return { rows: rows.slice(0, limit), total, asOf, nextCursor: rows.length > limit && last ? encodeAdminAdsCursor({ scope, asOf, at: last.createdAt.toISOString(), id: last.id }) : null }; }
const createdBoundary = (cursor: AdsCursor | null) => cursor ? { OR: [{ createdAt: { lt: new Date(cursor.at) } }, { createdAt: new Date(cursor.at), id: { lt: cursor.id } }] } : {};
export async function listPlatformAdminSources(db: PrismaClient, userId: string, input: AdminAdsPageQuery = {}): Promise<AdminAdsPage<AdminSourceRow>> {
  const parsed = parsePage(input);
  return db.$transaction(async tx => {
    await requirePlatformAdmin(tx, userId); const scope = pageScope(userId, 'sources', parsed); const cursor = decodeAdminAdsCursor(parsed.cursor, scope); const asOf = cursor?.asOf ?? new Date().toISOString();
    const base = { createdAt: { lte: new Date(asOf) }, ...(parsed.sourceId ? { id: parsed.sourceId } : {}), ...(parsed.status ? { status: parsed.status } : {}) };
    const rows = await tx.dataSource.findMany({ where: { ...base, ...createdBoundary(cursor) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: parsed.limit + 1, select: { id: true, createdAt: true, key: true, name: true, status: true, adapterVersion: true, capabilities: true, lastSuccessfulAt: true, lastErrorCode: true } });
    const total = await tx.dataSource.count({ where: base });
    const recent = rows.length ? await tx.collectionRun.findMany({ where: { dataSourceId: { in: rows.map(r => r.id) }, nextAttemptAt: { gt: new Date() } }, distinct: ['dataSourceId'], orderBy: [{ dataSourceId: 'asc' }, { nextAttemptAt: 'desc' }], select: { dataSourceId: true, nextAttemptAt: true, coverage: true, errorCode: true, status: true } }) : [];
    const meta = pageMeta(rows, total, parsed.limit, scope, asOf);
    return { ...meta, rows: meta.rows.map(row => ({ id: row.id, key: row.key, name: row.name, status: row.status, adapterVersion: row.adapterVersion, capabilities: verifiedSourceProfiles(row).map(p => `${p.query.keyword} · ${p.query.country} · ${p.query.mediaType} · 最多 ${p.query.limit} 条 · 有效至 ${p.expiresAt}`), lastSuccessfulAt: row.lastSuccessfulAt, lastErrorCode: code(row.lastErrorCode), retryAt: recent.find(run => run.dataSourceId === row.id && classifyAdminRun(run) === '受限')?.nextAttemptAt ?? null })) };
  });
}
const runProjection = (r: { id: string; dataSourceId: string; createdAt: Date; queuedAt: Date; startedAt: Date | null; taskId: string; status: string; coverage: unknown; querySnapshot: unknown; adapterVersion: string; fetchedCount: number; insertedCount: number; updatedCount: number; errorCode: string | null; nextAttemptAt: Date | null; cancelRequestedAt: Date | null; task: { name: string; createdByUserId: string | null; dataSource: { name: string; key: string } } }): AdminRunRow => {
  const query = redactAdminEvidence(r.querySnapshot) as Record<string, unknown> | null;
  const summary = query && typeof query === 'object' ? ['country', 'language', 'keyword', 'pageId', 'payingAdvertiserName'].map(k => typeof query[k] === 'string' ? `${({ country: '查询国家', language: '语言', keyword: '关键词', pageId: '页面 ID', payingAdvertiserName: '广告主' } as Record<string, string>)[k]}：${query[k]}` : null).filter(Boolean).join(' · ') : '';
  // Native batch adapters and ingest keys are archive identity, never a queue.
  const isArchive = r.task.createdByUserId === null || /native|operator|archive/i.test(r.adapterVersion) || /native|archive/i.test(String(query?.origin ?? query?.kind ?? ''));
  return { id: r.id, sourceId: r.dataSourceId, sourceName: r.task.dataSource.name, sourceKey: r.task.dataSource.key, taskId: r.taskId, taskName: r.task.name, isArchive, time: r.startedAt ?? r.queuedAt, startedAt: r.startedAt, status: r.status, outcomeLabel: classifyAdminRun(r), querySummary: summary || '未记录可展示的查询摘要', fetchedCount: r.fetchedCount, insertedCount: r.insertedCount, updatedCount: r.updatedCount, errorCode: code(r.errorCode), retryAt: r.nextAttemptAt, cancelRequestedAt: r.cancelRequestedAt };
};
const runSelect = { id: true, dataSourceId: true, createdAt: true, queuedAt: true, startedAt: true, taskId: true, adapterVersion: true, status: true, coverage: true, querySnapshot: true, fetchedCount: true, insertedCount: true, updatedCount: true, errorCode: true, nextAttemptAt: true, cancelRequestedAt: true, task: { select: { name: true, createdByUserId: true, dataSource: { select: { name: true, key: true } } } } } satisfies Prisma.CollectionRunSelect;
export async function listPlatformAdminRuns(db: PrismaClient, userId: string, input: AdminAdsPageQuery = {}): Promise<AdminAdsPage<AdminRunRow>> {
  const parsed = parsePage(input);
  return db.$transaction(async tx => {
    await requirePlatformAdmin(tx, userId); const scope = pageScope(userId, 'runs', parsed); const cursor = decodeAdminAdsCursor(parsed.cursor, scope); const asOf = cursor?.asOf ?? new Date().toISOString();
    const constraints = [Prisma.sql`r."createdAt"<=${sqlUtcTimestamp(new Date(asOf))}`];
    if (parsed.sourceId) constraints.push(Prisma.sql`r."dataSourceId"=${parsed.sourceId}`); if (parsed.status) constraints.push(Prisma.sql`r.status=${parsed.status}`); if (parsed.errorCode) constraints.push(Prisma.sql`r."errorCode"=${parsed.errorCode}`);
    if (parsed.dateFrom) constraints.push(Prisma.sql`COALESCE(r."startedAt",r."queuedAt")>=${sqlUtcTimestamp(new Date(parsed.dateFrom))}`); if (parsed.dateTo) constraints.push(Prisma.sql`COALESCE(r."startedAt",r."queuedAt")<${sqlUtcTimestamp(new Date(parsed.dateTo))}`);
    const [count] = await tx.$queryRaw<Array<{ total: number }>>(Prisma.sql`SELECT COUNT(*)::int total FROM "CollectionRun" r WHERE ${Prisma.join(constraints, ' AND ')}`);
    if (cursor) constraints.push(Prisma.sql`(COALESCE(r."startedAt",r."queuedAt"),r.id)<(${sqlUtcTimestamp(new Date(cursor.at))},${cursor.id})`);
    const ordered = await tx.$queryRaw<Array<{ id: string; at: Date }>>(Prisma.sql`SELECT r.id,COALESCE(r."startedAt",r."queuedAt") AS at FROM "CollectionRun" r WHERE ${Prisma.join(constraints, ' AND ')} ORDER BY COALESCE(r."startedAt",r."queuedAt") DESC,r.id DESC LIMIT ${parsed.limit + 1}`);
    const rows = await tx.collectionRun.findMany({ where: { id: { in: ordered.slice(0, parsed.limit).map(r => r.id) } }, select: runSelect }); const byId = new Map(rows.map(row => [row.id, row])); const last = ordered[parsed.limit - 1];
    return { rows: ordered.slice(0, parsed.limit).flatMap(r => { const row = byId.get(r.id); return row ? [runProjection(row)] : []; }), total: count.total, asOf, nextCursor: ordered.length > parsed.limit && last ? encodeAdminAdsCursor({ scope, asOf, at: last.at.toISOString(), id: last.id }) : null };
  });
}
export async function loadPlatformAdminRunDetail(db: PrismaClient, userId: string, input: { runId: string; cursor?: string; limit?: number }): Promise<AdminRunDetail> {
  const requested = z.object({ runId: z.uuid(), cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(100).default(20) }).strict().safeParse(input);
  if (!requested.success) throw new DomainError(400, 'INVALID_ADMIN_ADS_QUERY'); const parsed = requested.data;
  return db.$transaction(async tx => {
    await requirePlatformAdmin(tx, userId); const row = await tx.collectionRun.findUnique({ where: { id: parsed.runId }, select: { ...runSelect, restrictionReason: true, evidenceReference: true, adapterVersion: true } }); if (!row) throw new DomainError(404, 'COLLECTION_RUN_NOT_FOUND');
    const scope = pageScope(userId, 'runItems', parsed); const cursor = decodeAdminAdsCursor(parsed.cursor, scope); const asOf = cursor?.asOf ?? new Date().toISOString(); const base = { runId: row.id, createdAt: { lte: new Date(asOf) } };
    const items = await tx.runItem.findMany({ where: { ...base, ...createdBoundary(cursor) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: parsed.limit + 1, select: { id: true, createdAt: true, sourceAdId: true, status: true, errorCode: true, parserVersion: true, evidenceReference: true } });
    const meta = pageMeta(items, await tx.runItem.count({ where: base }), parsed.limit, scope, asOf);
    return { ...runProjection(row), querySnapshot: redactAdminEvidence(row.querySnapshot), coverage: redactAdminEvidence(row.coverage), restrictionReason: row.restrictionReason ? String(redactAdminEvidence(row.restrictionReason)) : null, evidenceReference: row.evidenceReference ? String(redactAdminEvidence(row.evidenceReference)) : null, adapterVersion: row.adapterVersion, items: { ...meta, rows: meta.rows.map(r => ({ id: r.id, sourceAdId: r.sourceAdId, status: r.status, errorCode: code(r.errorCode), parserVersion: r.parserVersion, evidenceReference: r.evidenceReference ? String(redactAdminEvidence(r.evidenceReference)) : null })) } };
  });
}
export async function listPlatformAdminMedia(db: PrismaClient, userId: string, input: AdminAdsPageQuery = {}): Promise<AdminMediaPage> {
  const parsed = parsePage(input);
  return db.$transaction(async tx => {
    await requirePlatformAdmin(tx, userId); const scope = pageScope(userId, 'media', parsed); const cursor = decodeAdminAdsCursor(parsed.cursor, scope); const asOf = cursor?.asOf ?? new Date().toISOString(); const at = new Date(asOf);
    const constraints = [Prisma.sql`m."createdAt"<=${sqlUtcTimestamp(at)}`, Prisma.sql`m.type IN ('IMAGE','VIDEO')`];
    if (parsed.sourceId) constraints.push(Prisma.sql`a."dataSourceId"=${parsed.sourceId}`); if (parsed.type) constraints.push(Prisma.sql`m.type=${parsed.type}`);
    if (parsed.dateFrom) constraints.push(Prisma.sql`m."createdAt">=${sqlUtcTimestamp(new Date(parsed.dateFrom))}`); if (parsed.dateTo) constraints.push(Prisma.sql`m."createdAt"<${sqlUtcTimestamp(new Date(parsed.dateTo))}`);
    if (parsed.errorCode) constraints.push(Prisma.sql`m."errorCode"=${parsed.errorCode}`);
    const states = await tx.$queryRaw<Array<{ status: string; count: number }>>(Prisma.sql`SELECT ${effectiveMediaStatusSql(at)} status,COUNT(*)::int count FROM "MediaObject" m JOIN "Ad" a ON a.id=m."adId" WHERE ${Prisma.join(constraints, ' AND ')} GROUP BY 1 ORDER BY 2 DESC,1`);
    if (parsed.status) constraints.push(Prisma.sql`${effectiveMediaStatusSql(at)}=${parsed.status}`);
    const [count] = await tx.$queryRaw<Array<{ total: number }>>(Prisma.sql`SELECT COUNT(*)::int total FROM "MediaObject" m JOIN "Ad" a ON a.id=m."adId" WHERE ${Prisma.join(constraints, ' AND ')}`);
    if (cursor) constraints.push(Prisma.sql`(m."createdAt",m.id)<(${sqlUtcTimestamp(new Date(cursor.at))},${cursor.id})`);
    const ordered = await tx.$queryRaw<Array<{ id: string; createdAt: Date }>>(Prisma.sql`SELECT m.id,m."createdAt" FROM "MediaObject" m JOIN "Ad" a ON a.id=m."adId" WHERE ${Prisma.join(constraints, ' AND ')} ORDER BY m."createdAt" DESC,m.id DESC LIMIT ${parsed.limit + 1}`);
    const rows = await tx.mediaObject.findMany({ where: { id: { in: ordered.slice(0, parsed.limit).map(row => row.id) } }, select: { id: true, adId: true, type: true, status: true, errorCode: true, downloadAttempts: true, storageKey: true, mimeType: true, sizeBytes: true, sha256: true, expiresAt: true, ad: { select: { sourceAdId: true, dataSourceId: true, advertiser: { select: { name: true } }, dataSource: { select: { name: true } } } } } });
    const byId = new Map(rows.map(row => [row.id, row])); const last = ordered[parsed.limit - 1];
    return { total: count.total, asOf, nextCursor: ordered.length > parsed.limit && last ? encodeAdminAdsCursor({ scope, asOf, at: last.createdAt.toISOString(), id: last.id }) : null, states, rows: ordered.slice(0, parsed.limit).flatMap(item => { const r = byId.get(item.id); return r ? [{ id: r.id, adId: r.adId, advertiser: r.ad.advertiser?.name ?? null, sourceAdId: r.ad.sourceAdId, sourceId: r.ad.dataSourceId, sourceName: r.ad.dataSource.name, type: r.type, status: r.status === 'READY' && !isPersistedAdminMedia(r, at) ? 'UNAVAILABLE' : r.status, lastErrorCode: code(r.errorCode), attempts: r.downloadAttempts, retryable: r.status === 'FAILED' && r.storageKey === null }] : []; }) };
  });
}
export async function setPlatformAdminSourceStatusOn(db: PrismaClient, userId: string, input: { sourceId: string; status: 'ACTIVE' | 'PAUSED'; reason: string }) {
  const parsed = z.object({ sourceId: z.uuid(), status: z.enum(['ACTIVE', 'PAUSED']), reason: z.string().trim().min(1).max(500) }).strict().safeParse(input); if (!parsed.success) throw new DomainError(400, 'INVALID_ADMIN_ADS_ACTION');
  return db.$transaction(async tx => { await requirePlatformAdmin(tx, userId); const [source] = await tx.$queryRaw<Array<{ id: string; status: string; adapterVersion: string; capabilities: unknown }>>`SELECT id,status,"adapterVersion",capabilities FROM "DataSource" WHERE id=${parsed.data.sourceId} FOR UPDATE`; if (!source) throw new DomainError(404, 'SOURCE_NOT_FOUND'); if (parsed.data.status === 'ACTIVE' && !verifiedSourceProfiles(source).length) throw new DomainError(409, 'SOURCE_CAPABILITY_UNVERIFIED'); await tx.dataSource.update({ where: { id: source.id }, data: { status: parsed.data.status } }); await tx.auditEvent.create({ data: { actorUserId: userId, action: 'SOURCE_STATUS_CHANGED', targetType: 'DataSource', targetId: source.id, metadata: { from: source.status, status: parsed.data.status, reason: parsed.data.reason, scope: 'APPLICATION_TASKS_ONLY' } } }); return { message: '应用侧来源状态已更新。' }; });
}
export async function retryPlatformAdminMediaOn(db: PrismaClient, userId: string, input: { mediaIds: string[]; reason?: string }) {
  const parsed = z.object({ mediaIds: z.array(z.uuid()).min(1).max(50), reason: z.string().trim().max(500).optional() }).strict().safeParse(input); if (!parsed.success || !parsed.data.reason) throw new DomainError(400, 'INVALID_ADMIN_ADS_ACTION'); const ids = [...new Set(parsed.data.mediaIds)];
  return db.$transaction(async tx => {
    await requirePlatformAdmin(tx, userId);
    const before = await tx.$queryRaw<Array<{ id: string; status: string; type: string; storageKey: string | null; downloadAttempts: number; errorCode: string | null }>>(Prisma.sql`SELECT id,status,type,"storageKey","downloadAttempts","errorCode" FROM "MediaObject" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`);
    if (before.length !== ids.length || before.some(row => row.status !== 'FAILED' || row.storageKey !== null || !['IMAGE', 'VIDEO'].includes(row.type))) throw new DomainError(409, 'MEDIA_NOT_RETRYABLE');
    const changed = await tx.mediaObject.updateMany({ where: { id: { in: ids }, status: 'FAILED', storageKey: null, type: { in: ['IMAGE', 'VIDEO'] } }, data: { status: 'PENDING', errorCode: null, nextDownloadAttemptAt: null, lastDownloadAttemptAt: null, downloadAttempts: 0 } });
    if (changed.count !== ids.length) throw new DomainError(409, 'MEDIA_NOT_RETRYABLE');
    for (const prior of before) await tx.auditEvent.create({ data: { actorUserId: userId, action: 'MEDIA_REQUEUED', targetType: 'MediaObject', targetId: prior.id, metadata: { reason: parsed.data.reason, batchSize: ids.length, before: { status: prior.status, attempts: prior.downloadAttempts, errorCode: code(prior.errorCode) }, after: { status: 'PENDING', attempts: 0, errorCode: null } } } });
    return { count: changed.count, message: '素材已重新排队。' };
  });
}
