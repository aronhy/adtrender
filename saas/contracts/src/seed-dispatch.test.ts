import { describe, expect, it } from 'vitest';
import { validateDispatchReceipt, validateExecutionGrant, validateCheckpointEnvelope, validateSourceControlSnapshot } from './seed-dispatch.js';
const id = '11111111-1111-4111-8111-111111111111';
const receipt = () => ({ schemaVersion: 1, protocolVersion: 1, requestId: id, nodeId: 'node-1', incarnationId: id, sequence: 1, type: 'COMMITTED', payloadHash: 'a'.repeat(64), sourceKey: 'meta_ad_library', queryId: id, taskId: id, attemptId: id, assignmentGeneration: 1, leaseVersion: 1, publicationRevision: 1, configHash: 'b'.repeat(64), runIds: [id], batchHashes: ['c'.repeat(64)], committedCheckpointSequence: 1, observedAt: '2026-10-11T00:00:00.000Z', outcome: 'HAS_RESULTS', counts: { fetched: 2, inserted: 1, updated: 1, quarantined: 0 }, restriction: null });
describe('dispatch envelopes', () => {
  it('accepts results and restrictions together without calling the unit complete coverage', () => {
    const value = { ...receipt(), outcome: 'PARTIAL', restriction: { reason: 'HTTP_429', notBefore: '2026-10-11T01:00:00.000Z', controlVersion: 2 } };
    expect(validateDispatchReceipt(value)).toMatchObject({ outcome: 'PARTIAL', restriction: { reason: 'HTTP_429' } });
  });
  it('rejects unversioned receipts, unknown sources, negative counts and duplicate batch acknowledgements', () => {
    const missing: any = receipt(); delete missing.schemaVersion;
    expect(() => validateDispatchReceipt(missing)).toThrow();
    expect(() => validateDispatchReceipt({ ...receipt(), sourceKey: 'fake' })).toThrow();
    expect(() => validateDispatchReceipt({ ...receipt(), counts: { fetched: 1, inserted: -1, updated: 0, quarantined: 0 } })).toThrow();
    expect(() => validateDispatchReceipt({ ...receipt(), batchHashes: ['c'.repeat(64), 'c'.repeat(64)] })).toThrow();
  });
  it('requires full attempt identity and a bounded central deadline in grants', () => {
    const value = { schemaVersion: 1, protocolVersion: 1, grantToken: 'test-token-with-adequate-entropy', nodeId: 'node-1', incarnationId: id, sourceKey: 'meta_ad_library', queryId: id, taskId: id, attemptId: id, assignmentGeneration: 1, leaseVersion: 1, publicationRevision: 1, configHash: 'b'.repeat(64), checkpointSequence: 0, checkpointRef: null, sourceControlVersion: 1, serverNow: '2026-10-11T00:00:00.000Z', validUntil: '2026-10-11T00:01:00.000Z', requestDeadline: '2026-10-11T00:00:50.000Z', nativeParams: { country: 'US', keyword: 'furniture' } };
    expect(validateExecutionGrant(value).leaseVersion).toBe(1);
    expect(() => validateExecutionGrant({ ...value, incarnationId: '' })).toThrow();
    expect(() => validateExecutionGrant({ ...value, requestDeadline: '2026-10-11T00:02:00.000Z' })).toThrow();
  });
  it('requires digest and schema for opaque checkpoints and a node-independent control scope', () => {
    const checkpoint = { schemaVersion: 1, adapterStateVersion: 'meta-state-1', queryId: id, sequence: 1, reference: 's3:private-source-evidence/checkpoints/test.json', sha256: 'c'.repeat(64), stateSchemaVersion: 1, appliedBatchHashes: ['a'.repeat(64)], sessionAffinity: null };
    expect(validateCheckpointEnvelope(checkpoint).sequence).toBe(1);
    expect(() => validateCheckpointEnvelope({ ...checkpoint, sha256: 'bad' })).toThrow();
    const control = { sourceKey: 'meta_ad_library', channel: 'PUBLIC_LIBRARY', scopeKey: 'SOURCE', notBefore: '2026-10-11T01:00:00.000Z', retryAfterUntil: null, manualPause: false, restrictionCount: 1, controlVersion: 1, reason: 'HTTP_429', lastEvidenceAt: '2026-10-11T00:00:00.000Z' };
    expect(validateSourceControlSnapshot(control).scopeKey).toBe('SOURCE');
    expect(() => validateSourceControlSnapshot({ ...control, nodeId: 'node-2' })).toThrow();
  });
});
