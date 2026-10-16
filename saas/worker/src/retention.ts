import type { PrismaClient } from '@prisma/client';
import type { S3Storage } from '../../app/src/media/storage';

export type RetentionOptions = {
  signal?: AbortSignal;
  limit?: number;
  /** Optional operator/test scope; omitted in the hourly sweep. */
  scope?: { privateFileIds: string[]; mediaObjectIds: string[] };
};
const expirable = ['READY', 'PENDING', 'FAILED', 'EXPIRED'];

export type SecurityRetentionOptions = {
  signal?: AbortSignal;
  /** Maximum combined deletions across both tables, never over 1000. */
  limit?: number;
  /** Server-side operator/test scope only; never accept this from API input. */
  scope?: { rateLimitBucketIds: string[]; oauthCodeUseHashes: string[] };
};
/** Technical garbage collection, not the business/security audit retention
 * policy. Both records remain at least 24 hours beyond their protection window.
 * One database-clock snapshot and atomic statement preserve active records even
 * if the worker clock is wrong. Concurrent sweepers skip each other's locks. */
export async function purgeExpiredSecurityRecords(db: PrismaClient, options: SecurityRetentionOptions = {}) {
  const limit = options.limit ?? 1000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('INVALID_SECURITY_RETENTION_LIMIT');
  const scope = options.scope;
  if (scope !== undefined && (!scope || typeof scope !== 'object'
    || !Array.isArray(scope.rateLimitBucketIds) || !Array.isArray(scope.oauthCodeUseHashes)
    || scope.rateLimitBucketIds.length > 1000 || scope.oauthCodeUseHashes.length > 1000
    || scope.rateLimitBucketIds.some(value => typeof value !== 'string' || !value || value.length > 128)
    || scope.oauthCodeUseHashes.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)))) {
    throw new Error('INVALID_SECURITY_RETENTION_SCOPE');
  }
  if (options.signal?.aborted) return { status: 'CANCELED' as const, rateLimitBucketsDeleted: 0, oauthCodeUsesDeleted: 0, totalDeleted: 0 };
  const [counts] = await db.$queryRaw<Array<{ rateLimitBucketsDeleted: number; oauthCodeUsesDeleted: number }>>`
    WITH cutoff AS MATERIALIZED (
      SELECT (clock_timestamp() AT TIME ZONE 'UTC') - interval '24 hours' AS at
    ), rate_candidates AS MATERIALIZED (
      SELECT id, "expiresAt" FROM "RateLimitBucket"
      WHERE "expiresAt" <= (SELECT at FROM cutoff)
        AND (${scope === undefined} OR id = ANY(${scope?.rateLimitBucketIds ?? []}::text[]))
      ORDER BY "expiresAt", id LIMIT ${limit} FOR UPDATE SKIP LOCKED
    ), oauth_candidates AS MATERIALIZED (
      SELECT "tokenHash" AS id, "expiresAt" FROM "OAuthCodeUse"
      WHERE "expiresAt" <= (SELECT at FROM cutoff)
        AND (${scope === undefined} OR "tokenHash" = ANY(${scope?.oauthCodeUseHashes ?? []}::text[]))
      ORDER BY "expiresAt", "tokenHash" LIMIT ${limit} FOR UPDATE SKIP LOCKED
    ), batch AS MATERIALIZED (
      SELECT * FROM (
        SELECT 'rate' AS kind, id, "expiresAt" FROM rate_candidates
        UNION ALL
        SELECT 'oauth' AS kind, id, "expiresAt" FROM oauth_candidates
      ) candidates ORDER BY "expiresAt", kind, id LIMIT ${limit}
    ), deleted_rate AS (
      DELETE FROM "RateLimitBucket" r USING batch b
      WHERE b.kind='rate' AND r.id=b.id AND r."expiresAt" <= (SELECT at FROM cutoff)
      RETURNING 1
    ), deleted_oauth AS (
      DELETE FROM "OAuthCodeUse" o USING batch b
      WHERE b.kind='oauth' AND o."tokenHash"=b.id AND o."expiresAt" <= (SELECT at FROM cutoff)
      RETURNING 1
    )
    SELECT (SELECT count(*)::integer FROM deleted_rate) AS "rateLimitBucketsDeleted",
      (SELECT count(*)::integer FROM deleted_oauth) AS "oauthCodeUsesDeleted"
  `;
  return { status: 'COMPLETED' as const, ...counts, totalDeleted: counts.rateLimitBucketsDeleted + counts.oauthCodeUsesDeleted };
}

