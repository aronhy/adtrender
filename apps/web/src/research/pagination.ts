import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { DomainError, requireWorkspaceRole } from '../team/access';

export type ResearchPageInput = { userId: string; workspaceId: string; kind: 'saved' | 'analysis'; folderId?: string; cursor?: string; limit?: number };
const requestSchema = z.object({ workspaceId: z.uuid(), kind: z.enum(['saved', 'analysis']), folderId: z.uuid().optional(), cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) }).strict();
const cursorSchema = z.object({ v: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/), asOf: z.iso.datetime(), at: z.iso.datetime(), id: z.uuid() }).strict();
type Cursor = z.infer<typeof cursorSchema>;
function decodeCursor(value: string, scope: string): Cursor {
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    if (cursor.scope !== scope || Date.parse(cursor.at) > Date.parse(cursor.asOf) || Date.parse(cursor.asOf) > Date.now()) throw new Error();
    return cursor;
  } catch { throw new DomainError(400, 'INVALID_RESEARCH_CURSOR'); }
}

/** Bounded keyset pages. Newly created rows are excluded until refresh; folder
 * changes and deletions remain live, so this is not a cross-request MVCC snapshot. */
export async function listResearchPage(db: PrismaClient, input: ResearchPageInput) {
  const { userId, ...requested } = input;
  const parsed = requestSchema.safeParse(requested);
  if (!parsed.success || (parsed.data.kind === 'analysis' && parsed.data.folderId)) throw new DomainError(400, 'INVALID_RESEARCH_QUERY');
  const filters = parsed.data;
  return db.$transaction(async tx => {
    const access = await requireWorkspaceRole(tx, userId, filters.workspaceId);
    const scope = { organizationId: access.organization.id, workspaceId: filters.workspaceId };
    if (filters.folderId && !await tx.folder.findFirst({ where: { ...scope, id: filters.folderId }, select: { id: true } })) throw new DomainError(404, 'FOLDER_NOT_FOUND');
    const fingerprint = createHash('sha256').update(JSON.stringify({ ...scope, kind: filters.kind, folderId: filters.folderId ?? null })).digest('hex');
    const cursor = filters.cursor === undefined ? null : decodeCursor(filters.cursor, fingerprint);
    const asOf = cursor?.asOf ?? new Date().toISOString();
    const base = { ...scope, createdAt: { lte: new Date(asOf) } };
    const boundary = cursor ? { OR: [{ createdAt: { lt: new Date(cursor.at) } }, { createdAt: new Date(cursor.at), id: { lt: cursor.id } }] } : {};
    const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
    const next = (rows: Array<{ id: string; createdAt: Date }>) => {
      const last = rows[filters.limit - 1];
      return rows.length > filters.limit && last ? Buffer.from(JSON.stringify({ v: 1, scope: fingerprint, asOf, at: last.createdAt.toISOString(), id: last.id } satisfies Cursor)).toString('base64url') : null;
    };
    if (filters.kind === 'saved') {
      const where = { ...base, ...(filters.folderId ? { folderId: filters.folderId } : {}) };
      const total = await tx.savedAd.count({ where });
      const rows = await tx.savedAd.findMany({ where: { ...where, ...boundary }, orderBy, take: filters.limit + 1, include: { ad: { include: { advertiser: true } }, notes: { where: scope, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
      return { kind: 'saved' as const, total, asOf, nextCursor: next(rows), savedAds: rows.slice(0, filters.limit) };
    }
    const total = await tx.analysisJob.count({ where: base });
    const rows = await tx.analysisJob.findMany({ where: { ...base, ...boundary }, orderBy, take: filters.limit + 1, include: { ad: { include: { advertiser: true } }, results: { where: scope } } });
    return { kind: 'analysis' as const, total, asOf, nextCursor: next(rows), analyses: rows.slice(0, filters.limit) };
  }, { isolationLevel: 'RepeatableRead' });
}
