import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDispatchTick } from './seed-control';
import { configuredCollectorDispatch } from '../../web/src/collector-dispatch/configured';
import { saveSeedDefinition } from '../../web/src/seed-library/catalog';
import { acceptConfigReceipt, previewPublication, publishSeedConfig, scopeManifest } from '../../web/src/seed-library/publications';
const url = process.env.SAAS_TEST_DATABASE_URL; let db: any;
beforeAll(() => {
  if (!url) return;
  const target = new URL(url); if (!['localhost', '127.0.0.1'].includes(target.hostname) || !target.pathname.includes('_test_')) throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const { PrismaClient } = createRequire(new URL('../../web/package.json', import.meta.url))('@prisma/client'); db = new PrismaClient({ datasources: { db: { url } } });
});
afterAll(async () => { await db?.$disconnect(); });
describe.skipIf(!url)('trusted independent seed dispatch worker tick', () => {
  it('publishes a fresh seed, schedules through the real tick, then lets the machine claim existing work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'seed-control-test-')), rollback = Error('SEED_CONTROL_TEST_ROLLBACK');
    const env = { COLLECTOR_DISPATCH_ENABLED: 'true', COLLECTOR_GRANT_SECRET: 'local-test-only-secret-with-more-than-32-bytes', COLLECTOR_EVIDENCE_ROOT: root, COLLECTOR_LEASE_MS: '60000', COLLECTOR_REQUEST_BUDGET_MS: '2000', COLLECTOR_EXIT_MARGIN_MS: '500', COLLECTOR_REQUEST_SPACING_MS: '0', COLLECTOR_CYCLE_MS: '60000', COLLECTOR_UNKNOWN_BACKOFF_MS: '60000' };
    try { await db.$transaction(async (tx: any) => {
      const api = new Proxy(tx, { get(target, key) { return key === '$transaction' ? (fn: any) => fn(tx) : Reflect.get(target, key); } });
      const suffix = randomUUID(), admin = await tx.user.create({ data: { email: suffix + '@seed-worker.example.test', isAdmin: true } }), member = await tx.user.create({ data: { email: suffix + '@seed-worker-member.example.test', isAdmin: false } });
      // Test isolation is a rolled-back transaction. Existing test catalogs do
      // not participate in this new publication or create unrelated cycles.
      await tx.seedDefinition.updateMany({ data: { status: 'ARCHIVED' } }); await tx.seedScanPlan.updateMany({ data: { status: 'ARCHIVED' } }); await tx.seedQuery.updateMany({ data: { desiredEnabled: false } });
      await tx.seedQueryBinding.updateMany({ where: { ownerKind: 'LEGACY', validToRevision: null }, data: { participationStatus: 'PAUSED' } });
      const source = await tx.dataSource.upsert({ where: { key: 'meta_ad_library' }, create: { key: 'meta_ad_library', name: 'Worker fixture', adapterVersion: 'meta-service-dom-1', status: 'ACTIVE' }, update: { status: 'ACTIVE' } });
      await tx.dataSource.update({ where: { id: source.id }, data: { capabilities: { seedDispatch: { verification: 'VERIFIED', profiles: [{ sourceKey: source.key, channel: 'META', modes: ['KEYWORD'], countries: ['US'], version: 'fixture-1', adapterVersion: 'meta-service-dom-1' }] } } } });
      await tx.collectorSourceAssignment.updateMany({ where: { sourceKey: source.key, channel: { in: ['META', '*'] } }, data: { state: 'STOPPED' } });
      for (const channel of ['META', '*']) await tx.collectorSourceControl.upsert({ where: { sourceKey_channel_scopeKey: { sourceKey: source.key, channel, scopeKey: 'SOURCE' } }, create: { dataSourceId: source.id, sourceKey: source.key, channel, scopeKey: 'SOURCE', controlMode: 'TASK_CLAIM', notBefore: new Date(0) }, update: { controlMode: 'TASK_CLAIM', manualPause: false, notBefore: new Date(0) } });
      await saveSeedDefinition(api, { actorUserId: admin.id, idempotencyKey: 'worker-seed', reason: 'Synthetic worker lifecycle', payload: { kind: 'KEYWORD', namespace: 'worker-test', rawValue: suffix, language: 'en', purposeTags: [], targetScope: { kind: 'EXPLICIT_COUNTRIES', countries: ['US'] }, targetPlatforms: [source.key], status: 'ACTIVE', priority: 0 } });
      const head = await tx.seedPublication.findFirst({ where: { status: 'PUBLISHED' }, orderBy: { revision: 'desc' } }), parentRevision = head?.revision ?? 0;
      const preview = await previewPublication(api, { actorUserId: admin.id, parentRevision, idempotencyKey: 'worker-preview', reason: 'Synthetic worker lifecycle' });
      const pub = await publishSeedConfig(api, { actorUserId: admin.id, parentRevision, previewId: preview.targetId, idempotencyKey: 'worker-publish', reason: 'Synthetic worker lifecycle' });
      const publication = await tx.seedPublication.findUnique({ where: { id: pub.targetId } }), full = publication.configSnapshot.manifest;
      const tombstones = await tx.seedQuery.findMany({ where: { id: { in: full.tombstones.map((t: any) => t.queryId) } }, select: { id: true, sourceKey: true } });
      const manifest = scopeManifest(full, [source.key], new Map(tombstones.map((q: any) => [q.id, q.sourceKey]))), query = manifest.queries.find((q: any) => q.params.keyword === suffix);
      expect(query).toBeTruthy(); expect(await tx.seedExecutionTask.count({ where: { queryId: query.queryId } })).toBe(0);
      const dispatch = configuredCollectorDispatch(api, env), identity: any = { nodeId: 'worker-' + suffix, incarnationId: randomUUID(), allowedSourceKeys: [source.key] };
      await dispatch.registerNode({ actorUserId: admin.id, ...identity, registryRevision: 1, enabled: true, expiresAt: null, codeRevision: 'fixture', protocolVersions: [1] });
      await dispatch.heartbeat(identity, { codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), resourceSnapshot: { healthy: true } });
      await dispatch.verifyNode({ actorUserId: admin.id, ...identity, codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), maxSlots: 1 });
      await acceptConfigReceipt(api, { trustedNodeId: identity.nodeId, sourceScopes: [source.key], receipt: { nodeId: identity.nodeId, incarnationId: identity.incarnationId, sequence: 1, publicationId: publication.id, publicationRevision: publication.revision, manifestHash: manifest.contentHash, applyStatus: 'APPLIED', nativeJobMappings: manifest.queries.map((q: any) => ({ queryId: q.queryId, nativeJobId: q.nativeJobIds[0] })) } });
      const claim = { requestId: randomUUID(), appliedRevision: publication.revision, configHash: manifest.contentHash, availableSlots: 1, supportedModes: ['KEYWORD'], queryIds: [query.queryId] };
      expect(await dispatch.claimTask(identity, claim)).toMatchObject({ idle: true, reason: 'NO_COMPATIBLE_TASK' });
      await expect(seedDispatchTick(api, { actorUserId: member.id, env })).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
      expect(await tx.seedExecutionTask.count({ where: { queryId: query.queryId } })).toBe(0);
      expect(await seedDispatchTick(api, { actorUserId: admin.id, env })).toMatchObject({ created: 1, failed: 0 });
      expect(await dispatch.claimTask(identity, { ...claim, requestId: randomUUID() })).toMatchObject({ queryId: query.queryId, sourceKey: source.key });
      throw rollback;
    }, { timeout: 60000 }); } catch (error) { if (error !== rollback) throw error; } finally { await rm(root, { recursive: true, force: true }); }
  }, 60000);
});
