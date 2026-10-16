import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonicalNativeParams } from '@ad-research/contracts/seed-native-query';
import { seedCanonical, type SourceKey } from '@ad-research/contracts/seeds';
import { validateCheckpointEnvelope, type ExecutionGrant, type SourceControlSnapshot } from '@ad-research/contracts/seed-dispatch';
import { DomainError, requirePlatformAdmin } from '../team/access';
import { scopeManifest } from '../seed-library/publications';
import { legacyQueryIdentity } from '../seed-library/legacy-query-key';
import { collectorEvidenceKey } from './evidence-store';
import { classifyNativeOutcome } from './outcome';
import type { AdminInput, AttemptInput, ClaimInput, CommitReceipt, ControlHandoffInput, ControlHandoffProof, DispatchOptions, ExecutionContext, MachineIdentity, PermitResult, PlatformGrant, PrepareInput, RecoverInput, RegisterNodeInput, SubmitInput, VerifyNodeInput } from './types';

const ACTIVE = ['LEASED', 'RUNNING', 'STOP_REQUESTED', 'COMMIT_PENDING'];
const OCCUPIED = [...ACTIVE, 'RECOVERING', 'RECOVERY_BLOCKED'];
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function fail(code: string, status = 409): never { throw new DomainError(status, code); }
const hashPattern = /^[a-f0-9]{64}$/;
const iso = (date: Date | string) => new Date(date).toISOString();
const equal = (left: string, right: string) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const nativeParams = (source: SourceKey, mode: string, value: Record<string, unknown>) => canonicalNativeParams(source, mode, { ...value, channel: undefined, mode: undefined });
const sameNative = (source: SourceKey, mode: string, a: Record<string, unknown>, b: Record<string, unknown>) => seedCanonical(nativeParams(source, mode, a)) === seedCanonical(nativeParams(source, mode, b));
const nativeNextAt = (raw: string | undefined, channel: string) => { if (!raw) return 0; let s: any; try { s = JSON.parse(raw); } catch { fail('CHECKPOINT_NATIVE_STATE_INVALID'); } const j = s.job ?? {}, state = s.sourceState ?? {}; return Math.max(0, ...[j.dueAt, j.retryAt, state.pauseUntil, state.nextBatchAt, state.pauses?.[channel]].map(v => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)); };
const cleanBinding = (b: any) => ({ queryId: b.queryId, ownerKind: b.ownerKind, seedId: b.seedId, scanPlanId: b.scanPlanId, legacyOwnerKey: b.legacyOwnerKey, ownerRevision: b.ownerRevision, participationStatus: b.participationStatus, purposeSnapshot: b.purposeSnapshot, validFromRevision: b.validFromRevision, validToRevision: b.validToRevision });

