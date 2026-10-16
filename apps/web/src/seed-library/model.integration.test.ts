import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
const require = createRequire(new URL('../../package.json', import.meta.url));
const url = process.env.SAAS_TEST_DATABASE_URL;
let db: any;
beforeAll(async () => {
  if (!url) return;
  const target = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.includes('_test_')) throw new Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const { PrismaClient } = require('@prisma/client'); db = new PrismaClient({ datasources: { db: { url } } });
});
afterAll(async () => { await db?.$disconnect(); });
async function isolated(run: (tx: any, fixture: any) => Promise<void>) {
  const stop = new Error('TEST_ROLLBACK');
  try { await db.$transaction(async (tx: any) => {
    const suffix = randomUUID();
    const source = await tx.dataSource.create({ data: { key: 'seed-model-' + suffix, name: 'Synthetic seed model', adapterVersion: 'fixture' } });
    const qid = randomUUID();
    await tx.$executeRawUnsafe('INSERT INTO "SeedQuery" (id,"updatedAt","dataSourceId","sourceKey",channel,mode,"queryKey","queryKeyVersion","adapterVersion","capabilityVersion") VALUES ($1,now(),$2,$3,\'ATC\',\'SEARCH\',$4,\'seed-query-1\',\'fixture\',\'fixture-1\')', qid, source.id, source.key, 'a'.repeat(64));
    await run(tx, { source, qid }); throw stop;
  }); } catch (error) { if (error !== stop) throw error; }
}
async function rejectsConstraint(tx: any, sql: string, args: unknown[], expected: RegExp) {
  await tx.$executeRawUnsafe('SAVEPOINT constraint_probe');
  try { await expect(tx.$executeRawUnsafe(sql, ...args)).rejects.toThrow(expected); }
  finally { await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT constraint_probe'); await tx.$executeRawUnsafe('RELEASE SAVEPOINT constraint_probe'); }
}
describe.skipIf(!url)('seed dispatch model invariants in PostgreSQL', () => {
  it('deduplicates actual queries independently of their owners', () => isolated(async (tx, f) => {
    await rejectsConstraint(tx, 'INSERT INTO "SeedQuery" (id,"updatedAt","dataSourceId","sourceKey",channel,mode,"queryKey","queryKeyVersion","adapterVersion","capabilityVersion") SELECT $1,now(),"dataSourceId","sourceKey",channel,mode,"queryKey","queryKeyVersion","adapterVersion","capabilityVersion" FROM "SeedQuery" WHERE id=$2', [randomUUID(), f.qid], /unique|23505/i);
  }));
  it('enforces exactly one binding owner and keeps a shared query', () => isolated(async (tx, f) => {
    const insert = 'INSERT INTO "SeedQueryBinding" (id,"queryId","ownerKind","ownerRevision","validFromRevision","legacyOwnerKey") VALUES ($1,$2,\'LEGACY\',1,1,$3)';
    await tx.$executeRawUnsafe(insert, randomUUID(), f.qid, 'old-job-1'); await tx.$executeRawUnsafe(insert, randomUUID(), f.qid, 'old-job-2');
    await rejectsConstraint(tx, insert, [randomUUID(), f.qid, null], /seed_binding_owner|check|23514/i);
    await rejectsConstraint(tx, insert, [randomUUID(), f.qid, 'old-job-1'], /unique|23505/i);
  }));
  it('starts a new publication epoch for unchanged owner content after rollback', () => isolated(async (tx, f) => {
    const first = randomUUID();
    const sql = 'INSERT INTO "SeedQueryBinding" (id,"queryId","ownerKind","ownerRevision","validFromRevision","legacyOwnerKey") VALUES ($1,$2,\'LEGACY\',$3,$4,\'restored-owner\')';
    await tx.$executeRawUnsafe(sql, first, f.qid, 1, 1);
    await tx.$executeRawUnsafe('UPDATE "SeedQueryBinding" SET "validToRevision"=2 WHERE id=$1', first);
    await tx.$executeRawUnsafe(sql, randomUUID(), f.qid, 1, 2);
    await rejectsConstraint(tx, 'UPDATE "SeedQueryBinding" SET "validToRevision"=NULL WHERE id=$1', [first], /IMMUTABLE_SEED_BINDING_HISTORY/i);
    await rejectsConstraint(tx, sql, [randomUUID(), f.qid, 2, 3], /unique|23505/i);
    const rows = await tx.$queryRawUnsafe('SELECT "ownerRevision","validFromRevision","validToRevision" FROM "SeedQueryBinding" WHERE "queryId"=$1 ORDER BY "validFromRevision"', f.qid);
    expect(rows).toEqual([{ ownerRevision: 1, validFromRevision: 1, validToRevision: 2 }, { ownerRevision: 1, validFromRevision: 2, validToRevision: null }]);
  }));
  it('keeps publication and node receipt payloads immutable', () => isolated(async (tx) => {
    const publication = randomUUID(), node = 'seed-model-node-' + randomUUID();
    await tx.$executeRawUnsafe('INSERT INTO "SeedPublication" (id,revision,"manifestHash","configSnapshot",reason) VALUES ($1,900000,$2,\'{}\',\'Synthetic model test\')', publication, 'd'.repeat(64));
    await rejectsConstraint(tx, 'UPDATE "SeedPublication" SET "manifestHash"=$2 WHERE id=$1', [publication, 'e'.repeat(64)], /IMMUTABLE_SEED_PUBLICATION/i);
    await tx.$executeRawUnsafe('INSERT INTO "CollectorNode" ("nodeId","incarnationId","registryRevision","codeRevision") VALUES ($1,$2,1,\'fixture\')', node, randomUUID());
    const receipt = randomUUID(), incarnation = randomUUID();
    await tx.$executeRawUnsafe('INSERT INTO "SeedCollectorReceipt" (id,"nodeId","incarnationId",sequence,type,"payloadHash") VALUES ($1,$2,$3,1,\'APPLIED\',$4)', receipt, node, incarnation, 'f'.repeat(64));
    await rejectsConstraint(tx, 'UPDATE "SeedCollectorReceipt" SET payload=\'{"changed":true}\' WHERE id=$1', [receipt], /IMMUTABLE_SEED_RECEIPT/i);
  }));
  it('preserves immutable legacy mapping and source consistency', () => isolated(async (tx, f) => {
    const id = randomUUID();
    await tx.$executeRawUnsafe('INSERT INTO "LegacyJobMapping" (id,"sourceKey","dataSourceId","queryId","nativeJobId","legacyKeyVersion","initialCheckpointDigest") VALUES ($1,$2,$3,$4,\'legacy-1\',\'legacy-1\',$5)', id, f.source.key, f.source.id, f.qid, 'b'.repeat(64));
    await rejectsConstraint(tx, 'UPDATE "LegacyJobMapping" SET "nativeJobId"=\'changed\' WHERE id=$1', [id], /IMMUTABLE_LEGACY_MAPPING/i);
    await rejectsConstraint(tx, 'UPDATE "SeedQuery" SET "sourceKey"=\'other\' WHERE id=$1', [f.qid], /IMMUTABLE_SEED_QUERY|foreign key|23503/i);
  }));
  it('reserves only one execution slot including recovery and pending commits', () => isolated(async (tx, f) => {
    const sql = 'INSERT INTO "SeedExecutionTask" (id,"updatedAt","queryId","dataSourceId","sourceKey","cycleKey","workUnitKey",state,"publicationRevision","schedulePolicyVersion") VALUES ($1,now(),$2,$3,$4,$5,\'page-1\',$6,1,\'fixture\')';
    await tx.$executeRawUnsafe(sql, randomUUID(), f.qid, f.source.id, f.source.key, 'cycle-1', 'RECOVERING');
    await rejectsConstraint(tx, sql, [randomUUID(), f.qid, f.source.id, f.source.key, 'cycle-2', 'COMMIT_PENDING'], /unique|23505/i);
    await rejectsConstraint(tx, sql, [randomUUID(), f.qid, f.source.id, 'wrong-source', 'cycle-3', 'READY'], /foreign key|23503/i);
  }));
  it('rejects batch/run source mismatches while allowing unattributed old facts', () => isolated(async (tx, f) => {
    const other = await tx.dataSource.create({ data: { key: 'other-' + randomUUID(), name: 'Other synthetic source', adapterVersion: 'fixture' } });
    const task = await tx.collectionTask.create({ data: { dataSourceId: other.id, name: 'Synthetic archive', query: {} } });
    const run = await tx.collectionRun.create({ data: { dataSourceId: other.id, taskId: task.id, idempotencyKey: randomUUID(), querySnapshot: {}, adapterVersion: 'fixture', status: 'SUCCEEDED' } });
    const sql = 'INSERT INTO "SeedAttempt" (id,"dataSourceId","sourceKey","runId","batchSha256","attributionQuality",outcome,"startedAt","finishedAt") VALUES ($1,$2,$3,$4,$5,\'UNATTRIBUTED\',\'FAILED\',now(),now())';
    await rejectsConstraint(tx, sql, [randomUUID(), f.source.id, f.source.key, run.id, 'c'.repeat(64)], /foreign key|23503/i);
    await tx.$executeRawUnsafe(sql, randomUUID(), other.id, other.key, run.id, 'c'.repeat(64));
  }));
  it('keeps attempt source, token and started owner snapshot consistent', () => isolated(async (tx, f) => {
    const task = randomUUID(), node = 'attempt-node-' + randomUUID(), attempt = randomUUID(), incarnation = randomUUID();
    await tx.$executeRawUnsafe('INSERT INTO "SeedExecutionTask" (id,"updatedAt","queryId","dataSourceId","sourceKey","cycleKey","workUnitKey","publicationRevision","schedulePolicyVersion") VALUES ($1,now(),$2,$3,$4,\'cycle-1\',\'page-1\',1,\'fixture\')', task, f.qid, f.source.id, f.source.key);
    await tx.$executeRawUnsafe('INSERT INTO "CollectorNode" ("nodeId","incarnationId","registryRevision","codeRevision") VALUES ($1,$2,1,\'fixture\')', node, incarnation);
    const sql = 'INSERT INTO "SeedTaskAttempt" (id,"taskId","dataSourceId","sourceKey","attemptNo","nodeId","incarnationId","assignmentGeneration","leaseVersion","tokenHash","leaseExpiresAt","publicationRevision","configHash") VALUES ($1,$2,$3,$4,1,$5,$6,1,1,$7,now()+interval \'5 minutes\',1,$8)';
    await rejectsConstraint(tx, sql, [randomUUID(), task, f.source.id, 'wrong-source', node, incarnation, 'a'.repeat(64), 'b'.repeat(64)], /foreign key|23503/i);
    await tx.$executeRawUnsafe(sql, attempt, task, f.source.id, f.source.key, node, incarnation, 'a'.repeat(64), 'b'.repeat(64));
    await rejectsConstraint(tx, 'UPDATE "SeedTaskAttempt" SET "tokenHash"=$2 WHERE id=$1', [attempt, 'c'.repeat(64)], /IMMUTABLE_SEED_ATTEMPT_IDENTITY/i);
    await rejectsConstraint(tx, 'UPDATE "SeedTaskAttempt" SET "startedAt"=now(),"requestDeadline"=now()+interval \'1 minute\',"primaryOwner"=\'{"ownerKind":"LEGACY","legacyOwnerKey":"unbound"}\' WHERE id=$1', [attempt], /check|23514/i);
  }));
});
