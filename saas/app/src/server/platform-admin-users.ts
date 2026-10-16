import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient, type Entitlement } from '@prisma/client';
import { z } from 'zod';
import { DomainError, lockAccountAdministration, requirePlatformAdmin } from '../team/access';
import { setUserDisabled } from '../team/admin';
import { activeEntitlement, lockOrganization, type QuotaKey } from '../billing/quotas';

export const adminQuotaKeys = ['WORKSPACES', 'MEMBERS', 'SAVED_ADS', 'ANALYSES'] as const;
type QuotaRecord = Pick<Entitlement, 'organizationId' | 'key' | 'limit' | 'used' | 'reserved' | 'source' | 'periodStart' | 'periodEnd' | 'validFrom' | 'validUntil'>;
export type AdminEntitlement = { key: QuotaKey; current: Omit<QuotaRecord, 'organizationId' | 'key'> | null };
export type PlatformAdminUserRow = { id: string; createdAt: Date; email: string | null; displayName: string | null; disabledAt: Date | null; isAdmin: boolean; emailVerified: boolean; organizationCount: number; lastActivityAt: Date | null };
export type PlatformAdminOrganizationRow = {
  id: string; name: string; status: string; createdAt: Date; memberCount: number; planName: string | null;
  subscription: { status: string; planVersion: number; currentPeriodStart: Date | null; currentPeriodEnd: Date | null; trialEndsAt: Date | null; cancelAtPeriodEnd: boolean } | null;
  quotaCheckedAt: Date; entitlements: AdminEntitlement[];
};
export type PlatformAdminUserDetail = PlatformAdminUserRow & {
  kind: 'USER'; savedCount: number; analysisCount: number; supportCount: number;
  organizations: Array<{ id: string; name: string; role: string; joinedAt: Date }>;
  supportRequests: Array<{ id: string; kind: string; subject: string | null; status: string; createdAt: Date; scope: 'ACCOUNT' | 'ORGANIZATION' }>;
};
export type PlatformAdminOrganizationDetail = PlatformAdminOrganizationRow & {
  kind: 'ORGANIZATION'; workspaceCount: number; savedCount: number; periodAnalysisCount: number | null; providerSubscriptionId: string | null;
  members: Array<{ id: string; displayName: string | null; email: string | null; organizationRole: string; workspaceRoles: Array<{ name: string; role: string }> }>;
  usageLedger: Array<{ id: string; createdAt: Date; key: string; quantity: number; status: string; releaseReason: string | null }>;
};
export type PlatformAdminUsersResult = {
  section: 'users' | 'organizations'; total: number; asOf: string; nextCursor: string | null;
  rows: PlatformAdminUserRow[] | PlatformAdminOrganizationRow[];
  chart: { label: string; points: Array<{ label: string; value: number }> };
  detail: PlatformAdminUserDetail | PlatformAdminOrganizationDetail | null;
};

const querySchema = z.object({
  section: z.enum(['users', 'organizations']).default('users'), search: z.string().trim().max(200).default(''),
  status: z.enum(['ALL', 'VERIFIED', 'UNVERIFIED', 'DISABLED', 'ACTIVE', 'ARCHIVED']).default('ALL'),
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(), cursor: z.string().max(2048).optional(), detailId: z.uuid().optional(),
}).strict().superRefine((value, context) => {
  if (value.from && value.to && (Date.parse(value.from) >= Date.parse(value.to) || Date.parse(value.to) - Date.parse(value.from) > 366 * 86_400_000)) context.addIssue({ code: 'custom', message: 'Invalid date range' });
  if (value.section === 'users' && ['ACTIVE', 'ARCHIVED'].includes(value.status) || value.section === 'organizations' && ['VERIFIED', 'UNVERIFIED', 'DISABLED'].includes(value.status)) context.addIssue({ code: 'custom', message: 'Invalid status for section' });
});
const cursorSchema = z.object({ v: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/), asOf: z.iso.datetime(), at: z.iso.datetime(), id: z.uuid() }).strict();
type Cursor = z.infer<typeof cursorSchema>;
type Query = z.infer<typeof querySchema>;
const reasonSchema = z.string().trim().min(1).max(500).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SET_ACCOUNT_STATUS'), targetUserId: z.uuid(), disabled: z.boolean(), reason: reasonSchema, confirmationEmail: z.string().max(254).optional() }).strict(),
  z.object({ type: z.literal('ADJUST_ENTITLEMENT'), organizationId: z.uuid(), key: z.enum(adminQuotaKeys), limit: z.number().int().min(0).max(1_000_000), reason: reasonSchema }).strict(),
]);
export type PlatformAdminUsersCommand = z.infer<typeof commandSchema>;