/** All identities here come from the HTTP credential resolver, never request JSON. */
export function createCollectorDispatchService(db: any, options: DispatchOptions) {
  if (options.tokenSecret.length < 32 || options.leaseMs <= options.requestBudgetMs + options.exitMarginMs || options.requestBudgetMs <= 0 || options.exitMarginMs <= 0 || options.cycleMs <= 0 || options.requestSpacingMs < 0 || options.unknownOutcomeBackoffMs <= 0) fail('DISPATCH_CONFIG_INVALID', 503);
  const now = () => options.now?.() ?? new Date();
  const txRun = <T>(fn: (tx: any) => Promise<T>) => db.$transaction(fn, { timeout: 15000 });
  const lock = (tx: any, key: string) => tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', 'seed-dispatch:' + key);
  const token = (kind: string, record: any) => `${record.id}.${createHmac('sha256', options.tokenSecret).update(seedCanonical({ kind, id: record.id, nodeId: record.nodeId, incarnationId: record.incarnationId, generation: record.assignmentGeneration ?? record.generation, leaseVersion: record.leaseVersion ?? null })).digest('hex')}`;
  const preparedToken = (id: string) => `${id}.${createHmac('sha256', options.tokenSecret).update('seed-prepared:' + id).digest('hex')}`;
  const audit = (tx: any, action: string, targetId: string | null, metadata: any, actorUserId?: string, requestId?: string) => tx.auditEvent.create({ data: { action, targetType: 'CollectorDispatch', targetId, metadata, actorUserId, requestId } });
  async function machine(tx: any, identity: MachineIdentity, source?: string, executable = false) {
    if (source && !identity.allowedSourceKeys.includes(source as SourceKey)) fail('MACHINE_SOURCE_FORBIDDEN', 403);
    const node = await tx.collectorNode.findUnique({ where: { nodeId: identity.nodeId } });
    if (!node || node.incarnationId !== identity.incarnationId) fail('MACHINE_IDENTITY_REJECTED', 403);
    if (executable && (!node.enabled || (node.expiresAt && node.expiresAt <= now()) || node.status !== 'STANDBY_READY' || !node.lastHeartbeatAt || now().valueOf() - node.lastHeartbeatAt.valueOf() > options.leaseMs)) fail('NODE_NOT_EXECUTABLE');
    return node;
  }
  async function sourceControls(tx: any, sourceKey: string, channel: string) {
    await lock(tx, 'source:' + sourceKey);
    const source = await tx.dataSource.findUnique({ where: { key: sourceKey } });
    if (!source) fail('SOURCE_NOT_FOUND');
    const inherited = await tx.collectorSourceControl.findUnique({ where: { sourceKey_channel_scopeKey: { sourceKey, channel: '*', scopeKey: 'SOURCE' } } });
    const exact = await tx.collectorSourceControl.upsert({ where: { sourceKey_channel_scopeKey: { sourceKey, channel, scopeKey: 'SOURCE' } }, create: { dataSourceId: source.id, sourceKey, channel, scopeKey: 'SOURCE', notBefore: new Date(0), controlMode: inherited?.controlMode ?? 'LEGACY_QUEUE', assignmentGeneration: inherited?.assignmentGeneration ?? 0 }, update: {} });
    const global = await tx.collectorSourceControl.findUnique({ where: { sourceKey_channel_scopeKey: { sourceKey, channel: '*', scopeKey: 'SOURCE' } } });
    const rows = global && global.id !== exact.id ? [exact, global] : [exact];
    const limiting = rows.reduce((a, b) => a.notBefore >= b.notBefore ? a : b);
    const snapshot: SourceControlSnapshot = { sourceKey: sourceKey as SourceKey, channel, scopeKey: 'SOURCE', notBefore: iso(limiting.notBefore), retryAfterUntil: rows.filter(c => c.retryAfterUntil).sort((a, b) => b.retryAfterUntil - a.retryAfterUntil)[0]?.retryAfterUntil?.toISOString() ?? null, manualPause: rows.some(c => c.manualPause), restrictionCount: rows.reduce((sum, c) => sum + c.restrictionCount, 0), controlVersion: Math.max(...rows.map(c => c.controlVersion)), reason: limiting.reason, lastEvidenceAt: limiting.lastEvidenceAt?.toISOString() ?? null };
    const draining = await tx.collectorSourceAssignment.count({ where: { sourceKey, channel: { in: [channel, '*'] }, state: 'DRAINING' } });
    return { source, exact, snapshot, allowed: !draining && source.status === 'ACTIVE' && !snapshot.manualPause && new Date(snapshot.notBefore) <= now() };
  }
  async function applied(tx: any, identity: MachineIdentity, revision: number, configHash: string, queryId?: string, sourceKey?: SourceKey) {
    const publication = await tx.seedPublication.findUnique({ where: { revision } });
    if (!publication || publication.status !== 'PUBLISHED') fail('CONFIG_NOT_PUBLISHED');
    const full = publication.configSnapshot.manifest ?? publication.configSnapshot;
    const tombstones = await tx.seedQuery.findMany({ where: { id: { in: full.tombstones.map((t: any) => t.queryId) } }, select: { id: true, sourceKey: true } });
    const source = sourceKey ?? full.queries.find((q: any) => q.queryId === queryId)?.sourceKey;
    if (source && !identity.allowedSourceKeys.includes(source)) fail('MACHINE_SOURCE_FORBIDDEN', 403);
    const choices = [[...identity.allowedSourceKeys], ...(source ? [[source]] : identity.allowedSourceKeys.map(s => [s]))];
    const scoped = choices.map(scopes => scopeManifest(full, scopes, new Map(tombstones.map((q: any) => [q.id, q.sourceKey])))).find(manifest => manifest.contentHash === configHash);
    if (!scoped) fail('CONFIG_HASH_MISMATCH');
    const node = await machine(tx, identity);
    if (!node.protocolVersions.some((p: number) => p >= scoped.protocolMin && p <= scoped.protocolMax)) fail('PROTOCOL_INCOMPATIBLE');
    const receipt = await tx.seedCollectorReceipt.findFirst({ where: { nodeId: identity.nodeId, incarnationId: identity.incarnationId, publicationRevision: revision, manifestHash: configHash, type: 'APPLIED', applyStatus: 'APPLIED' }, orderBy: { sequence: 'desc' } });
    if (!receipt) fail('CONFIG_NOT_APPLIED');
    const mappings = receipt.nativeJobMappings?.length ? receipt.nativeJobMappings : receipt.payload?.nativeJobMappings ?? [];
    if (queryId && !mappings.some((m: any) => m.queryId === queryId && scoped.queries.some(q => q.queryId === queryId && q.nativeJobIds.includes(m.nativeJobId)))) fail('NATIVE_MAPPING_MISSING');
    return scoped;
  }
  async function owners(tx: any, queryId: string, revision: number) {
    const rows = await tx.seedQueryBinding.findMany({ where: { queryId, participationStatus: 'ACTIVE', validFromRevision: { lte: revision }, OR: [{ validToRevision: null }, { validToRevision: { gt: revision } }] }, orderBy: [{ ownerKind: 'asc' }, { id: 'asc' }] });
    if (!rows.length) fail('NO_PUBLISHED_OWNER');
    return rows.map(cleanBinding);
  }
  async function attempt(tx: any, identity: MachineIdentity, input: AttemptInput, active = true) {
    const a = await tx.seedTaskAttempt.findUnique({ where: { id: input.attemptId }, include: { task: { include: { query: true } } } });
    if (!a) fail('LEASE_LOST');
    const node = await machine(tx, identity, a.sourceKey);
    if (a.nodeId !== identity.nodeId || a.incarnationId !== identity.incarnationId || !equal(a.tokenHash, sha(input.grantToken)) || !equal(input.grantToken, token('attempt', a))) fail('LEASE_LOST');
    if (active && (!ACTIVE.includes(a.state) || a.leaseExpiresAt <= now() || a.task.query.assignmentGeneration !== a.assignmentGeneration)) fail('LEASE_LOST');
    if (active) await machine(tx, identity, a.sourceKey, true);
    return { a, node, q: a.task.query };
  }
  async function grant(tx: any, a: any): Promise<ExecutionGrant> {
    const q = a.task?.query ?? await tx.seedQuery.findUnique({ where: { id: (a.task ?? await tx.seedExecutionTask.findUnique({ where: { id: a.taskId } })).queryId } });
    const runtime = await tx.seedRuntimeState.findUnique({ where: { queryId: q.id } });
    const control = await sourceControls(tx, q.sourceKey, q.channel);
    return { schemaVersion: 1, protocolVersion: 1, grantToken: token('attempt', a), nodeId: a.nodeId, incarnationId: a.incarnationId, sourceKey: a.sourceKey, queryId: q.id, taskId: a.taskId, attemptId: a.id, assignmentGeneration: a.assignmentGeneration, leaseVersion: a.leaseVersion, publicationRevision: a.publicationRevision, configHash: a.configHash, checkpointSequence: a.checkpointSequence, checkpointRef: runtime?.checkpointRef ?? null, sourceControlVersion: control.snapshot.controlVersion, serverNow: iso(now()), validUntil: iso(a.leaseExpiresAt), requestDeadline: iso(a.requestDeadline ?? new Date(Math.min(now().valueOf() + options.requestBudgetMs, a.leaseExpiresAt.valueOf() - options.exitMarginMs))), nativeParams: { ...q.normalizedParams, mode: q.mode, channel: q.channel } };
  }
  const contextOf = (g: ExecutionGrant): ExecutionContext => ({ grantToken: g.grantToken, sourceKey: g.sourceKey, queryId: g.queryId, taskId: g.taskId, attemptId: g.attemptId, assignmentGeneration: g.assignmentGeneration, leaseVersion: g.leaseVersion, publicationRevision: g.publicationRevision, configHash: g.configHash, mode: String(g.nativeParams.mode), channel: String(g.nativeParams.channel), nativeParams: g.nativeParams });
  async function persist(sourceKey: SourceKey, raw: string, expectedHash: string) {
    if (!hashPattern.test(expectedHash) || sha(raw) !== expectedHash) fail('RAW_HASH_MISMATCH', 400);
    const key = collectorEvidenceKey({ prefix: options.evidencePrefix, sourceKey }, expectedHash), store = await options.storeForSource(sourceKey), bytes = Buffer.from(raw, 'utf8');
    await store.putIfAbsent(key, bytes, expectedHash);
    const stored = Buffer.from(await store.get(key));
    if (!stored.equals(bytes) || sha(stored) !== expectedHash) fail('RAW_OBJECT_NOT_DURABLE');
    return { key, reference: `${options.evidenceScheme}:${key}`, sha256: expectedHash, bytes: bytes.byteLength };
  }
  async function checkpointObject(sourceKey: SourceKey, input: SubmitInput, queryId: string) {
    if (!input.checkpoint) return null;
    let envelope = validateCheckpointEnvelope(input.checkpoint);
    if (envelope.queryId !== queryId) fail('CHECKPOINT_QUERY_MISMATCH');
    if (input.checkpointRaw !== undefined) {
      const object = await persist(sourceKey, input.checkpointRaw, envelope.sha256);
      envelope = { ...envelope, reference: object.reference };
    } else {
      const key = collectorEvidenceKey({ prefix: options.evidencePrefix, sourceKey }, envelope.sha256);
      if (envelope.reference !== `${options.evidenceScheme}:${key}`) fail('CHECKPOINT_REFERENCE_REJECTED');
      const bytes = await (await options.storeForSource(sourceKey)).get(key);
      if (sha(bytes) !== envelope.sha256) fail('CHECKPOINT_HASH_MISMATCH');
    }
    return envelope;
  }

  async function adoptNativeSourceState(tx: any, sourceKey: SourceKey, raw?: string) {
    if (!raw) return; let snapshot: any; try { snapshot = JSON.parse(raw); } catch { fail('CHECKPOINT_NATIVE_STATE_INVALID'); }
    const state = snapshot.sourceState ?? {}, pauseUntil = Math.max(0, ...[state.pauseUntil, state.nextBatchAt].map(v => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0));
    if (state.manualPause || pauseUntil) {
      const control = await sourceControls(tx, sourceKey, '*');
      await tx.collectorSourceControl.update({ where: { id: control.exact.id }, data: { notBefore: new Date(Math.max(control.exact.notBefore.valueOf(), pauseUntil)), ...(state.manualPause ? { manualPause: true, reason: String(state.manualPause.reason ?? 'NATIVE_MANUAL_PAUSE').slice(0, 200) } : {}), controlVersion: { increment: 1 }, lastEvidenceAt: now() } });
    }
    // Native per-channel pauses retain their own boundary. A SERP cooldown
    // cannot become a SOURCE wildcard cooldown and stop the ATC channel.
    if (state.pauses && typeof state.pauses === 'object' && !Array.isArray(state.pauses)) for (const [channel, value] of Object.entries(state.pauses).sort(([a], [b]) => a.localeCompare(b))) {
      if (!channel || typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
      const control = await sourceControls(tx, sourceKey, channel);
      await tx.collectorSourceControl.update({ where: { id: control.exact.id }, data: { notBefore: new Date(Math.max(control.exact.notBefore.valueOf(), value)), controlVersion: { increment: 1 }, lastEvidenceAt: now() } });
    }
  }

  async function registerNode(input: RegisterNodeInput) {
    return txRun(async tx => {
      await requirePlatformAdmin(tx, input.actorUserId); await lock(tx, 'node:' + input.nodeId);
      const prior = await tx.collectorNode.findUnique({ where: { nodeId: input.nodeId } });
      if (prior && input.registryRevision <= prior.registryRevision) fail('NODE_REGISTRY_STALE');
      if (!input.nodeId || !input.incarnationId || input.registryRevision < 1 || !input.protocolVersions.length || input.protocolVersions.some(p => !Number.isSafeInteger(p) || p < 1)) fail('NODE_REGISTRY_INVALID', 400);
      if (prior && prior.incarnationId !== input.incarnationId) {
        const busy = await tx.seedTaskAttempt.count({ where: { nodeId: input.nodeId, state: { in: OCCUPIED } } });
        const assigned = await tx.collectorSourceAssignment.count({ where: { nodeId: input.nodeId, state: { in: ['ACTIVE', 'DRAINING'] } } });
        if (busy || assigned) fail('NODE_REINCARNATION_REQUIRES_RECOVERY');
      }
      const data = { incarnationId: input.incarnationId, registryRevision: input.registryRevision, enabled: input.enabled, expiresAt: input.expiresAt, status: 'REGISTERED', codeRevision: input.codeRevision, protocolVersions: input.protocolVersions, capabilityDigest: null, resourceSnapshot: {}, lastHeartbeatAt: null };
      const node = await tx.collectorNode.upsert({ where: { nodeId: input.nodeId }, create: { nodeId: input.nodeId, ...data }, update: data });
      await audit(tx, 'COLLECTOR_NODE_REGISTERED', node.nodeId, { registryRevision: input.registryRevision, incarnationId: input.incarnationId, enabled: input.enabled, expiresAt: input.expiresAt?.toISOString() ?? null }, input.actorUserId); return node;
    });
  }
  async function heartbeat(identity: MachineIdentity, input: { codeRevision: string; capabilityDigest: string; resourceSnapshot: Record<string, unknown> }) {
    return txRun(async tx => { await lock(tx, 'node:' + identity.nodeId); const node = await machine(tx, identity); if (node.codeRevision !== input.codeRevision || !hashPattern.test(input.capabilityDigest)) fail('NODE_HEARTBEAT_INCOMPATIBLE');
      // Node observations cannot increase the administrator-approved concurrency limit.
      const resourceSnapshot = { ...input.resourceSnapshot, maxSlots: node.resourceSnapshot?.maxSlots ?? 0 };
      const updated = await tx.collectorNode.update({ where: { nodeId: node.nodeId }, data: { lastHeartbeatAt: now(), capabilityDigest: input.capabilityDigest, resourceSnapshot, ...(node.status === 'STANDBY_READY' && node.capabilityDigest !== input.capabilityDigest ? { status: 'REGISTERED' } : {}) } });
      if (updated.status === 'STANDBY_READY' && updated.enabled && (!updated.expiresAt || updated.expiresAt > now())) await tx.collectorSourceAssignment.updateMany({ where: { nodeId: identity.nodeId, incarnationId: identity.incarnationId, state: 'ACTIVE', leaseExpiresAt: { gt: now() } }, data: { leaseExpiresAt: new Date(Math.min(now().valueOf() + options.leaseMs, updated.expiresAt?.valueOf() ?? Infinity)) } });
      return updated; });
  }
  async function verifyNode(input: VerifyNodeInput) {
    return txRun(async tx => { await requirePlatformAdmin(tx, input.actorUserId); await lock(tx, 'node:' + input.nodeId); const node = await tx.collectorNode.findUnique({ where: { nodeId: input.nodeId } });
      if (!node || node.incarnationId !== input.incarnationId || node.codeRevision !== input.codeRevision || !node.lastHeartbeatAt || node.capabilityDigest !== input.capabilityDigest || !Number.isSafeInteger(input.maxSlots) || input.maxSlots < 1) fail('NODE_VERIFY_FAILED');
      const result = await tx.collectorNode.update({ where: { nodeId: input.nodeId }, data: { status: 'STANDBY_READY', resourceSnapshot: { ...node.resourceSnapshot, maxSlots: input.maxSlots } } }); await audit(tx, 'COLLECTOR_NODE_VERIFIED', input.nodeId, { incarnationId: input.incarnationId, maxSlots: input.maxSlots, capabilityDigest: input.capabilityDigest }, input.actorUserId); return result; });
  }
  async function setNodeEnabled(input: AdminInput & { nodeId: string; enabled: boolean }) {
    return txRun(async tx => { await requirePlatformAdmin(tx, input.actorUserId); await lock(tx, 'node:' + input.nodeId); const node = await tx.collectorNode.update({ where: { nodeId: input.nodeId }, data: { enabled: input.enabled } });
      if (!input.enabled) { await tx.seedTaskAttempt.updateMany({ where: { nodeId: input.nodeId, state: { in: ['LEASED', 'RUNNING'] } }, data: { state: 'STOP_REQUESTED', stopReason: 'NODE_DISABLED' } }); await tx.seedExecutionTask.updateMany({ where: { attempts: { some: { nodeId: input.nodeId, state: 'STOP_REQUESTED' } }, state: { in: ['LEASED', 'RUNNING'] } }, data: { state: 'STOP_REQUESTED', cancelReason: 'NODE_DISABLED' } }); }
      await audit(tx, 'COLLECTOR_NODE_ENABLED_CHANGED', input.nodeId, { enabled: input.enabled }, input.actorUserId); return node; });
  }
  async function scheduleDueQueries(input: AdminInput & { queryIds?: string[] }) {
    await requirePlatformAdmin(db, input.actorUserId);
    // Source control is authoritative: a newly published query may still have
    // its default LEGACY mirror until this scheduler adopts TASK mode below.
    // CONFIG/LEGACY queues do not enter per-query transactions on every tick.
    const eligibility = `q."desiredEnabled" AND ($1::text[] IS NULL OR q.id=ANY($1::text[]))
      AND (EXISTS(SELECT 1 FROM "CollectorSourceControl" c WHERE c."sourceKey"=q."sourceKey"
        AND c.channel=q.channel AND c."scopeKey"='SOURCE' AND c."controlMode"='TASK_CLAIM')
        OR (NOT EXISTS(SELECT 1 FROM "CollectorSourceControl" c WHERE c."sourceKey"=q."sourceKey"
          AND c.channel=q.channel AND c."scopeKey"='SOURCE')
          AND EXISTS(SELECT 1 FROM "CollectorSourceControl" c WHERE c."sourceKey"=q."sourceKey"
            AND c.channel='*' AND c."scopeKey"='SOURCE' AND c."controlMode"='TASK_CLAIM'))) `;
    // A fixed high-water mark makes one tick finite. Later inserts enter the next
    // tick; database pages bound memory, not the number of queries processed.
    // Keep the timestamp as database text so keyset comparisons retain all
    // PostgreSQL microseconds, rather than truncating them through JS Date.
    const [head]: { id: string; createdAt: string }[] = await db.$queryRawUnsafe(`
      SELECT q.id,q."createdAt"::text AS "createdAt" FROM "SeedQuery" q WHERE ${eligibility}
      ORDER BY q."createdAt" DESC,q.id DESC LIMIT 1`, input.queryIds ?? null);
    if (!head) return { created: 0, failed: 0 };
    let cursor: { id: string; createdAt: string } | null = null, created = 0, failed = 0;
    for (;;) {
      const queries: { id: string; createdAt: string; sourceKey: string }[] = await db.$queryRawUnsafe(`
        SELECT q.id,q."createdAt"::text AS "createdAt",q."sourceKey" FROM "SeedQuery" q WHERE ${eligibility}
          AND (q."createdAt",q.id)<=($2::timestamp,$3::text)
          AND ($4::timestamp IS NULL OR (q."createdAt",q.id)>($4::timestamp,$5::text))
        ORDER BY q."createdAt",q.id LIMIT 100`, input.queryIds ?? null, head.createdAt, head.id, cursor?.createdAt ?? null, cursor?.id ?? null);
      if (!queries.length) break;
      for (const row of queries) {
        try { created += await txRun(async tx => {
          await requirePlatformAdmin(tx, input.actorUserId); await lock(tx, 'source:' + row.sourceKey); await lock(tx, 'query:' + row.id);
          const q = await tx.seedQuery.findUnique({ where: { id: row.id }, include: { runtime: true } }), runtime = q?.runtime;
          if (!q?.desiredEnabled || !runtime?.desiredRevision || (runtime.nextAllowedAt && runtime.nextAllowedAt > now())) return 0;
          const control = await sourceControls(tx, q.sourceKey, q.channel); if (!control.allowed || control.exact.controlMode !== 'TASK_CLAIM') return 0;
          if (q.controlMode !== 'TASK_CLAIM' || q.assignmentGeneration !== control.exact.assignmentGeneration) await tx.seedQuery.update({ where: { id: q.id }, data: { controlMode: 'TASK_CLAIM', assignmentGeneration: control.exact.assignmentGeneration } });
          if (runtime.assignmentGeneration !== control.exact.assignmentGeneration) await tx.seedRuntimeState.update({ where: { queryId: q.id }, data: { assignmentGeneration: control.exact.assignmentGeneration } });
          if (await tx.seedExecutionTask.count({ where: { queryId: q.id, state: { in: [...OCCUPIED, 'READY'] } } })) return 0;
          if (!await tx.seedQueryBinding.count({ where: { queryId: q.id, participationStatus: 'ACTIVE', validFromRevision: { lte: runtime.desiredRevision }, OR: [{ validToRevision: null }, { validToRevision: { gt: runtime.desiredRevision } }] } })) return 0;
          const cycleKey = String(Math.floor(now().valueOf() / options.cycleMs)), workUnitKey = 'checkpoint:' + runtime.checkpointSequence;
          const prior = await tx.seedExecutionTask.findUnique({ where: { queryId_cycleKey_workUnitKey: { queryId: q.id, cycleKey, workUnitKey } }, select: { id: true } }); if (prior) return 0;
          await tx.seedExecutionTask.create({ data: { queryId: q.id, dataSourceId: q.dataSourceId, sourceKey: q.sourceKey, cycleKey, workUnitKey, publicationRevision: runtime.desiredRevision, schedulePolicyVersion: 'compatibility-fair-1', notBefore: now() } }); return 1;
        }); } catch (error) {
          // Authorization failures terminate the tick. A single query/database
          // failure rolls back that query only and is retried on the next tick.
          if (error instanceof DomainError && error.status === 403) throw error;
          failed++;
        }
      }
      cursor = queries.at(-1)!;
    }
    return { created, failed };
  }
  async function claimTask(identity: MachineIdentity, input: ClaimInput): Promise<ExecutionGrant | { idle: true; reason: string }> {
    return txRun(async tx => { await lock(tx, 'node:' + identity.nodeId); const node = await machine(tx, identity, input.sourceKey); const payloadHash = sha(seedCanonical(input));
      const prior = await tx.seedTaskAttempt.findUnique({ where: { nodeId_incarnationId_claimRequestId: { nodeId: identity.nodeId, incarnationId: identity.incarnationId, claimRequestId: input.requestId } }, include: { task: { include: { query: true } } } });
      if (prior) { if (prior.claimPayloadHash !== payloadHash) fail('CLAIM_IDEMPOTENCY_CONFLICT'); await machine(tx, identity, prior.sourceKey, true); if (prior.state === 'STOP_REQUESTED' || !prior.task.query.desiredEnabled || !ACTIVE.includes(prior.state) || prior.leaseExpiresAt <= now()) fail('LEASE_LOST'); return grant(tx, prior); }
      if (!input.requestId || !Number.isSafeInteger(input.availableSlots) || input.availableSlots < 0 || !hashPattern.test(input.configHash)) fail('CLAIM_INVALID', 400);
      if (!node.enabled || (node.expiresAt && node.expiresAt <= now()) || node.status !== 'STANDBY_READY' || !node.lastHeartbeatAt || now().valueOf() - node.lastHeartbeatAt.valueOf() > options.leaseMs) return { idle: true, reason: 'NODE_NOT_EXECUTABLE' };
      if (node.resourceSnapshot?.pressure === 'HIGH' || node.resourceSnapshot?.healthy === false) return { idle: true, reason: 'RESOURCE_BACKPRESSURE' };
      const capacity = Math.min(input.availableSlots, Number(node.resourceSnapshot?.maxSlots ?? 0));
      const busy = await tx.seedTaskAttempt.count({ where: { nodeId: identity.nodeId, state: { in: OCCUPIED } } }); if (capacity <= busy) return { idle: true, reason: 'NO_RESOURCE_SLOT' };
      const appliedManifest = await applied(tx, identity, input.appliedRevision, input.configHash, undefined, input.sourceKey);
      const appliedIds = appliedManifest.queries.map(q => q.queryId).filter(id => !input.queryIds || input.queryIds.includes(id));
      let cursor: { lastAttemptAt: Date; createdAt: Date; id: string } | null = null;
      for (;;) {
        const page: { id: string; queryId: string; sourceKey: string; lastAttemptAt: Date; createdAt: Date }[] = await tx.$queryRawUnsafe(`
          SELECT t.id, t."queryId", t."sourceKey", t."createdAt", coalesce(r."lastAttemptAt",timestamp '1970-01-01') AS "lastAttemptAt"
          FROM "SeedExecutionTask" t JOIN "SeedQuery" q ON q.id=t."queryId" JOIN "SeedRuntimeState" r ON r."queryId"=q.id JOIN "DataSource" ds ON ds.id=q."dataSourceId"
          WHERE t.state='READY' AND t."notBefore" <= $1 AND t."sourceKey"=ANY($2::text[]) AND t."queryId"=ANY($3::text[])
            AND q."desiredEnabled" AND q.mode=ANY($4::text[]) AND q."controlMode"='TASK_CLAIM' AND r."desiredRevision"=$5
            AND ds.status='ACTIVE' AND (r."nextAllowedAt" IS NULL OR r."nextAllowedAt"<=$1)
            AND EXISTS(SELECT 1 FROM "CollectorSourceControl" c WHERE c."sourceKey"=q."sourceKey" AND c.channel=q.channel AND c."scopeKey"='SOURCE' AND c."controlMode"='TASK_CLAIM' AND NOT c."manualPause" AND c."notBefore"<=$1 AND c."assignmentGeneration"=q."assignmentGeneration")
            AND NOT EXISTS(SELECT 1 FROM "CollectorSourceControl" c WHERE c."sourceKey"=q."sourceKey" AND c.channel='*' AND c."scopeKey"='SOURCE' AND (c."manualPause" OR c."notBefore">$1))
            AND NOT EXISTS(SELECT 1 FROM "CollectorSourceAssignment" a WHERE a."sourceKey"=q."sourceKey" AND a.channel IN(q.channel,'*') AND a.state='DRAINING')
            AND NOT EXISTS(SELECT 1 FROM "SeedExecutionTask" busy WHERE busy."queryId"=q.id AND busy.state IN('LEASED','RUNNING','STOP_REQUESTED','COMMIT_PENDING','RECOVERING','RECOVERY_BLOCKED'))
            AND EXISTS(SELECT 1 FROM "SeedQueryBinding" b WHERE b."queryId"=q.id AND b."participationStatus"='ACTIVE' AND b."validFromRevision"<=$5 AND (b."validToRevision" IS NULL OR b."validToRevision">$5))
            AND (NOT EXISTS(SELECT 1 FROM "LegacyJobMapping" m WHERE m."queryId"=q.id) OR (r."checkpointRef" IS NOT NULL AND r."checkpointSha" IS NOT NULL))
            AND (r."sessionAffinity" IS NULL OR r."sessionAffinity"=ANY($6::text[]))
            AND ($7::timestamp IS NULL OR (coalesce(r."lastAttemptAt",timestamp '1970-01-01'),t."createdAt",t.id)>($7::timestamp,$8::timestamp,$9::text))
          ORDER BY coalesce(r."lastAttemptAt",timestamp '1970-01-01'),t."createdAt",t.id LIMIT 100`,
          now(), input.sourceKey ? [input.sourceKey] : [...identity.allowedSourceKeys], appliedIds, input.supportedModes, input.appliedRevision, [identity.nodeId, 'node:' + identity.nodeId], cursor?.lastAttemptAt ?? null, cursor?.createdAt ?? null, cursor?.id ?? null);
        if (!page.length) break;
        for (const t of page) { await lock(tx, 'source:' + t.sourceKey); await lock(tx, 'query:' + t.queryId); const fresh = await tx.seedExecutionTask.findUnique({ where: { id: t.id }, include: { query: { include: { runtime: true } } } }); if (!fresh || fresh.state !== 'READY') continue;
        const q = fresh.query, runtime = q.runtime; if (!q.desiredEnabled || q.controlMode !== 'TASK_CLAIM' || runtime.desiredRevision !== input.appliedRevision) continue;
        if (await tx.seedExecutionTask.count({ where: { queryId: q.id, state: { in: OCCUPIED } } })) continue;
        const control = await sourceControls(tx, q.sourceKey, q.channel); if (!control.allowed || control.exact.controlMode !== 'TASK_CLAIM') continue;
        await applied(tx, identity, input.appliedRevision, input.configHash, q.id); await owners(tx, q.id, runtime.desiredRevision);
        if (runtime.sessionAffinity && ![identity.nodeId, 'node:' + identity.nodeId].includes(runtime.sessionAffinity)) continue;
        const mapped = await tx.legacyJobMapping.count({ where: { queryId: q.id } }); if (mapped && (!runtime.checkpointRef || !runtime.checkpointSha)) continue;
        const count = await tx.seedTaskAttempt.count({ where: { taskId: fresh.id } }), id = randomUUID(), expiry = new Date(Math.min(now().valueOf() + options.leaseMs, node.expiresAt?.valueOf() ?? Infinity));
        if (expiry.valueOf() <= now().valueOf() + options.requestBudgetMs + options.exitMarginMs) continue;
        const data = { id, taskId: fresh.id, dataSourceId: q.dataSourceId, sourceKey: q.sourceKey, attemptNo: count + 1, nodeId: identity.nodeId, incarnationId: identity.incarnationId, assignmentGeneration: q.assignmentGeneration, leaseVersion: count + 1, leaseExpiresAt: expiry, publicationRevision: input.appliedRevision, configHash: input.configHash, claimRequestId: input.requestId, claimPayloadHash: payloadHash, checkpointSequence: runtime.checkpointSequence };
        const a = await tx.seedTaskAttempt.create({ data: { ...data, tokenHash: sha(token('attempt', data)) } });
        await tx.seedExecutionTask.update({ where: { id: fresh.id }, data: { state: 'LEASED', publicationRevision: input.appliedRevision } });
        await tx.seedRuntimeState.update({ where: { queryId: q.id }, data: { collectorId: identity.nodeId, appliedRevision: input.appliedRevision, executionState: 'LEASED', lastAttemptAt: now() } });
        return grant(tx, { ...a, task: fresh });
        }
        const last = page.at(-1)!; cursor = { lastAttemptAt: last.lastAttemptAt, createdAt: last.createdAt, id: last.id };
      } return { idle: true, reason: 'NO_COMPATIBLE_TASK' }; });
  }
  async function startAttempt(identity: MachineIdentity, input: AttemptInput) {
    return txRun(async tx => { const first = await attempt(tx, identity, input); await lock(tx, 'source:' + first.q.sourceKey); await lock(tx, 'query:' + first.q.id); const { a, q } = await attempt(tx, identity, input);
      if (a.startedAt) return grant(tx, a);
      if (!q.desiredEnabled || a.state !== 'LEASED') fail('STOP_REQUESTED'); const runtime = await tx.seedRuntimeState.findUnique({ where: { queryId: q.id } }); if (runtime.desiredRevision !== a.publicationRevision) fail('CONFIG_STALE');
      await applied(tx, identity, a.publicationRevision, a.configHash, q.id); const bindings = await owners(tx, q.id, runtime.desiredRevision); const control = await sourceControls(tx, q.sourceKey, q.channel); if (!control.allowed) fail('SOURCE_COOLDOWN');
      const deadline = new Date(Math.min(now().valueOf() + options.requestBudgetMs, a.leaseExpiresAt.valueOf() - options.exitMarginMs)); if (deadline <= now()) fail('REQUEST_DEADLINE_EXPIRED');
      const started = await tx.seedTaskAttempt.update({ where: { id: a.id }, data: { state: 'RUNNING', startedAt: now(), heartbeatAt: now(), requestDeadline: deadline, bindingSnapshot: bindings, primaryOwner: bindings[0] } });
      await tx.seedExecutionTask.update({ where: { id: a.taskId }, data: { state: 'RUNNING' } }); await tx.seedRuntimeState.update({ where: { queryId: q.id }, data: { executionState: 'RUNNING', lastReportedAt: now() } }); await audit(tx, 'SEED_ATTEMPT_STARTED', a.id, { queryId: q.id, assignmentGeneration: a.assignmentGeneration, leaseVersion: a.leaseVersion, bindingSnapshot: bindings }); return grant(tx, started); });
  }
  async function renewAttempt(identity: MachineIdentity, input: AttemptInput) {
    return txRun(async tx => { await lock(tx, 'node:' + identity.nodeId); const { a, q, node } = await attempt(tx, identity, input); if (a.state === 'STOP_REQUESTED' || !q.desiredEnabled || (await sourceControls(tx, q.sourceKey, q.channel)).snapshot.manualPause) fail('STOP_REQUESTED');
      if (input.sequence !== undefined && input.sequence <= a.lastReceiptSeq) fail('RECEIPT_SEQUENCE_STALE');
      const expiry = new Date(Math.min(now().valueOf() + options.leaseMs, node.expiresAt?.valueOf() ?? Infinity));
      const updated = await tx.seedTaskAttempt.update({ where: { id: a.id }, data: { heartbeatAt: now(), leaseExpiresAt: expiry, requestDeadline: new Date(Math.min(now().valueOf() + options.requestBudgetMs, expiry.valueOf() - options.exitMarginMs)), ...(input.sequence !== undefined ? { lastReceiptSeq: input.sequence } : {}) } }); return grant(tx, updated); });
  }
  async function acquireSourcePermit(identity: MachineIdentity, input: AttemptInput & { requestKind: string }): Promise<PermitResult> {
    return txRun(async tx => { const { a, q } = await attempt(tx, identity, input); const control = await sourceControls(tx, q.sourceKey, q.channel);
      if (!q.desiredEnabled || a.state !== 'RUNNING' || !a.startedAt || !a.requestDeadline || a.requestDeadline <= now()) return { allowed: false, reason: 'STOP_REQUESTED', sourceControl: control.snapshot };
      const runtime = await tx.seedRuntimeState.findUnique({ where: { queryId: q.id } }); if (runtime.desiredRevision !== a.publicationRevision) return { allowed: false, reason: 'CONFIG_STALE', sourceControl: control.snapshot };
      await owners(tx, q.id, runtime.desiredRevision); if (!control.allowed) return { allowed: false, reason: 'SOURCE_COOLDOWN', sourceControl: control.snapshot };
      if (options.requestSpacingMs) await tx.collectorSourceControl.update({ where: { id: control.exact.id }, data: { notBefore: new Date(now().valueOf() + options.requestSpacingMs) } });
      const g = await grant(tx, a); return { allowed: true, sourceControl: control.snapshot, grant: g, context: contextOf(g) }; });
  }
  async function recordRestriction(identity: MachineIdentity, input: AttemptInput & { expectedControlVersion: number; reason: string; retryAfterMs: number; requestId?: string }) {
    return txRun(async tx => { const { a, q } = await attempt(tx, identity, input, false); if (!Number.isFinite(input.retryAfterMs) || input.retryAfterMs < 0 || !input.reason || input.reason.length > 200) fail('RESTRICTION_INVALID', 400);
      const control = await sourceControls(tx, q.sourceKey, q.channel), requestId = input.requestId ?? `${a.id}:${input.expectedControlVersion}:${input.reason}`;
      const prior = await tx.auditEvent.findFirst({ where: { action: 'SEED_SOURCE_RESTRICTED', requestId, targetId: q.sourceKey } }); if (prior) return prior.metadata.sourceControl;
      const global = await tx.collectorSourceControl.upsert({ where: { sourceKey_channel_scopeKey: { sourceKey: q.sourceKey, channel: '*', scopeKey: 'SOURCE' } }, create: { dataSourceId: q.dataSourceId, sourceKey: q.sourceKey, channel: '*', scopeKey: 'SOURCE', notBefore: new Date(0), controlMode: control.exact.controlMode }, update: {} });
      const until = new Date(Math.max(global.notBefore.valueOf(), now().valueOf() + input.retryAfterMs));
      await tx.collectorSourceControl.update({ where: { id: global.id }, data: { notBefore: until, retryAfterUntil: until, restrictionCount: { increment: 1 }, ...(/(?:403|ACCESS_BLOCKED|LOGIN_REQUIRED|CHALLENGE|CAPTCHA|LOGIN_REDIRECT|CHECKPOINT_REQUIRED)/i.test(input.reason) ? { manualPause: true } : {}), controlVersion: Math.max(global.controlVersion, control.exact.controlVersion) + 1, lastEvidenceAt: now(), reason: input.reason } });
      const updated = (await sourceControls(tx, q.sourceKey, q.channel)).snapshot; await audit(tx, 'SEED_SOURCE_RESTRICTED', q.sourceKey, { attemptId: a.id, reason: input.reason, expectedControlVersion: input.expectedControlVersion, sourceControl: updated }, undefined, requestId); return updated; });
  }
  async function requestStop(input: AdminInput & { queryId?: string; sourceKey?: SourceKey; nodeId?: string; reason: string }) {
    return txRun(async tx => { await requirePlatformAdmin(tx, input.actorUserId); if (!input.queryId && !input.sourceKey && !input.nodeId) fail('STOP_SCOPE_REQUIRED', 400);
      if (input.nodeId) await lock(tx, 'node:' + input.nodeId);
      const sources = new Set<string>(input.sourceKey ? [input.sourceKey] : []);
      if (input.queryId) { const q = await tx.seedQuery.findUnique({ where: { id: input.queryId }, select: { sourceKey: true } }); if (q) sources.add(q.sourceKey); }
      if (input.nodeId) {
        const [assignments, attempts] = await Promise.all([tx.collectorSourceAssignment.findMany({ where: { nodeId: input.nodeId, state: { in: ['ACTIVE', 'DRAINING'] } }, select: { sourceKey: true } }), tx.seedTaskAttempt.findMany({ where: { nodeId: input.nodeId, state: { in: OCCUPIED } }, select: { sourceKey: true } })]);
        for (const row of [...assignments, ...attempts]) sources.add(row.sourceKey);
      }
      // Serialize the drain barrier with claims/UNIT_START, so an attempt
      // cannot slip between the stop snapshot and the DRAINING projection.
      for (const sourceKey of [...sources].sort()) await lock(tx, 'source:' + sourceKey);
      const where = { state: { in: ['LEASED', 'RUNNING'] }, ...(input.sourceKey ? { sourceKey: input.sourceKey } : {}), ...(input.nodeId ? { nodeId: input.nodeId } : {}), ...(input.queryId ? { task: { queryId: input.queryId } } : {}) };
      if (input.sourceKey || input.nodeId) await tx.collectorSourceAssignment.updateMany({ where: { state: 'ACTIVE', ...(input.sourceKey ? { sourceKey: input.sourceKey } : {}), ...(input.nodeId ? { nodeId: input.nodeId } : {}) }, data: { state: 'DRAINING' } });
      const changed = await tx.seedTaskAttempt.updateMany({ where, data: { state: 'STOP_REQUESTED', stopReason: input.reason } }); await tx.seedExecutionTask.updateMany({ where: { state: { in: ['LEASED', 'RUNNING'] }, attempts: { some: { state: 'STOP_REQUESTED', ...(input.nodeId ? { nodeId: input.nodeId } : {}) } } }, data: { state: 'STOP_REQUESTED', cancelReason: input.reason } }); await audit(tx, 'SEED_STOP_REQUESTED', input.queryId ?? input.sourceKey ?? input.nodeId ?? null, { reason: input.reason, affected: changed.count }, input.actorUserId); return changed; });
  }
  async function recoverExpiredAttempts(input: AdminInput) {
    await requirePlatformAdmin(db, input.actorUserId); let cursor = '', recovering = 0;
    for (;;) {
      const rows = await db.seedTaskAttempt.findMany({ where: { id: { gt: cursor }, state: { in: ACTIVE }, leaseExpiresAt: { lte: now() } }, orderBy: { id: 'asc' }, take: 100, select: { id: true, sourceKey: true, task: { select: { queryId: true } } } });
      if (!rows.length) break;
      for (const row of rows) recovering += await txRun(async tx => {
        await requirePlatformAdmin(tx, input.actorUserId); await lock(tx, 'source:' + row.sourceKey); await lock(tx, 'query:' + row.task.queryId);
        const a = await tx.seedTaskAttempt.findUnique({ where: { id: row.id } }); if (!a || !ACTIVE.includes(a.state) || a.leaseExpiresAt > now()) return 0;
        await tx.seedTaskAttempt.update({ where: { id: a.id }, data: { state: 'RECOVERING', stopReason: 'LEASE_EXPIRED' } });
        await tx.seedExecutionTask.updateMany({ where: { id: a.taskId, state: { in: ACTIVE } }, data: { state: 'RECOVERING', cancelReason: 'LEASE_EXPIRED' } });
        const runtime = await tx.seedRuntimeState.findUnique({ where: { queryId: row.task.queryId } });
        await tx.seedRuntimeState.update({ where: { queryId: row.task.queryId }, data: { executionState: 'RECOVERING', nextAllowedAt: new Date(Math.max(runtime.nextAllowedAt?.valueOf() ?? 0, now().valueOf() + options.unknownOutcomeBackoffMs)) } }); return 1;
      });
      cursor = rows.at(-1)!.id;
    }
    return { recovering };
  }

  async function prepareSubmission(identity: MachineIdentity, input: PrepareInput) {
    if (!input.requestId || !hashPattern.test(input.rawSha) || !hashPattern.test(input.sidecarHash) || !input.expectedBatchHashes.length || new Set(input.expectedBatchHashes).size !== input.expectedBatchHashes.length || input.expectedBatchHashes.some(h => !hashPattern.test(h))) fail('PREPARE_INVALID', 400);
    if (!input.context.attemptId) fail('STARTED_ATTEMPT_REQUIRED');
    await machine(db, identity, input.context.sourceKey);
    const initial = await attempt(db, identity, { attemptId: input.context.attemptId, grantToken: input.context.grantToken }, false);
    if (initial.q.sourceKey !== input.context.sourceKey) fail('EXECUTION_CONTEXT_MISMATCH');
    const safeContext = { ...input.context, grantToken: undefined };
    const payloadHash = sha(seedCanonical({ ...input, context: safeContext }));
    // This sidecar is server-owned execution evidence. The remote archive path
    // and its byte hash are recorded separately, never treated as a fetchable URL.
    const centralSidecar = seedCanonical({ schemaVersion: 1, context: safeContext, rawSha: input.rawSha, expectedBatchHashes: input.expectedBatchHashes, clientSidecarHash: input.sidecarHash });
    const sidecar = await persist(input.context.sourceKey, centralSidecar, sha(centralSidecar));
    return txRun(async tx => {
      const { a, q } = await attempt(tx, identity, { attemptId: input.context.attemptId!, grantToken: input.context.grantToken }, false); await lock(tx, 'source:' + q.sourceKey); await lock(tx, 'query:' + q.id);
      const prior = await tx.auditEvent.findFirst({ where: { action: 'SEED_UNIT_PREPARED', targetId: a.id, requestId: input.requestId } });
      if (prior) { if (prior.metadata.payloadHash !== payloadHash) fail('PREPARE_IDEMPOTENCY_CONFLICT'); return { prepareToken: preparedToken(prior.id), context: contextOf(await grant(tx, a)), expectedBatchHashes: prior.metadata.expectedBatchHashes, sidecarRef: prior.metadata.sidecarRef }; }
      await attempt(tx, identity, { attemptId: a.id, grantToken: input.context.grantToken });
      if (!a.startedAt || !['RUNNING', 'STOP_REQUESTED'].includes(a.state)) fail('STARTED_ATTEMPT_REQUIRED');
      const c = input.context;
      if (c.queryId !== q.id || c.sourceKey !== q.sourceKey || c.taskId !== a.taskId || c.assignmentGeneration !== a.assignmentGeneration || c.leaseVersion !== a.leaseVersion || c.publicationRevision !== a.publicationRevision || c.configHash !== a.configHash || c.mode !== q.mode || c.channel !== q.channel) fail('EXECUTION_CONTEXT_MISMATCH');
      const native = { ...c.nativeParams }; delete native.mode; delete native.channel;
      if (!sameNative(q.sourceKey, q.mode, native, q.normalizedParams)) fail('EXECUTION_PARAMS_MISMATCH');
      if (await tx.auditEvent.count({ where: { action: 'SEED_UNIT_PREPARED', targetId: a.id } })) fail('ATTEMPT_ALREADY_PREPARED');
      const saved = await audit(tx, 'SEED_UNIT_PREPARED', a.id, { payloadHash, sourceKey: q.sourceKey, queryId: q.id, attemptId: a.id, nodeId: a.nodeId, incarnationId: a.incarnationId, assignmentGeneration: a.assignmentGeneration, checkpointSequence: a.checkpointSequence, bindingSnapshot: a.bindingSnapshot, primaryOwner: a.primaryOwner, rawSha: input.rawSha, expectedBatchHashes: input.expectedBatchHashes, sidecarRef: sidecar.reference, sidecarHash: sidecar.sha256, clientSidecarRef: input.sidecarRef, clientSidecarHash: input.sidecarHash }, undefined, input.requestId);
      await tx.seedTaskAttempt.update({ where: { id: a.id }, data: { state: 'COMMIT_PENDING' } }); await tx.seedExecutionTask.update({ where: { id: a.taskId }, data: { state: 'COMMIT_PENDING' } }); await tx.seedRuntimeState.update({ where: { queryId: q.id }, data: { executionState: 'COMMIT_PENDING', pendingManifestRef: sidecar.reference } });
      return { prepareToken: preparedToken(saved.id), context: contextOf(await grant(tx, a)), expectedBatchHashes: input.expectedBatchHashes, sidecarRef: sidecar.reference };
    });
  }
  async function prepared(tx: any, identity: MachineIdentity, input: SubmitInput | RecoverInput) {
    const value = input.prepareToken ?? '', id = value.split('.')[0];
    if (!id || !equal(value, preparedToken(id))) fail('PREPARE_TOKEN_INVALID', 403);
    const record = await tx.auditEvent.findUnique({ where: { id } });
    if (!record || record.action !== 'SEED_UNIT_PREPARED' || record.metadata.nodeId !== identity.nodeId || record.metadata.incarnationId !== identity.incarnationId || record.metadata.sourceKey !== input.sourceKey || !record.metadata.expectedBatchHashes.includes(input.batchHash)) fail('UNPREPARED_BATCH');
    return record;
  }
  async function commit(identity: MachineIdentity, input: SubmitInput | RecoverInput, recover: boolean): Promise<CommitReceipt> {
    await machine(db, identity, input.sourceKey);
    if (!input.requestId || !hashPattern.test(input.batchHash) || sha(input.raw) !== input.batchHash) fail('RAW_HASH_MISMATCH', 400);
    const record = await prepared(db, identity, input); const a = await db.seedTaskAttempt.findUnique({ where: { id: record.metadata.attemptId }, include: { task: { include: { query: true } } } });
    if (!a) fail('LEASE_LOST');
    let batch: any; try { batch = JSON.parse(input.raw); } catch { fail('BATCH_INVALID', 400); }
    if (batch.sourceKey !== input.sourceKey || !sameNative(input.sourceKey, a.task.query.mode, batch.query, a.task.query.normalizedParams)) fail('BATCH_QUERY_MISMATCH');
    const object = await persist(input.sourceKey, input.raw, input.batchHash);
    const cp = !recover ? await checkpointObject(input.sourceKey, input as SubmitInput, a.task.queryId) : null;
    const payloadHash = sha(seedCanonical({ preparedId: record.id, sourceKey: input.sourceKey, batchHash: input.batchHash, checkpoint: cp }));
    return txRun(async tx => {
      await lock(tx, 'source:' + a.sourceKey); await lock(tx, 'query:' + a.task.queryId); await machine(tx, identity, input.sourceKey);
      const pending = await prepared(tx, identity, input);
      const replay = await tx.auditEvent.findFirst({ where: { action: 'SEED_BATCH_COMMITTED', targetId: pending.id, requestId: input.requestId } });
      if (replay) { if (replay.metadata.payloadHash !== payloadHash) fail('SUBMIT_IDEMPOTENCY_CONFLICT'); return replay.metadata.receipt; }
      if (!recover) await attempt(tx, identity, { attemptId: a.id, grantToken: token('attempt', a) });
      const durable = await audit(tx, 'SEED_RAW_OBJECT_DURABLE', pending.id, { sourceKey: input.sourceKey, batchHash: input.batchHash, objectReference: object.reference, objectKey: object.key, verifiedBytes: object.bytes });
      const execution = { kind: 'TASK', sourceKey: input.sourceKey, preparedId: pending.id, attemptId: a.id, grantToken: token('attempt', a), recover, durableId: durable.id };
      const rows = await tx.$queryRawUnsafe('SELECT seed_dispatch.ingest_authorized($1,$2::jsonb) AS receipt', input.raw, JSON.stringify(execution)); const imported = rows[0].receipt;
      const run = await tx.collectionRun.findUnique({ where: { id: imported.runId } }); if (!run || run.dataSourceId !== a.dataSourceId) fail('INGEST_RECEIPT_INVALID');
      const primary = a.primaryOwner, bindingSnapshot = a.bindingSnapshot;
      const classification = classifyNativeOutcome(batch, run), outcome = classification.outcome;
      const fact = await tx.seedAttempt.upsert({ where: { sourceKey_batchSha256: { sourceKey: input.sourceKey, batchSha256: input.batchHash } }, create: { queryId: a.task.queryId, dataSourceId: a.dataSourceId, sourceKey: input.sourceKey, taskAttemptId: a.id, primarySeedId: primary?.seedId ?? null, primaryScanPlanId: primary?.scanPlanId ?? null, runId: run.id, batchSha256: input.batchHash, bindingSnapshot, attributionQuality: 'EXACT_QUERY', outcome, outcomeEvidence: { rawEvidenceReference: object.reference, rawSha256: input.batchHash, sidecarRef: pending.metadata.sidecarRef, adapterCoverage: batch.coverage ?? {}, partial: classification.partial }, exhausted: classification.exhausted, restrictionReason: classification.restrictionReason, startedAt: a.startedAt, finishedAt: new Date(Math.max(now().valueOf(), run.finishedAt?.valueOf() ?? 0, a.startedAt.valueOf())), fetchedCount: run.fetchedCount, insertedCount: run.insertedCount, updatedCount: run.updatedCount }, update: {} });
      if (fact.taskAttemptId !== a.id || fact.queryId !== a.task.queryId) fail('BATCH_ATTRIBUTION_CONFLICT');
      const ads = await tx.runItem.findMany({ where: { runId: run.id, adId: { not: null } }, select: { adId: true } });
      for (const owner of bindingSnapshot.filter((b: any) => b.ownerKind === 'SEED')) for (const ad of ads) await tx.seedAttemptMatch.upsert({ where: { attemptId_seedId_adId: { attemptId: fact.id, seedId: owner.seedId, adId: ad.adId } }, create: { attemptId: fact.id, seedId: owner.seedId, adId: ad.adId, dataSourceId: a.dataSourceId, matchRole: owner.seedId === primary.seedId ? 'PRIMARY' : 'SHARED_QUERY' }, update: {} });
      const previous = await tx.auditEvent.findMany({ where: { action: 'SEED_BATCH_COMMITTED', targetId: pending.id } });
      const confirmed = [...new Set<string>([...previous.map((p: any) => p.metadata.batchHash as string), input.batchHash])];
      const complete = pending.metadata.expectedBatchHashes.every((h: string) => confirmed.includes(h)); let checkpointSequence: number | null = null;
      if (complete && cp && !recover) {
        if (cp.sequence !== a.checkpointSequence + 1 || !pending.metadata.expectedBatchHashes.every((h: string) => cp.appliedBatchHashes.includes(h))) fail('CHECKPOINT_SEQUENCE_CONFLICT');
        const changed = await tx.seedRuntimeState.updateMany({ where: { queryId: a.task.queryId, assignmentGeneration: a.assignmentGeneration, checkpointSequence: a.checkpointSequence, collectorId: identity.nodeId }, data: { checkpointSequence: cp.sequence, checkpointVersion: { increment: 1 }, checkpointRef: cp.reference, checkpointSha: cp.sha256, checkpointDigest: cp.sha256, stateSchemaVersion: cp.stateSchemaVersion, sessionAffinity: cp.sessionAffinity, lastAppliedBatchHashes: cp.appliedBatchHashes, pendingManifestRef: null } });
        if (changed.count !== 1) fail('CHECKPOINT_FENCE_LOST'); checkpointSequence = cp.sequence;
      }
      if (complete && cp && !recover) {
        let nativeNext = 0;
        if ((input as SubmitInput).checkpointRaw) {
          let snapshot: any; try { snapshot = JSON.parse((input as SubmitInput).checkpointRaw!); } catch { fail('CHECKPOINT_NATIVE_STATE_INVALID'); }
          if (snapshot.sourceKey !== input.sourceKey || snapshot.queryId !== a.task.queryId || !sameNative(input.sourceKey, a.task.query.mode, snapshot.nativeParams, a.task.query.normalizedParams)) fail('CHECKPOINT_NATIVE_STATE_INVALID');
          const state = snapshot.sourceState ?? {}, job = snapshot.job ?? {};
          nativeNext = Math.max(...[job.dueAt, job.retryAt, state.pauseUntil, state.nextBatchAt, state.pauses?.[a.task.query.channel]].map(v => Number.isFinite(v) && v > 0 ? v : 0));
        }
        await adoptNativeSourceState(tx, input.sourceKey, (input as SubmitInput).checkpointRaw);
        const restrictions = await sourceControls(tx, input.sourceKey, a.task.query.channel), currentRuntime = await tx.seedRuntimeState.findUnique({ where: { queryId: a.task.queryId } });
        const nextAllowedAt = new Date(Math.max(nativeNext || now().valueOf() + (['PARTIAL', 'FAILED', 'RATE_LIMITED', 'TIMEOUT'].includes(outcome) ? options.unknownOutcomeBackoffMs : options.cycleMs), new Date(restrictions.snapshot.notBefore).valueOf(), currentRuntime.nextAllowedAt?.valueOf() ?? 0));
        await tx.seedTaskAttempt.update({ where: { id: a.id }, data: { state: 'COMPLETED' } }); await tx.seedExecutionTask.update({ where: { id: a.taskId }, data: { state: 'COMPLETED', outcome, completedAt: now() } }); await tx.seedRuntimeState.update({ where: { queryId: a.task.queryId }, data: { executionState: 'IDLE', nextAllowedAt, lastReportedAt: now(), ...(!cp ? {} : { pendingManifestRef: null }) } }); }
      const receipt: CommitReceipt = { status: imported.status, runId: run.id, inserted: imported.inserted ?? 0, updated: imported.updated ?? 0, originalInserted: run.insertedCount, originalUpdated: run.updatedCount, committedAt: iso(run.finishedAt ?? now()), confirmedBatchHashes: confirmed, complete, committedCheckpointSequence: checkpointSequence, checkpointRef: checkpointSequence !== null ? cp!.reference : null };
      await audit(tx, 'SEED_BATCH_COMMITTED', pending.id, { payloadHash, batchHash: input.batchHash, receipt, durableId: durable.id, recovered: recover }, undefined, input.requestId); return receipt;
    });
  }
  const submitManagedUnit = (identity: MachineIdentity, input: SubmitInput) => commit(identity, input, false);
  async function registerLegacyPending(input: AdminInput & { nodeId: string; incarnationId: string; sourceKey: SourceKey; rawSha: string; batchHashes: string[]; reason: string }) {
    return txRun(async tx => { await requirePlatformAdmin(tx, input.actorUserId); const node = await tx.collectorNode.findUnique({ where: { nodeId: input.nodeId } });
      if (!node || node.incarnationId !== input.incarnationId || !input.reason || !hashPattern.test(input.rawSha) || !input.batchHashes.length || input.batchHashes.some(h => !hashPattern.test(h))) fail('LEGACY_PENDING_INVALID', 400);
      await lock(tx, 'legacy-pending:' + input.nodeId + ':' + input.rawSha);
      const prior = await tx.auditEvent.findFirst({ where: { action: 'SEED_LEGACY_PENDING_REGISTERED', targetId: input.rawSha }, orderBy: { createdAt: 'desc' } });
      const metadata = { nodeId: input.nodeId, incarnationId: input.incarnationId, sourceKey: input.sourceKey, rawSha: input.rawSha, batchHashes: [...new Set(input.batchHashes)], reason: input.reason };
      if (prior) { if (seedCanonical(prior.metadata) !== seedCanonical(metadata)) fail('LEGACY_PENDING_CONFLICT'); return { registrationId: prior.id }; }
      return { registrationId: (await audit(tx, 'SEED_LEGACY_PENDING_REGISTERED', input.rawSha, metadata, input.actorUserId)).id }; });
  }
  async function recoverSubmit(identity: MachineIdentity, input: RecoverInput): Promise<CommitReceipt> {
    if (input.prepareToken) return commit(identity, input, true);
    await machine(db, identity, input.sourceKey);
    const pending = await db.auditEvent.findFirst({ where: { action: 'SEED_LEGACY_PENDING_REGISTERED', targetId: input.rawSha }, orderBy: { createdAt: 'desc' } });
    if (!pending || pending.metadata.sourceKey !== input.sourceKey || pending.metadata.nodeId !== identity.nodeId || pending.metadata.incarnationId !== identity.incarnationId || !pending.metadata.batchHashes.includes(input.batchHash)) fail('LEGACY_PENDING_NOT_REGISTERED');
    const object = await persist(input.sourceKey, input.raw, input.batchHash);
    return txRun(async tx => { await machine(tx, identity, input.sourceKey); await lock(tx, 'legacy-request:' + identity.nodeId + ':' + identity.incarnationId + ':' + input.requestId); await lock(tx, 'legacy-batch:' + input.sourceKey + ':' + input.batchHash);
      const payloadHash = sha(seedCanonical({ sourceKey: input.sourceKey, rawSha: input.rawSha, batchHash: input.batchHash }));
      const previous = await tx.auditEvent.findFirst({ where: { action: 'SEED_LEGACY_BATCH_COMMITTED', targetId: pending.id, requestId: input.requestId } });
      if (previous) { if (previous.metadata.payloadHash !== payloadHash) fail('RECOVER_IDEMPOTENCY_CONFLICT'); return previous.metadata.receipt; }
      const durable = await audit(tx, 'SEED_RAW_OBJECT_DURABLE', pending.id, { sourceKey: input.sourceKey, batchHash: input.batchHash, objectKey: object.key, objectReference: object.reference, verifiedBytes: object.bytes });
      const execution = { kind: 'LEGACY_RECOVERY', sourceKey: input.sourceKey, registrationId: pending.id, nodeId: identity.nodeId, incarnationId: identity.incarnationId, durableId: durable.id };
      const rows = await tx.$queryRawUnsafe('SELECT seed_dispatch.ingest_authorized($1,$2::jsonb) AS receipt', input.raw, JSON.stringify(execution)); const imported = rows[0].receipt, run = await tx.collectionRun.findUnique({ where: { id: imported.runId } });
      const source = await tx.dataSource.findUnique({ where: { key: input.sourceKey } }); let batch: any; try { batch = JSON.parse(input.raw); } catch { fail('BATCH_INVALID', 400); }
      const nativeIdentity = legacyQueryIdentity(input.sourceKey, batch.query), query = nativeIdentity.quality === 'HISTORICAL_QUERY' ? await tx.seedQuery.findFirst({ where: { sourceKey: input.sourceKey, queryKey: nativeIdentity.key } }) : null;
      await tx.seedAttempt.upsert({ where: { sourceKey_batchSha256: { sourceKey: input.sourceKey, batchSha256: input.batchHash } }, create: { dataSourceId: source.id, sourceKey: input.sourceKey, queryId: query?.id ?? null, runId: run.id, batchSha256: input.batchHash, attributionQuality: query ? 'HISTORICAL_QUERY' : 'UNATTRIBUTED', outcome: run.fetchedCount ? 'HAS_RESULTS' : 'PARTIAL', outcomeEvidence: { rawEvidenceReference: object.reference, registeredPendingId: pending.id }, startedAt: run.startedAt ?? now(), finishedAt: new Date(Math.max(run.finishedAt?.valueOf() ?? now().valueOf(), run.startedAt?.valueOf() ?? 0)), fetchedCount: run.fetchedCount, insertedCount: run.insertedCount, updatedCount: run.updatedCount }, update: {} });
      // Historical ingestion is a fact replay only. It never touches the current runtime.
      const receipt: CommitReceipt = { status: imported.status, runId: run.id, inserted: imported.inserted ?? 0, updated: imported.updated ?? 0, originalInserted: run.insertedCount, originalUpdated: run.updatedCount, committedAt: iso(run.finishedAt ?? now()), confirmedBatchHashes: [input.batchHash], complete: false, committedCheckpointSequence: null };
      await audit(tx, 'SEED_LEGACY_BATCH_COMMITTED', pending.id, { payloadHash, receipt, durableId: durable.id }, undefined, input.requestId); return receipt; });
  }
  async function acknowledgeStop(identity: MachineIdentity, input: AttemptInput & { requestId: string; sequence: number; drained: boolean; pendingPreserved: boolean; checkpoint?: any; checkpointRaw?: string }) {
    const result = await txRun(async tx => { const { a, q } = await attempt(tx, identity, input, false); await lock(tx, 'source:' + q.sourceKey); await lock(tx, 'query:' + q.id);
      const key = { nodeId_incarnationId_sequence: { nodeId: identity.nodeId, incarnationId: identity.incarnationId, sequence: input.sequence } };
      const prior = await tx.seedCollectorReceipt.findUnique({ where: key });
      if (prior) { if (prior.payloadHash !== sha(seedCanonical(input))) fail('RECEIPT_IDEMPOTENCY_CONFLICT'); return { receiptId: prior.id, state: 'RECOVERING' }; }
      if (input.sequence <= a.lastReceiptSeq) fail('RECEIPT_SEQUENCE_STALE');
      if (!OCCUPIED.includes(a.state)) fail('STOP_ALREADY_COMPLETED');
      const receipt = await tx.seedCollectorReceipt.create({ data: { nodeId: identity.nodeId, incarnationId: identity.incarnationId, sequence: input.sequence, type: input.drained ? 'DRAINED' : 'NO_NEW_SOURCE_REQUESTS', payloadHash: sha(seedCanonical(input)), payload: { sourceKey: a.sourceKey, assignmentGeneration: a.assignmentGeneration, pendingHashes: [], attemptId: a.id, drained: input.drained, pendingPreserved: input.pendingPreserved, requestDeadline: a.requestDeadline?.toISOString() ?? null } } });
      await tx.seedTaskAttempt.update({ where: { id: a.id }, data: { state: 'RECOVERING', lastReceiptSeq: input.sequence, stopReason: 'STOP_ACKNOWLEDGED' } }); await tx.seedExecutionTask.update({ where: { id: a.taskId }, data: { state: 'RECOVERING' } });
      await audit(tx, 'SEED_STOP_ACKNOWLEDGED', a.id, { receiptId: receipt.id, drained: input.drained, pendingPreserved: input.pendingPreserved }, undefined, input.requestId); return { receiptId: receipt.id, state: 'RECOVERING' }; });
    if (input.drained && input.checkpoint) { const recovery = await recoverStoppedAttempt(identity, { ...input, checkpoint: input.checkpoint, stopReceiptId: result.receiptId }); return { ...result, ...recovery, state: 'COMPLETED' }; }
    return result;
  }
  async function reconcileCommon(input: { actorUserId?: string; attemptId: string; stopReceiptId: string; checkpoint: any; checkpointRaw?: string }, identity?: MachineIdentity, grantToken?: string) {
    if (identity) await attempt(db, identity, { attemptId: input.attemptId, grantToken: grantToken! }, false); else await requirePlatformAdmin(db, input.actorUserId!);
    const a = await db.seedTaskAttempt.findUnique({ where: { id: input.attemptId }, include: { task: true } }); if (!a) fail('RECOVERY_ATTEMPT_MISSING');
    const cp = await checkpointObject(a.sourceKey, { checkpoint: input.checkpoint, checkpointRaw: input.checkpointRaw } as SubmitInput, a.task.queryId); if (!cp) fail('CHECKPOINT_REQUIRED');
    if (input.checkpointRaw) { let native: any; try { native = JSON.parse(input.checkpointRaw); } catch { fail('CHECKPOINT_NATIVE_STATE_INVALID'); } const q = await db.seedQuery.findUnique({ where: { id: a.task.queryId } }); if (native.sourceKey !== a.sourceKey || native.queryId !== a.task.queryId || !sameNative(a.sourceKey, q.mode, native.nativeParams, q.normalizedParams)) fail('CHECKPOINT_NATIVE_STATE_INVALID'); }
    return txRun(async tx => { if (identity) await attempt(tx, identity, { attemptId: a.id, grantToken: grantToken! }, false); else await requirePlatformAdmin(tx, input.actorUserId!); await lock(tx, 'source:' + a.sourceKey); await lock(tx, 'query:' + a.task.queryId);
      const current = await tx.seedTaskAttempt.findUnique({ where: { id: a.id } }), receipt = await tx.seedCollectorReceipt.findUnique({ where: { id: input.stopReceiptId } });
      if (current.state === 'COMPLETED') { const previous = await tx.auditEvent.findFirst({ where: { action: 'SEED_RECOVERY_CONFIRMED', targetId: a.id } });
        if (previous && previous.metadata.stopReceiptId === input.stopReceiptId && previous.metadata.checkpointSha === cp.sha256 && previous.metadata.checkpointSequence === cp.sequence) return { recovered: true, checkpointSequence: cp.sequence, checkpointRef: cp.reference };
        fail('RECOVERY_IDEMPOTENCY_CONFLICT');
      }
      if (!['RECOVERING', 'RECOVERY_BLOCKED'].includes(current.state) || !receipt || receipt.type !== 'DRAINED' || receipt.nodeId !== a.nodeId || receipt.incarnationId !== a.incarnationId || receipt.payload.attemptId !== a.id || receipt.payload.pendingPreserved !== true) fail('DRAIN_PROOF_REQUIRED');
      if (now().valueOf() < (a.requestDeadline?.valueOf() ?? a.leaseExpiresAt.valueOf()) + options.exitMarginMs) fail('REQUEST_CUTOFF_NOT_ELAPSED');
      const pending = await tx.auditEvent.findMany({ where: { action: 'SEED_UNIT_PREPARED', targetId: a.id } });
      for (const p of pending) { const confirmed = await tx.auditEvent.findMany({ where: { action: 'SEED_BATCH_COMMITTED', targetId: p.id } }); if (!p.metadata.expectedBatchHashes.every((h: string) => confirmed.some((c: any) => c.metadata.batchHash === h))) fail('PENDING_BATCHES_UNCONFIRMED'); }
      if (cp.sequence < a.checkpointSequence || (pending.length && cp.sequence !== a.checkpointSequence + 1)) fail('CHECKPOINT_SEQUENCE_CONFLICT');
      const runtime = await tx.seedRuntimeState.findUnique({ where: { queryId: a.task.queryId } }); if (runtime.assignmentGeneration !== a.assignmentGeneration || runtime.checkpointSequence !== a.checkpointSequence || runtime.collectorId !== a.nodeId) fail('CHECKPOINT_FENCE_LOST');
      const query = await tx.seedQuery.findUnique({ where: { id: a.task.queryId } });
      const batches = await tx.seedAttempt.findMany({ where: { taskAttemptId: a.id } }); if (!batches.every((b: any) => cp.appliedBatchHashes.includes(b.batchSha256))) fail('CHECKPOINT_BATCHES_UNCONFIRMED');
      await adoptNativeSourceState(tx, a.sourceKey, input.checkpointRaw);
      await tx.seedRuntimeState.update({ where: { queryId: a.task.queryId }, data: { checkpointSequence: cp.sequence, checkpointVersion: { increment: 1 }, checkpointRef: cp.reference, checkpointSha: cp.sha256, checkpointDigest: cp.sha256, lastAppliedBatchHashes: cp.appliedBatchHashes, pendingManifestRef: null, stateSchemaVersion: cp.stateSchemaVersion, sessionAffinity: cp.sessionAffinity, executionState: 'IDLE', nextAllowedAt: new Date(Math.max(runtime.nextAllowedAt?.valueOf() ?? 0, nativeNextAt(input.checkpointRaw, query.channel), new Date((await sourceControls(tx, a.sourceKey, query.channel)).snapshot.notBefore).valueOf(), now().valueOf())) } });
      await tx.seedTaskAttempt.update({ where: { id: a.id }, data: { state: 'COMPLETED' } }); await tx.seedExecutionTask.update({ where: { id: a.taskId }, data: { state: 'COMPLETED', outcome: 'STOPPED', completedAt: now() } }); await audit(tx, 'SEED_RECOVERY_CONFIRMED', a.id, { stopReceiptId: receipt.id, checkpointRef: cp.reference, checkpointSha: cp.sha256, checkpointSequence: cp.sequence }, input.actorUserId); return { recovered: true, checkpointSequence: cp.sequence, checkpointRef: cp.reference }; });
  }

  const reconcileRecovery = (input: AdminInput & { attemptId: string; stopReceiptId: string; checkpoint: any; checkpointRaw?: string }) => reconcileCommon(input);
  const recoverStoppedAttempt = (identity: MachineIdentity, input: AttemptInput & { stopReceiptId: string; checkpoint: any; checkpointRaw?: string }) => reconcileCommon(input, identity, input.grantToken);
  async function setSourcePause(input: AdminInput & { sourceKey: SourceKey; manualPause: boolean; reason: string; expectedControlVersion?: number }) {
    return txRun(async tx => { await requirePlatformAdmin(tx, input.actorUserId); const control = await sourceControls(tx, input.sourceKey, '*');
      if (input.expectedControlVersion !== undefined && control.snapshot.controlVersion !== input.expectedControlVersion) fail('SOURCE_CONTROL_CONFLICT');
      const saved = await tx.collectorSourceControl.update({ where: { id: control.exact.id }, data: { manualPause: input.manualPause, reason: input.reason, controlVersion: { increment: 1 }, lastEvidenceAt: now() } });
      // This administrator command is source-wide: an explicit resume also
      // acknowledges imported/channel manual pauses, without reducing cooldown.
      if (!input.manualPause) await tx.collectorSourceControl.updateMany({ where: { sourceKey: input.sourceKey, scopeKey: 'SOURCE', manualPause: true }, data: { manualPause: false, reason: input.reason, controlVersion: { increment: 1 }, lastEvidenceAt: now() } });
      await audit(tx, 'SEED_SOURCE_PAUSE_CHANGED', input.sourceKey, { manualPause: input.manualPause, reason: input.reason, controlVersion: saved.controlVersion }, input.actorUserId); return (await sourceControls(tx, input.sourceKey, '*')).snapshot; });
  }

  async function assignInTransaction(tx: any, input: AdminInput & { sourceKey: SourceKey; channel?: string; nodeId: string; incarnationId: string; publicationRevision: number; configHash: string; controlMode: 'LEGACY_QUEUE' | 'CONFIG_QUEUE' | 'TASK_CLAIM' }) {
      await requirePlatformAdmin(tx, input.actorUserId); await lock(tx, 'node:' + input.nodeId); await lock(tx, 'source:' + input.sourceKey); const channel = input.channel ?? '*';
      const node = await tx.collectorNode.findUnique({ where: { nodeId: input.nodeId } }); if (!node || node.incarnationId !== input.incarnationId || !node.enabled || node.status !== 'STANDBY_READY' || !node.lastHeartbeatAt || (node.expiresAt && node.expiresAt <= now())) fail('NODE_NOT_EXECUTABLE');
      const current = await tx.collectorSourceAssignment.findFirst({ where: { sourceKey: input.sourceKey, channel, state: { in: ['ACTIVE', 'DRAINING'] } } }); if (current) fail('SOURCE_ALREADY_ASSIGNED');
      if (await tx.seedTaskAttempt.count({ where: { sourceKey: input.sourceKey, state: { in: OCCUPIED }, ...(channel === '*' ? {} : { task: { query: { channel } } }) } })) fail('SOURCE_RECOVERY_REQUIRED');
      const source = await tx.dataSource.findUnique({ where: { key: input.sourceKey } }); if (!source) fail('SOURCE_NOT_FOUND');
      const inventory = await tx.$queryRawUnsafe(`SELECT EXISTS(SELECT 1 FROM "AuditEvent" started WHERE started.action='SEED_LEGACY_IMPORT_STARTED' AND started.metadata->'result'->>'sourceKey'=$1 AND NOT EXISTS(SELECT 1 FROM "AuditEvent" completed WHERE completed.action='SEED_LEGACY_IMPORT_COMPLETED' AND completed."targetId"=started."targetId")) AS incomplete`, input.sourceKey);
      if (inventory[0]?.incomplete) fail('LEGACY_INVENTORY_INCOMPLETE');
      if (await tx.collectionRun.count({ where: { dataSourceId: source.id, status: 'RUNNING', leaseExpiresAt: { gt: now() } } })) fail('LEGACY_SOURCE_LEASE_ACTIVE');
      const history = await tx.$queryRawUnsafe("SELECT to_regclass('history_collector.target') IS NOT NULL AS present");
      if (history[0]?.present) { const leased = await tx.$queryRawUnsafe('SELECT EXISTS(SELECT 1 FROM history_collector.target WHERE source_key=$1 AND lease_until>$2) AS busy', input.sourceKey, now()); if (leased[0]?.busy) fail('LEGACY_SOURCE_LEASE_ACTIVE'); }
      const latest = await tx.collectorSourceAssignment.findFirst({ where: { sourceKey: input.sourceKey, channel }, orderBy: { generation: 'desc' } });
      const controls = await sourceControls(tx, input.sourceKey, channel), generation = Math.max(latest?.generation ?? 0, controls.exact.assignmentGeneration) + 1;
      const data = { id: randomUUID(), dataSourceId: source.id, sourceKey: input.sourceKey, channel, nodeId: input.nodeId, incarnationId: input.incarnationId, generation, controlMode: input.controlMode, leaseExpiresAt: new Date(Math.min(now().valueOf() + options.leaseMs, node.expiresAt?.valueOf() ?? Infinity)), publicationRevision: input.publicationRevision, configHash: input.configHash };
      const assignment = await tx.collectorSourceAssignment.create({ data: { ...data, tokenHash: sha(token('platform', data)) } });
      await tx.collectorSourceControl.updateMany({ where: { sourceKey: input.sourceKey, ...(channel === '*' ? {} : { channel }) }, data: { controlMode: input.controlMode, assignmentGeneration: generation } });
      await tx.seedQuery.updateMany({ where: { sourceKey: input.sourceKey, ...(channel === '*' ? {} : { channel }) }, data: { controlMode: input.controlMode, assignmentGeneration: generation } });
      await tx.seedRuntimeState.updateMany({ where: { sourceKey: input.sourceKey, ...(channel === '*' ? {} : { query: { channel } }) }, data: { collectorId: input.nodeId, assignmentGeneration: generation } });
      await audit(tx, 'COLLECTOR_SOURCE_ASSIGNED', assignment.id, { sourceKey: input.sourceKey, channel, generation, nodeId: input.nodeId, incarnationId: input.incarnationId, controlMode: input.controlMode }, input.actorUserId); return assignment;
  }
  async function assignSource(input: AdminInput & { sourceKey: SourceKey; channel?: string; nodeId: string; incarnationId: string; publicationRevision: number; configHash: string; controlMode: 'LEGACY_QUEUE' | 'CONFIG_QUEUE' | 'TASK_CLAIM' }) { return txRun(tx => assignInTransaction(tx, input)); }
  async function readSourceStopContext(identity: MachineIdentity, input: { sourceKey: SourceKey }) {
    return txRun(async tx => { await machine(tx, identity, input.sourceKey); await lock(tx, 'source:' + input.sourceKey);
      const rows = await tx.collectorSourceAssignment.findMany({ where: { sourceKey: input.sourceKey, nodeId: identity.nodeId, incarnationId: identity.incarnationId, state: { in: ['ACTIVE', 'DRAINING'] } }, take: 2 });
      if (rows.length !== 1) fail('TASK_SOURCE_ASSIGNMENT_REQUIRED'); const assignment = rows[0];
      return { schemaVersion: 1, scope: 'source_stop', nodeId: identity.nodeId, incarnationId: identity.incarnationId, sourceKey: input.sourceKey, controlMode: assignment.controlMode, assignmentGeneration: assignment.generation, state: assignment.state, issuedAt: iso(now()) };
    });
  }
  async function acknowledgeSourceStop(identity: MachineIdentity, input: { sourceKey: SourceKey; grantToken?: string; assignmentGeneration?: number; requestId: string; sequence: number; pendingPreserved: boolean; pendingHashes: string[] }) {
    if (!input.requestId || !Number.isSafeInteger(input.sequence) || input.sequence < 1) fail('SOURCE_STOP_INVALID', 400);
    return txRun(async tx => { await machine(tx, identity, input.sourceKey); await lock(tx, 'source:' + input.sourceKey);
      let assignment: any;
      if (input.grantToken) {
        assignment = await tx.collectorSourceAssignment.findUnique({ where: { id: input.grantToken.split('.')[0] } });
        if (!assignment || assignment.nodeId !== identity.nodeId || assignment.incarnationId !== identity.incarnationId || assignment.sourceKey !== input.sourceKey || !equal(input.grantToken, token('platform', assignment))) fail('PLATFORM_GRANT_LOST');
      } else {
        if (!Number.isSafeInteger(input.assignmentGeneration) || input.assignmentGeneration! < 1) fail('TASK_SOURCE_DRAIN_REQUIRED');
        const rows = await tx.collectorSourceAssignment.findMany({ where: { sourceKey: input.sourceKey, nodeId: identity.nodeId, incarnationId: identity.incarnationId, generation: input.assignmentGeneration, controlMode: 'TASK_CLAIM' }, take: 2 });
        if (rows.length !== 1) fail('TASK_SOURCE_DRAIN_REQUIRED'); assignment = rows[0];
      }
      if (!input.pendingPreserved || !Array.isArray(input.pendingHashes) || input.pendingHashes.some(h => !hashPattern.test(h))) fail('PENDING_MANIFEST_REQUIRED');
      const payloadHash = sha(seedCanonical(input)), key = { nodeId_incarnationId_sequence: { nodeId: identity.nodeId, incarnationId: identity.incarnationId, sequence: input.sequence } }, prior = await tx.seedCollectorReceipt.findUnique({ where: key });
      if (prior) { if (prior.payloadHash !== payloadHash) fail('RECEIPT_IDEMPOTENCY_CONFLICT'); return { receiptId: prior.id }; }
      if (!input.grantToken) {
        if (assignment.state !== 'DRAINING') fail('TASK_SOURCE_DRAIN_REQUIRED');
        if (await tx.seedTaskAttempt.count({ where: { sourceKey: input.sourceKey, state: { in: OCCUPIED }, ...(assignment.channel === '*' ? {} : { task: { query: { channel: assignment.channel } } }) } })) fail('SOURCE_RECOVERY_REQUIRED');
      } else {
        if (assignment.state === 'STOPPED') fail('PLATFORM_GRANT_LOST');
        // A local service window ending cannot revoke the central owner.
        if (assignment.state !== 'DRAINING') fail('SOURCE_DRAIN_REQUIRED');
      }
      const saved = await tx.seedCollectorReceipt.create({ data: { nodeId: identity.nodeId, incarnationId: identity.incarnationId, sequence: input.sequence, type: 'DRAINED', payloadHash, payload: { sourceKey: input.sourceKey, assignmentGeneration: assignment.generation, pendingPreserved: true, pendingHashes: input.pendingHashes } } });
      await tx.collectorSourceAssignment.update({ where: { id: assignment.id }, data: { state: 'DRAINING', lastStopReceiptId: saved.id } }); return { receiptId: saved.id };
    });
  }

  async function getPlatformGrant(identity: MachineIdentity, input: { sourceKey: SourceKey; channel?: string }): Promise<PlatformGrant> {
    return txRun(async tx => {
      const node = await machine(tx, identity, input.sourceKey, true); await lock(tx, 'source:' + input.sourceKey);
      const assignment = await tx.collectorSourceAssignment.findFirst({ where: { sourceKey: input.sourceKey, nodeId: identity.nodeId, incarnationId: identity.incarnationId, state: 'ACTIVE', ...(input.channel ? { channel: input.channel } : {}) }, orderBy: { generation: 'desc' } });
      if (!assignment || assignment.controlMode === 'TASK_CLAIM') fail('PLATFORM_ASSIGNMENT_REQUIRED');
      if (assignment.leaseExpiresAt <= now()) fail('PLATFORM_ASSIGNMENT_EXPIRED');
      const candidates = await tx.seedCollectorReceipt.findMany({ where: { nodeId: identity.nodeId, incarnationId: identity.incarnationId, type: 'APPLIED', applyStatus: 'APPLIED' }, orderBy: [{ publicationRevision: 'desc' }, { sequence: 'desc' }] });
      let latestApplied: any;
      for (const receipt of candidates) {
        const publication = await tx.seedPublication.findUnique({ where: { revision: receipt.publicationRevision } }); if (!publication) continue;
        const full = publication.configSnapshot.manifest ?? publication.configSnapshot, mappings = receipt.nativeJobMappings?.length ? receipt.nativeJobMappings : receipt.payload?.nativeJobMappings ?? [];
        const scopes = receipt.queryCounts?.sourceScopes;
        if (Array.isArray(scopes)) { if (!scopes.includes(input.sourceKey)) continue; }
        else if (!mappings.some((m: any) => full.queries.some((q: any) => q.queryId === m.queryId && q.sourceKey === input.sourceKey && q.nativeJobIds.includes(m.nativeJobId)))) {
          const tombstoneSource = await tx.seedQuery.count({ where: { sourceKey: input.sourceKey, id: { in: full.tombstones.map((t: any) => t.queryId) } } });
          if (!tombstoneSource && !full.queries.some((q: any) => q.sourceKey === input.sourceKey) && !(identity.allowedSourceKeys.length === 1 && identity.allowedSourceKeys[0] === input.sourceKey)) continue;
        }
        try { await applied(tx, identity, receipt.publicationRevision, receipt.manifestHash, undefined, input.sourceKey); }
        catch (error) { if (error instanceof DomainError && error.code === 'CONFIG_HASH_MISMATCH') continue; throw error; }
        latestApplied = receipt; break;
      }
      if (latestApplied && latestApplied.publicationRevision >= assignment.publicationRevision && (latestApplied.publicationRevision !== assignment.publicationRevision || latestApplied.manifestHash !== assignment.configHash)) { await applied(tx, identity, latestApplied.publicationRevision, latestApplied.manifestHash, undefined, input.sourceKey); assignment.publicationRevision = latestApplied.publicationRevision; assignment.configHash = latestApplied.manifestHash; await tx.collectorSourceAssignment.update({ where: { id: assignment.id }, data: { publicationRevision: assignment.publicationRevision, configHash: assignment.configHash } }); }
      if (assignment.configHash === null || assignment.publicationRevision < 1) fail('CONFIG_NOT_APPLIED');
      await applied(tx, identity, assignment.publicationRevision, assignment.configHash, undefined, input.sourceKey);
      const control = await sourceControls(tx, input.sourceKey, assignment.channel);
      // This is a renewal of the centrally selected owner, never an owner election.
      const expiry = new Date(Math.min(now().valueOf() + options.leaseMs, node.expiresAt?.valueOf() ?? Infinity));
      await tx.collectorSourceAssignment.update({ where: { id: assignment.id }, data: { leaseExpiresAt: expiry } });
      return { schemaVersion: 1, protocolVersion: 1, scope: 'platform_queue', controlMode: assignment.controlMode, nodeId: identity.nodeId, incarnationId: identity.incarnationId, sourceKey: input.sourceKey, assignmentGeneration: assignment.generation, publicationRevision: assignment.publicationRevision, configHash: assignment.configHash, serverNow: iso(now()), validUntil: iso(expiry), requestDeadline: iso(new Date(Math.min(now().valueOf() + options.requestBudgetMs, expiry.valueOf() - options.exitMarginMs))), grantToken: token('platform', assignment), sourceControlVersion: control.snapshot.controlVersion };
    });
  }
  async function platformPermit(identity: MachineIdentity, input: { grantToken: string; sourceKey: SourceKey; queryId?: string; nativeJobId?: string; mode?: string; channel?: string; requestKind: string; requestId?: string; nativeParams?: Record<string, unknown> }): Promise<PermitResult> {
    return txRun(async tx => {
      const node = await machine(tx, identity, input.sourceKey, true); await lock(tx, 'node:' + node.nodeId); await lock(tx, 'source:' + input.sourceKey);
      const assignment = await tx.collectorSourceAssignment.findUnique({ where: { id: input.grantToken.split('.')[0] } });
      if (!assignment || assignment.sourceKey !== input.sourceKey || assignment.nodeId !== identity.nodeId || assignment.incarnationId !== identity.incarnationId || assignment.state !== 'ACTIVE' || assignment.leaseExpiresAt <= now() || !equal(input.grantToken, token('platform', assignment))) fail('PLATFORM_GRANT_LOST');
      const control = await sourceControls(tx, input.sourceKey, input.channel ?? assignment.channel); if (!control.allowed) return { allowed: false, reason: 'SOURCE_COOLDOWN', sourceControl: control.snapshot };
      if (!['LEGACY_QUEUE', 'CONFIG_QUEUE'].includes(assignment.controlMode) || !input.queryId) fail('CONFIG_QUERY_REQUIRED');
      const q = await tx.seedQuery.findUnique({ where: { id: input.queryId }, include: { runtime: true } });
      if (!q || q.sourceKey !== input.sourceKey || !q.desiredEnabled || q.assignmentGeneration !== assignment.generation || q.runtime.desiredRevision !== assignment.publicationRevision || (input.mode && q.mode !== input.mode) || (input.channel && q.channel !== input.channel)) fail('CONFIG_QUERY_MISMATCH');
      if (input.nativeParams && !sameNative(input.sourceKey, q.mode, input.nativeParams, q.normalizedParams)) fail('EXECUTION_PARAMS_MISMATCH');
      await applied(tx, identity, assignment.publicationRevision, assignment.configHash, q.id);
      if (input.nativeJobId) { const publication = await tx.seedPublication.findUnique({ where: { revision: assignment.publicationRevision } }), manifest = publication.configSnapshot.manifest ?? publication.configSnapshot; if (!manifest.queries.some((spec: any) => spec.queryId === q.id && spec.nativeJobIds.includes(input.nativeJobId))) fail('NATIVE_MAPPING_MISSING'); }
      await lock(tx, 'query:' + q.id);
      const prior = await tx.seedTaskAttempt.findFirst({ where: { sourceKey: input.sourceKey, nodeId: identity.nodeId, incarnationId: identity.incarnationId, task: { queryId: q.id }, state: { in: OCCUPIED } }, include: { task: { include: { query: true } } } });
      if (prior) { if (prior.assignmentGeneration !== assignment.generation || prior.state !== 'RUNNING' || prior.leaseExpiresAt <= now() || prior.requestDeadline <= now()) return { allowed: false, reason: 'QUERY_RECOVERY_REQUIRED', sourceControl: control.snapshot }; const g = await grant(tx, prior); return { allowed: true, sourceControl: control.snapshot, grant: g, context: { ...contextOf(g), nativeJobId: input.nativeJobId } }; }
      if (input.requestKind !== 'UNIT_START') fail('UNIT_START_REQUIRED');
      if (node.resourceSnapshot?.pressure === 'HIGH' || node.resourceSnapshot?.healthy === false) return { allowed: false, reason: 'RESOURCE_BACKPRESSURE', sourceControl: control.snapshot };
      if (await tx.seedExecutionTask.count({ where: { queryId: q.id, state: { in: OCCUPIED } } })) return { allowed: false, reason: 'QUERY_RECOVERY_REQUIRED', sourceControl: control.snapshot };
      const busy = await tx.seedTaskAttempt.count({ where: { nodeId: identity.nodeId, state: { in: OCCUPIED } } }); if (busy >= Number(node.resourceSnapshot.maxSlots ?? 0)) return { allowed: false, reason: 'NO_RESOURCE_SLOT', sourceControl: control.snapshot };
      const bindings = await owners(tx, q.id, assignment.publicationRevision), task = await tx.seedExecutionTask.create({ data: { queryId: q.id, dataSourceId: q.dataSourceId, sourceKey: q.sourceKey, cycleKey: 'config:' + assignment.generation + ':' + (input.requestId ?? randomUUID()), workUnitKey: 'checkpoint:' + q.runtime.checkpointSequence, publicationRevision: assignment.publicationRevision, schedulePolicyVersion: 'compatibility-fair-1', state: 'RUNNING' } });
      const expiry = new Date(Math.min(now().valueOf() + options.leaseMs, assignment.leaseExpiresAt.valueOf())), deadline = new Date(Math.min(now().valueOf() + options.requestBudgetMs, expiry.valueOf() - options.exitMarginMs));
      if (deadline <= now()) fail('REQUEST_DEADLINE_EXPIRED');
      const data = { id: randomUUID(), taskId: task.id, dataSourceId: q.dataSourceId, sourceKey: q.sourceKey, attemptNo: 1, nodeId: node.nodeId, incarnationId: node.incarnationId, assignmentGeneration: assignment.generation, leaseVersion: 1, leaseExpiresAt: expiry, requestDeadline: deadline, publicationRevision: assignment.publicationRevision, configHash: assignment.configHash, checkpointSequence: q.runtime.checkpointSequence, state: 'RUNNING', startedAt: now(), heartbeatAt: now(), bindingSnapshot: bindings, primaryOwner: bindings[0] };
      const a = await tx.seedTaskAttempt.create({ data: { ...data, tokenHash: sha(token('attempt', data)) } });
      await tx.seedRuntimeState.update({ where: { queryId: q.id }, data: { executionState: 'RUNNING', appliedRevision: assignment.publicationRevision, lastAttemptAt: now() } });
      const g = await grant(tx, { ...a, task: { ...task, query: q } }); return { allowed: true, sourceControl: control.snapshot, grant: g, context: { ...contextOf(g), nativeJobId: input.nativeJobId } };
    });
  }
  async function verifiedSourceCheckpoints(sourceKey: SourceKey, channel: string) {
    const rows = await db.seedRuntimeState.findMany({ where: { sourceKey, ...(channel === '*' ? {} : { query: { channel } }), OR: [{ checkpointSequence: { gt: 0 } }, { pendingManifestRef: { not: null } }, { query: { legacyMappings: { some: {} } } }] }, orderBy: { queryId: 'asc' } });
    for (const r of rows) {
      if (!r.checkpointRef || !r.checkpointSha || r.pendingManifestRef) fail('CHECKPOINT_REQUIRED');
      const key = collectorEvidenceKey({ prefix: options.evidencePrefix, sourceKey }, r.checkpointSha);
      if (r.checkpointRef !== `${options.evidenceScheme}:${key}`) fail('CHECKPOINT_REFERENCE_REJECTED');
      const bytes = await (await options.storeForSource(sourceKey)).get(key); if (sha(bytes) !== r.checkpointSha) fail('CHECKPOINT_HASH_MISMATCH');
    }
    return sha(seedCanonical(rows.map((r: any) => [r.queryId, r.checkpointSequence, r.checkpointSha, r.checkpointRef, r.assignmentGeneration, r.pendingManifestRef])));
  }
  async function assertStopProof(tx: any, sourceKey: SourceKey, channel: string, current: any, stopReceiptId: string, checkpointFingerprint: string) {
    const receipt = await tx.seedCollectorReceipt.findUnique({ where: { id: stopReceiptId } });
    if (!receipt || receipt.type !== 'DRAINED' || receipt.nodeId !== current.nodeId || receipt.incarnationId !== current.incarnationId || receipt.payload.sourceKey !== sourceKey || receipt.payload.assignmentGeneration !== current.generation || receipt.payload.pendingPreserved !== true) fail('DRAIN_PROOF_REQUIRED');
    if (!Array.isArray(receipt.payload.pendingHashes) || receipt.payload.pendingHashes.some((h: string) => !hashPattern.test(h))) fail('PENDING_MANIFEST_REQUIRED');
    const registered = await tx.auditEvent.findMany({ where: { action: 'SEED_LEGACY_PENDING_REGISTERED', metadata: { path: ['sourceKey'], equals: sourceKey } } });
    const required = [...new Set<string>([...receipt.payload.pendingHashes, ...registered.filter((p: any) => p.metadata.nodeId === current.nodeId && p.metadata.incarnationId === current.incarnationId).flatMap((p: any) => p.metadata.batchHashes)])];
    if (required.length) { const facts = await tx.seedAttempt.findMany({ where: { sourceKey, batchSha256: { in: required } }, select: { batchSha256: true } }); if (!required.every(hash => facts.some((f: any) => f.batchSha256 === hash))) fail('PENDING_BATCHES_UNCONFIRMED'); }
    if (now().valueOf() <= current.leaseExpiresAt.valueOf() + options.exitMarginMs) fail('REQUEST_CUTOFF_NOT_ELAPSED');
    if (await tx.seedTaskAttempt.count({ where: { sourceKey, state: { in: OCCUPIED }, ...(channel === '*' ? {} : { task: { query: { channel } } }) } })) fail('SOURCE_RECOVERY_REQUIRED');
    const rows = await tx.seedRuntimeState.findMany({ where: { sourceKey, ...(channel === '*' ? {} : { query: { channel } }), OR: [{ checkpointSequence: { gt: 0 } }, { pendingManifestRef: { not: null } }, { query: { legacyMappings: { some: {} } } }] }, orderBy: { queryId: 'asc' } });
    if (sha(seedCanonical(rows.map((r: any) => [r.queryId, r.checkpointSequence, r.checkpointSha, r.checkpointRef, r.assignmentGeneration, r.pendingManifestRef]))) !== checkpointFingerprint) fail('CHECKPOINT_FENCE_LOST');
    return receipt;
  }
  async function switchSourceMode(input: AdminInput & { sourceKey: SourceKey; channel?: string; nodeId: string; incarnationId: string; publicationRevision: number; configHash: string; controlMode: 'LEGACY_QUEUE' | 'CONFIG_QUEUE' | 'TASK_CLAIM'; stopReceiptId: string }) {
    await requirePlatformAdmin(db, input.actorUserId);
    const channel = input.channel ?? '*', fingerprint = await verifiedSourceCheckpoints(input.sourceKey, channel);
    return txRun(async tx => { await requirePlatformAdmin(tx, input.actorUserId); await lock(tx, 'node:' + input.nodeId); await lock(tx, 'source:' + input.sourceKey);
      const current = await tx.collectorSourceAssignment.findFirst({ where: { sourceKey: input.sourceKey, channel, state: { in: ['ACTIVE', 'DRAINING'] } } }); if (!current) fail('SOURCE_ASSIGNMENT_MISSING');
      const receipt = await assertStopProof(tx, input.sourceKey, channel, current, input.stopReceiptId, fingerprint);
      await tx.collectorSourceAssignment.update({ where: { id: current.id }, data: { state: 'STOPPED', lastStopReceiptId: receipt.id } });
      return assignInTransaction(tx, input);
    });
  }
  async function retireSourceAssignment(input: AdminInput & { sourceKey: SourceKey; channel?: string; stopReceiptId: string; reason: string }) {
    await requirePlatformAdmin(db, input.actorUserId); if (!input.reason) fail('RETIRE_REASON_REQUIRED', 400);
    const channel = input.channel ?? '*', fingerprint = await verifiedSourceCheckpoints(input.sourceKey, channel);
    const first = await db.collectorSourceAssignment.findFirst({ where: { sourceKey: input.sourceKey, channel, state: { in: ['ACTIVE', 'DRAINING'] } } }); if (!first) fail('SOURCE_ASSIGNMENT_MISSING');
    return txRun(async tx => { await requirePlatformAdmin(tx, input.actorUserId); await lock(tx, 'node:' + first.nodeId); await lock(tx, 'source:' + input.sourceKey);
      const current = await tx.collectorSourceAssignment.findUnique({ where: { id: first.id } }); if (!current || current.state === 'STOPPED') fail('SOURCE_ASSIGNMENT_MISSING');
      const receipt = await assertStopProof(tx, input.sourceKey, channel, current, input.stopReceiptId, fingerprint);
      await tx.collectorSourceAssignment.update({ where: { id: current.id }, data: { state: 'STOPPED', lastStopReceiptId: receipt.id } });
      const control = await sourceControls(tx, input.sourceKey, channel); await tx.collectorSourceControl.update({ where: { id: control.exact.id }, data: { manualPause: true, reason: 'SOURCE_ASSIGNMENT_RETIRED', controlVersion: { increment: 1 }, lastEvidenceAt: now() } });
      await audit(tx, 'COLLECTOR_SOURCE_RETIRED', current.id, { reason: input.reason, stopReceiptId: receipt.id, generation: current.generation }, input.actorUserId);
      return { retired: true, assignmentId: current.id, generation: current.generation, nodeId: current.nodeId, incarnationId: current.incarnationId };
    });
  }
  async function readControlHandoff(identity: MachineIdentity, input: ControlHandoffInput): Promise<ControlHandoffProof> {
    if (!input.requestId || input.fromMode === input.toMode || !['LEGACY_QUEUE', 'CONFIG_QUEUE', 'TASK_CLAIM'].includes(input.fromMode) || !['LEGACY_QUEUE', 'CONFIG_QUEUE', 'TASK_CLAIM'].includes(input.toMode)) fail('CONTROL_HANDOFF_INVALID', 400);
    return txRun(async tx => { await lock(tx, 'node:' + identity.nodeId); await lock(tx, 'source:' + input.sourceKey); await machine(tx, identity, input.sourceKey, true);
      const current = await tx.collectorSourceAssignment.findFirst({ where: { sourceKey: input.sourceKey, nodeId: identity.nodeId, incarnationId: identity.incarnationId, state: 'ACTIVE', controlMode: input.toMode, publicationRevision: input.publicationRevision, configHash: input.configHash }, orderBy: { generation: 'desc' } });
      if (!current || current.leaseExpiresAt <= now()) fail('CONTROL_HANDOFF_ASSIGNMENT_REQUIRED');
      const previous = await tx.collectorSourceAssignment.findFirst({ where: { sourceKey: input.sourceKey, channel: current.channel, generation: current.generation - 1, state: 'STOPPED', controlMode: input.fromMode } });
      if (!previous?.lastStopReceiptId) fail('CONTROL_HANDOFF_PROOF_REQUIRED');
      const receipt = await tx.seedCollectorReceipt.findUnique({ where: { id: previous.lastStopReceiptId } });
      if (!receipt || receipt.type !== 'DRAINED' || receipt.nodeId !== previous.nodeId || receipt.incarnationId !== previous.incarnationId || receipt.payload.sourceKey !== input.sourceKey || receipt.payload.assignmentGeneration !== previous.generation || receipt.payload.pendingPreserved !== true || now().valueOf() <= previous.leaseExpiresAt.valueOf() + options.exitMarginMs) fail('CONTROL_HANDOFF_PROOF_REQUIRED');
      if (await tx.seedTaskAttempt.count({ where: { sourceKey: input.sourceKey, assignmentGeneration: { lt: current.generation }, state: { in: OCCUPIED }, ...(current.channel === '*' ? {} : { task: { query: { channel: current.channel } } }) } })) fail('SOURCE_RECOVERY_REQUIRED');
      const manifest = await applied(tx, identity, input.publicationRevision, input.configHash, undefined, input.sourceKey);
      if (input.nativeJobMappings?.some(mapping => !manifest.queries.some(q => q.sourceKey === input.sourceKey && q.queryId === mapping.queryId && q.nativeJobIds.includes(mapping.nativeJobId)))) fail('NATIVE_MAPPING_MISSING');
      const payloadHash = sha(seedCanonical(input)), requestId = 'handoff:' + identity.nodeId + ':' + identity.incarnationId + ':' + input.requestId;
      const prior = await tx.auditEvent.findFirst({ where: { action: 'COLLECTOR_CONTROL_HANDOFF', requestId } }); if (prior) { if (prior.metadata.payloadHash !== payloadHash || prior.targetId !== current.id) fail('CONTROL_HANDOFF_IDEMPOTENCY_CONFLICT'); return prior.metadata.proof; }
      const proof: ControlHandoffProof = { schemaVersion: 1, nodeId: identity.nodeId, incarnationId: identity.incarnationId, sourceKey: input.sourceKey, fromMode: input.fromMode, toMode: input.toMode, assignmentGeneration: current.generation, publicationRevision: input.publicationRevision, configHash: input.configHash, drainedReceiptId: receipt.id, issuedAt: iso(now()), handoffId: randomUUID(), requestId: input.requestId };
      await audit(tx, 'COLLECTOR_CONTROL_HANDOFF', current.id, { payloadHash, proof }, undefined, requestId); return proof;
    });
  }
  async function readCheckpoint(identity: MachineIdentity, input: AttemptInput & { queryId: string }) {
    const { a, q } = await attempt(db, identity, input); if (q.id !== input.queryId) fail('CHECKPOINT_QUERY_MISMATCH');
    const runtime = await db.seedRuntimeState.findUnique({ where: { queryId: q.id } });
    if (runtime.assignmentGeneration !== a.assignmentGeneration || runtime.checkpointSequence !== a.checkpointSequence) fail('CHECKPOINT_FENCE_LOST');
    if (!runtime.checkpointRef && !runtime.checkpointSha) return { checkpointSequence: 0, checkpointRef: null, checkpointSha: null, stateSchemaVersion: runtime.stateSchemaVersion, sessionAffinity: runtime.sessionAffinity, raw: null };
    const key = collectorEvidenceKey({ prefix: options.evidencePrefix, sourceKey: q.sourceKey }, runtime.checkpointSha);
    if (runtime.checkpointRef !== `${options.evidenceScheme}:${key}`) fail('CHECKPOINT_REFERENCE_REJECTED');
    const bytes = await (await options.storeForSource(q.sourceKey)).get(key); if (sha(bytes) !== runtime.checkpointSha) fail('CHECKPOINT_HASH_MISMATCH');
    await attempt(db, identity, input);
    return { checkpointSequence: runtime.checkpointSequence, checkpointRef: runtime.checkpointRef, checkpointSha: runtime.checkpointSha, stateSchemaVersion: runtime.stateSchemaVersion, sessionAffinity: runtime.sessionAffinity, raw: Buffer.from(bytes).toString('utf8') };
  }
  return { readSourceStopContext, readControlHandoff, retireSourceAssignment, acknowledgeSourceStop, setSourcePause, recoverStoppedAttempt, readCheckpoint, registerNode, heartbeat, verifyNode, setNodeEnabled, scheduleDueQueries, claimTask, startAttempt, renewAttempt, acquireSourcePermit, recordRestriction, requestStop, recoverExpiredAttempts, prepareSubmission, submitManagedUnit, registerLegacyPending, recoverSubmit, acknowledgeStop, reconcileRecovery, assignSource, getPlatformGrant, platformPermit, switchSourceMode };
}
