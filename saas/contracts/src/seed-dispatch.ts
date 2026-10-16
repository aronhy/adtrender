import { seedSourceKeys, type SourceKey } from './seeds.js';
export type ExecutionOutcome = 'HAS_RESULTS' | 'IDENTITY_FOUND' | 'RELIABLE_NO_RESULTS' | 'PARTIAL' | 'RATE_LIMITED' | 'TIMEOUT' | 'FAILED' | 'STOPPED';
export interface ExecutionGrant {
  schemaVersion: 1; protocolVersion: number; grantToken: string; nodeId: string; incarnationId: string; sourceKey: SourceKey;
  queryId: string; taskId: string; attemptId: string; assignmentGeneration: number; leaseVersion: number;
  publicationRevision: number; configHash: string; checkpointSequence: number; checkpointRef: string | null;
  sourceControlVersion: number; serverNow: string; validUntil: string; requestDeadline: string; nativeParams: Record<string, unknown>;
}
export interface ExecutionReceipt {
  schemaVersion: 1; protocolVersion: number; requestId: string; nodeId: string; incarnationId: string; sequence: number;
  type: 'STARTED' | 'PROGRESS' | 'COMMITTED' | 'STOPPED' | 'RECOVERED'; payloadHash: string; sourceKey: SourceKey;
  queryId: string; taskId: string; attemptId: string; assignmentGeneration: number; leaseVersion: number;
  publicationRevision: number; configHash: string; runIds: string[]; batchHashes: string[];
  committedCheckpointSequence: number | null; observedAt: string; outcome: ExecutionOutcome;
  counts: { fetched: number; inserted: number; updated: number; quarantined: number };
  restriction: { reason: string; notBefore: string; controlVersion: number } | null;
}
export interface CheckpointEnvelope {
  schemaVersion: 1; adapterStateVersion: string; queryId: string; sequence: number; reference: string; sha256: string;
  stateSchemaVersion: number; appliedBatchHashes: string[]; sessionAffinity: string | null;
}
export interface SourceControlSnapshot {
  sourceKey: SourceKey; channel: string; scopeKey: string; notBefore: string; retryAfterUntil: string | null;
  manualPause: boolean; restrictionCount: number; controlVersion: number; reason: string | null; lastEvidenceAt: string | null;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i, sha = /^[a-f0-9]{64}$/;
function check(ok: unknown) { if (!ok) throw new Error('INVALID_DISPATCH_ENVELOPE'); }
function object(value: unknown): Record<string, any> { check(value && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value))); return value as Record<string, any>; }
function exact(v: Record<string, unknown>, keys: string[]) { check(Object.keys(v).every(key => keys.includes(key))); }
function integer(v: unknown, min = 0) { return Number.isSafeInteger(v) && Number(v) >= min; }
function text(v: unknown, max = 200) { return typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v); }
function time(v: unknown): v is string { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v)); }
function identity(v: Record<string, any>) { for (const key of ['queryId', 'taskId', 'attemptId', 'incarnationId']) check(typeof v[key] === 'string' && uuid.test(v[key])); check(text(v.nodeId, 120) && seedSourceKeys.includes(v.sourceKey) && v.schemaVersion === 1 && integer(v.protocolVersion, 1) && integer(v.assignmentGeneration) && integer(v.leaseVersion, 1) && integer(v.publicationRevision, 1) && sha.test(v.configHash)); }
function list(value: unknown, pattern: RegExp) { check(Array.isArray(value) && value.every(item => typeof item === 'string' && pattern.test(item)) && new Set(value).size === value.length); }
export function validateExecutionGrant(value: unknown): ExecutionGrant {
  const v = object(value); exact(v, ['schemaVersion', 'protocolVersion', 'grantToken', 'nodeId', 'incarnationId', 'sourceKey', 'queryId', 'taskId', 'attemptId', 'assignmentGeneration', 'leaseVersion', 'publicationRevision', 'configHash', 'checkpointSequence', 'checkpointRef', 'sourceControlVersion', 'serverNow', 'validUntil', 'requestDeadline', 'nativeParams']); identity(v);
  check(text(v.grantToken, 4096) && v.grantToken.length >= 24 && integer(v.checkpointSequence) && (v.checkpointRef === null || text(v.checkpointRef, 2000)) && integer(v.sourceControlVersion));
  check(time(v.serverNow) && time(v.validUntil) && time(v.requestDeadline) && Date.parse(v.serverNow) < Date.parse(v.requestDeadline) && Date.parse(v.requestDeadline) <= Date.parse(v.validUntil)); object(v.nativeParams); return JSON.parse(JSON.stringify(v));
}
export function validateDispatchReceipt(value: unknown): ExecutionReceipt {
  const v = object(value); exact(v, ['schemaVersion', 'protocolVersion', 'requestId', 'nodeId', 'incarnationId', 'sequence', 'type', 'payloadHash', 'sourceKey', 'queryId', 'taskId', 'attemptId', 'assignmentGeneration', 'leaseVersion', 'publicationRevision', 'configHash', 'runIds', 'batchHashes', 'committedCheckpointSequence', 'observedAt', 'outcome', 'counts', 'restriction']); identity(v);
  check(uuid.test(v.requestId) && integer(v.sequence, 1) && ['STARTED', 'PROGRESS', 'COMMITTED', 'STOPPED', 'RECOVERED'].includes(v.type) && sha.test(v.payloadHash) && time(v.observedAt));
  check(['HAS_RESULTS', 'IDENTITY_FOUND', 'RELIABLE_NO_RESULTS', 'PARTIAL', 'RATE_LIMITED', 'TIMEOUT', 'FAILED', 'STOPPED'].includes(v.outcome)); list(v.runIds, uuid); list(v.batchHashes, sha);
  check(v.committedCheckpointSequence === null || integer(v.committedCheckpointSequence)); const counts = object(v.counts); exact(counts, ['fetched', 'inserted', 'updated', 'quarantined']); check(['fetched', 'inserted', 'updated', 'quarantined'].every(key => integer(counts[key])));
  if (v.restriction !== null) { const r = object(v.restriction); exact(r, ['reason', 'notBefore', 'controlVersion']); check(text(r.reason) && time(r.notBefore) && integer(r.controlVersion)); }
  return JSON.parse(JSON.stringify(v));
}
export function validateCheckpointEnvelope(value: unknown): CheckpointEnvelope {
  const v = object(value); exact(v, ['schemaVersion', 'adapterStateVersion', 'queryId', 'sequence', 'reference', 'sha256', 'stateSchemaVersion', 'appliedBatchHashes', 'sessionAffinity']);
  check(v.schemaVersion === 1 && text(v.adapterStateVersion) && uuid.test(v.queryId) && integer(v.sequence) && text(v.reference, 2000) && /^(?:s3|local-private):/.test(v.reference) && sha.test(v.sha256) && integer(v.stateSchemaVersion, 1) && (v.sessionAffinity === null || text(v.sessionAffinity, 1000))); list(v.appliedBatchHashes, sha); return JSON.parse(JSON.stringify(v));
}
export function validateSourceControlSnapshot(value: unknown): SourceControlSnapshot {
  const v = object(value); exact(v, ['sourceKey', 'channel', 'scopeKey', 'notBefore', 'retryAfterUntil', 'manualPause', 'restrictionCount', 'controlVersion', 'reason', 'lastEvidenceAt']);
  check(seedSourceKeys.includes(v.sourceKey) && text(v.channel) && text(v.scopeKey, 1000) && time(v.notBefore) && (v.retryAfterUntil === null || time(v.retryAfterUntil)) && typeof v.manualPause === 'boolean' && integer(v.restrictionCount) && integer(v.controlVersion) && (v.reason === null || text(v.reason)) && (v.lastEvidenceAt === null || time(v.lastEvidenceAt))); return JSON.parse(JSON.stringify(v));
}
