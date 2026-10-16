import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { assertVerifiedCollectionQuery, verifiedSourceProfiles, type CollectionQuery } from '@ad-research/contracts';
import { createCollectionQueue } from '../collection-admin/queue';
import { DomainError, requirePlatformAdmin } from '../team/access';
import { decodeAdminAdsCursor, encodeAdminAdsCursor, redactAdminEvidence, type AdminAdsPage } from './platform-admin-ads';

const reason = z.string().trim().min(1).max(500);
const common = { reason };
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('CREATE_TASK'), sourceId: z.uuid(), name: z.string().trim().min(1).max(100), query: z.unknown(), intervalMinutes: z.number().int().min(1).max(1440).nullable().default(null), ...common }).strict(),
  z.object({ type: z.literal('SET_TASK_STATUS'), taskId: z.uuid(), status: z.enum(['ACTIVE', 'PAUSED']), ...common }).strict(),
  z.object({ type: z.literal('ENQUEUE_TASK'), taskId: z.uuid(), idempotencyKey: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/), ...common }).strict(),
  z.object({ type: z.literal('CANCEL_RUN'), runId: z.uuid(), confirmationRunId: z.uuid(), ...common }).strict(),
]).refine(value => value.type !== 'CANCEL_RUN' || value.confirmationRunId === value.runId);
export type PlatformAdminTaskAction = z.input<typeof actionSchema>;
export function parsePlatformAdminTaskAction(input: unknown) { const parsed = actionSchema.safeParse(input); if (!parsed.success) throw new DomainError(400, 'INVALID_ADMIN_TASK_ACTION'); return parsed.data; }
export function assertApplicationTask(task: { createdByUserId: string | null; dataSource: { adapterVersion: string } }) { if (!task.createdByUserId || /native|operator/i.test(task.dataSource.adapterVersion)) throw new DomainError(409, 'ARCHIVE_CONTROL_FORBIDDEN'); }
export type ApplicationTaskRow = { id: string; name: string; sourceName: string; sourceId: string; status: string; query: CollectionQuery | null; intervalMinutes: number | null; activeRuns: { id: string; status: string; cancelRequestedAt: Date | null }[] };
export type ApplicationTaskPage = AdminAdsPage<ApplicationTaskRow> & { sources: { id: string; name: string; status: string; profiles: { id: string; query: CollectionQuery; expiresAt: string }[] }[] };
export async function listPlatformAdminTasks(db: PrismaClient, userId: string, input: { cursor?: string; limit?: number } = {}): Promise<ApplicationTaskPage> {
  const requested = z.object({ cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(100).default(20) }).strict().safeParse(input); if (!requested.success) throw new DomainError(400, 'INVALID_ADMIN_TASK_QUERY'); const parsed = requested.data;
  return db.$transaction(async tx => {
    await requirePlatformAdmin(tx, userId); const scope = createHash('sha256').update(JSON.stringify({ userId, kind: 'applicationTasks', limit: parsed.limit })).digest('hex'); const cursor = decodeAdminAdsCursor(parsed.cursor, scope); const asOf = cursor?.asOf ?? new Date().toISOString();
    const where: Prisma.CollectionTaskWhereInput = { createdByUserId: { not: null }, createdAt: { lte: new Date(asOf) }, NOT: [{ dataSource: { adapterVersion: { contains: 'native', mode: 'insensitive' } } }, { dataSource: { adapterVersion: { contains: 'operator', mode: 'insensitive' } } }] };
    const total = await tx.collectionTask.count({ where });
    const rows = await tx.collectionTask.findMany({ where: { ...where, ...(cursor ? { OR: [{ createdAt: { lt: new Date(cursor.at) } }, { createdAt: new Date(cursor.at), id: { lt: cursor.id } }] } : {}) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: parsed.limit + 1, select: { id: true, createdAt: true, name: true, dataSourceId: true, status: true, query: true, scheduleCron: true, dataSource: { select: { name: true } }, runs: { where: { status: { in: ['QUEUED', 'RUNNING'] } }, take: 5, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }], select: { id: true, status: true, cancelRequestedAt: true } } } });
    const sources = await tx.dataSource.findMany({ where: { NOT: [{ adapterVersion: { contains: 'native', mode: 'insensitive' } }, { adapterVersion: { contains: 'operator', mode: 'insensitive' } }] }, orderBy: [{ key: 'asc' }], select: { id: true, name: true, status: true, adapterVersion: true, capabilities: true } });
    const last = rows[parsed.limit - 1];
    return { total, asOf, nextCursor: rows.length > parsed.limit && last ? encodeAdminAdsCursor({ scope, asOf, at: last.createdAt.toISOString(), id: last.id }) : null, rows: rows.slice(0, parsed.limit).map(row => { const query = redactAdminEvidence(row.query) as CollectionQuery; return { id: row.id, name: row.name, sourceName: row.dataSource.name, sourceId: row.dataSourceId, status: row.status, query: query && typeof query.keyword === 'string' ? query : null, intervalMinutes: row.scheduleCron?.match(/^@every ([1-9]\d*)s$/) ? Number(row.scheduleCron.match(/\d+/)?.[0]) / 60 : null, activeRuns: row.runs }; }), sources: sources.map(source => ({ id: source.id, name: source.name, status: source.status, profiles: verifiedSourceProfiles(source).map(p => ({ id: p.id, query: p.query, expiresAt: p.expiresAt })) })) };
  });
}
/** The established queue retains capability checks, source/task locks, lease and
 * cancellation semantics. Decorating its transaction adds the mandatory reason
 * and before/after audit in the SAME outer transaction, never as a later write. */
