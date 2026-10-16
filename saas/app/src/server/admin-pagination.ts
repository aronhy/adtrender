import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type Entitlement } from '@prisma/client';
import { z } from 'zod';
import { DomainError, requirePlatformAdmin } from '../team/access';
import type { AdminCustomerView, AdminPageQuery, AdminPageResult } from '../client/types';
import { organizationSupportSelect, accountSupportSelect, organizationSupportView, accountSupportView } from './admin-support';

const inputSchema = z.object({
  kind: z.enum(['users', 'customers', 'tasks', 'runs', 'organizationFeedback', 'accountSupport', 'mediaFailures']),
  cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(20),
}).strict();
const cursorSchema = z.object({ v: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/), asOf: z.iso.datetime(), at: z.iso.datetime(), id: z.uuid() }).strict();
type Cursor = z.infer<typeof cursorSchema>;
const quotaKeys = ['WORKSPACES', 'MEMBERS', 'SAVED_ADS', 'ANALYSES'] as const;

function decodeCursor(encoded: string, scope: string): Cursor {
  try {
    if (encoded.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
    if (cursor.scope !== scope || Date.parse(cursor.at) > Date.parse(cursor.asOf) || Date.parse(cursor.asOf) > Date.now()) throw new Error();
    return cursor;
  } catch { throw new DomainError(400, 'INVALID_ADMIN_CURSOR'); }
}

/** Creation time stays stable when accounts, feedback, jobs or failed media are
 * updated. Changes to status filters remain live; this is not an MVCC snapshot
 * across requests. Every request rechecks the active platform administrator. */
export async function listAdminPage(db: PrismaClient, input: AdminPageQuery & { userId: string }): Promise<AdminPageResult> {
  const { userId, ...requested } = input;
  const parsed = inputSchema.safeParse(requested);
  if (!parsed.success) throw new DomainError(400, 'INVALID_ADMIN_QUERY');
  const { kind, limit } = parsed.data;
  return db.$transaction(async tx => {
    await requirePlatformAdmin(tx, userId);
    const scope = createHash('sha256').update(JSON.stringify({ userId, kind })).digest('hex');
    const cursor = parsed.data.cursor === undefined ? null : decodeCursor(parsed.data.cursor, scope);
    const asOf = cursor?.asOf ?? new Date().toISOString();
    const base = { createdAt: { lte: new Date(asOf) } };
    const boundary = cursor ? { OR: [{ createdAt: { lt: new Date(cursor.at) } }, { createdAt: new Date(cursor.at), id: { lt: cursor.id } }] } : {};
    const where = { ...base, ...boundary };
    const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
    const page = (rows: Array<{ id: string; createdAt: Date }>, total: number): AdminPageResult => {
      const last = rows[limit - 1];
      const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify({ v: 1, scope, asOf, at: last.createdAt.toISOString(), id: last.id } satisfies Cursor)).toString('base64url') : null;
      return { kind, total, asOf, nextCursor, users: [], customers: [], tasks: [], runs: [], feedback: [], mediaFailures: [] };
    };

    switch (kind) {
      case 'users': {
        const total = await tx.user.count({ where: base });
        const rows = await tx.user.findMany({ where, orderBy, take: limit + 1, select: { id: true, createdAt: true, email: true, disabledAt: true, isAdmin: true } });
        return { ...page(rows, total), users: rows.slice(0, limit).map(row => ({ id: row.id, email: row.email, disabledAt: row.disabledAt, isAdmin: row.isAdmin })) };
      }
      case 'customers': {
        const total = await tx.organization.count({ where: base });
        const rows = await tx.organization.findMany({ where, orderBy, take: limit + 1, select: {
          id: true, createdAt: true, name: true, status: true, _count: { select: { members: true } },
          subscription: { select: { status: true, currentPeriodStart: true, currentPeriodEnd: true, trialEndsAt: true, cancelAtPeriodEnd: true, planVersion: { select: { name: true } } } },
        } });
        const visible = rows.slice(0, limit);
        const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
        // Match billing/quotas.activeEntitlement exactly: database clock, inclusive
        // start/exclusive end, newest effective period. DISTINCT ON bounds history
        // to four rows per visible organization; future/expired rows are not quotas.
        const effective = visible.length ? await tx.$queryRaw<Array<Pick<Entitlement, 'organizationId' | 'key' | 'limit' | 'used' | 'reserved' | 'source' | 'periodStart' | 'periodEnd' | 'validFrom' | 'validUntil'>>>(Prisma.sql`
          SELECT DISTINCT ON ("organizationId", key) "organizationId", key, "limit", used, reserved, source, "periodStart", "periodEnd", "validFrom", "validUntil"
          FROM "Entitlement" WHERE "organizationId" IN (${Prisma.join(visible.map(row => row.id))})
          AND key IN (${Prisma.join(quotaKeys)}) AND "validFrom" <= ${clock.now}
          AND ("validUntil" IS NULL OR "validUntil" > ${clock.now})
          ORDER BY "organizationId", key, "periodStart" DESC
        `) : [];
        const customers: AdminCustomerView[] = visible.map(row => ({
          id: row.id, name: row.name, status: row.status, memberCount: row._count.members, planName: row.subscription?.planVersion.name ?? null,
          subscription: row.subscription ? { status: row.subscription.status, currentPeriodStart: row.subscription.currentPeriodStart, currentPeriodEnd: row.subscription.currentPeriodEnd, trialEndsAt: row.subscription.trialEndsAt, cancelAtPeriodEnd: row.subscription.cancelAtPeriodEnd } : null,
          quotaCheckedAt: clock.now,
          entitlements: quotaKeys.map(key => {
            const current = effective.find(item => item.organizationId === row.id && item.key === key);
            return { key, current: current ? { limit: current.limit, used: current.used, reserved: current.reserved, source: current.source === 'MANUAL' ? 'MANUAL' : current.source === 'PLAN' ? 'PLAN' : current.source === 'STRIPE' ? 'STRIPE' : 'UNKNOWN', periodStart: current.periodStart, periodEnd: current.periodEnd, validFrom: current.validFrom, validUntil: current.validUntil } : null };
          }),
        }));
        return { ...page(rows, total), customers };
      }
      case 'tasks': {
        const total = await tx.collectionTask.count({ where: base });
        const rows = await tx.collectionTask.findMany({ where, orderBy, take: limit + 1 });
        return { ...page(rows, total), tasks: rows.slice(0, limit).map(row => {
          const query = row.query as Record<string, unknown>;
          return { id: row.id, name: row.name, dataSourceId: row.dataSourceId, status: row.status, query: typeof query.keyword === 'string' ? query.keyword : '', country: typeof query.country === 'string' ? query.country : 'ALL', intervalMinutes: row.scheduleCron ? Number(row.scheduleCron.match(/\d+/)?.[0]) / 60 : null };
        }) };
      }
      case 'runs': {
        const total = await tx.collectionRun.count({ where: base });
        const rows = await tx.collectionRun.findMany({ where, orderBy, take: limit + 1, include: { task: { select: { name: true } } } });
        return { ...page(rows, total), runs: rows.slice(0, limit).map(row => ({ id: row.id, taskId: row.taskId, taskName: row.task.name, status: row.status, startedAt: row.startedAt, finishedAt: row.finishedAt, fetchedCount: row.fetchedCount, createdCount: row.insertedCount, updatedCount: row.updatedCount, coverage: (row.coverage as { outcome?: string })?.outcome ?? 'unknown', restrictedReason: row.restrictionReason, errorCode: row.errorCode })) };
      }
      case 'organizationFeedback': {
        const total = await tx.feedback.count({ where: base });
        const rows = await tx.feedback.findMany({ where, orderBy, take: limit + 1, select: organizationSupportSelect });
        return { ...page(rows, total), feedback: rows.slice(0, limit).map(organizationSupportView) };
      }
      case 'accountSupport': {
        const total = await tx.accountSupportRequest.count({ where: base });
        const rows = await tx.accountSupportRequest.findMany({ where, orderBy, take: limit + 1, select: accountSupportSelect });
        return { ...page(rows, total), feedback: rows.slice(0, limit).map(accountSupportView) };
      }
      case 'mediaFailures': {
        const total = await tx.mediaObject.count({ where: { ...base, status: 'FAILED' } });
        const rows = await tx.mediaObject.findMany({ where: { ...where, status: 'FAILED' }, orderBy, take: limit + 1, select: { id: true, createdAt: true, adId: true, errorCode: true } });
        return { ...page(rows, total), mediaFailures: rows.slice(0, limit).map(row => ({ id: row.id, adId: row.adId, errorCode: row.errorCode })) };
      }
    }
  }, { isolationLevel: 'RepeatableRead' });
}
