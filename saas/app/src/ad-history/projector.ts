import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { normalizeHistoryFact, projectAdHistory } from './normalize';
import type { HistoryFact } from './types';

const PAGE_SIZE = 500;
// A single pathological ad cannot consume unbounded memory or hold a lease forever.
const MAX_OBSERVATIONS = 50_000;
const TRANSACTION_MS = 90_000;
type Database = Pick<PrismaClient, '$transaction' | '$queryRaw' | 'adHistoryProjectionTask' | 'adHistoryBackfillCursor' | 'ad'>;
type Tx = Prisma.TransactionClient;
function validLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('INVALID_HISTORY_LIMIT');
}
function validIds(ids: string[]) {
  if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 200)) throw new Error('INVALID_HISTORY_SCOPE');
}
function canceled(signal?: AbortSignal) { if (signal?.aborted) throw new Error('HISTORY_CANCELED'); }
function stableId(parts: string[]) { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }

async function rebuild(tx: Tx, adId: string, signal?: AbortSignal) {
  canceled(signal);
  // An advisory lock does not block ingestion's foreign-key lock on Ad. Never hold
  // the queue row while waiting for this lock: claim and acknowledgement are separate.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${adId}, 811))::text`;
  const ad = await tx.ad.findUniqueOrThrow({ where: { id: adId }, select: { dataSourceId: true, dataSource: { select: { key: true } } } });
  const facts: HistoryFact[] = [];
  let cursor: { observedAt: Date; id: string } | undefined;
  while (true) {
    canceled(signal);
    const observations = await tx.adObservation.findMany({
      where: { adId, ...(cursor ? { OR: [{ observedAt: { gt: cursor.observedAt } }, { observedAt: cursor.observedAt, id: { gt: cursor.id } }] } : {}) },
      orderBy: [{ observedAt: 'asc' }, { id: 'asc' }], take: PAGE_SIZE,
      include: { run: true },
    });
    if (!observations.length) break;
    if (facts.length + observations.length > MAX_OBSERVATIONS) throw new Error('HISTORY_AD_OBSERVATION_LIMIT');
    // Never attach current media to old observations. Only immutable snapshot media
    // can establish historical hashes; today's mutable MediaObject is not evidence.
    for (const observation of observations) facts.push(normalizeHistoryFact({
      observation, run: { ...observation.run, sourceKey: ad.dataSource.key }, media: [],
    }));
    cursor = observations.at(-1)!;
  }
  const projected = projectAdHistory({ adId, facts });
  const scopes = new Map(facts.map(fact => [fact.scope.hash, fact.scope]));
  canceled(signal);
  await tx.adHistoryEvent.deleteMany({ where: { adId } });
  await tx.adDailySnapshot.deleteMany({ where: { adId } });
  for (let i = 0; i < projected.days.length; i += PAGE_SIZE) {
    canceled(signal);
    await tx.adDailySnapshot.createMany({ data: projected.days.slice(i, i + PAGE_SIZE).map(day => {
      const scope = scopes.get(day.scopeHash)!;
      return { id: stableId(['day', adId, day.day, day.timezone, day.scopeHash]), adId, dataSourceId: ad.dataSourceId,
        day: new Date(`${day.day}T00:00:00.000Z`), timezone: day.timezone, scopeHash: day.scopeHash,
        scopeKind: scope.kind, sourceKey: scope.sourceKey, queryCountry: scope.queryCountry, queryLanguage: scope.queryLanguage,
        observationCount: day.observationCount, activeObservationCount: day.activeObservationCount, inactiveObservationCount: day.inactiveObservationCount, firstObservedAt: day.firstObservedAt, lastObservedAt: day.lastObservedAt,
        latestObservationId: day.latestObservationId, latestSourceStatus: day.latestSourceStatus,
        hasStateConflict: day.hasStateConflict, contentKey: day.contentKey };
    }) });
  }
  for (let i = 0; i < projected.changes.length; i += PAGE_SIZE) {
    canceled(signal);
    await tx.adHistoryEvent.createMany({ data: projected.changes.slice(i, i + PAGE_SIZE).map(change => ({
      ...change, id: stableId(['event', adId, change.beforeObservationId, change.afterObservationId, change.type, change.scopeHash]),
      adId, dataSourceId: ad.dataSourceId,
    })) });
  }
}

/** Replaces one ad's derived state atomically, including successors of late evidence. */
export async function rebuildAdHistory(db: Database, adId: string, signal?: AbortSignal): Promise<void> {
  if (!adId || typeof adId !== 'string') throw new Error('INVALID_HISTORY_AD');
  await db.$transaction(tx => rebuild(tx, adId, signal), { timeout: TRANSACTION_MS, maxWait: 10_000 });
}