function queueInTransaction(tx: Prisma.TransactionClient, reason: string, before: Prisma.InputJsonValue, after: Prisma.InputJsonValue) {
  const decorated = new Proxy(tx, { get(target, key) {
    if (key === 'auditEvent') return { ...target.auditEvent, create: (args: Prisma.AuditEventCreateArgs) => target.auditEvent.create({ ...args, data: { ...args.data, metadata: { ...(args.data.metadata && typeof args.data.metadata === 'object' && !Array.isArray(args.data.metadata) ? args.data.metadata : {}), reason, before, after } } }) };
    return Reflect.get(target, key);
  } });
  const adapter = { $transaction: (operation: (db: Prisma.TransactionClient) => Promise<unknown>) => operation(decorated) } as unknown as PrismaClient;
  return createCollectionQueue(adapter);
}
export async function applyPlatformAdminTask(db: PrismaClient, userId: string, input: PlatformAdminTaskAction) {
  const parsed = parsePlatformAdminTaskAction(input);
  return db.$transaction(async tx => {
    await requirePlatformAdmin(tx, userId);
    if (parsed.type === 'CREATE_TASK') {
      const [source] = await tx.$queryRaw<Array<{ id: string; adapterVersion: string; capabilities: unknown }>>`SELECT id,"adapterVersion",capabilities FROM "DataSource" WHERE id=${parsed.sourceId} FOR SHARE`;
      if (!source) throw new DomainError(404, 'SOURCE_NOT_FOUND'); assertApplicationTask({ createdByUserId: userId, dataSource: source });
      let query: CollectionQuery; try { query = assertVerifiedCollectionQuery(source, parsed.query); } catch { throw new DomainError(409, 'SOURCE_CAPABILITY_UNVERIFIED'); }
      const task = await tx.collectionTask.create({ data: { dataSourceId: source.id, createdByUserId: userId, name: parsed.name, query: query as unknown as Prisma.InputJsonValue, status: 'PAUSED', maxItems: query.limit, scheduleCron: parsed.intervalMinutes ? `@every ${parsed.intervalMinutes * 60}s` : null, nextRunAt: parsed.intervalMinutes ? new Date(Date.now() + parsed.intervalMinutes * 60_000) : null } });
      await tx.auditEvent.create({ data: { actorUserId: userId, action: 'COLLECTION_TASK_CREATED', targetType: 'CollectionTask', targetId: task.id, metadata: { reason: parsed.reason, before: null, after: { sourceId: source.id, status: 'PAUSED', name: task.name, query: query as unknown as Prisma.InputJsonValue, intervalMinutes: parsed.intervalMinutes } } } }); return { id: task.id, message: '已保存为暂停任务；启用前将再次校验来源范围。' };
    }
    if (parsed.type === 'CANCEL_RUN') {
      const [run] = await tx.$queryRaw<Array<{ id: string; status: string; cancelRequestedAt: Date | null; createdByUserId: string | null; adapterVersion: string }>>`SELECT r.id,r.status,r."cancelRequestedAt",t."createdByUserId",s."adapterVersion" FROM "CollectionRun" r JOIN "CollectionTask" t ON t.id=r."taskId" JOIN "DataSource" s ON s.id=t."dataSourceId" WHERE r.id=${parsed.runId} FOR UPDATE OF r FOR SHARE OF t,s`;
      if (!run) throw new DomainError(404, 'COLLECTION_RUN_NOT_FOUND'); assertApplicationTask({ createdByUserId: run.createdByUserId, dataSource: run }); if (!['QUEUED', 'RUNNING'].includes(run.status)) throw new DomainError(409, 'COLLECTION_RUN_NOT_CANCELABLE');
      const queue = queueInTransaction(tx, parsed.reason, { status: run.status, cancelRequested: !!run.cancelRequestedAt }, { status: run.status === 'QUEUED' ? 'CANCELED' : 'RUNNING', cancelRequested: true, awaitingWorker: run.status === 'RUNNING' }); await queue.requestCancel(run.id, userId); return { message: run.status === 'RUNNING' ? '已请求取消，等待执行器确认。' : '排队批次已取消。' };
    }
    const [task] = await tx.$queryRaw<Array<{ id: string; status: string; createdByUserId: string | null; adapterVersion: string }>>`SELECT t.id,t.status,t."createdByUserId",s."adapterVersion" FROM "CollectionTask" t JOIN "DataSource" s ON s.id=t."dataSourceId" WHERE t.id=${parsed.taskId} FOR UPDATE OF t FOR SHARE OF s`;
    if (!task) throw new DomainError(404, 'COLLECTION_TASK_NOT_FOUND'); assertApplicationTask({ createdByUserId: task.createdByUserId, dataSource: task });
    if (parsed.type === 'SET_TASK_STATUS') { await queueInTransaction(tx, parsed.reason, { status: task.status }, { status: parsed.status }).setTaskStatus({ taskId: task.id, actorUserId: userId, status: parsed.status }); return { message: '应用侧任务计划状态已更新。' }; }
    const run = await queueInTransaction(tx, parsed.reason, { taskStatus: task.status }, { status: 'QUEUED' }).enqueue({ taskId: task.id, requestedByUserId: userId, idempotencyKey: parsed.idempotencyKey }); return { id: run.id, message: '应用侧抓取任务已排队。' };
  });
}