// Wasp owns providerData as text. Parse only on the server (including malformed
// legacy JSON), and return a boolean rather than authentication fields. Default
// pages read only visible identities; verification filters scan identities in
// the already narrowed search/date scope to preserve exact totals and cursors.
async function verifiedUsers(tx: Prisma.TransactionClient, where: Prisma.UserWhereInput): Promise<Set<string>> {
  const identities = await tx.authIdentity.findMany({ where: { providerName: { in: ['email', 'google'] }, auth: { user: where } }, select: { providerName: true, providerData: true, auth: { select: { userId: true, user: { select: { email: true } } } } } });
  const ids = new Set<string>();
  for (const identity of identities) {
    try {
      const value: unknown = JSON.parse(identity.providerData);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const data = value as Record<string, unknown>;
      const verified = identity.providerName === 'email' ? data.isEmailVerified === true : data.version === 1 && data.admitted === true && typeof identity.auth.user?.email === 'string' && data.verifiedEmail === identity.auth.user.email.toLowerCase();
      if (verified && identity.auth.userId) ids.add(identity.auth.userId);
    } catch { /* Corrupt/unadmitted identity is unverified, never a query error. */ }
  }
  return ids;
}
type UserRecord = Omit<PlatformAdminUserRow, 'organizationCount' | 'emailVerified'> & { organizationCount: bigint };
const userFields = Prisma.sql`u.id,u."createdAt",u.email,u."displayName",u."disabledAt",u."isAdmin",
  (SELECT COUNT(*) FROM "OrganizationMember" om WHERE om."userId"=u.id) AS "organizationCount",
  (SELECT MAX(pe."createdAt") FROM "ProductEvent" pe WHERE pe."userId"=u.id) AS "lastActivityAt"`;
