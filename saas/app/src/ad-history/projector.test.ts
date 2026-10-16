import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backfillAdHistory, historyProjectionTick, rebuildAdHistory } from './projector';

const url = process.env.SAAS_TEST_DATABASE_URL;
const prefix = `history-${randomUUID()}`;
let db: any, other: any, source: any, task: any;
const ads: string[] = [];
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { release, promise }; }
async function ad() {
 const row = await db.ad.create({ data: { dataSourceId: source.id, sourceAdId: randomUUID(), sourceUrl: 'https://example.test/ad' } }); ads.push(row.id); return row.id;
}
async function observe(adId: string, observedAt = '2026-10-08T00:00:00Z', status = 'ACTIVE', client = db) {
 const run = await client.collectionRun.create({ data: { taskId: task.id, dataSourceId: source.id, idempotencyKey: randomUUID(), querySnapshot: { country: 'US', keyword: 'bags' }, adapterVersion: 'test' } });
 return client.adObservation.create({ data: { adId, dataSourceId: source.id, collectionRunId: run.id, observedAt: new Date(observedAt), sourceStatus: status, queryCountry: 'US', snapshot: { body: 'Archived text' }, parserVersion: 'test' } });
}
async function clearPending() { for (const id of ads) await db.$executeRaw`UPDATE "AdHistoryProjectionTask" SET "completedRevision"="revision" WHERE "adId"=${id}`; }
it.each([0, 1001, -1, 1.5, NaN])('rejects invalid history batch limit %s', async limit => {
 await expect(historyProjectionTick({} as any, { workerId: 'test', limit })).rejects.toThrow('INVALID_HISTORY_LIMIT');
 await expect(backfillAdHistory({} as any, { apply: false, adIds: [], limit })).rejects.toThrow('INVALID_HISTORY_LIMIT');
});

it('empty explicit queue scope never falls back to every ad', async () => {
 expect(await historyProjectionTick({} as any, { workerId: 'test', limit: 10, adIds: [] })).toEqual({ processed: 0, failed: 0 });
});
it.each([null, [''], Array(1001).fill('x')])('rejects malformed explicit queue scopes %#', async adIds => {
 await expect(historyProjectionTick({} as any, { workerId: 'test', limit: 10, adIds: adIds as any })).rejects.toThrow('INVALID_HISTORY_SCOPE');
});