/** Only explicit expiry timestamps are acted on; rows remain as reference tombstones.
 * One object is locked through deletion, so concurrent workers skip it. Provider
 * deletion must be idempotent: a DB commit failure is retried on a later sweep. */
export async function expireStoredFiles(db: PrismaClient, storage?: Pick<S3Storage, 'delete'>, options: RetentionOptions = {}) {
  let deleted = 0, failed = 0;
  if (options.signal?.aborted) return { status: 'CANCELED', deleted, failed };
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_RETENTION_LIMIT');
  const expiresAt = { lte: new Date() }, status = { in: expirable };
  const privateFiles = await db.privateFile.findMany({ where: { expiresAt, status, ...(options.scope ? { id: { in: options.scope.privateFileIds } } : {}) }, select: { id: true }, take: limit, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }] });
  // Filter before LIMIT: permanent archives must not occupy every bounded
  // candidate slot and prevent cleanup of ordinary expired/uncommitted media.
  const mediaFiles = await db.$queryRaw<Array<{ id: string }>>`
    SELECT m.id FROM public."MediaObject" m
    WHERE m."expiresAt" <= ${expiresAt.lte} AND m.status IN ('READY','PENDING','FAILED','EXPIRED')
      AND (${options.scope === undefined} OR m.id=ANY(${options.scope?.mediaObjectIds ?? []}::text[]))
      AND NOT EXISTS (SELECT 1 FROM public."ArchiveMediaCapture" a WHERE a."objectKey"=m."storageKey")
    ORDER BY m."updatedAt" ASC, m.id ASC LIMIT ${limit}`;
  for (const kind of ['private', 'media'] as const) {
    for (const candidate of kind === 'private' ? privateFiles : mediaFiles) {
      if (options.signal?.aborted) return { status: 'CANCELED', deleted, failed };
      const result = await db.$transaction(async tx => {
        const rows = kind === 'private'
          ? await tx.$queryRaw<Array<{ id: string; storageKey: string | null }>>`SELECT id, "storageKey" FROM "PrivateFile" WHERE id=${candidate.id} AND "expiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AND status IN ('READY','PENDING','FAILED','EXPIRED') FOR UPDATE SKIP LOCKED`
          : await tx.$queryRaw<Array<{ id: string; storageKey: string | null }>>`SELECT id, "storageKey" FROM "MediaObject" WHERE id=${candidate.id} AND "expiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AND status IN ('READY','PENDING','FAILED','EXPIRED') FOR UPDATE SKIP LOCKED`;
        const row = rows[0];
        if (!row || options.signal?.aborted) return 'SKIPPED';
        if (kind === 'media' && row.storageKey) {
          // Recheck after locking: a completed download may have installed its
          // immutable capture after this sweep selected its candidates.
          const [capture] = await tx.$queryRaw<Array<{ archived: boolean }>>`
            SELECT EXISTS(SELECT 1 FROM public."ArchiveMediaCapture" WHERE "objectKey"=${row.storageKey}) AS archived`;
          if (capture?.archived) return 'SKIPPED';
        }
        if (kind === 'private') await tx.privateFile.update({ where: { id: row.id }, data: { status: 'EXPIRED' } });
        else await tx.mediaObject.update({ where: { id: row.id }, data: { status: 'EXPIRED' } });
        if (!storage || !row.storageKey) return 'EXPIRED';
        try { await storage.delete(row.storageKey); }
        catch {
          if (kind === 'media') await tx.mediaObject.update({ where: { id: row.id }, data: { errorCode: 'STORAGE_DELETE_FAILED' } });
          return 'FAILED';
        }
        // Even on shutdown, persist a completed deletion rather than claiming the object remains.
        if (kind === 'private') await tx.privateFile.update({ where: { id: row.id }, data: { status: 'DELETED' } });
        else await tx.mediaObject.update({ where: { id: row.id }, data: { status: 'DELETED', errorCode: null } });
        return 'DELETED';
      }, { maxWait: 5000, timeout: 15000 });
      if (result === 'DELETED') deleted++;
      if (result === 'FAILED') failed++;
    }
  }
  return { status: storage ? 'COMPLETED' : 'CONFIGURATION_REQUIRED', deleted, failed };
}