function userDto(row: Omit<PlatformAdminUserRow, 'organizationCount'> & { organizationCount: number | bigint }): PlatformAdminUserRow {
  return { id: row.id, createdAt: row.createdAt, email: row.email, displayName: row.displayName, disabledAt: row.disabledAt, isAdmin: row.isAdmin, emailVerified: row.emailVerified, organizationCount: Number(row.organizationCount), lastActivityAt: row.lastActivityAt };
}
function cursorRead(encoded: string | undefined, scope: string, now: Date): Cursor | null {
  if (encoded === undefined) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const value = cursorSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
    if (value.scope !== scope || Date.parse(value.at) > Date.parse(value.asOf) || Date.parse(value.asOf) > now.getTime()) throw new Error();
    return value;
  } catch { throw new DomainError(400, 'INVALID_ADMIN_CURSOR'); }
}
function cursorNext(rows: Array<{ id: string; createdAt: Date }>, scope: string, asOf: string): string | null {
  const last = rows[19];
  return rows.length > 20 && last ? Buffer.from(JSON.stringify({ v: 1, scope, asOf, at: last.createdAt.toISOString(), id: last.id } satisfies Cursor)).toString('base64url') : null;
}
function userFilters(query: Query, asOf: Date, verification: Set<string> | null) {
  // Prisma binds JS Date as timestamptz; Wasp DateTime columns hold UTC wall
  // time without timezone. Explicit ISO::timestamp avoids session-zone drift.
  const filters: Prisma.Sql[] = [Prisma.sql`u."createdAt" <= ${asOf.toISOString()}::timestamp`];
  if (query.from) filters.push(Prisma.sql`u."createdAt" >= ${query.from}::timestamp`);
  if (query.to) filters.push(Prisma.sql`u."createdAt" < ${query.to}::timestamp`);
  if (query.search) {
    const like = `%${query.search.replace(/[\\%_]/g, '\\$&')}%`;
    filters.push(Prisma.sql`(u.email ILIKE ${like} OR u."displayName" ILIKE ${like})`);
  }
  if (query.status === 'VERIFIED') filters.push(Prisma.sql`u.id = ANY(${Array.from(verification ?? [])}::text[])`);
  if (query.status === 'UNVERIFIED') filters.push(Prisma.sql`NOT (u.id = ANY(${Array.from(verification ?? [])}::text[]))`);
  if (query.status === 'DISABLED') filters.push(Prisma.sql`u."disabledAt" IS NOT NULL`);
  return filters;
}
const organizationSelect = {
  id: true, name: true, status: true, createdAt: true, _count: { select: { members: true } },
  subscription: { select: { status: true, currentPeriodStart: true, currentPeriodEnd: true, trialEndsAt: true, cancelAtPeriodEnd: true, planVersion: { select: { name: true, version: true } } } },
} satisfies Prisma.OrganizationSelect;
type OrganizationRecord = Prisma.OrganizationGetPayload<{ select: typeof organizationSelect }>;
async function effectiveQuotas(tx: Prisma.TransactionClient, organizationIds: string[], now: Date): Promise<QuotaRecord[]> {
  if (!organizationIds.length) return [];
  // Same validity window and newest period as billing/quotas.activeEntitlement.
  return tx.$queryRaw<QuotaRecord[]>(Prisma.sql`
    SELECT DISTINCT ON ("organizationId",key) "organizationId",key,"limit",used,reserved,source,"periodStart","periodEnd","validFrom","validUntil"
    FROM "Entitlement" WHERE "organizationId" IN (${Prisma.join(organizationIds)}) AND key IN (${Prisma.join(adminQuotaKeys)})
    AND "validFrom" <= ${now.toISOString()}::timestamp AND ("validUntil" IS NULL OR "validUntil" > ${now.toISOString()}::timestamp)
    ORDER BY "organizationId",key,"periodStart" DESC
  `);
}
function organizationDto(row: OrganizationRecord, quotas: QuotaRecord[], now: Date): PlatformAdminOrganizationRow {
  return {
    id: row.id, name: row.name, status: row.status, createdAt: row.createdAt, memberCount: row._count.members, planName: row.subscription?.planVersion.name ?? null,
    subscription: row.subscription ? { status: row.subscription.status, planVersion: row.subscription.planVersion.version, currentPeriodStart: row.subscription.currentPeriodStart, currentPeriodEnd: row.subscription.currentPeriodEnd, trialEndsAt: row.subscription.trialEndsAt, cancelAtPeriodEnd: row.subscription.cancelAtPeriodEnd } : null,
    quotaCheckedAt: now, entitlements: adminQuotaKeys.map(key => {
      const current = quotas.find(item => item.organizationId === row.id && item.key === key);
      return { key, current: current ? { limit: current.limit, used: current.used, reserved: current.reserved, source: current.source, periodStart: current.periodStart, periodEnd: current.periodEnd, validFrom: current.validFrom, validUntil: current.validUntil } : null };
    }),
  };
}
async function userDetail(tx: Prisma.TransactionClient, id: string): Promise<PlatformAdminUserDetail> {
  const rows = await tx.$queryRaw<UserRecord[]>(Prisma.sql`SELECT ${userFields} FROM "User" u WHERE u.id=${id}`);
  if (!rows[0]) throw new DomainError(404, 'USER_NOT_FOUND');
  const [organizations, savedCount, analysisCount, accountSupportCount, feedbackCount, requests, feedback, verification] = await Promise.all([
    tx.organizationMember.findMany({ where: { userId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { role: true, createdAt: true, organization: { select: { id: true, name: true } } } }),
    tx.savedAd.count({ where: { savedByUserId: id } }), tx.analysisJob.count({ where: { requestedByUserId: id } }),
    tx.accountSupportRequest.count({ where: { userId: id } }), tx.feedback.count({ where: { userId: id } }),
    tx.accountSupportRequest.findMany({ where: { userId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20, select: { id: true, kind: true, status: true, createdAt: true } }),
    tx.feedback.findMany({ where: { userId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20, select: { id: true, category: true, subject: true, status: true, createdAt: true } }),
    verifiedUsers(tx, { id }),
  ]);
  return { ...userDto({ ...rows[0], emailVerified: verification.has(id) }), kind: 'USER', savedCount, analysisCount, supportCount: accountSupportCount + feedbackCount,
    organizations: organizations.map(item => ({ id: item.organization.id, name: item.organization.name, role: item.role, joinedAt: item.createdAt })),
    supportRequests: [...requests.map(item => ({ ...item, subject: null, scope: 'ACCOUNT' as const })), ...feedback.map(item => ({ id: item.id, kind: item.category, subject: item.subject, status: item.status, createdAt: item.createdAt, scope: 'ORGANIZATION' as const }))].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)).slice(0, 20),
  };
}
async function organizationDetail(tx: Prisma.TransactionClient, id: string, now: Date): Promise<PlatformAdminOrganizationDetail> {
  const row = await tx.organization.findUnique({ where: { id }, select: organizationSelect });
  if (!row) throw new DomainError(404, 'ORGANIZATION_NOT_FOUND');
  const quotas = await effectiveQuotas(tx, [id], now);
  const [workspaceCount, savedCount, members, usageLedger, subscription, periodAnalysisCount] = await Promise.all([
    tx.workspace.count({ where: { organizationId: id, archivedAt: null } }), tx.savedAd.count({ where: { organizationId: id } }),
    tx.organizationMember.findMany({ where: { organizationId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { userId: true, role: true, user: { select: { displayName: true, email: true } }, workspaces: { where: { workspace: { archivedAt: null } }, select: { role: true, workspace: { select: { name: true } } } } } }),
    tx.usageLedger.findMany({ where: { organizationId: id }, take: 20, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, createdAt: true, quantity: true, status: true, releaseReason: true, entitlement: { select: { key: true } } } }),
    tx.subscription.findUnique({ where: { organizationId: id }, select: { providerSubscriptionId: true } }),
    row.subscription?.currentPeriodStart && row.subscription.currentPeriodEnd ? tx.analysisJob.count({ where: { organizationId: id, createdAt: { gte: row.subscription.currentPeriodStart, lt: row.subscription.currentPeriodEnd } } }) : Promise.resolve(null),
  ]);
  return { ...organizationDto(row, quotas, now), kind: 'ORGANIZATION', workspaceCount, savedCount, periodAnalysisCount,
    providerSubscriptionId: subscription?.providerSubscriptionId ? subscription.providerSubscriptionId.length > 4 ? `••••${subscription.providerSubscriptionId.slice(-4)}` : '••••' : null,
    members: members.map(item => ({ id: item.userId, displayName: item.user.displayName, email: item.user.email, organizationRole: item.role, workspaceRoles: item.workspaces.map(workspace => ({ name: workspace.workspace.name, role: workspace.role })) })),
    usageLedger: usageLedger.map(item => ({ id: item.id, createdAt: item.createdAt, key: item.entitlement.key, quantity: item.quantity, status: item.status, releaseReason: item.releaseReason })),
  };
}

/** Stable creation-time cursors survive deleting an anchor. Filters and active
 * permissions remain live; asOf is not an MVCC snapshot across requests. */
export async function queryPlatformAdminUsers(db: PrismaClient, userId: string, input: unknown): Promise<PlatformAdminUsersResult> {
  const parsed = querySchema.safeParse(input);
  if (!parsed.success) throw new DomainError(400, 'INVALID_ADMIN_QUERY');
  const query = parsed.data;
  return db.$transaction(async tx => {
    await requirePlatformAdmin(tx, userId);
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const scope = createHash('sha256').update(JSON.stringify({ userId, section: query.section, search: query.search, status: query.status, from: query.from, to: query.to })).digest('hex');
    const cursor = cursorRead(query.cursor, scope, clock.now);
    const asOf = cursor?.asOf ?? clock.now.toISOString();
    const snapshotTime = new Date(asOf);
    const detail = query.detailId ? query.section === 'users' ? await userDetail(tx, query.detailId) : await organizationDetail(tx, query.detailId, clock.now) : null;
    if (query.section === 'users') {
      const verification = ['VERIFIED', 'UNVERIFIED'].includes(query.status) ? await verifiedUsers(tx, {
        createdAt: { lte: snapshotTime, ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lt: new Date(query.to) } : {}) },
        ...(query.search ? { OR: [{ email: { contains: query.search, mode: 'insensitive' } }, { displayName: { contains: query.search, mode: 'insensitive' } }] } : {}),
      }) : null;
      const filters = userFilters(query, snapshotTime, verification);
      const filteredWhere = Prisma.join(filters, ' AND ');
      const [totalRow] = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`SELECT COUNT(*) AS count FROM "User" u WHERE ${filteredWhere}`);
      if (cursor) filters.push(Prisma.sql`(u."createdAt" < ${cursor.at}::timestamp OR (u."createdAt"=${cursor.at}::timestamp AND u.id < ${cursor.id}))`);
      const rows = await tx.$queryRaw<UserRecord[]>(Prisma.sql`SELECT ${userFields} FROM "User" u WHERE ${Prisma.join(filters, ' AND ')} ORDER BY u."createdAt" DESC,u.id DESC LIMIT 21`);
      const visible = rows.slice(0, 20);
      const pageVerification = verification ?? (visible.length ? await verifiedUsers(tx, { id: { in: visible.map(row => row.id) } }) : new Set<string>());
      const chartStart = query.from ? new Date(query.from) : new Date(clock.now.getTime() - 7 * 86_400_000);
      const chartEnd = query.to ? new Date(query.to) : clock.now;
      const chart = await tx.$queryRaw<Array<{ label: string; value: bigint }>>(Prisma.sql`SELECT to_char(u."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Hong_Kong','YYYY-MM-DD') AS label,COUNT(*) AS value FROM "User" u WHERE ${filteredWhere} AND u."createdAt" >= ${chartStart.toISOString()}::timestamp AND u."createdAt" < ${chartEnd.toISOString()}::timestamp GROUP BY label ORDER BY label ASC`);
      return { section: query.section, total: Number(totalRow.count), asOf, nextCursor: cursorNext(rows, scope, asOf), rows: visible.map(row => userDto({ ...row, emailVerified: pageVerification.has(row.id) })), chart: { label: '新注册用户趋势', points: chart.map(point => ({ label: point.label, value: Number(point.value) })) }, detail };
    }
    const createdAt = { lte: snapshotTime, ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lt: new Date(query.to) } : {}) };
    const base: Prisma.OrganizationWhereInput = { createdAt, ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}), ...(query.status !== 'ALL' ? { status: query.status } : {}) };
    const where: Prisma.OrganizationWhereInput = cursor ? { AND: [base, { OR: [{ createdAt: { lt: new Date(cursor.at) } }, { createdAt: new Date(cursor.at), id: { lt: cursor.id } }] }] } : base;
    const [total, rows] = await Promise.all([tx.organization.count({ where: base }), tx.organization.findMany({ where, take: 21, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: organizationSelect })]);
    const quotas = await effectiveQuotas(tx, rows.slice(0, 20).map(row => row.id), clock.now);
    const chartFilters: Prisma.Sql[] = [Prisma.sql`o."createdAt" <= ${snapshotTime.toISOString()}::timestamp`];
    if (query.from) chartFilters.push(Prisma.sql`o."createdAt" >= ${query.from}::timestamp`);
    if (query.to) chartFilters.push(Prisma.sql`o."createdAt" < ${query.to}::timestamp`);
    if (query.search) chartFilters.push(Prisma.sql`o.name ILIKE ${`%${query.search.replace(/[\\%_]/g, '\\$&')}%`}`);
    if (query.status !== 'ALL') chartFilters.push(Prisma.sql`o.status=${query.status}`);
    const chart = await tx.$queryRaw<Array<{ label: string; value: bigint }>>(Prisma.sql`SELECT COALESCE(p.name,'未配置套餐') AS label,COUNT(*) AS value FROM "Organization" o LEFT JOIN "Subscription" s ON s."organizationId"=o.id LEFT JOIN "PlanVersion" p ON p.id=s."planVersionId" WHERE ${Prisma.join(chartFilters, ' AND ')} GROUP BY COALESCE(p.name,'未配置套餐') ORDER BY value DESC,label ASC`);
    return { section: query.section, total, asOf, nextCursor: cursorNext(rows, scope, asOf), rows: rows.slice(0, 20).map(row => organizationDto(row, quotas, clock.now)), chart: { label: '各套餐组织数', points: chart.map(point => ({ label: point.label, value: Number(point.value) })) }, detail };
  }, { isolationLevel: 'RepeatableRead', maxWait: 10_000, timeout: 20_000 });
}

