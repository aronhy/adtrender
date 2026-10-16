import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCollectorDispatchService } from './service';
import { legacyQueryIdentity } from '../seed-library/legacy-query-key';
import { acceptConfigReceipt } from '../seed-library/publications';
import { importLegacyInventory, prepareLegacyInventory } from '../seed-library/legacy-import';
import { seedManifestContentHash } from '@ad-research/contracts/seeds';
const url = process.env.SAAS_TEST_DATABASE_URL, require = createRequire(new URL('../../package.json', import.meta.url));
let db: any;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
beforeAll(async () => {
  if (!url) return;
  const target = new URL(url); if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.includes('_test_')) throw new Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const { PrismaClient } = require('@prisma/client'); db = new PrismaClient({ datasources: { db: { url } } });
  const sql = ['meta', 'google', 'snapchat', 'tiktok', 'pinterest'].map(source => readFileSync('apps/collector/deploy/' + source + '/ingest.sql', 'utf8').replace(/^GRANT[^\n]*\n/gm, '')).join('\n');
  execFileSync('psql', [url.split('?')[0], '-X', '-v', 'ON_ERROR_STOP=1'], { input: sql, stdio: ['pipe', 'pipe', 'pipe'] });
});
afterAll(async () => { await db?.$disconnect(); });
async function fixture() {
  const suffix = randomUUID(), objects = new Map<string, Uint8Array>();
  const priorCooldown = await db.collectorSourceControl.findFirst({ where: { sourceKey: 'meta_ad_library', channel: '*' }, orderBy: { notBefore: 'desc' } });
  let clock = new Date(Math.max(Date.now(), (priorCooldown?.notBefore?.valueOf() ?? 0) + 1000));
  const serviceOptions: any = { tokenSecret: 'synthetic-test-secret-with-32-characters', leaseMs: 3000, requestBudgetMs: 200, exitMarginMs: 100, requestSpacingMs: 0, cycleMs: 60000, unknownOutcomeBackoffMs: 60000, evidencePrefix: 'private-source-evidence/dispatch', evidenceScheme: 'local-private', now: () => clock, storeForSource: () => ({ async putIfAbsent(key: string, bytes: Uint8Array) { if (objects.has(key)) return 'EXISTS'; objects.set(key, Buffer.from(bytes)); return 'CREATED'; }, async get(key: string) { const bytes = objects.get(key); if (!bytes) throw Error('OBJECT_NOT_FOUND'); return Buffer.from(bytes); } }) };
  const service: any = createCollectorDispatchService(db, serviceOptions);
  const admin = await db.user.create({ data: { email: 'dispatch-' + suffix + '@example.test', isAdmin: true } });
  const source = await db.dataSource.upsert({ where: { key: 'meta_ad_library' }, create: { key: 'meta_ad_library', name: 'Synthetic Meta fixture', adapterVersion: 'meta-service-dom-1', status: 'ACTIVE' }, update: { status: 'ACTIVE' } });
  const channel = 'test-' + suffix, queryId = randomUUID(), params = { country: 'US', language: 'en', keyword: 'synthetic-' + suffix, pageId: null, status: 'all', mediaType: 'all' };
  const queryKey = legacyQueryIdentity(source.key, params).key;
  await db.seedQuery.create({ data: { id: queryId, dataSourceId: source.id, sourceKey: source.key, channel, mode: 'KEYWORD', normalizedParams: params, queryKey, queryKeyVersion: 'legacy-1', adapterVersion: 'meta-service-dom-1', capabilityVersion: 'fixture', desiredEnabled: true, controlMode: 'TASK_CLAIM' } });
  const latest = await db.seedPublication.findFirst({ orderBy: { revision: 'desc' } });
  const revision = (latest?.revision ?? 0) + 1;
  const body: any = { schemaVersion: 1, protocolMin: 1, protocolMax: 1, publicationId: randomUUID(), revision, parentRevision: latest?.revision ?? null, compilerVersion: 'fixture', capabilityVersion: 'fixture', createdAt: clock.toISOString(), queries: [{ queryId, queryKey, queryKeyVersion: 'legacy-1', sourceKey: source.key, channel, mode: 'KEYWORD', params, legacyDims: {}, adapterVersion: 'meta-service-dom-1', capabilityVersion: 'fixture', desiredEnabled: true, nativeJobIds: ['fixture-' + suffix] }], bindings: [], scanPlans: [], tombstones: [], schedulePolicyVersion: 'fixture' };
  const manifest = { ...body, contentHash: seedManifestContentHash(body) };
  await db.seedPublication.create({ data: { id: body.publicationId, revision, parentRevision: body.parentRevision, manifestHash: manifest.contentHash, configSnapshot: { manifest }, reason: 'Synthetic dispatch test' } });
  await db.seedRuntimeState.create({ data: { queryId, dataSourceId: source.id, sourceKey: source.key, desiredRevision: revision } });
  await db.seedQueryBinding.create({ data: { queryId, ownerKind: 'LEGACY', legacyOwnerKey: 'fixture-owner-' + suffix, ownerRevision: 1, validFromRevision: revision } });
  await db.collectorSourceControl.create({ data: { dataSourceId: source.id, sourceKey: source.key, channel, scopeKey: 'SOURCE', controlMode: 'TASK_CLAIM', notBefore: new Date(0) } });
  const identity: any = { nodeId: 'dispatch-node-' + suffix, incarnationId: randomUUID(), allowedSourceKeys: ['meta_ad_library'] };
  await service.registerNode({ actorUserId: admin.id, ...identity, registryRevision: 1, enabled: true, expiresAt: null, codeRevision: 'fixture', protocolVersions: [1] });
  await service.heartbeat(identity, { codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), resourceSnapshot: { healthy: true } });
  await service.verifyNode({ actorUserId: admin.id, nodeId: identity.nodeId, incarnationId: identity.incarnationId, codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), maxSlots: 1 });
  await db.seedCollectorReceipt.create({ data: { publicationId: body.publicationId, publicationRevision: revision, manifestHash: manifest.contentHash, nodeId: identity.nodeId, incarnationId: identity.incarnationId, sequence: 1, type: 'APPLIED', applyStatus: 'APPLIED', payloadHash: 'a'.repeat(64), payload: { nativeJobMappings: [{ queryId, nativeJobId: 'fixture-' + suffix }] } } });
  await service.scheduleDueQueries({ actorUserId: admin.id, queryIds: [queryId] });
  const claim = (requestId = randomUUID()): Promise<any> => service.claimTask(identity, { requestId, appliedRevision: revision, configHash: manifest.contentHash, availableSlots: 1, supportedModes: ['KEYWORD'], queryIds: [queryId] });
  return { now: () => clock, serviceOptions, service, admin, source, queryId, channel, params, manifest, identity, objects, claim, advance(ms: number) { clock = new Date(clock.valueOf() + ms); } };
}
async function preparedFixture(batchOverride: any = {}) {
  const f = await fixture(), grant = await f.claim();
  await f.service.startAttempt(f.identity, { grantToken: grant.grantToken, attemptId: grant.attemptId });
  const raw = JSON.stringify({ sourceKey: 'meta_ad_library', platform: 'META', version: 'meta-service-dom-1', query: f.params, observedAt: new Date().toISOString(), status: 'NO_RESULTS', ads: [], evidence: [], coverage: { exhausted: false }, ...batchOverride });
  const context = { grantToken: grant.grantToken, sourceKey: grant.sourceKey, queryId: grant.queryId, taskId: grant.taskId, attemptId: grant.attemptId, assignmentGeneration: grant.assignmentGeneration, leaseVersion: grant.leaseVersion, publicationRevision: grant.publicationRevision, configHash: grant.configHash, mode: 'KEYWORD', channel: f.channel, nativeParams: grant.nativeParams };
  const pre = await f.service.prepareSubmission(f.identity, { requestId: randomUUID(), context, rawSha: sha(raw), expectedBatchHashes: [sha(raw)], sidecarHash: sha('synthetic-sidecar'), sidecarRef: 'local-private:archive/pending.json' });
  return { ...f, grant, raw, pre, input: { requestId: randomUUID(), sourceKey: 'meta_ad_library' as const, prepareToken: pre.prepareToken, batchHash: sha(raw), raw } };
}
describe.skipIf(!url)('central dispatch lease and submission boundaries', () => {
  it('claims once across real connections and replays only the same request content', async () => {
    const f = await fixture(), requestId = randomUUID();
    const [first, replay] = await Promise.all([f.claim(requestId), f.claim(requestId)]); expect(first.attemptId).toBe(replay.attemptId); expect(first.grantToken).toBe(replay.grantToken);
    expect(await f.claim()).toMatchObject({ idle: true });
    await expect(f.service.claimTask(f.identity, { requestId, appliedRevision: f.manifest.revision, configHash: f.manifest.contentHash, availableSlots: 2, supportedModes: ['KEYWORD'], queryIds: [f.queryId] })).rejects.toMatchObject({ code: 'CLAIM_IDEMPOTENCY_CONFLICT' });
  });
  it('rechecks paused owners before start and rejects a false machine incarnation', async () => {
    const f = await fixture(), grant = await f.claim();
    await db.seedQueryBinding.updateMany({ where: { queryId: f.queryId }, data: { participationStatus: 'PAUSED' } });
    await expect(f.service.startAttempt(f.identity, { grantToken: grant.grantToken, attemptId: grant.attemptId })).rejects.toMatchObject({ code: 'NO_PUBLISHED_OWNER' });
    await expect(f.service.startAttempt({ ...f.identity, incarnationId: randomUUID() }, { grantToken: grant.grantToken, attemptId: grant.attemptId })).rejects.toMatchObject({ code: 'MACHINE_IDENTITY_REJECTED' });
  });
  it('never reschedules an expired attempt without confirmed recovery evidence', async () => {
    const f = await fixture(), grant = await f.claim(); await f.service.startAttempt(f.identity, { grantToken: grant.grantToken, attemptId: grant.attemptId }); const priorNext = new Date(f.now().valueOf() + 3600000); await db.seedRuntimeState.update({ where: { queryId: f.queryId }, data: { nextAllowedAt: priorNext } }); f.advance(10000);
    await f.service.recoverExpiredAttempts({ actorUserId: f.admin.id });
    expect(await f.claim()).toMatchObject({ idle: true });
    const task = await db.seedExecutionTask.findUnique({ where: { id: grant.taskId } }); expect(['RECOVERING', 'RECOVERY_BLOCKED']).toContain(task.state); expect((await db.seedRuntimeState.findUnique({ where: { queryId: f.queryId } })).nextAllowedAt).toEqual(priorNext);
    await expect(f.service.renewAttempt(f.identity, { grantToken: grant.grantToken, attemptId: grant.attemptId })).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });
  it('preserves newer source restrictions when an old success arrives', async () => {
    const f = await fixture(), grant = await f.claim(); await f.service.startAttempt(f.identity, { grantToken: grant.grantToken, attemptId: grant.attemptId });
    const cooling = await f.service.recordRestriction(f.identity, { grantToken: grant.grantToken, attemptId: grant.attemptId, expectedControlVersion: 0, reason: 'HTTP_429', retryAfterMs: 60000 });
    expect(cooling.controlVersion).toBeGreaterThan(grant.sourceControlVersion);
    const permit = await f.service.acquireSourcePermit(f.identity, { grantToken: grant.grantToken, attemptId: grant.attemptId, requestKind: 'DETAIL' }); expect(permit.allowed).toBe(false);
    expect(permit.sourceControl.notBefore).toBe(cooling.notBefore);
  });
  it('keeps disabled nodes out and does not grant another source through request data', async () => {
    const f = await fixture(); await f.service.setNodeEnabled({ actorUserId: f.admin.id, nodeId: f.identity.nodeId, enabled: false });
    expect(await f.claim()).toMatchObject({ idle: true });
    await expect(f.service.getPlatformGrant(f.identity, { sourceKey: 'google_ads_transparency' })).rejects.toMatchObject({ code: 'MACHINE_SOURCE_FORBIDDEN' });
  });
  it('refuses recovery of an unregistered legacy batch hash', async () => {
    const f = await fixture(), raw = '{}';
    await expect(f.service.recoverSubmit(f.identity, { requestId: randomUUID(), sourceKey: 'meta_ad_library', rawSha: sha(raw), batchHash: sha(raw), raw })).rejects.toMatchObject({ code: 'LEGACY_PENDING_NOT_REGISTERED' });
  });
  it('requires a server durable object anchor even when a collector knows PREPARED and grant', async () => {
    const f = await preparedFixture();
    await expect(db.$transaction(async (tx: any) => {
      await tx.$queryRawUnsafe("SELECT set_config('seed_dispatch.execution',$1,true)", JSON.stringify({ kind: 'TASK', sourceKey: 'meta_ad_library', preparedId: f.pre.prepareToken.split('.')[0], attemptId: f.grant.attemptId, grantToken: f.grant.grantToken, recover: true }));
      await tx.$queryRawUnsafe('SELECT meta_collector.ingest($1)', f.raw);
    })).rejects.toThrow('RAW_OBJECT_NOT_DURABLE');
  });
  it('stores exact raw bytes before ingest, preserves original counters and waits for a checkpoint', async () => {
    const f = await preparedFixture(), first = await f.service.submitManagedUnit(f.identity, f.input);
    expect(first).toMatchObject({ status: 'IMPORTED', complete: true, committedCheckpointSequence: null, originalInserted: 0 });
    expect(f.objects.get('private-source-evidence/dispatch/meta_ad_library/' + sha(f.raw) + '.bin')).toEqual(Buffer.from(f.raw));
    expect((await db.seedExecutionTask.findUnique({ where: { id: f.grant.taskId } })).state).toBe('COMMIT_PENDING');
    expect(await f.service.submitManagedUnit(f.identity, f.input)).toEqual(first);
    const fact = await db.seedAttempt.findUnique({ where: { sourceKey_batchSha256: { sourceKey: 'meta_ad_library', batchSha256: sha(f.raw) } } });
    expect(fact).toMatchObject({ queryId: f.queryId, taskAttemptId: f.grant.attemptId, attributionQuality: 'EXACT_QUERY', outcome: 'PARTIAL', exhausted: false });
    expect(fact.bindingSnapshot).toHaveLength(1);
  });
  it('rejects corrupted storage and records no import or batch fact', async () => {
    const f = await preparedFixture(), key = 'private-source-evidence/dispatch/meta_ad_library/' + sha(f.raw) + '.bin'; f.objects.set(key, Buffer.from('corrupted'));
    await expect(f.service.submitManagedUnit(f.identity, f.input)).rejects.toMatchObject({ code: 'RAW_OBJECT_NOT_DURABLE' });
    expect(await db.seedAttempt.count({ where: { sourceKey: 'meta_ad_library', batchSha256: sha(f.raw) } })).toBe(0);
  });
  it('promotes only the confirmed next checkpoint and preserves native retry timing', async () => {
    const f = await preparedFixture(); await f.service.submitManagedUnit(f.identity, f.input);
    const next = f.now().valueOf() + 3600000;
    const checkpointRaw = JSON.stringify({ schemaVersion: 1, sourceKey: 'meta_ad_library', queryId: f.queryId, nativeParams: f.params, job: { dueAt: next, seen: ['native-observed-id'] }, sourceState: { pauseUntil: 0 }, appliedBatchHashes: [sha(f.raw)] });
    const checkpoint = { schemaVersion: 1 as const, adapterStateVersion: 'meta-service-dom-1', queryId: f.queryId, sequence: 1, reference: 'local-private:node/pending-cp', sha256: sha(checkpointRaw), stateSchemaVersion: 1, appliedBatchHashes: [sha(f.raw)], sessionAffinity: null };
    const committed = await f.service.submitManagedUnit(f.identity, { ...f.input, requestId: randomUUID(), checkpoint, checkpointRaw });
    expect(committed).toMatchObject({ status: 'ALREADY_IMPORTED', complete: true, committedCheckpointSequence: 1 });
    const runtime = await db.seedRuntimeState.findUnique({ where: { queryId: f.queryId } }); expect(runtime).toMatchObject({ checkpointSequence: 1, checkpointSha: sha(checkpointRaw), pendingManifestRef: null }); expect(runtime.nextAllowedAt.valueOf()).toBe(next);
    expect((await db.seedExecutionTask.findUnique({ where: { id: f.grant.taskId } })).state).toBe('COMPLETED');
    await expect(f.service.readCheckpoint(f.identity, { attemptId: f.grant.attemptId, grantToken: f.grant.grantToken, queryId: f.queryId })).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });
  it('recovers an expired prepared original hash without promoting the current checkpoint', async () => {
    const f = await preparedFixture(); f.advance(10000); await f.service.recoverExpiredAttempts({ actorUserId: f.admin.id });
    const receipt = await f.service.recoverSubmit(f.identity, { ...f.input, rawSha: sha(f.raw) }); expect(receipt).toMatchObject({ complete: true, committedCheckpointSequence: null });
    expect((await db.seedRuntimeState.findUnique({ where: { queryId: f.queryId } })).checkpointSequence).toBe(0);
    expect((await db.seedExecutionTask.findUnique({ where: { id: f.grant.taskId } })).state).toBe('RECOVERING');
  });
  it('accepts only centrally registered legacy original hashes and does not move owner', async () => {
    const f = await fixture(), raw = JSON.stringify({ sourceKey: 'meta_ad_library', platform: 'META', version: 'meta-service-dom-1', query: f.params, observedAt: new Date().toISOString(), status: 'NO_RESULTS', ads: [], evidence: [], coverage: {} });
    await f.service.registerLegacyPending({ actorUserId: f.admin.id, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, sourceKey: 'meta_ad_library', rawSha: sha(raw), batchHashes: [sha(raw)], reason: 'Synthetic archived pending replay' });
    const input = { requestId: randomUUID(), sourceKey: 'meta_ad_library' as const, rawSha: sha(raw), batchHash: sha(raw), raw };
    const first = await f.service.recoverSubmit(f.identity, input), replay = await f.service.recoverSubmit(f.identity, input); expect(replay.runId).toBe(first.runId); expect(replay.committedAt).toBe(first.committedAt);
    expect((await db.seedRuntimeState.findUnique({ where: { queryId: f.queryId } })).collectorId).toBeNull();
    await expect(f.service.recoverSubmit(f.identity, { ...input, raw: raw + ' ', batchHash: sha(raw + ' ') })).rejects.toMatchObject({ code: 'LEGACY_PENDING_NOT_REGISTERED' });
  });

  it('requires a fresh heartbeat and does not execute an old standby forever', async () => {
    const f = await fixture(); f.advance(4000);
    expect(await f.claim()).toMatchObject({ idle: true, reason: 'NODE_NOT_EXECUTABLE' });
    await f.service.heartbeat(f.identity, { codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), resourceSnapshot: { healthy: true } });
    expect(await f.claim()).toMatchObject({ sourceKey: 'meta_ad_library', queryId: f.queryId });
  });
  it('uses the node scoped config hash when a global publication includes another source', async () => {
    const f = await fixture(), full = { ...f.manifest, publicationId: randomUUID(), revision: f.manifest.revision + 1, parentRevision: f.manifest.revision, queries: [...f.manifest.queries, { ...f.manifest.queries[0], queryId: randomUUID(), queryKey: 'b'.repeat(64), sourceKey: 'snapchat_ads_gallery', channel: 'PUBLISHER', mode: 'PUBLISHER', params: { country: 'US', publisher: 'synthetic' } }] };
    full.contentHash = seedManifestContentHash(full);
    const scoped = { ...full, queries: [full.queries[0]] }; scoped.contentHash = seedManifestContentHash(scoped);
    await db.seedPublication.create({ data: { id: full.publicationId, revision: full.revision, parentRevision: full.parentRevision, manifestHash: full.contentHash, configSnapshot: { manifest: full }, reason: 'Scoped synthetic fixture' } });
    await db.seedRuntimeState.update({ where: { queryId: f.queryId }, data: { desiredRevision: full.revision } });
    await db.seedCollectorReceipt.create({ data: { publicationId: full.publicationId, publicationRevision: full.revision, manifestHash: scoped.contentHash, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, sequence: 2, type: 'APPLIED', applyStatus: 'APPLIED', payloadHash: sha('scoped-fixture'), nativeJobMappings: [{ queryId: f.queryId, nativeJobId: full.queries[0].nativeJobIds[0] }] } });
    const input = { requestId: randomUUID(), appliedRevision: full.revision, configHash: full.contentHash, availableSlots: 1, supportedModes: ['KEYWORD'], queryIds: [f.queryId] };
    await expect(f.service.claimTask(f.identity, input)).rejects.toMatchObject({ code: 'CONFIG_HASH_MISMATCH' });
    expect(await f.service.claimTask(f.identity, { ...input, configHash: scoped.contentHash })).toMatchObject({ queryId: f.queryId, configHash: scoped.contentHash });
    await expect(f.service.claimTask(f.identity, { ...input, requestId: randomUUID(), sourceKey: 'snapchat_ads_gallery' })).rejects.toMatchObject({ code: 'MACHINE_SOURCE_FORBIDDEN' });
  });
  it('keeps the checkpoint-native failure backoff when recovery becomes ready', async () => {
    const f = await fixture(), grant = await f.claim(); await f.service.startAttempt(f.identity, { attemptId: grant.attemptId, grantToken: grant.grantToken });
    const priorRetry = f.now().valueOf() + 7200000; await db.seedRuntimeState.update({ where: { queryId: f.queryId }, data: { nextAllowedAt: new Date(priorRetry) } });
    await f.service.requestStop({ actorUserId: f.admin.id, queryId: f.queryId, reason: 'Synthetic operator stop' });
    const stopped = await f.service.acknowledgeStop(f.identity, { attemptId: grant.attemptId, grantToken: grant.grantToken, requestId: randomUUID(), sequence: 2, drained: true, pendingPreserved: true }); f.advance(400);
    const checkpointRaw = JSON.stringify({ schemaVersion: 1, sourceKey: 'meta_ad_library', queryId: f.queryId, nativeParams: f.params, job: { failures: 3, dueAt: f.now().valueOf() + 3600000 }, sourceState: { pauseUntil: 0 }, appliedBatchHashes: [] });
    const checkpoint = { schemaVersion: 1 as const, adapterStateVersion: 'native-job-1', queryId: f.queryId, sequence: 0, reference: 'local-private:node/restore', sha256: sha(checkpointRaw), stateSchemaVersion: 1, appliedBatchHashes: [], sessionAffinity: null };
    await f.service.reconcileRecovery({ actorUserId: f.admin.id, attemptId: grant.attemptId, stopReceiptId: stopped.receiptId, checkpoint, checkpointRaw });
    expect((await db.seedRuntimeState.findUnique({ where: { queryId: f.queryId } })).nextAllowedAt.valueOf()).toBe(priorRetry);
  });

  it('restores opaque checkpoint bytes through a new fresh grant after lease-expired pending recovery', async () => {
    const f = await preparedFixture(); f.advance(10000); await f.service.recoverExpiredAttempts({ actorUserId: f.admin.id });
    await f.service.recoverSubmit(f.identity, { ...f.input, rawSha: sha(f.raw) });
    const checkpointRaw = JSON.stringify({ schemaVersion: 1, sourceKey: 'meta_ad_library', queryId: f.queryId, nativeParams: f.params, job: { dueAt: f.now().valueOf() + 4000, seen: ['preserved-seen'], failures: 2, cursor: { page: 3, row: 2 } }, sourceState: { pauseUntil: 0 }, appliedBatchHashes: [sha(f.raw)] });
    const checkpoint = { schemaVersion: 1 as const, adapterStateVersion: 'native-job-1', queryId: f.queryId, sequence: 1, reference: 'local-private:node/recovery', sha256: sha(checkpointRaw), stateSchemaVersion: 1, appliedBatchHashes: [sha(f.raw)], sessionAffinity: null };
    const stop = { attemptId: f.grant.attemptId, grantToken: f.grant.grantToken, requestId: randomUUID(), sequence: 2, drained: true, pendingPreserved: true, checkpoint, checkpointRaw };
    const original = await f.service.acknowledgeStop(f.identity, stop); expect(original).toMatchObject({ recovered: true, checkpointSequence: 1, state: 'COMPLETED' });
    expect(await f.service.acknowledgeStop(f.identity, stop)).toEqual(original);
    f.advance(61000); await f.service.heartbeat(f.identity, { codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), resourceSnapshot: { healthy: true } });
    await f.service.scheduleDueQueries({ actorUserId: f.admin.id, queryIds: [f.queryId] }); const fresh = await f.claim(); expect(fresh.checkpointSequence).toBe(1);
    const restored = await f.service.readCheckpoint(f.identity, { attemptId: fresh.attemptId, grantToken: fresh.grantToken, queryId: f.queryId }); expect(restored.raw).toBe(checkpointRaw); expect(JSON.parse(restored.raw!).job).toMatchObject({ failures: 2, seen: ['preserved-seen'], cursor: { page: 3, row: 2 } });
    await expect(f.service.readCheckpoint(f.identity, { attemptId: fresh.attemptId, grantToken: fresh.grantToken, queryId: randomUUID() })).rejects.toMatchObject({ code: 'CHECKPOINT_QUERY_MISMATCH' });
  });
  it('keeps a CONFIG owner while advancing only its applied publication and freezes a real attempt', async () => {
    const f = await fixture();
    const assigned = await f.service.assignSource({ actorUserId: f.admin.id, sourceKey: 'meta_ad_library', channel: f.channel, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, publicationRevision: f.manifest.revision, configHash: f.manifest.contentHash, controlMode: 'CONFIG_QUEUE' });
    const platform = await f.service.getPlatformGrant(f.identity, { sourceKey: 'meta_ad_library', channel: f.channel });
    const permit = await f.service.platformPermit(f.identity, { grantToken: platform.grantToken, sourceKey: 'meta_ad_library', queryId: f.queryId, nativeJobId: f.manifest.queries[0].nativeJobIds[0], channel: f.channel, mode: 'KEYWORD', nativeParams: { ...f.params, pageId: '' }, requestKind: 'UNIT_START', requestId: randomUUID() });
    expect(permit).toMatchObject({ allowed: true, context: { queryId: f.queryId, assignmentGeneration: assigned.generation } }); expect(permit.context!.attemptId).toBeTruthy();
    expect((await db.seedTaskAttempt.findUnique({ where: { id: permit.context!.attemptId } })).bindingSnapshot).toHaveLength(1);
    const latest = await db.seedPublication.findFirst({ orderBy: { revision: 'desc' } }), body = { ...f.manifest, publicationId: randomUUID(), revision: latest.revision + 1, parentRevision: latest.revision }; body.contentHash = seedManifestContentHash(body);
    await db.seedPublication.create({ data: { id: body.publicationId, revision: body.revision, parentRevision: body.parentRevision, manifestHash: body.contentHash, configSnapshot: { manifest: body }, reason: 'CONFIG next synthetic publication' } });
    await db.seedRuntimeState.update({ where: { queryId: f.queryId }, data: { desiredRevision: body.revision } });
    await db.seedCollectorReceipt.create({ data: { publicationId: body.publicationId, publicationRevision: body.revision, manifestHash: body.contentHash, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, sequence: 2, type: 'APPLIED', applyStatus: 'APPLIED', payloadHash: sha('config-next'), nativeJobMappings: [{ queryId: f.queryId, nativeJobId: body.queries[0].nativeJobIds[0] }] } });
    const refreshed = await f.service.getPlatformGrant(f.identity, { sourceKey: 'meta_ad_library', channel: f.channel }); expect(refreshed).toMatchObject({ nodeId: f.identity.nodeId, assignmentGeneration: assigned.generation, publicationRevision: body.revision, configHash: body.contentHash });
    expect((await db.seedRuntimeState.findUnique({ where: { queryId: f.queryId } })).collectorId).toBe(f.identity.nodeId);
  });
  it('treats challenge/login restrictions as a source manual pause', async () => {
    const f = await fixture(), grant = await f.claim(); await f.service.startAttempt(f.identity, { attemptId: grant.attemptId, grantToken: grant.grantToken });
    try { const control = await f.service.recordRestriction(f.identity, { attemptId: grant.attemptId, grantToken: grant.grantToken, expectedControlVersion: grant.sourceControlVersion, reason: 'META_LOGIN_REQUIRED', retryAfterMs: 0 }); expect(control.manualPause).toBe(true); expect((await f.service.acquireSourcePermit(f.identity, { attemptId: grant.attemptId, grantToken: grant.grantToken, requestKind: 'DETAIL' })).allowed).toBe(false); }
    finally { await f.service.setSourcePause({ actorUserId: f.admin.id, sourceKey: 'meta_ad_library', manualPause: false, reason: 'Synthetic test operator acknowledgment' }); }
  });
  it('enforces administrator-approved capacity and live resource backpressure', async () => {
    const f = await fixture(); await f.service.heartbeat(f.identity, { codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), resourceSnapshot: { pressure: 'HIGH', maxSlots: 999 } }); expect(await f.claim()).toMatchObject({ idle: true, reason: 'RESOURCE_BACKPRESSURE' });
    await f.service.heartbeat(f.identity, { codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), resourceSnapshot: { healthy: true, maxSlots: 999 } });
    const grant = await f.service.claimTask(f.identity, { requestId: randomUUID(), appliedRevision: f.manifest.revision, configHash: f.manifest.contentHash, availableSlots: 999, supportedModes: ['KEYWORD'], queryIds: [f.queryId] }); expect(grant.attemptId).toBeTruthy(); expect(await f.claim()).toMatchObject({ idle: true, reason: 'NO_RESOURCE_SLOT' });
    expect((await db.collectorNode.findUnique({ where: { nodeId: f.identity.nodeId } })).resourceSnapshot.maxSlots).toBe(1);
  });

  it('gives an unserved compatible query its turn before a recently served query', async () => {
    const f = await fixture(), secondId = randomUUID(), params = { ...f.params, keyword: 'fair-unserved-' + randomUUID() }, queryKey = legacyQueryIdentity('meta_ad_library', params).key;
    await db.seedQuery.create({ data: { id: secondId, dataSourceId: f.source.id, sourceKey: 'meta_ad_library', channel: f.channel, mode: 'KEYWORD', normalizedParams: params, queryKey, queryKeyVersion: 'legacy-1', adapterVersion: 'meta-service-dom-1', capabilityVersion: 'fixture', desiredEnabled: true, controlMode: 'TASK_CLAIM' } });
    const latest = await db.seedPublication.findFirst({ orderBy: { revision: 'desc' } }), manifest = { ...f.manifest, publicationId: randomUUID(), revision: latest.revision + 1, parentRevision: latest.revision, queries: [...f.manifest.queries, { ...f.manifest.queries[0], queryId: secondId, queryKey, params, nativeJobIds: ['fair-native-' + secondId] }] }; manifest.contentHash = seedManifestContentHash(manifest);
    await db.seedPublication.create({ data: { id: manifest.publicationId, revision: manifest.revision, parentRevision: manifest.parentRevision, manifestHash: manifest.contentHash, configSnapshot: { manifest }, reason: 'Fair scheduler synthetic fixture' } });
    await db.seedRuntimeState.create({ data: { queryId: secondId, dataSourceId: f.source.id, sourceKey: 'meta_ad_library', desiredRevision: manifest.revision } });
    await db.seedQueryBinding.create({ data: { queryId: secondId, ownerKind: 'LEGACY', legacyOwnerKey: 'fair-owner-' + secondId, ownerRevision: 1, validFromRevision: manifest.revision } });
    await db.seedRuntimeState.update({ where: { queryId: f.queryId }, data: { desiredRevision: manifest.revision, lastAttemptAt: f.now() } });
    await db.seedCollectorReceipt.create({ data: { publicationId: manifest.publicationId, publicationRevision: manifest.revision, manifestHash: manifest.contentHash, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, sequence: 2, type: 'APPLIED', applyStatus: 'APPLIED', payloadHash: sha('fair-fixture'), nativeJobMappings: manifest.queries.map((q: any) => ({ queryId: q.queryId, nativeJobId: q.nativeJobIds[0] })) } });
    await f.service.scheduleDueQueries({ actorUserId: f.admin.id, queryIds: [secondId] });
    const result = await f.service.claimTask(f.identity, { requestId: randomUUID(), appliedRevision: manifest.revision, configHash: manifest.contentHash, availableSlots: 1, supportedModes: ['KEYWORD'], queryIds: [f.queryId, secondId] }); expect(result.queryId).toBe(secondId);
  });
  it('never switches mode from a client claim of drain or before the old cutoff', async () => {
    const f = await fixture(); await f.service.assignSource({ actorUserId: f.admin.id, sourceKey: 'meta_ad_library', channel: f.channel, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, publicationRevision: f.manifest.revision, configHash: f.manifest.contentHash, controlMode: 'CONFIG_QUEUE' });
    const input = { actorUserId: f.admin.id, sourceKey: 'meta_ad_library' as const, channel: f.channel, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, publicationRevision: f.manifest.revision, configHash: f.manifest.contentHash, controlMode: 'TASK_CLAIM' as const, stopReceiptId: randomUUID() };
    await expect(f.service.switchSourceMode(input)).rejects.toMatchObject({ code: 'DRAIN_PROOF_REQUIRED' });
    const assignment = await db.collectorSourceAssignment.findFirst({ where: { sourceKey: 'meta_ad_library', channel: f.channel, state: 'ACTIVE' } });
    const proof = await db.seedCollectorReceipt.create({ data: { nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, sequence: 2, type: 'DRAINED', payloadHash: sha('mode-fixture'), payload: { sourceKey: 'meta_ad_library', assignmentGeneration: assignment.generation, pendingPreserved: true, pendingHashes: [] } } });
    await expect(f.service.switchSourceMode({ ...input, stopReceiptId: proof.id })).rejects.toMatchObject({ code: 'REQUEST_CUTOFF_NOT_ELAPSED' });
    expect((await db.collectorSourceAssignment.findUnique({ where: { id: assignment.id } })).state).toBe('ACTIVE');
    f.advance(4000); await f.service.heartbeat(f.identity, { codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), resourceSnapshot: { healthy: true } });
    const switched = await f.service.switchSourceMode({ ...input, stopReceiptId: proof.id }); expect(switched).toMatchObject({ generation: assignment.generation + 1, controlMode: 'TASK_CLAIM' });
    expect((await db.seedRuntimeState.findUnique({ where: { queryId: f.queryId } })).checkpointSequence).toBe(0);
  });

  it.each(['META_THEN_GOOGLE', 'GOOGLE_THEN_META'])('does not borrow another source applied hash (%s)', async order => {
    const f = await fixture(), identity = { ...f.identity, allowedSourceKeys: ['meta_ad_library', 'google_ads_transparency'] };
    await f.service.assignSource({ actorUserId: f.admin.id, sourceKey: 'meta_ad_library', channel: f.channel, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, publicationRevision: f.manifest.revision, configHash: f.manifest.contentHash, controlMode: 'CONFIG_QUEUE' });
    const googleId = randomUUID(), latest = await db.seedPublication.findFirst({ orderBy: { revision: 'desc' } }), full = { ...f.manifest, publicationId: randomUUID(), revision: latest.revision + 1, parentRevision: latest.revision, queries: [...f.manifest.queries, { ...f.manifest.queries[0], queryId: googleId, queryKey: sha(googleId), sourceKey: 'google_ads_transparency', channel: 'ATC', mode: 'DISCOVER', params: { country: 'US', language: 'en', kind: 'DISCOVER', term: 'synthetic' }, nativeJobIds: ['google-' + googleId] }] }; full.contentHash = seedManifestContentHash(full);
    await db.seedPublication.create({ data: { id: full.publicationId, revision: full.revision, parentRevision: full.parentRevision, manifestHash: full.contentHash, configSnapshot: { manifest: full }, reason: 'Two-source APPLIED fixture' } });
    const meta = { ...full, queries: [full.queries[0]] }, google = { ...full, queries: [full.queries[1]] }; meta.contentHash = seedManifestContentHash(meta); google.contentHash = seedManifestContentHash(google);
    const receipts = order === 'META_THEN_GOOGLE' ? [meta, google] : [google, meta];
    for (let i = 0; i < receipts.length; i++) { const scoped = receipts[i]; await db.seedCollectorReceipt.create({ data: { publicationId: full.publicationId, publicationRevision: full.revision, manifestHash: scoped.contentHash, nodeId: identity.nodeId, incarnationId: identity.incarnationId, sequence: i + 2, type: 'APPLIED', applyStatus: 'APPLIED', payloadHash: sha(order + i), nativeJobMappings: scoped.queries.map((q: any) => ({ queryId: q.queryId, nativeJobId: q.nativeJobIds[0] })) } }); }
    await db.seedRuntimeState.update({ where: { queryId: f.queryId }, data: { desiredRevision: full.revision } });
    const grant = await f.service.getPlatformGrant(identity, { sourceKey: 'meta_ad_library', channel: f.channel }); expect(grant).toMatchObject({ publicationRevision: full.revision, configHash: meta.contentHash, nodeId: identity.nodeId }); expect(grant.configHash).not.toBe(google.contentHash);
  });
  it('denies a restricted native runtime role even with the known prepared context', async () => {
    const f = await preparedFixture(), role = 'seed_runtime_' + randomUUID().replaceAll('-', '');
    await db.$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe('CREATE ROLE "' + role + '" NOLOGIN'); await tx.$executeRawUnsafe('GRANT USAGE ON SCHEMA meta_collector TO "' + role + '"'); await tx.$executeRawUnsafe('GRANT EXECUTE ON FUNCTION meta_collector.ingest(text) TO "' + role + '"');
      await tx.$executeRawUnsafe('SET LOCAL ROLE "' + role + '"');
      await tx.$queryRawUnsafe("SELECT set_config('seed_dispatch.execution',$1,true)", JSON.stringify({ kind: 'TASK', sourceKey: 'meta_ad_library', preparedId: f.pre.prepareToken.split('.')[0], attemptId: f.grant.attemptId, grantToken: f.grant.grantToken, recover: true }));
      await tx.$executeRawUnsafe('SAVEPOINT native_guard_fixture');
      await expect(tx.$queryRawUnsafe('SELECT meta_collector.ingest($1)', f.raw)).rejects.toThrow('RAW_OBJECT_NOT_DURABLE'); await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT native_guard_fixture');
      await tx.$executeRawUnsafe('SAVEPOINT native_audit_fixture'); await expect(tx.$executeRawUnsafe('INSERT INTO "AuditEvent"(id,action,"targetType",metadata) VALUES($1,$2,$3,$4::jsonb)', randomUUID(), 'SEED_RAW_OBJECT_DURABLE', 'CollectorDispatch', '{}')).rejects.toThrow('permission denied'); await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT native_audit_fixture');
      await tx.$executeRawUnsafe('RESET ROLE'); await tx.$executeRawUnsafe('REVOKE USAGE ON SCHEMA meta_collector FROM "' + role + '"'); await tx.$executeRawUnsafe('REVOKE EXECUTE ON FUNCTION meta_collector.ingest(text) FROM "' + role + '"'); await tx.$executeRawUnsafe('DROP ROLE "' + role + '"');
    });
  });

  it('drains an idle platform with its real source grant and never invents a task attempt', async () => {
    const f = await fixture(); await f.service.assignSource({ actorUserId: f.admin.id, sourceKey: 'meta_ad_library', channel: f.channel, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, publicationRevision: f.manifest.revision, configHash: f.manifest.contentHash, controlMode: 'CONFIG_QUEUE' });
    const grant = await f.service.getPlatformGrant(f.identity, { sourceKey: 'meta_ad_library', channel: f.channel });
    await f.service.requestStop({ actorUserId: f.admin.id, sourceKey: 'meta_ad_library', nodeId: f.identity.nodeId, reason: 'Synthetic source drain' });
    await expect(f.service.getPlatformGrant(f.identity, { sourceKey: 'meta_ad_library', channel: f.channel })).rejects.toMatchObject({ code: 'PLATFORM_ASSIGNMENT_REQUIRED' });
    const input = { sourceKey: 'meta_ad_library' as const, grantToken: grant.grantToken, requestId: randomUUID(), sequence: 2, pendingPreserved: true, pendingHashes: [] };
    const stopped = await f.service.acknowledgeSourceStop(f.identity, input); expect(await f.service.acknowledgeSourceStop(f.identity, input)).toEqual(stopped);
    expect(await db.seedTaskAttempt.count({ where: { nodeId: f.identity.nodeId } })).toBe(0);
    f.advance(4000); await f.service.heartbeat(f.identity, { codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), resourceSnapshot: { healthy: true } });
    const assigned = await f.service.switchSourceMode({ actorUserId: f.admin.id, sourceKey: 'meta_ad_library', channel: f.channel, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, publicationRevision: f.manifest.revision, configHash: f.manifest.contentHash, controlMode: 'TASK_CLAIM', stopReceiptId: stopped.receiptId }); expect(assigned.controlMode).toBe('TASK_CLAIM');
  });

  it('requires retirement of an idle source assignment before node reincarnation', async () => {
    const f = await fixture();
    await f.service.assignSource({ actorUserId: f.admin.id, sourceKey: 'meta_ad_library', channel: f.channel, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, publicationRevision: f.manifest.revision, configHash: f.manifest.contentHash, controlMode: 'CONFIG_QUEUE' });
    await expect(f.service.registerNode({ actorUserId: f.admin.id, nodeId: f.identity.nodeId, incarnationId: randomUUID(), registryRevision: 2, enabled: true, expiresAt: null, codeRevision: 'fixture', protocolVersions: [1] })).rejects.toMatchObject({ code: 'NODE_REINCARNATION_REQUIRES_RECOVERY' });
    expect((await db.collectorNode.findUnique({ where: { nodeId: f.identity.nodeId } })).incarnationId).toBe(f.identity.incarnationId);
  });
  it('replays an idle drain after its assignment was stopped and gives an explicit mode handoff proof', async () => {
    const f = await fixture();
    await f.service.assignSource({ actorUserId: f.admin.id, sourceKey: 'meta_ad_library', channel: f.channel, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, publicationRevision: f.manifest.revision, configHash: f.manifest.contentHash, controlMode: 'CONFIG_QUEUE' });
    const platform = await f.service.getPlatformGrant(f.identity, { sourceKey: 'meta_ad_library', channel: f.channel });
    const input = { sourceKey: 'meta_ad_library' as const, grantToken: platform.grantToken, requestId: randomUUID(), sequence: 2, pendingPreserved: true, pendingHashes: [] };
    await f.service.requestStop({ actorUserId: f.admin.id, nodeId: f.identity.nodeId, reason: 'Explicit central handoff stop' });
    const stop = await f.service.acknowledgeSourceStop(f.identity, input); f.advance(4000);
    await f.service.heartbeat(f.identity, { codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), resourceSnapshot: { healthy: true } });
    const next = await f.service.switchSourceMode({ actorUserId: f.admin.id, sourceKey: 'meta_ad_library', channel: f.channel, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, publicationRevision: f.manifest.revision, configHash: f.manifest.contentHash, controlMode: 'TASK_CLAIM', stopReceiptId: stop.receiptId });
    expect(await f.service.acknowledgeSourceStop(f.identity, input)).toEqual(stop);
    const request = { sourceKey: 'meta_ad_library' as const, fromMode: 'CONFIG_QUEUE' as const, toMode: 'TASK_CLAIM' as const, publicationRevision: f.manifest.revision, configHash: f.manifest.contentHash, requestId: randomUUID() };
    const proof = await f.service.readControlHandoff(f.identity, request);
    expect(proof).toMatchObject({ schemaVersion: 1, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, assignmentGeneration: next.generation, drainedReceiptId: stop.receiptId, ...request });
    expect(proof).not.toHaveProperty('grantToken'); expect(await f.service.readControlHandoff(f.identity, request)).toEqual(proof);
    await expect(f.service.readControlHandoff(f.identity, { ...request, requestId: randomUUID(), fromMode: 'LEGACY_QUEUE' })).rejects.toMatchObject({ code: 'CONTROL_HANDOFF_PROOF_REQUIRED' });
  });
  it('claims an actual imported node-affine Meta checkpoint only on the original node', async () => {
    const f = await fixture(), rollback = Error('ISOLATED_LEGACY_CLAIM_ROLLBACK');
    try { await db.$transaction(async (tx: any) => {
      const api = new Proxy(tx, { get(target, key) { return key === '$transaction' ? (run: any) => run(tx) : Reflect.get(target, key); } });
      const service = createCollectorDispatchService(api, f.serviceOptions), state = { schemaVersion: 3, jobs: [{ id: 'imported-' + randomUUID(), country: 'US', language: 'en', keyword: randomUUID(), seen: ['original-seen'], cursor: { page: 9 }, failures: 2, dueAt: 0 }], pauseUntil: 0 };
      const prepared = await prepareLegacyInventory(api, { actorUserId: f.admin.id, sourceKey: 'meta_ad_library', state, nodeId: f.identity.nodeId }), cp = prepared.checkpoints[0];
      const key = 'private-source-evidence/dispatch/meta_ad_library/' + cp.sha256 + '.bin'; f.objects.set(key, Buffer.from(cp.raw));
      await importLegacyInventory(api, { actorUserId: f.admin.id, sourceKey: 'meta_ad_library', state, nodeId: f.identity.nodeId, adapterVersion: 'meta-service-dom-1', checkpointRefs: { [cp.nativeJobId]: { reference: 'local-private:' + key, sha256: cp.sha256 } }, idempotencyKey: randomUUID(), reason: 'Actual legacy claim fixture' });
      const query = await tx.seedQuery.findUnique({ where: { id: cp.queryId } }), head = await tx.seedPublication.findFirst({ orderBy: { revision: 'desc' } });
      const manifest = { ...f.manifest, publicationId: randomUUID(), revision: head.revision + 1, parentRevision: head.revision, queries: [{ ...f.manifest.queries[0], queryId: query.id, channel: 'META', queryKey: query.queryKey, params: query.normalizedParams, nativeJobIds: [cp.nativeJobId] }] }; manifest.contentHash = seedManifestContentHash(manifest);
      await tx.seedPublication.create({ data: { id: manifest.publicationId, revision: manifest.revision, parentRevision: manifest.parentRevision, manifestHash: manifest.contentHash, configSnapshot: { manifest }, reason: 'Actual imported legacy publication' } });
      await tx.seedRuntimeState.update({ where: { queryId: query.id }, data: { desiredRevision: manifest.revision } });
      await tx.collectorSourceControl.update({ where: { sourceKey_channel_scopeKey: { sourceKey: 'meta_ad_library', channel: 'META', scopeKey: 'SOURCE' } }, data: { controlMode: 'TASK_CLAIM', notBefore: new Date(0), manualPause: false } });
      await tx.collectorSourceControl.updateMany({ where: { sourceKey: 'meta_ad_library', channel: '*' }, data: { notBefore: new Date(0), manualPause: false } });
      await tx.collectorSourceAssignment.updateMany({ where: { sourceKey: 'meta_ad_library', channel: { in: ['META', '*'] }, state: 'DRAINING' }, data: { state: 'STOPPED' } });
      const other = { ...f.identity, nodeId: 'other-' + randomUUID(), incarnationId: randomUUID() };
      await service.registerNode({ actorUserId: f.admin.id, ...other, registryRevision: 1, enabled: true, expiresAt: null, codeRevision: 'fixture', protocolVersions: [1] });
      await service.heartbeat(other, { codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), resourceSnapshot: { healthy: true } }); await service.verifyNode({ actorUserId: f.admin.id, ...other, codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), maxSlots: 1 });
      for (const [identity, sequence] of [[f.identity, 2], [other, 1]] as any) await tx.seedCollectorReceipt.create({ data: { publicationId: manifest.publicationId, publicationRevision: manifest.revision, manifestHash: manifest.contentHash, nodeId: identity.nodeId, incarnationId: identity.incarnationId, sequence, type: 'APPLIED', applyStatus: 'APPLIED', payloadHash: sha(identity.nodeId), nativeJobMappings: [{ queryId: query.id, nativeJobId: cp.nativeJobId }] } });
      await service.scheduleDueQueries({ actorUserId: f.admin.id, queryIds: [query.id] });
      const claim = { requestId: randomUUID(), appliedRevision: manifest.revision, configHash: manifest.contentHash, availableSlots: 1, supportedModes: ['KEYWORD'], queryIds: [query.id] };
      expect(await service.claimTask(other, claim)).toMatchObject({ idle: true });
      const grant: any = await service.claimTask(f.identity, { ...claim, requestId: randomUUID() }); expect(grant).toMatchObject({ queryId: query.id, checkpointSequence: 1 });
      const restored = await service.readCheckpoint(f.identity, { attemptId: grant.attemptId, grantToken: grant.grantToken, queryId: query.id }); expect(restored.sessionAffinity).toBe('node:' + f.identity.nodeId); expect(JSON.parse(restored.raw!).job.seen).toEqual(['original-seen']);
      throw rollback;
    }, { timeout: 30000 }); } catch (error) { if (error !== rollback) throw error; }
  });

  it('schedules every database page, keeps successful queries when one query fails, and notices a later query', async () => {
    const f = await fixture(), ids = Array.from({ length: 1005 }, () => randomUUID()), badId = ids[503];
    await db.seedQuery.createMany({ data: ids.map(id => ({ id, dataSourceId: f.source.id, sourceKey: 'meta_ad_library', channel: f.channel, mode: 'KEYWORD', normalizedParams: { ...f.params, keyword: id }, queryKey: sha(id), queryKeyVersion: 'legacy-1', adapterVersion: 'meta-service-dom-1', capabilityVersion: 'fixture', desiredEnabled: true, controlMode: 'TASK_CLAIM' })) });
    await db.seedRuntimeState.createMany({ data: ids.map(queryId => ({ queryId, dataSourceId: f.source.id, sourceKey: 'meta_ad_library', desiredRevision: f.manifest.revision })) });
    await db.seedQueryBinding.createMany({ data: ids.map(queryId => ({ queryId, ownerKind: 'LEGACY', legacyOwnerKey: 'scale-' + queryId, ownerRevision: 1, validFromRevision: f.manifest.revision })) });
    const functionName = 'seed_fixture_failure_' + randomUUID().replaceAll('-', '');
    await db.$executeRawUnsafe(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."queryId"='${badId}' THEN RAISE EXCEPTION 'SYNTHETIC_SCHEDULE_FAILURE'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER ${functionName} BEFORE INSERT ON "SeedExecutionTask" FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
    try {
      const result = await f.service.scheduleDueQueries({ actorUserId: f.admin.id, queryIds: ids }); expect(result).toMatchObject({ created: 1004, failed: 1 });
      expect(await db.seedExecutionTask.count({ where: { queryId: { in: ids }, state: 'READY' } })).toBe(1004);
    } finally { await db.$executeRawUnsafe(`DROP TRIGGER ${functionName} ON "SeedExecutionTask"`); await db.$executeRawUnsafe(`DROP FUNCTION ${functionName}()`); }
    expect(await f.service.scheduleDueQueries({ actorUserId: f.admin.id, queryIds: ids })).toMatchObject({ created: 1, failed: 0 });
    const late = randomUUID(); await db.seedQuery.create({ data: { id: late, dataSourceId: f.source.id, sourceKey: 'meta_ad_library', channel: f.channel, mode: 'KEYWORD', normalizedParams: { ...f.params, keyword: late }, queryKey: sha(late), queryKeyVersion: 'legacy-1', adapterVersion: 'meta-service-dom-1', capabilityVersion: 'fixture', desiredEnabled: true, controlMode: 'TASK_CLAIM' } });
    await db.seedRuntimeState.create({ data: { queryId: late, dataSourceId: f.source.id, sourceKey: 'meta_ad_library', desiredRevision: f.manifest.revision } }); await db.seedQueryBinding.create({ data: { queryId: late, ownerKind: 'LEGACY', legacyOwnerKey: 'late-' + late, ownerRevision: 1, validFromRevision: f.manifest.revision } });
    expect(await f.service.scheduleDueQueries({ actorUserId: f.admin.id, queryIds: [...ids, late] })).toMatchObject({ created: 1 });
    expect(await db.seedExecutionTask.count({ where: { queryId: late, state: 'READY' } })).toBe(1);
    const head = await db.seedPublication.findFirst({ orderBy: { revision: 'desc' } }), manifest = { ...f.manifest, publicationId: randomUUID(), revision: head.revision + 1, parentRevision: head.revision, queries: [...ids, late].map(id => ({ ...f.manifest.queries[0], queryId: id, queryKey: sha(id), params: { ...f.params, keyword: id }, nativeJobIds: ['scale-native-' + id] })) }; manifest.contentHash = seedManifestContentHash(manifest);
    await db.seedPublication.create({ data: { id: manifest.publicationId, revision: manifest.revision, parentRevision: manifest.parentRevision, manifestHash: manifest.contentHash, configSnapshot: { manifest }, reason: 'Large queue late query fairness fixture' } });
    await db.seedRuntimeState.updateMany({ where: { queryId: { in: ids } }, data: { desiredRevision: manifest.revision, lastAttemptAt: f.now() } }); await db.seedRuntimeState.update({ where: { queryId: late }, data: { desiredRevision: manifest.revision } });
    await db.seedCollectorReceipt.create({ data: { publicationId: manifest.publicationId, publicationRevision: manifest.revision, manifestHash: manifest.contentHash, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, sequence: 2, type: 'APPLIED', applyStatus: 'APPLIED', payloadHash: sha('large-fair-queue'), nativeJobMappings: manifest.queries.map((q: any) => ({ queryId: q.queryId, nativeJobId: q.nativeJobIds[0] })) } });
    const claim = await f.service.claimTask(f.identity, { requestId: randomUUID(), appliedRevision: manifest.revision, configHash: manifest.contentHash, availableSlots: 1, supportedModes: ['KEYWORD'] }); expect(claim.queryId).toBe(late);

  }, 120000);

  it('retires only after drain and cutoff, pauses new grants, and then allows a fresh incarnation', async () => {
    const f = await fixture(); await f.service.assignSource({ actorUserId: f.admin.id, sourceKey: 'meta_ad_library', channel: f.channel, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, publicationRevision: f.manifest.revision, configHash: f.manifest.contentHash, controlMode: 'CONFIG_QUEUE' });
    const grant = await f.service.getPlatformGrant(f.identity, { sourceKey: 'meta_ad_library', channel: f.channel });
    await f.service.requestStop({ actorUserId: f.admin.id, nodeId: f.identity.nodeId, reason: 'Explicit central retirement stop' });
    const stop = await f.service.acknowledgeSourceStop(f.identity, { sourceKey: 'meta_ad_library', grantToken: grant.grantToken, requestId: randomUUID(), sequence: 2, pendingPreserved: true, pendingHashes: [] });
    const args = { actorUserId: f.admin.id, sourceKey: 'meta_ad_library' as const, channel: f.channel, stopReceiptId: stop.receiptId, reason: 'Synthetic incarnation retirement' };
    await expect(f.service.retireSourceAssignment(args)).rejects.toMatchObject({ code: 'REQUEST_CUTOFF_NOT_ELAPSED' }); f.advance(4000);
    await f.service.heartbeat(f.identity, { codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), resourceSnapshot: { healthy: true } });
    expect(await f.service.retireSourceAssignment(args)).toMatchObject({ retired: true });
    expect(await db.collectorSourceControl.findUnique({ where: { sourceKey_channel_scopeKey: { sourceKey: 'meta_ad_library', channel: f.channel, scopeKey: 'SOURCE' } } })).toMatchObject({ manualPause: true, reason: 'SOURCE_ASSIGNMENT_RETIRED' });
    const identity = { ...f.identity, incarnationId: randomUUID() };
    await f.service.registerNode({ actorUserId: f.admin.id, ...identity, registryRevision: 2, enabled: true, expiresAt: null, codeRevision: 'fixture', protocolVersions: [1] });
    await f.service.heartbeat(identity, { codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), resourceSnapshot: { healthy: true } }); await f.service.verifyNode({ actorUserId: f.admin.id, ...identity, codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), maxSlots: 1 });
    await db.seedCollectorReceipt.create({ data: { publicationId: f.manifest.publicationId, publicationRevision: f.manifest.revision, manifestHash: f.manifest.contentHash, nodeId: identity.nodeId, incarnationId: identity.incarnationId, sequence: 1, type: 'APPLIED', applyStatus: 'APPLIED', payloadHash: sha('fresh-inc'), nativeJobMappings: [{ queryId: f.queryId, nativeJobId: f.manifest.queries[0].nativeJobIds[0] }] } });
    await f.service.assignSource({ actorUserId: f.admin.id, sourceKey: 'meta_ad_library', channel: f.channel, nodeId: identity.nodeId, incarnationId: identity.incarnationId, publicationRevision: f.manifest.revision, configHash: f.manifest.contentHash, controlMode: 'TASK_CLAIM' });
    expect(await f.service.claimTask(identity, { requestId: randomUUID(), appliedRevision: f.manifest.revision, configHash: f.manifest.contentHash, availableSlots: 1, supportedModes: ['KEYWORD'], queryIds: [f.queryId] })).toMatchObject({ idle: true, reason: 'NO_COMPATIBLE_TASK' });
    await f.service.setSourcePause({ actorUserId: f.admin.id, sourceKey: 'meta_ad_library', manualPause: false, reason: 'Explicit source-wide operator resume after reassignment' });
    expect(await f.service.claimTask(identity, { requestId: randomUUID(), appliedRevision: f.manifest.revision, configHash: f.manifest.contentHash, availableSlots: 1, supportedModes: ['KEYWORD'], queryIds: [f.queryId] })).toMatchObject({ queryId: f.queryId });
  });
  it('serializes platform slots across sources on one node and applies resource backpressure', async () => {
    const f = await fixture(), googleId = randomUUID(), googleParams = { kind: 'DISCOVER', country: 'US', language: 'en', term: randomUUID() }, identity = { ...f.identity, allowedSourceKeys: ['meta_ad_library', 'google_ads_transparency'] };
    const source = await db.dataSource.upsert({ where: { key: 'google_ads_transparency' }, create: { key: 'google_ads_transparency', name: 'Synthetic slot fixture', adapterVersion: 'google-service-dom-1', status: 'ACTIVE' }, update: { status: 'ACTIVE' } });
    const googleChannel = f.channel + '-google'; await db.seedQuery.create({ data: { id: googleId, dataSourceId: source.id, sourceKey: source.key, channel: googleChannel, mode: 'DISCOVER', normalizedParams: googleParams, queryKey: legacyQueryIdentity(source.key, googleParams).key, queryKeyVersion: 'legacy-1', adapterVersion: 'google-service-dom-1', capabilityVersion: 'fixture', desiredEnabled: true } });
    const head = await db.seedPublication.findFirst({ orderBy: { revision: 'desc' } }), manifest = { ...f.manifest, publicationId: randomUUID(), revision: head.revision + 1, parentRevision: head.revision, queries: [...f.manifest.queries, { ...f.manifest.queries[0], queryId: googleId, sourceKey: source.key, channel: googleChannel, mode: 'DISCOVER', queryKey: legacyQueryIdentity(source.key, googleParams).key, params: googleParams, nativeJobIds: ['slot-' + googleId] }] }; manifest.contentHash = seedManifestContentHash(manifest);
    await db.seedPublication.create({ data: { id: manifest.publicationId, revision: manifest.revision, parentRevision: manifest.parentRevision, manifestHash: manifest.contentHash, configSnapshot: { manifest }, reason: 'Cross-source node slot fixture' } }); await db.seedRuntimeState.create({ data: { queryId: googleId, dataSourceId: source.id, sourceKey: source.key, desiredRevision: manifest.revision } }); await db.seedRuntimeState.update({ where: { queryId: f.queryId }, data: { desiredRevision: manifest.revision } });
    await db.seedQueryBinding.create({ data: { queryId: googleId, ownerKind: 'LEGACY', legacyOwnerKey: 'slot-' + googleId, ownerRevision: 1, validFromRevision: manifest.revision } });
    await db.seedCollectorReceipt.create({ data: { publicationId: manifest.publicationId, publicationRevision: manifest.revision, manifestHash: manifest.contentHash, nodeId: identity.nodeId, incarnationId: identity.incarnationId, sequence: 2, type: 'APPLIED', applyStatus: 'APPLIED', payloadHash: sha('slot-fixture'), nativeJobMappings: manifest.queries.map((q: any) => ({ queryId: q.queryId, nativeJobId: q.nativeJobIds[0] })) } });
    const googleGlobal = await db.collectorSourceControl.findFirst({ where: { sourceKey: source.key, channel: '*' } }); if (googleGlobal?.notBefore > f.now()) f.advance(googleGlobal.notBefore.valueOf() - f.now().valueOf() + 1000);
    await f.service.heartbeat(identity, { codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), resourceSnapshot: { healthy: true } });
    for (const [sourceKey, channel] of [['meta_ad_library', f.channel], [source.key, googleChannel]] as any) await f.service.assignSource({ actorUserId: f.admin.id, sourceKey, channel, nodeId: identity.nodeId, incarnationId: identity.incarnationId, publicationRevision: manifest.revision, configHash: manifest.contentHash, controlMode: 'CONFIG_QUEUE' });
    const metaGrant = await f.service.getPlatformGrant(identity, { sourceKey: 'meta_ad_library', channel: f.channel }), googleGrant = await f.service.getPlatformGrant(identity, { sourceKey: source.key, channel: googleChannel });
    const inputs: any[] = [{ sourceKey: 'meta_ad_library', queryId: f.queryId, channel: f.channel, mode: 'KEYWORD', nativeParams: f.params, grantToken: metaGrant.grantToken }, { sourceKey: source.key, queryId: googleId, channel: googleChannel, mode: 'DISCOVER', nativeParams: googleParams, grantToken: googleGrant.grantToken }].map(v => ({ ...v, requestKind: 'UNIT_START', requestId: randomUUID() }));
    await f.service.heartbeat(identity, { codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), resourceSnapshot: { pressure: 'HIGH' } });
    expect(await f.service.platformPermit(identity, inputs[0])).toMatchObject({ allowed: false, reason: 'RESOURCE_BACKPRESSURE' });
    await f.service.heartbeat(identity, { codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), resourceSnapshot: { healthy: true } });
    const permits = await Promise.all(inputs.map(input => f.service.platformPermit(identity, input))); expect(permits.filter(p => p.allowed)).toHaveLength(1); expect(permits.find(p => !p.allowed)?.reason).toBe('NO_RESOURCE_SLOT');
    expect(await db.seedTaskAttempt.count({ where: { nodeId: identity.nodeId, state: 'RUNNING' } })).toBe(1);
  });
  it('does not assign while the existing app worker has a valid source lease', async () => {
    const f = await fixture(), task = await db.collectionTask.create({ data: { dataSourceId: f.source.id, name: 'Synthetic old worker', query: {} } });
    const run = await db.collectionRun.create({ data: { taskId: task.id, dataSourceId: f.source.id, idempotencyKey: 'old-worker-' + randomUUID(), querySnapshot: {}, adapterVersion: 'fixture', status: 'RUNNING', leaseExpiresAt: new Date(f.now().valueOf() + 60000) } });
    try { await expect(f.service.assignSource({ actorUserId: f.admin.id, sourceKey: 'meta_ad_library', channel: f.channel, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, publicationRevision: f.manifest.revision, configHash: f.manifest.contentHash, controlMode: 'CONFIG_QUEUE' })).rejects.toMatchObject({ code: 'LEGACY_SOURCE_LEASE_ACTIVE' }); }
    finally { await db.collectionRun.update({ where: { id: run.id }, data: { status: 'CANCELED' } }); }
  });

  it('drains an idle TASK assignment without an execution token, then hands off to CONFIG', async () => {
    const f = await fixture(), assigned = await f.service.assignSource({ actorUserId: f.admin.id, sourceKey: 'meta_ad_library', channel: f.channel, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, publicationRevision: f.manifest.revision, configHash: f.manifest.contentHash, controlMode: 'TASK_CLAIM' });
    const input = { sourceKey: 'meta_ad_library' as const, assignmentGeneration: assigned.generation, requestId: randomUUID(), sequence: 2, pendingPreserved: true, pendingHashes: [] };
    expect(await f.service.readSourceStopContext(f.identity, { sourceKey: 'meta_ad_library' })).toMatchObject({ schemaVersion: 1, scope: 'source_stop', state: 'ACTIVE', assignmentGeneration: assigned.generation });
    await expect(f.service.acknowledgeSourceStop(f.identity, input)).rejects.toMatchObject({ code: 'TASK_SOURCE_DRAIN_REQUIRED' });
    await f.service.requestStop({ actorUserId: f.admin.id, sourceKey: 'meta_ad_library', nodeId: f.identity.nodeId, reason: 'Explicit TASK source drain' });
    const metadata = await f.service.readSourceStopContext(f.identity, { sourceKey: 'meta_ad_library' }); expect(metadata.state).toBe('DRAINING'); expect(metadata).not.toHaveProperty('grantToken');
    await expect(f.service.acknowledgeSourceStop(f.identity, { ...input, assignmentGeneration: assigned.generation + 1 })).rejects.toMatchObject({ code: 'TASK_SOURCE_DRAIN_REQUIRED' });
    const stopped = await f.service.acknowledgeSourceStop(f.identity, input); expect(await f.service.acknowledgeSourceStop(f.identity, input)).toEqual(stopped);
    f.advance(4000); await f.service.heartbeat(f.identity, { codeRevision: 'fixture', capabilityDigest: 'a'.repeat(64), resourceSnapshot: { healthy: true } });
    const next = await f.service.switchSourceMode({ actorUserId: f.admin.id, sourceKey: 'meta_ad_library', channel: f.channel, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, publicationRevision: f.manifest.revision, configHash: f.manifest.contentHash, controlMode: 'CONFIG_QUEUE', stopReceiptId: stopped.receiptId });
    expect(await f.service.acknowledgeSourceStop(f.identity, input)).toEqual(stopped);
    expect(await f.service.readControlHandoff(f.identity, { sourceKey: 'meta_ad_library', fromMode: 'TASK_CLAIM', toMode: 'CONFIG_QUEUE', publicationRevision: f.manifest.revision, configHash: f.manifest.contentHash, requestId: randomUUID() })).toMatchObject({ assignmentGeneration: next.generation, drainedReceiptId: stopped.receiptId });
    const busy = await fixture(); const owner = await busy.service.assignSource({ actorUserId: busy.admin.id, sourceKey: 'meta_ad_library', channel: busy.channel, nodeId: busy.identity.nodeId, incarnationId: busy.identity.incarnationId, publicationRevision: busy.manifest.revision, configHash: busy.manifest.contentHash, controlMode: 'TASK_CLAIM' }); await busy.claim();
    await busy.service.requestStop({ actorUserId: busy.admin.id, sourceKey: 'meta_ad_library', nodeId: busy.identity.nodeId, reason: 'Busy TASK source drain' });
    await expect(busy.service.acknowledgeSourceStop(busy.identity, { ...input, requestId: randomUUID(), assignmentGeneration: owner.generation })).rejects.toMatchObject({ code: 'SOURCE_RECOVERY_REQUIRED' });
  });
  it.each([
    [{ coverage: { reason: 'EXPLICIT_NO_RESULTS', exhausted: true } }, 'RELIABLE_NO_RESULTS'],
    [{ status: 'PARTIAL', errorCode: 'META_HTTP_429', coverage: { reason: 'EXPLICIT_NO_RESULTS', exhausted: true } }, 'RATE_LIMITED'],
    [{ status: 'FAILED', errorCode: 'META_TIMEOUT' }, 'TIMEOUT'],
    [{ status: 'NO_RESULTS', errorCode: 'META_SOURCE_CHALLENGE', coverage: { reason: 'EXPLICIT_NO_RESULTS' } }, 'FAILED'],
  ])('records actual native batch evidence as a PostgreSQL outcome (%s)', async (batch, outcome) => {
    const f = await preparedFixture(batch); await f.service.submitManagedUnit(f.identity, f.input);
    const fact = await db.seedAttempt.findUnique({ where: { sourceKey_batchSha256: { sourceKey: 'meta_ad_library', batchSha256: sha(f.raw) } } }); expect(fact.outcome).toBe(outcome); expect(fact.exhausted).toBe(outcome === 'RELIABLE_NO_RESULTS'); expect(fact.fetchedCount).toBe(0);
  });

  it('guards managed LEGACY and retired sources while preserving never-managed source compatibility', async () => {
    const f = await fixture(), rollback = Error('LEGACY_MANAGED_GUARD_TEST_ROLLBACK');
    try { await db.$transaction(async (tx: any) => {
      const api = new Proxy(tx, { get(target, key) { return key === '$transaction' ? (run: any) => run(tx) : Reflect.get(target, key); } }), service = createCollectorDispatchService(api, f.serviceOptions);
      await tx.collectorSourceControl.updateMany({ where: { sourceKey: 'meta_ad_library' }, data: { controlMode: 'LEGACY_QUEUE' } });
      const assigned = await service.assignSource({ actorUserId: f.admin.id, sourceKey: 'meta_ad_library', channel: f.channel, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, publicationRevision: f.manifest.revision, configHash: f.manifest.contentHash, controlMode: 'LEGACY_QUEUE' });
      const raw = JSON.stringify({ sourceKey: 'meta_ad_library', platform: 'META', version: 'meta-service-dom-1', query: f.params, observedAt: new Date().toISOString(), status: 'NO_RESULTS', ads: [], evidence: [], coverage: { reason: 'EXPLICIT_NO_RESULTS' } });
      await tx.$queryRawUnsafe("SELECT set_config('seed_dispatch.execution','',true)");
      await tx.$executeRawUnsafe('SAVEPOINT legacy_managed_guard'); await expect(tx.$queryRawUnsafe('SELECT meta_collector.ingest($1)', raw)).rejects.toThrow('MANAGED_INGEST_REQUIRED'); await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT legacy_managed_guard');
      const platform = await service.getPlatformGrant(f.identity, { sourceKey: 'meta_ad_library', channel: f.channel }), permit = await service.platformPermit(f.identity, { sourceKey: 'meta_ad_library', grantToken: platform.grantToken, queryId: f.queryId, nativeJobId: f.manifest.queries[0].nativeJobIds[0], mode: 'KEYWORD', channel: f.channel, nativeParams: f.params, requestKind: 'UNIT_START', requestId: randomUUID() });
      const pre = await service.prepareSubmission(f.identity, { requestId: randomUUID(), context: permit.context!, rawSha: sha(raw), expectedBatchHashes: [sha(raw)], sidecarHash: sha('legacy-private-sidecar'), sidecarRef: 'local-private:old/pending.json' });
      expect(await service.submitManagedUnit(f.identity, { requestId: randomUUID(), sourceKey: 'meta_ad_library', prepareToken: pre.prepareToken, batchHash: sha(raw), raw })).toMatchObject({ status: 'IMPORTED' });
      await tx.collectorSourceAssignment.update({ where: { id: assigned.id }, data: { state: 'STOPPED' } });
      await tx.$executeRawUnsafe('SAVEPOINT legacy_retired_guard'); await expect(tx.$queryRawUnsafe('SELECT meta_collector.ingest($1)', raw + ' ')).rejects.toThrow('MANAGED_INGEST_REQUIRED'); await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT legacy_retired_guard');
      const pendingRaw = JSON.stringify({ ...JSON.parse(raw), observedAt: new Date(Date.now() + 1).toISOString() });
      await service.registerLegacyPending({ actorUserId: f.admin.id, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, sourceKey: 'meta_ad_library', rawSha: sha(pendingRaw), batchHashes: [sha(pendingRaw)], reason: 'Known original pending after retirement' });
      expect(await service.recoverSubmit(f.identity, { requestId: randomUUID(), sourceKey: 'meta_ad_library', rawSha: sha(pendingRaw), batchHash: sha(pendingRaw), raw: pendingRaw })).toMatchObject({ status: 'IMPORTED', committedCheckpointSequence: null });
      // An unregistered source with no control/assignment rows keeps its old
      // optional hook behavior. No facts or production tables are touched.
      await tx.$executeRawUnsafe('SELECT seed_dispatch.guard_native_ingest($1,$2)', 'synthetic_never_managed_' + randomUUID(), '{}');
      await tx.collectorSourceAssignment.deleteMany({ where: { sourceKey: 'snapchat_ads_gallery' } }); await tx.collectorSourceControl.deleteMany({ where: { sourceKey: 'snapchat_ads_gallery' } });
      await tx.dataSource.upsert({ where: { key: 'snapchat_ads_gallery' }, create: { key: 'snapchat_ads_gallery', name: 'Never managed legacy compatibility fixture', adapterVersion: 'snapchat-service-public-1', status: 'ACTIVE' }, update: {} });
      const legacyRaw = JSON.stringify({ sourceKey: 'snapchat_ads_gallery', platform: 'SNAPCHAT', version: 'snapchat-service-public-1', query: { publisher: 'untouched-old-source-' + randomUUID(), country: 'FR' }, observedAt: new Date().toISOString(), status: 'NO_RESULTS', ads: [], evidence: [], coverage: { reason: 'EXPLICIT_NO_RESULTS' } });
      const oldReceipt = await tx.$queryRawUnsafe('SELECT snapchat_collector.ingest($1) AS receipt', legacyRaw); expect(oldReceipt[0].receipt.status).toBe('IMPORTED');
      throw rollback;
    }, { timeout: 30000 }); } catch (error) { if (error !== rollback) throw error; }
  });

  it('advances platform auth to a scoped empty APPLIED manifest after the final owner is removed', async () => {
    const f = await fixture(); await f.service.assignSource({ actorUserId: f.admin.id, sourceKey: 'meta_ad_library', channel: f.channel, nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, publicationRevision: f.manifest.revision, configHash: f.manifest.contentHash, controlMode: 'CONFIG_QUEUE' });
    const head = await db.seedPublication.findFirst({ orderBy: { revision: 'desc' } }), empty = { ...f.manifest, publicationId: randomUUID(), revision: head.revision + 1, parentRevision: head.revision, queries: [], bindings: [], tombstones: [{ queryId: f.queryId, reason: 'NO_PUBLISHED_OWNER' }] }; empty.contentHash = seedManifestContentHash(empty);
    await db.seedPublication.create({ data: { id: empty.publicationId, revision: empty.revision, parentRevision: empty.parentRevision, manifestHash: empty.contentHash, configSnapshot: { manifest: empty }, reason: 'Final owner removed fixture' } }); await db.seedQuery.update({ where: { id: f.queryId }, data: { desiredEnabled: false } }); await db.seedRuntimeState.update({ where: { queryId: f.queryId }, data: { desiredRevision: empty.revision } });
    await acceptConfigReceipt(db, { trustedNodeId: f.identity.nodeId, sourceScopes: ['meta_ad_library'], receipt: { nodeId: f.identity.nodeId, incarnationId: f.identity.incarnationId, sequence: 2, publicationId: empty.publicationId, publicationRevision: empty.revision, manifestHash: empty.contentHash, applyStatus: 'APPLIED', nativeJobMappings: [] } });
    const platform = await f.service.getPlatformGrant(f.identity, { sourceKey: 'meta_ad_library', channel: f.channel }); expect(platform).toMatchObject({ publicationRevision: empty.revision, configHash: empty.contentHash });
    await expect(f.service.platformPermit(f.identity, { sourceKey: 'meta_ad_library', grantToken: platform.grantToken, queryId: f.queryId, mode: 'KEYWORD', channel: f.channel, requestKind: 'UNIT_START', requestId: randomUUID() })).rejects.toMatchObject({ code: 'CONFIG_QUERY_MISMATCH' });
    expect(await db.seedTaskAttempt.count({ where: { nodeId: f.identity.nodeId } })).toBe(0);
  });

});
