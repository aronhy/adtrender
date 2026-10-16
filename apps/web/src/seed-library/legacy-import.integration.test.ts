import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLegacyCheckpoint, importLegacyInventory, inventoryLegacyState, prepareLegacyInventory } from './legacy-import';
import { createCollectorEvidenceStore, collectorEvidenceKey } from '../collector-dispatch/evidence-store';

const url = process.env.SAAS_TEST_DATABASE_URL; let db: any;
beforeAll(() => {
  if (!url) return;
  const target = new URL(url); if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.includes('_test_')) throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const { PrismaClient } = createRequire(new URL('../../package.json', import.meta.url))('@prisma/client'); db = new PrismaClient({ datasources: { db: { url } } });
});
afterAll(async () => { await db?.$disconnect(); });
function transactionDb(tx: any) { return new Proxy(tx, { get(target, name) { return name === '$transaction' ? (run: (db: any) => Promise<unknown>) => run(tx) : Reflect.get(target, name); } }); }
async function isolated(body: (tx: any, api: any, fixture: any) => Promise<void>) {
  const stop = Error('TEST_ROLLBACK');
  try { await db.$transaction(async (tx: any) => {
    const suffix = randomUUID(), nodeId = 'legacy-' + suffix, sourceKey = 'meta_ad_library' as const;
    const source = await tx.dataSource.upsert({ where: { key: sourceKey }, create: { key: sourceKey, name: 'Synthetic legacy source', adapterVersion: 'fixture' }, update: {} });
    const admin = await tx.user.create({ data: { email: suffix + '@legacy.example.test', isAdmin: true } });
    const state = { schemaVersion: 3, jobs: [{ id: 'original-' + suffix, country: 'US', language: 'en', keyword: suffix, seen: ['historical-ad'], cursor: { page: 3, row: 4 }, failures: 2, dueAt: 9000, lastAttemptAt: 200 }], pauseUntil: 8000, restrictions: 4, appliedBatches: { ['a'.repeat(64)]: { committedAt: '2026-10-10T01:00:00Z' } } };
    const inventory = inventoryLegacyState(sourceKey, state), job = inventory.jobs[0];
    const query = await tx.seedQuery.create({ data: { id: randomUUID(), dataSourceId: source.id, sourceKey, channel: job.channel, mode: job.mode, normalizedParams: job.params, queryCountry: 'US', queryLanguage: 'en', queryKey: job.queryKey, queryKeyVersion: 'legacy-1', adapterVersion: 'fixture', capabilityVersion: 'fixture', desiredEnabled: false } });
    await body(tx, transactionDb(tx), { suffix, nodeId, sourceKey, source, admin, state, job, query }); throw stop;
  }, { timeout: 30_000 }); } catch (error) { if (error !== stop) throw error; }
}
describe.skipIf(!url)('legacy inventory preserves registry query identity in PostgreSQL', () => {
  it('persists a checkpoint for the existing query ID and preserves replay progress', () => isolated(async (tx, api, f) => {
    expect(f.query.id).not.toBe(f.job.queryId);
    const prepared = await prepareLegacyInventory(api, { actorUserId: f.admin.id, sourceKey: f.sourceKey, state: f.state, nodeId: f.nodeId });
    const checkpoint = prepared.checkpoints[0]; expect(checkpoint.queryId).toBe(f.query.id); expect(checkpoint.stateSchemaVersion).toBe(1); expect(checkpoint.sessionAffinity).toBe('node:' + f.nodeId);
    const root = await mkdtemp(join(tmpdir(), 'seed-legacy-checkpoint-'));
    try {
      const namespace = { prefix: 'private-legacy-checkpoints', sourceKey: f.sourceKey };
      const store = await createCollectorEvidenceStore({ kind: 'local', rootDirectory: root, namespace });
      const key = collectorEvidenceKey(namespace, checkpoint.sha256), reference = 'local-private:' + key;
      await store.putIfAbsent(key, Buffer.from(checkpoint.raw, 'utf8'), checkpoint.sha256);
      const args = { actorUserId: f.admin.id, sourceKey: f.sourceKey, state: f.state, nodeId: f.nodeId, adapterVersion: 'fixture', checkpointRefs: { [f.job.nativeJobId]: { reference, sha256: checkpoint.sha256 } }, idempotencyKey: 'import', reason: 'Synthetic legacy recovery' };
      expect(await importLegacyInventory(api, args)).toMatchObject({ mapped: 1 });
      const runtime = await tx.seedRuntimeState.findUnique({ where: { queryId: f.query.id } });
      expect(runtime).toMatchObject({ checkpointSequence: 1, stateSchemaVersion: 1, sessionAffinity: 'node:' + f.nodeId, checkpointRef: reference, seenCount: 1 });
      expect(await tx.seedQuery.count({ where: { queryKey: f.job.queryKey } })).toBe(1);
      expect((await tx.legacyJobMapping.findUnique({ where: { sourceKey_nativeJobId: { sourceKey: f.sourceKey, nativeJobId: f.job.nativeJobId } } })).queryId).toBe(f.query.id);
      await tx.seedRuntimeState.update({ where: { queryId: f.query.id }, data: { checkpointSequence: 7, seenCount: 99 } });
      expect(await importLegacyInventory(api, { ...args, idempotencyKey: 'later-replay' })).toMatchObject({ mapped: 0 });
      expect(await tx.seedRuntimeState.findUnique({ where: { queryId: f.query.id } })).toMatchObject({ checkpointSequence: 7, seenCount: 99 });
    } finally { await rm(root, { recursive: true, force: true }); }
  }));
  it('rejects a prebuilt deterministic-ID checkpoint without altering the existing query or runtime', () => isolated(async (tx, api, f) => {
    const wrong = buildLegacyCheckpoint(f.sourceKey, f.state, f.job, f.nodeId);
    await expect(importLegacyInventory(api, { actorUserId: f.admin.id, sourceKey: f.sourceKey, state: f.state, nodeId: f.nodeId, adapterVersion: 'fixture', checkpointRefs: { [f.job.nativeJobId]: { reference: 'local-private:fixture/' + wrong.sha256, sha256: wrong.sha256 } }, idempotencyKey: 'stale-checkpoint', reason: 'Synthetic rejected checkpoint' })).rejects.toMatchObject({ code: 'LEGACY_CHECKPOINT_REQUIRED' });
    expect(await tx.seedRuntimeState.count({ where: { queryId: f.query.id } })).toBe(0); expect(await tx.legacyJobMapping.count({ where: { queryId: f.query.id } })).toBe(0);
    expect((await tx.seedQuery.findUnique({ where: { id: f.query.id } })).desiredEnabled).toBe(false);
  }));
  it('imports the actual TikTok manualPause object as a central manual restriction', () => isolated(async (tx, api, f) => {
    const sourceKey = 'tiktok_commercial_library' as const;
    await tx.dataSource.upsert({ where: { key: sourceKey }, create: { key: sourceKey, name: 'Synthetic TikTok legacy source', adapterVersion: 'fixture' }, update: {} });
    const state = { schema: 1, jobs: [{ id: 'tiktok-' + f.suffix, country: 'JP', start: '2025-01-01', end: '2025-01-02', seen: ['retained-ad'], dueAt: 9000 }], pauseUntil: 8000, manualPause: { reason: 'TIKTOK_SOURCE_CHALLENGE', since: 123 }, pauseReason: 'older generic reason' };
    const prepared = await prepareLegacyInventory(api, { actorUserId: f.admin.id, sourceKey, state, nodeId: f.nodeId });
    const checkpoint = prepared.checkpoints[0];
    await importLegacyInventory(api, { actorUserId: f.admin.id, sourceKey, state, nodeId: f.nodeId, adapterVersion: 'fixture', checkpointRefs: { [checkpoint.nativeJobId]: { reference: 'local-private:tiktok/' + checkpoint.sha256, sha256: checkpoint.sha256 } }, idempotencyKey: 'tiktok-manual', reason: 'Synthetic TikTok manual restriction' });
    expect(await tx.collectorSourceControl.findUnique({ where: { sourceKey_channel_scopeKey: { sourceKey, channel: 'SWEEP', scopeKey: 'SOURCE' } } })).toMatchObject({ manualPause: true, reason: 'TIKTOK_SOURCE_CHALLENGE' });
    expect(JSON.parse(checkpoint.raw).sourceState.manualPause).toEqual(state.manualPause);
  }));
  it('retains native Snapchat restrictionCount and never lowers an existing central count', () => isolated(async (tx, api, f) => {
    const sourceKey = 'snapchat_ads_gallery' as const;
    const source = await tx.dataSource.upsert({ where: { key: sourceKey }, create: { key: sourceKey, name: 'Synthetic Snapchat legacy source', adapterVersion: 'fixture' }, update: {} });
    const key = { sourceKey_channel_scopeKey: { sourceKey, channel: 'PUBLISHER', scopeKey: 'SOURCE' } };
    await tx.collectorSourceControl.upsert({ where: key, create: { dataSourceId: source.id, sourceKey, channel: 'PUBLISHER', scopeKey: 'SOURCE', restrictionCount: 2 }, update: { restrictionCount: 2 } });
    const state = { schemaVersion: 1, jobs: [{ id: 'snapchat-' + f.suffix, country: 'US', publisher: f.suffix, seen: [] }], pauseUntil: 8000, restrictionCount: 7, restrictions: 3 };
    const checkpoint = (await prepareLegacyInventory(api, { actorUserId: f.admin.id, sourceKey, state, nodeId: f.nodeId })).checkpoints[0];
    const args = { actorUserId: f.admin.id, sourceKey, state, nodeId: f.nodeId, adapterVersion: 'fixture', checkpointRefs: { [checkpoint.nativeJobId]: { reference: 'local-private:snapchat/' + checkpoint.sha256, sha256: checkpoint.sha256 } }, idempotencyKey: 'snapchat-restriction', reason: 'Synthetic Snapchat restriction' };
    await importLegacyInventory(api, args); expect((await tx.collectorSourceControl.findUnique({ where: key })).restrictionCount).toBe(7);
    await tx.collectorSourceControl.update({ where: key, data: { restrictionCount: 12 } });
    await importLegacyInventory(api, { ...args, idempotencyKey: 'snapchat-replay' }); expect((await tx.collectorSourceControl.findUnique({ where: key })).restrictionCount).toBe(12);
  }));
});
