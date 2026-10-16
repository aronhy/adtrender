import type { CheckpointEnvelope, ExecutionGrant, SourceControlSnapshot } from '@ad-research/contracts/seed-dispatch';
import type { SourceKey } from '@ad-research/contracts/seeds';
export interface ArtifactStore { putIfAbsent(key: string, bytes: Uint8Array, sha256: string): Promise<'CREATED' | 'EXISTS'>; get(key: string): Promise<Uint8Array> }
export interface MachineIdentity { nodeId: string; incarnationId: string; allowedSourceKeys: readonly SourceKey[] }
export interface DispatchOptions {
  tokenSecret: string; leaseMs: number; requestBudgetMs: number; exitMarginMs: number; requestSpacingMs: number;
  cycleMs: number; unknownOutcomeBackoffMs: number; evidencePrefix: string; evidenceScheme: 's3' | 'local-private';
  storeForSource(source: SourceKey): ArtifactStore | Promise<ArtifactStore>; now?: () => Date;
}
export interface AdminInput { actorUserId: string }
export interface RegisterNodeInput extends AdminInput { nodeId: string; incarnationId: string; registryRevision: number; enabled: boolean; expiresAt: Date | null; codeRevision: string; protocolVersions: number[] }
export interface VerifyNodeInput extends AdminInput { nodeId: string; incarnationId: string; codeRevision: string; capabilityDigest: string; maxSlots: number }
export interface ClaimInput { requestId: string; appliedRevision: number; configHash: string; availableSlots: number; supportedModes: string[]; sourceKey?: SourceKey; queryIds?: string[] }
export interface AttemptInput { grantToken: string; attemptId: string; sequence?: number }
export interface ExecutionContext {
  grantToken: string; sourceKey: SourceKey; queryId: string; taskId?: string; attemptId?: string;
  assignmentGeneration: number; leaseVersion?: number; publicationRevision: number; configHash: string;
  nativeJobId?: string; mode: string; channel: string; nativeParams: Record<string, unknown>;
}
export interface PrepareInput { requestId: string; context: ExecutionContext; rawSha: string; expectedBatchHashes: string[]; sidecarHash: string; sidecarRef: string }
export interface SubmitInput { requestId: string; prepareToken: string; sourceKey: SourceKey; batchHash: string; raw: string; checkpoint?: CheckpointEnvelope; checkpointRaw?: string }
export interface RecoverInput { requestId: string; sourceKey: SourceKey; rawSha: string; batchHash: string; raw: string; sidecarRef?: string; prepareToken?: string }
export interface CommitReceipt { status: 'IMPORTED' | 'ALREADY_IMPORTED'; runId: string; inserted: number; updated: number; originalInserted: number; originalUpdated: number; committedAt: string; confirmedBatchHashes: string[]; complete: boolean; committedCheckpointSequence: number | null; checkpointRef?: string | null }
export interface PermitResult { allowed: boolean; reason?: string; sourceControl: SourceControlSnapshot; grant?: ExecutionGrant; context?: ExecutionContext }
export interface PlatformGrant {
  schemaVersion: 1; protocolVersion: number; scope: 'platform_queue'; controlMode: 'LEGACY_QUEUE' | 'CONFIG_QUEUE';
  nodeId: string; incarnationId: string; sourceKey: SourceKey; assignmentGeneration: number; publicationRevision: number;
  configHash: string; serverNow: string; validUntil: string; requestDeadline: string; grantToken: string; sourceControlVersion: number;
}
export type ControlMode = 'LEGACY_QUEUE' | 'CONFIG_QUEUE' | 'TASK_CLAIM';
export interface ControlHandoffInput { sourceKey: SourceKey; fromMode: ControlMode; toMode: ControlMode; publicationRevision: number; configHash: string; requestId: string; nativeJobMappings?: { queryId: string; nativeJobId: string }[] }
export interface ControlHandoffProof { schemaVersion: 1; nodeId: string; incarnationId: string; sourceKey: SourceKey; fromMode: ControlMode; toMode: ControlMode; assignmentGeneration: number; publicationRevision: number; configHash: string; drainedReceiptId: string; issuedAt: string; handoffId: string; requestId: string }