export async function historyProjectionTick(db: Database, input: { workerId: string; limit: number; adIds?: string[]; signal?: AbortSignal }): Promise<{ processed: number; failed: number }> {
  validLimit(input.limit);
  if (!input.workerId?.trim() || input.workerId.length > 200) throw new Error('INVALID_HISTORY_WORKER');
  if (input.adIds !== undefined) { validIds(input.adIds); if (!input.adIds.length) return { processed: 0, failed: 0 }; }
  let processed = 0, failed = 0;
  for (let i = 0; i < input.limit && !input.signal?.aborted; i++) {
    // One statement/autocommit: release the queue lock before the ad lock. Database
    // time owns leases; each claim has a fencing version even for reused worker IDs.
    const [claim] = await db.$queryRaw<Array<{ adId: string; revision: bigint; leaseVersion: number }>>`
      WITH candidate AS (
        SELECT "adId" FROM "AdHistoryProjectionTask"
        WHERE "revision" > "completedRevision" ${input.adIds ? Prisma.sql`AND "adId" IN (${Prisma.join(input.adIds)})` : Prisma.empty} AND "nextAttemptAt" <= clock_timestamp() AT TIME ZONE 'UTC'
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= clock_timestamp() AT TIME ZONE 'UTC')
        ORDER BY "nextAttemptAt", "adId" FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE "AdHistoryProjectionTask" t SET "leaseOwner"=${input.workerId}, "leaseVersion"=t."leaseVersion"+1,
        "leaseExpiresAt"=(clock_timestamp() AT TIME ZONE 'UTC') + interval '120 seconds', "attempts"=t."attempts"+1
      FROM candidate c WHERE t."adId"=c."adId" RETURNING t."adId", t."revision", t."leaseVersion"`;
    if (!claim) break;
    try {
      await rebuildAdHistory(db, claim.adId, input.signal);
      // A concurrent insert can raise revision while rebuild runs. Acknowledge only
      // the captured revision, leaving later evidence pending for another pass.
      await db.adHistoryProjectionTask.updateMany({ where: { adId: claim.adId, leaseOwner: input.workerId, leaseVersion: claim.leaseVersion },
        data: { completedRevision: claim.revision, leaseOwner: null, leaseExpiresAt: null, errorCode: null, attempts: 0 } });
      processed++;
    } catch (error) {
      failed++;
      const errorCode = error instanceof Error && ['HISTORY_CANCELED', 'HISTORY_AD_OBSERVATION_LIMIT'].includes(error.message) ? error.message : 'HISTORY_PROJECTION_FAILED';
      await db.$queryRaw`UPDATE "AdHistoryProjectionTask" SET "leaseOwner"=NULL,"leaseExpiresAt"=NULL,
        "errorCode"=${errorCode}, "nextAttemptAt"=(clock_timestamp() AT TIME ZONE 'UTC') + interval '60 seconds'
        WHERE "adId"=${claim.adId} AND "leaseOwner"=${input.workerId} AND "leaseVersion"=${claim.leaseVersion}`;
    }
  }
  return { processed, failed };
}

export async function backfillAdHistory(db: Database, input: { apply: boolean; adIds: string[]; limit: number; signal?: AbortSignal }): Promise<{ candidates: number; rebuilt: number; cursor: string | null }> {
  validLimit(input.limit);
  validIds(input.adIds);
  const ids = [...new Set(input.adIds)].sort();
  const key = `scope:${stableId(ids)}`;
  let candidates = 0, rebuilt = 0, cursor: string | null = null;
  if (!input.apply) {
    const saved = await db.adHistoryBackfillCursor.findUnique({ where: { id: key } });
    if (saved?.completed) return { candidates, rebuilt, cursor };
    const rows = await db.ad.findMany({ where: { ...(ids.length ? { id: { in: ids, ...(saved?.lastAdId ? { gt: saved.lastAdId } : {}) } } : saved?.lastAdId ? { id: { gt: saved.lastAdId } } : {}), observations: { some: {} } }, orderBy: { id: 'asc' }, take: input.limit, select: { id: true } });
    return { candidates: rows.length, rebuilt: 0, cursor: rows.at(-1)?.id ?? null };
  }
  // Persist one ad and its cursor atomically. Concurrent invocations serialize on
  // this scope; a crash rolls back both, and a restart resumes the next ad.
  for (let i = 0; i < input.limit && !input.signal?.aborted; i++) {
    const next = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 812))::text`;
      const saved = await tx.adHistoryBackfillCursor.upsert({ where: { id: key }, create: { id: key, scopeAdIds: ids }, update: {} });
      if (saved.completed) return null;
      const row = await tx.ad.findFirst({ where: { id: { ...(ids.length ? { in: ids } : {}), ...(saved.lastAdId ? { gt: saved.lastAdId } : {}) }, observations: { some: {} } }, orderBy: { id: 'asc' }, select: { id: true } });
      if (!row) { await tx.adHistoryBackfillCursor.update({ where: { id: key }, data: { completed: true } }); return null; }
      await rebuild(tx, row.id, input.signal);
      await tx.adHistoryBackfillCursor.update({ where: { id: key }, data: { lastAdId: row.id } });
      return row.id;
    }, { timeout: TRANSACTION_MS, maxWait: 10_000 });
    if (!next) { cursor = null; break; }
    candidates++; rebuilt++; cursor = next;
  }
  return { candidates, rebuilt, cursor };
}