export async function runPlatformAdminUsersCommand(db: PrismaClient, userId: string, input: unknown): Promise<{ message: string }> {
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) throw new DomainError(400, 'INVALID_ADMIN_COMMAND');
  const command = parsed.data;
  return db.$transaction(async tx => {
    if (command.type === 'SET_ACCOUNT_STATUS') {
      // Confirmation and existing owner/admin protection share a transaction.
      await lockAccountAdministration(tx);
      await requirePlatformAdmin(tx, userId);
      const target = await tx.user.findUnique({ where: { id: command.targetUserId }, select: { email: true } });
      if (!target) throw new DomainError(404, 'USER_NOT_FOUND');
      if (command.disabled && (!target.email || command.confirmationEmail !== target.email)) throw new DomainError(400, 'ACCOUNT_CONFIRMATION_MISMATCH');
      const transactionBridge = { $transaction: (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) => work(tx) } as unknown as PrismaClient;
      await setUserDisabled(transactionBridge, { actorUserId: userId, targetUserId: command.targetUserId, disabled: command.disabled, reason: command.reason.replace(/[\r\n\t]+/g, ' ') });
      return { message: command.disabled ? '账号已停用。下一次受保护请求即被拒绝。' : '账号已恢复。' };
    }
    await requirePlatformAdmin(tx, userId);
    await lockOrganization(tx, command.organizationId);
    const row = await activeEntitlement(tx, command.organizationId, command.key);
    await tx.entitlement.update({ where: { id: row.id }, data: { limit: command.limit, source: 'MANUAL', version: { increment: 1 } } });
    await tx.auditEvent.create({ data: { organizationId: command.organizationId, actorUserId: userId, action: 'ENTITLEMENT_ADJUSTED', targetType: 'Entitlement', targetId: row.id, metadata: { before: row.limit, after: command.limit, used: row.used, reserved: row.reserved, reason: command.reason } } });
    return { message: '权益已调整，已记录审计。' };
  }, { maxWait: 10_000, timeout: 20_000 });
}