describe.skipIf(!url)('history persistence with real PostgreSQL', () => {
 beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url } } }); other = new PrismaClient({ datasources: { db: { url } } });
  source = await db.dataSource.create({ data: { key: prefix, name: 'history test', adapterVersion: 'test' } });
  task = await db.collectionTask.create({ data: { dataSourceId: source.id, name: prefix, query: {} } });
 });
 afterAll(async () => {
  if (!db) return;
  for (const model of ['adHistoryEvent', 'adDailySnapshot', 'adHistoryProjectionTask', 'adObservation']) await db[model].deleteMany({ where: { adId: { in: ads } } });
  await db.adHistoryBackfillCursor.deleteMany({ where: { id: { startsWith: 'scope:' }, scopeAdIds: { hasSome: ads } } });
  await db.ad.deleteMany({ where: { id: { in: ads } } });
  await db.collectionRun.deleteMany({ where: { taskId: task.id } });
  await db.collectionTask.delete({ where: { id: task.id } }); await db.dataSource.delete({ where: { id: source.id } });
  await Promise.all([db.$disconnect(), other.$disconnect()]);
 });
 it('rolls back enqueue atomically with observation', async () => {
  const id = await ad();
  await expect(db.$transaction(async (tx: any) => { await observe(id, undefined, undefined, tx); throw new Error('ROLLBACK'); })).rejects.toThrow('ROLLBACK');
  expect(await db.adHistoryProjectionTask.findUnique({ where: { adId: id } })).toBeNull();
 });
 it('projects a transaction that began before an empty incremental tick and committed later', async () => {
  await clearPending(); const id = await ad(), inserted = gate(), release = gate();
  const pending = db.$transaction(async (tx: any) => { await observe(id, undefined, undefined, tx); inserted.release(); await release.promise; }, { timeout: 10000 });
  await inserted.promise;
  try { expect((await historyProjectionTick(other, { workerId: prefix, adIds: ads, limit: 10 })).processed).toBe(0); }
  finally { release.release(); await pending; }
  expect((await historyProjectionTick(other, { workerId: prefix, adIds: ads, limit: 10 })).processed).toBe(1);
 });
 it('replay is idempotent and late historical evidence corrects successor changes', async () => {
  const id = await ad(); const first = await observe(id, '2026-10-08T00:00:00Z', 'ACTIVE'); const last = await observe(id, '2026-10-10T00:00:00Z', 'INACTIVE');
  await rebuildAdHistory(db, id);
  const eventIds = (await db.adHistoryEvent.findMany({ where: { adId: id } })).map((e: any) => e.id);
  await rebuildAdHistory(db, id);
  expect((await db.adHistoryEvent.findMany({ where: { adId: id } })).map((e: any) => e.id)).toEqual(eventIds);
  expect(await db.adDailySnapshot.count({ where: { adId: id } })).toBe(2);
  const middle = await observe(id, '2026-10-09T00:00:00Z', 'INACTIVE');
  await rebuildAdHistory(db, id);
  expect((await db.adDailySnapshot.findMany({ where: { adId: id }, orderBy: { day: 'asc' } })).map((r: any) => r.day.toISOString().slice(0, 10))).toEqual(['2026-10-08', '2026-10-09', '2026-10-10']);
  const events = await db.adHistoryEvent.findMany({ where: { adId: id } });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: 'STATUS_CHANGED', beforeObservationId: first.id, afterObservationId: middle.id });
  expect(await db.adObservation.count({ where: { id: { in: [first.id, middle.id, last.id] } } })).toBe(3);
 });
 it('two workers produce one projection; expired leases are recovered', async () => {
  await clearPending(); const id = await ad(); await observe(id);
  const results = await Promise.all([db, other].map(client => historyProjectionTick(client, { workerId: randomUUID(), adIds: ads, limit: 1 })));
  expect(results.reduce((sum, value) => sum + value.processed, 0)).toBe(1);
  expect(await db.adDailySnapshot.count({ where: { adId: id } })).toBe(1);
  await observe(id, '2026-10-09T00:00:00Z');
  await db.adHistoryProjectionTask.update({ where: { adId: id }, data: { leaseOwner: 'dead-worker', leaseExpiresAt: new Date(0) } });
  expect((await historyProjectionTick(db, { workerId: prefix, adIds: ads, limit: 1 })).processed).toBe(1);
  expect(await db.adDailySnapshot.count({ where: { adId: id } })).toBe(2);
 });
 it('does not swallow a revision inserted while a worker is rebuilding', async () => {
  await clearPending(); const id = await ad(); await observe(id);
  const locked = gate(), release = gate();
  const holder = db.$transaction(async (tx: any) => { await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 811))::text`; locked.release(); await release.promise; }, { timeout: 10000 });
  await locked.promise;
  const tick = historyProjectionTick(other, { workerId: prefix, adIds: ads, limit: 1 });
  try {
   for (let i = 0; i < 100; i++) { if ((await db.adHistoryProjectionTask.findUnique({ where: { adId: id } })).leaseOwner) break; await new Promise(r => setTimeout(r, 10)); }
   await observe(id, '2026-10-09T00:00:00Z');
  } finally { release.release(); await holder; }
  expect((await tick).processed).toBe(1);
  const queued = await db.adHistoryProjectionTask.findUnique({ where: { adId: id } });
  expect(queued.revision).toBeGreaterThan(queued.completedRevision);
  expect((await historyProjectionTick(db, { workerId: prefix, adIds: ads, limit: 1 })).processed).toBe(1);
 });
 it('dry-run does not create projections or cursors and scoped apply resumes durably', async () => {
  const ids = [await ad(), await ad()].sort(); for (const id of ids) await observe(id);
  expect(await backfillAdHistory(db, { apply: false, adIds: ids, limit: 1 })).toMatchObject({ candidates: 1, rebuilt: 0 });
  expect(await db.adDailySnapshot.count({ where: { adId: { in: ids } } })).toBe(0);
  expect(await db.adHistoryBackfillCursor.count({ where: { scopeAdIds: { hasSome: ids } } })).toBe(0);
  expect(await backfillAdHistory(db, { apply: true, adIds: ids, limit: 1 })).toMatchObject({ candidates: 1, rebuilt: 1, cursor: ids[0] });
  expect(await backfillAdHistory(other, { apply: true, adIds: ids, limit: 1 })).toMatchObject({ candidates: 1, rebuilt: 1, cursor: ids[1] });
  expect(await backfillAdHistory(db, { apply: true, adIds: ids, limit: 1 })).toMatchObject({ candidates: 0, rebuilt: 0, cursor: null });
 });
 it('removes an orphanable queue task when an unprojected ad is removed', async () => {
  const id = await ad(); await observe(id);
  await db.adObservation.deleteMany({ where: { adId: id } });
  await db.ad.delete({ where: { id } });
  expect(await db.adHistoryProjectionTask.findUnique({ where: { adId: id } })).toBeNull();
 });
 it('replays more than one scan page without losing equal-timestamp observations', async () => {
  const id = await ad();
  const runIds = Array.from({ length: 501 }, () => randomUUID());
  await db.collectionRun.createMany({ data: runIds.map(runId => ({ id: runId, taskId: task.id, dataSourceId: source.id, idempotencyKey: runId, querySnapshot: { country: 'US', keyword: 'bags' }, adapterVersion: 'test' })) });
  await db.adObservation.createMany({ data: runIds.map(runId => ({ id: randomUUID(), adId: id, dataSourceId: source.id, collectionRunId: runId, observedAt: new Date('2026-10-08T00:00:00Z'), sourceStatus: 'ACTIVE', queryCountry: 'US', snapshot: {}, parserVersion: 'test' })) });
  await rebuildAdHistory(db, id);
  const days = await db.adDailySnapshot.findMany({ where: { adId: id } });
  expect(days).toHaveLength(1); expect(days[0].observationCount).toBe(501); expect(days[0].activeObservationCount).toBe(501); expect(days[0].inactiveObservationCount).toBe(0);
 });
 it('collector INSERT can enqueue but cannot write derived tables or call definer function', async () => {
  const id = await ad();
  const run = await db.collectionRun.create({ data: { taskId: task.id, dataSourceId: source.id, idempotencyKey: randomUUID(), querySnapshot: {}, adapterVersion: 'test' } });
  const role = `history_test_${randomUUID().replaceAll('-', '')}`;
  await expect(db.$transaction(async (tx: any) => {
   await tx.$executeRawUnsafe(`CREATE ROLE "${role}" NOLOGIN`);
   await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
   await tx.$executeRawUnsafe(`GRANT SELECT, INSERT ON "AdObservation" TO "${role}"`);
   await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
   const observationId = randomUUID();
   await tx.$executeRaw`INSERT INTO "AdObservation" (id,"adId","dataSourceId","collectionRunId","observedAt",snapshot,"parserVersion") VALUES (${observationId},${id},${source.id},${run.id},NOW(),'{}'::jsonb,'test')`;
   const [privileges] = await tx.$queryRaw`SELECT has_table_privilege(current_user, '"AdDailySnapshot"', 'INSERT') AS daily, has_table_privilege(current_user, '"AdHistoryProjectionTask"', 'UPDATE') AS queue, has_function_privilege(current_user, 'saas_enqueue_ad_history()', 'EXECUTE') AS function`;
   expect(privileges).toEqual({ daily: false, queue: false, function: false });
   await tx.$executeRawUnsafe('SAVEPOINT denied');
   await expect(tx.$executeRaw`DELETE FROM "AdHistoryEvent"`).rejects.toThrow();
   await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT denied');
   await tx.$executeRawUnsafe('RESET ROLE');
   expect((await tx.adHistoryProjectionTask.findUnique({ where: { adId: id } })).revision).toBe(1n);
   const [owner] = await tx.$queryRaw`SELECT has_table_privilege('saas_history_enqueue', '"User"', 'UPDATE') AS customer, has_table_privilege('saas_history_enqueue', '"AdDailySnapshot"', 'INSERT') AS daily, has_schema_privilege('saas_history_enqueue', 'public', 'CREATE') AS schema`;
   expect(owner).toEqual({ customer: false, daily: false, schema: false });
   throw new Error('ROLLBACK_TEST_ROLE');
  })).rejects.toThrow('ROLLBACK_TEST_ROLE');
 });
 it('rejects observations and projections with inconsistent source or ad', async () => {
  const a = await ad(), b = await ad(); const obs = await observe(a); await rebuildAdHistory(db, a);
  const day = await db.adDailySnapshot.findFirst({ where: { adId: a } });
  await expect(db.adDailySnapshot.update({ where: { id: day.id }, data: { adId: b } })).rejects.toThrow();
  await expect(db.adDailySnapshot.update({ where: { id: day.id }, data: { dataSourceId: 'missing-source' } })).rejects.toThrow();
  await expect(db.adHistoryEvent.create({ data: { adId: b, dataSourceId: source.id, beforeObservationId: obs.id, afterObservationId: obs.id, scopeHash: 'x', type: 'STATUS_CHANGED', observedAt: obs.observedAt } })).rejects.toThrow();
 });
});
