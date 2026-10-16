BEGIN;
SET LOCAL timezone = 'UTC';

-- CreateTable
CREATE TABLE "SeedDefinition" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "rawValue" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'und',
    "purposeTags" JSONB NOT NULL DEFAULT '[]',
    "targetScope" JSONB NOT NULL,
    "targetPlatforms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "verificationStatus" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "createdByUserId" TEXT,
    "mergedIntoSeedId" TEXT,

    CONSTRAINT "SeedDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeedScanPlan" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "dataSourceId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "targetScope" JSONB NOT NULL,
    "datePolicy" JSONB NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'ALL',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "evidence" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "SeedScanPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeedEvidence" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seedId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "originKind" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "dataSourceId" TEXT,
    "observationId" TEXT,
    "adId" TEXT,
    "runId" TEXT,
    "sourceAdId" TEXT,
    "evidenceSha256" TEXT,
    "observedAt" TIMESTAMP(3),
    "extractionVersion" TEXT NOT NULL,
    "fieldPath" TEXT,
    "rawValue" TEXT,
    "normalizedValue" TEXT,
    "role" TEXT,

    CONSTRAINT "SeedEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeedRelation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "fromSeedId" TEXT NOT NULL,
    "toSeedId" TEXT NOT NULL,
    "relationType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "evidenceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "decisionReason" TEXT,
    "decidedByUserId" TEXT,

    CONSTRAINT "SeedRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeedQuery" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "queryCountry" TEXT,
    "queryLanguage" TEXT,
    "normalizedParams" JSONB NOT NULL DEFAULT '{}',
    "queryKey" TEXT NOT NULL,
    "queryKeyVersion" TEXT NOT NULL,
    "adapterVersion" TEXT NOT NULL,
    "capabilityVersion" TEXT NOT NULL,
    "legacyDims" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'READY',
    "desiredEnabled" BOOLEAN NOT NULL DEFAULT false,
    "controlMode" TEXT NOT NULL DEFAULT 'LEGACY_QUEUE',
    "assignmentGeneration" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SeedQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeedQueryBinding" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queryId" TEXT NOT NULL,
    "ownerKind" TEXT NOT NULL,
    "seedId" TEXT,
    "scanPlanId" TEXT,
    "legacyOwnerKey" TEXT,
    "ownerRevision" INTEGER NOT NULL,
    "participationStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "purposeSnapshot" JSONB NOT NULL DEFAULT '[]',
    "validFromRevision" INTEGER NOT NULL,
    "validToRevision" INTEGER,

    CONSTRAINT "SeedQueryBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegacyJobMapping" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataSourceId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "queryId" TEXT NOT NULL,
    "nativeJobId" TEXT NOT NULL,
    "legacyKeyVersion" TEXT NOT NULL,
    "initialCheckpointDigest" TEXT,

    CONSTRAINT "LegacyJobMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeedExecutionTask" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "queryId" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "cycleKey" TEXT NOT NULL,
    "workUnitKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'READY',
    "notBefore" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publicationRevision" INTEGER NOT NULL,
    "schedulePolicyVersion" TEXT NOT NULL,
    "cancelReason" TEXT,
    "outcome" TEXT,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SeedExecutionTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeedTaskAttempt" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "taskId" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "nodeId" TEXT NOT NULL,
    "incarnationId" TEXT NOT NULL,
    "assignmentGeneration" INTEGER NOT NULL,
    "leaseVersion" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "heartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "requestDeadline" TIMESTAMP(3),
    "stopReason" TEXT,
    "bindingSnapshot" JSONB NOT NULL DEFAULT '[]',
    "primaryOwner" JSONB,
    "lastReceiptSeq" INTEGER NOT NULL DEFAULT 0,
    "publicationRevision" INTEGER NOT NULL,
    "configHash" TEXT NOT NULL,
    "claimRequestId" TEXT,
    "claimPayloadHash" TEXT,
    "checkpointSequence" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'LEASED',

    CONSTRAINT "SeedTaskAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeedRuntimeState" (
    "queryId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "collectorId" TEXT,
    "assignmentGeneration" INTEGER NOT NULL DEFAULT 0,
    "nativeJobId" TEXT,
    "desiredRevision" INTEGER NOT NULL DEFAULT 0,
    "appliedRevision" INTEGER NOT NULL DEFAULT 0,
    "executionState" TEXT NOT NULL DEFAULT 'IDLE',
    "nextAllowedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "checkpointDigest" TEXT,
    "seenCount" INTEGER NOT NULL DEFAULT 0,
    "lastReportedAt" TIMESTAMP(3),
    "checkpointVersion" INTEGER NOT NULL DEFAULT 0,
    "checkpointSequence" INTEGER NOT NULL DEFAULT 0,
    "checkpointRef" TEXT,
    "checkpointSha" TEXT,
    "lastAppliedBatchHashes" JSONB NOT NULL DEFAULT '[]',
    "pendingManifestRef" TEXT,
    "stateSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "sessionAffinity" TEXT,

    CONSTRAINT "SeedRuntimeState_pkey" PRIMARY KEY ("queryId")
);

-- CreateTable
CREATE TABLE "SeedAttempt" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queryId" TEXT,
    "dataSourceId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "taskAttemptId" TEXT,
    "primarySeedId" TEXT,
    "primaryScanPlanId" TEXT,
    "runId" TEXT NOT NULL,
    "batchSha256" TEXT NOT NULL,
    "bindingSnapshot" JSONB NOT NULL DEFAULT '[]',
    "attributionQuality" TEXT NOT NULL DEFAULT 'UNATTRIBUTED',
    "outcome" TEXT NOT NULL,
    "outcomeEvidence" JSONB NOT NULL DEFAULT '{}',
    "exhausted" BOOLEAN NOT NULL DEFAULT false,
    "restrictionReason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "fetchedCount" INTEGER NOT NULL DEFAULT 0,
    "insertedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SeedAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeedAttemptMatch" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "seedId" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "matchRole" TEXT NOT NULL,
    "evidenceId" TEXT,

    CONSTRAINT "SeedAttemptMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeedPublication" (
    "id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "parentRevision" INTEGER,
    "manifestHash" TEXT NOT NULL,
    "configSnapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PUBLISHED',
    "reason" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeedPublication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeedCollectorReceipt" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publicationId" TEXT,
    "publicationRevision" INTEGER,
    "manifestHash" TEXT,
    "nodeId" TEXT NOT NULL,
    "incarnationId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "applyStatus" TEXT,
    "appliedAt" TIMESTAMP(3),
    "queryCounts" JSONB NOT NULL DEFAULT '{}',
    "nativeJobMappings" JSONB NOT NULL DEFAULT '[]',
    "errorCode" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeedCollectorReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeedImportJob" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "previewRevision" INTEGER NOT NULL,
    "rowResults" JSONB NOT NULL DEFAULT '[]',
    "counts" JSONB NOT NULL DEFAULT '{}',
    "idempotencyKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeedImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectorNode" (
    "nodeId" TEXT NOT NULL,
    "incarnationId" TEXT NOT NULL,
    "registryRevision" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'REGISTERED',
    "codeRevision" TEXT NOT NULL,
    "protocolVersions" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "capabilityDigest" TEXT,
    "resourceSnapshot" JSONB NOT NULL DEFAULT '{}',
    "lastHeartbeatAt" TIMESTAMP(3),

    CONSTRAINT "CollectorNode_pkey" PRIMARY KEY ("nodeId")
);

-- CreateTable
CREATE TABLE "CollectorSourceControl" (
    "id" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "notBefore" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restrictionCount" INTEGER NOT NULL DEFAULT 0,
    "manualPause" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "retryAfterUntil" TIMESTAMP(3),
    "controlVersion" INTEGER NOT NULL DEFAULT 0,
    "lastEvidenceAt" TIMESTAMP(3),
    "controlMode" TEXT NOT NULL DEFAULT 'LEGACY_QUEUE',
    "assignmentGeneration" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CollectorSourceControl_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SeedDefinition_status_createdAt_idx" ON "SeedDefinition"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SeedDefinition_normalizedValue_idx" ON "SeedDefinition"("normalizedValue");

-- CreateIndex
CREATE UNIQUE INDEX "SeedDefinition_kind_namespace_language_normalizedValue_key" ON "SeedDefinition"("kind", "namespace", "language", "normalizedValue");

-- CreateIndex
CREATE INDEX "SeedScanPlan_sourceKey_status_idx" ON "SeedScanPlan"("sourceKey", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SeedEvidence_dedupeKey_key" ON "SeedEvidence"("dedupeKey");

-- CreateIndex
CREATE INDEX "SeedEvidence_seedId_observedAt_idx" ON "SeedEvidence"("seedId", "observedAt");

-- CreateIndex
CREATE INDEX "SeedEvidence_runId_idx" ON "SeedEvidence"("runId");

-- CreateIndex
CREATE INDEX "SeedRelation_status_createdAt_idx" ON "SeedRelation"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SeedRelation_fromSeedId_toSeedId_relationType_key" ON "SeedRelation"("fromSeedId", "toSeedId", "relationType");

-- CreateIndex
CREATE INDEX "SeedQuery_sourceKey_status_idx" ON "SeedQuery"("sourceKey", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SeedQuery_sourceKey_channel_queryKey_key" ON "SeedQuery"("sourceKey", "channel", "queryKey");

-- CreateIndex
CREATE UNIQUE INDEX "SeedQuery_id_dataSourceId_sourceKey_key" ON "SeedQuery"("id", "dataSourceId", "sourceKey");

-- CreateIndex
CREATE INDEX "SeedQueryBinding_queryId_participationStatus_validToRevisio_idx" ON "SeedQueryBinding"("queryId", "participationStatus", "validToRevision");

-- CreateIndex
CREATE UNIQUE INDEX "SeedQueryBinding_queryId_seedId_ownerRevision_key" ON "SeedQueryBinding"("queryId", "seedId", "ownerRevision");

-- CreateIndex
CREATE UNIQUE INDEX "SeedQueryBinding_queryId_scanPlanId_ownerRevision_key" ON "SeedQueryBinding"("queryId", "scanPlanId", "ownerRevision");

-- CreateIndex
CREATE UNIQUE INDEX "SeedQueryBinding_queryId_legacyOwnerKey_ownerRevision_key" ON "SeedQueryBinding"("queryId", "legacyOwnerKey", "ownerRevision");

-- CreateIndex
CREATE INDEX "LegacyJobMapping_queryId_idx" ON "LegacyJobMapping"("queryId");

-- CreateIndex
CREATE UNIQUE INDEX "LegacyJobMapping_sourceKey_nativeJobId_key" ON "LegacyJobMapping"("sourceKey", "nativeJobId");

-- CreateIndex
CREATE INDEX "SeedExecutionTask_state_notBefore_createdAt_idx" ON "SeedExecutionTask"("state", "notBefore", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SeedExecutionTask_queryId_cycleKey_workUnitKey_key" ON "SeedExecutionTask"("queryId", "cycleKey", "workUnitKey");

-- CreateIndex
CREATE UNIQUE INDEX "SeedExecutionTask_id_dataSourceId_sourceKey_key" ON "SeedExecutionTask"("id", "dataSourceId", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "SeedTaskAttempt_tokenHash_key" ON "SeedTaskAttempt"("tokenHash");

-- CreateIndex
CREATE INDEX "SeedTaskAttempt_state_leaseExpiresAt_idx" ON "SeedTaskAttempt"("state", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SeedTaskAttempt_taskId_attemptNo_key" ON "SeedTaskAttempt"("taskId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "SeedTaskAttempt_nodeId_incarnationId_claimRequestId_key" ON "SeedTaskAttempt"("nodeId", "incarnationId", "claimRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "SeedTaskAttempt_id_dataSourceId_sourceKey_key" ON "SeedTaskAttempt"("id", "dataSourceId", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "SeedRuntimeState_queryId_dataSourceId_sourceKey_key" ON "SeedRuntimeState"("queryId", "dataSourceId", "sourceKey");

-- CreateIndex
CREATE INDEX "SeedAttempt_queryId_startedAt_idx" ON "SeedAttempt"("queryId", "startedAt");

-- CreateIndex
CREATE INDEX "SeedAttempt_runId_idx" ON "SeedAttempt"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "SeedAttempt_sourceKey_batchSha256_key" ON "SeedAttempt"("sourceKey", "batchSha256");

-- CreateIndex
CREATE UNIQUE INDEX "SeedAttempt_id_dataSourceId_key" ON "SeedAttempt"("id", "dataSourceId");

-- CreateIndex
CREATE UNIQUE INDEX "SeedAttemptMatch_attemptId_seedId_adId_key" ON "SeedAttemptMatch"("attemptId", "seedId", "adId");

-- CreateIndex
CREATE UNIQUE INDEX "SeedPublication_revision_key" ON "SeedPublication"("revision");

-- CreateIndex
CREATE UNIQUE INDEX "SeedPublication_id_revision_key" ON "SeedPublication"("id", "revision");

-- CreateIndex
CREATE INDEX "SeedCollectorReceipt_publicationId_type_idx" ON "SeedCollectorReceipt"("publicationId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "SeedCollectorReceipt_nodeId_incarnationId_sequence_key" ON "SeedCollectorReceipt"("nodeId", "incarnationId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "SeedImportJob_idempotencyKey_key" ON "SeedImportJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CollectorNode_enabled_status_expiresAt_idx" ON "CollectorNode"("enabled", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CollectorSourceControl_sourceKey_channel_scopeKey_key" ON "CollectorSourceControl"("sourceKey", "channel", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "DataSource_id_key_key" ON "DataSource"("id", "key");

-- AddForeignKey
ALTER TABLE "SeedDefinition" ADD CONSTRAINT "SeedDefinition_mergedIntoSeedId_fkey" FOREIGN KEY ("mergedIntoSeedId") REFERENCES "SeedDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedScanPlan" ADD CONSTRAINT "SeedScanPlan_dataSourceId_sourceKey_fkey" FOREIGN KEY ("dataSourceId", "sourceKey") REFERENCES "DataSource"("id", "key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedEvidence" ADD CONSTRAINT "SeedEvidence_seedId_fkey" FOREIGN KEY ("seedId") REFERENCES "SeedDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedEvidence" ADD CONSTRAINT "SeedEvidence_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedEvidence" ADD CONSTRAINT "SeedEvidence_runId_dataSourceId_fkey" FOREIGN KEY ("runId", "dataSourceId") REFERENCES "CollectionRun"("id", "dataSourceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedEvidence" ADD CONSTRAINT "SeedEvidence_observationId_adId_dataSourceId_fkey" FOREIGN KEY ("observationId", "adId", "dataSourceId") REFERENCES "AdObservation"("id", "adId", "dataSourceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedRelation" ADD CONSTRAINT "SeedRelation_fromSeedId_fkey" FOREIGN KEY ("fromSeedId") REFERENCES "SeedDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedRelation" ADD CONSTRAINT "SeedRelation_toSeedId_fkey" FOREIGN KEY ("toSeedId") REFERENCES "SeedDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedQuery" ADD CONSTRAINT "SeedQuery_dataSourceId_sourceKey_fkey" FOREIGN KEY ("dataSourceId", "sourceKey") REFERENCES "DataSource"("id", "key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedQueryBinding" ADD CONSTRAINT "SeedQueryBinding_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "SeedQuery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedQueryBinding" ADD CONSTRAINT "SeedQueryBinding_seedId_fkey" FOREIGN KEY ("seedId") REFERENCES "SeedDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedQueryBinding" ADD CONSTRAINT "SeedQueryBinding_scanPlanId_fkey" FOREIGN KEY ("scanPlanId") REFERENCES "SeedScanPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyJobMapping" ADD CONSTRAINT "LegacyJobMapping_queryId_dataSourceId_sourceKey_fkey" FOREIGN KEY ("queryId", "dataSourceId", "sourceKey") REFERENCES "SeedQuery"("id", "dataSourceId", "sourceKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedExecutionTask" ADD CONSTRAINT "SeedExecutionTask_queryId_dataSourceId_sourceKey_fkey" FOREIGN KEY ("queryId", "dataSourceId", "sourceKey") REFERENCES "SeedQuery"("id", "dataSourceId", "sourceKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedTaskAttempt" ADD CONSTRAINT "SeedTaskAttempt_taskId_dataSourceId_sourceKey_fkey" FOREIGN KEY ("taskId", "dataSourceId", "sourceKey") REFERENCES "SeedExecutionTask"("id", "dataSourceId", "sourceKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedTaskAttempt" ADD CONSTRAINT "SeedTaskAttempt_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "CollectorNode"("nodeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedRuntimeState" ADD CONSTRAINT "SeedRuntimeState_queryId_dataSourceId_sourceKey_fkey" FOREIGN KEY ("queryId", "dataSourceId", "sourceKey") REFERENCES "SeedQuery"("id", "dataSourceId", "sourceKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedAttempt" ADD CONSTRAINT "SeedAttempt_dataSourceId_sourceKey_fkey" FOREIGN KEY ("dataSourceId", "sourceKey") REFERENCES "DataSource"("id", "key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedAttempt" ADD CONSTRAINT "SeedAttempt_queryId_dataSourceId_sourceKey_fkey" FOREIGN KEY ("queryId", "dataSourceId", "sourceKey") REFERENCES "SeedQuery"("id", "dataSourceId", "sourceKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedAttempt" ADD CONSTRAINT "SeedAttempt_taskAttemptId_dataSourceId_sourceKey_fkey" FOREIGN KEY ("taskAttemptId", "dataSourceId", "sourceKey") REFERENCES "SeedTaskAttempt"("id", "dataSourceId", "sourceKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedAttempt" ADD CONSTRAINT "SeedAttempt_primarySeedId_fkey" FOREIGN KEY ("primarySeedId") REFERENCES "SeedDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedAttempt" ADD CONSTRAINT "SeedAttempt_primaryScanPlanId_fkey" FOREIGN KEY ("primaryScanPlanId") REFERENCES "SeedScanPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedAttempt" ADD CONSTRAINT "SeedAttempt_runId_dataSourceId_fkey" FOREIGN KEY ("runId", "dataSourceId") REFERENCES "CollectionRun"("id", "dataSourceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedAttemptMatch" ADD CONSTRAINT "SeedAttemptMatch_attemptId_dataSourceId_fkey" FOREIGN KEY ("attemptId", "dataSourceId") REFERENCES "SeedAttempt"("id", "dataSourceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedAttemptMatch" ADD CONSTRAINT "SeedAttemptMatch_seedId_fkey" FOREIGN KEY ("seedId") REFERENCES "SeedDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedAttemptMatch" ADD CONSTRAINT "SeedAttemptMatch_adId_dataSourceId_fkey" FOREIGN KEY ("adId", "dataSourceId") REFERENCES "Ad"("id", "dataSourceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedAttemptMatch" ADD CONSTRAINT "SeedAttemptMatch_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "SeedEvidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedCollectorReceipt" ADD CONSTRAINT "SeedCollectorReceipt_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "CollectorNode"("nodeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedCollectorReceipt" ADD CONSTRAINT "SeedCollectorReceipt_publicationId_publicationRevision_fkey" FOREIGN KEY ("publicationId", "publicationRevision") REFERENCES "SeedPublication"("id", "revision") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectorSourceControl" ADD CONSTRAINT "CollectorSourceControl_dataSourceId_sourceKey_fkey" FOREIGN KEY ("dataSourceId", "sourceKey") REFERENCES "DataSource"("id", "key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Database boundaries supplement Prisma: no table-level source/owner/lease
-- invariant depends on a caller following the TypeScript contract.
ALTER TABLE "SeedDefinition" ADD CONSTRAINT seed_definition_valid CHECK (
  kind IN ('KEYWORD','NAME','DOMAIN','NATIVE_ADVERTISER','APP_REFERENCE')
  AND namespace <> '' AND "rawValue" <> '' AND "normalizedValue" <> '' AND language <> ''
  AND status IN ('DRAFT','ACTIVE','PAUSED','ARCHIVED','MERGED') AND priority >= 0 AND revision > 0
  AND "verificationStatus" IN ('CANDIDATE','VERIFIED','CONFLICT','REJECTED','NOT_APPLICABLE')
  AND jsonb_typeof("purposeTags") = 'array' AND jsonb_typeof("targetScope") = 'object'
  AND cardinality("targetPlatforms") > 0
  AND ("mergedIntoSeedId" IS NULL OR "mergedIntoSeedId" <> id)
  AND (kind <> 'NATIVE_ADVERTISER' OR (cardinality("targetPlatforms") = 1 AND "targetPlatforms"[1] = namespace
    AND "rawValue" !~* '^(page-url-sha256|ad-local|name-hash):')));
ALTER TABLE "SeedScanPlan" ADD CONSTRAINT seed_scan_plan_valid CHECK (
  revision > 0 AND "sourceKey" IN ('tiktok_commercial_library','pinterest_ads_repository')
  AND category = 'ALL' AND status IN ('DRAFT','ACTIVE','PAUSED','ARCHIVED')
  AND jsonb_typeof("targetScope") = 'object' AND jsonb_typeof("datePolicy") = 'object' AND jsonb_typeof(evidence) = 'object');
ALTER TABLE "SeedEvidence" ADD CONSTRAINT seed_evidence_valid CHECK (
  "dedupeKey" <> '' AND "originKind" <> '' AND "extractionVersion" <> ''
  AND ("evidenceSha256" IS NULL OR "evidenceSha256" ~ '^[a-f0-9]{64}$')
  AND ("runId" IS NULL OR "dataSourceId" IS NOT NULL)
  AND ("observationId" IS NULL OR ("dataSourceId" IS NOT NULL AND "adId" IS NOT NULL AND "runId" IS NOT NULL))
  AND ("originKind" <> 'DIRECTORY_ONLY' OR ("runId" IS NULL AND "observationId" IS NULL)));
ALTER TABLE "SeedRelation" ADD CONSTRAINT seed_relation_valid CHECK (
  "fromSeedId" <> "toSeedId" AND "relationType" IN ('ALIAS_OF','PRODUCT_OF','OPERATED_BY','DOMAIN_OF','APPLICATION_OF','IDENTITY_ON_SOURCE')
  AND status IN ('PENDING','CONFIRMED','REJECTED'));
ALTER TABLE "SeedQuery" ADD CONSTRAINT seed_query_valid CHECK (
  "sourceKey" <> '' AND channel <> '' AND mode <> '' AND "queryKey" ~ '^[a-f0-9]{64}$' AND "queryKeyVersion" <> ''
  AND "adapterVersion" <> '' AND "capabilityVersion" <> '' AND jsonb_typeof("normalizedParams") = 'object' AND jsonb_typeof("legacyDims") = 'object'
  AND status IN ('READY','DORMANT','UNSUPPORTED','NEEDS_RESOLUTION') AND "assignmentGeneration" >= 0
  AND "controlMode" IN ('LEGACY_QUEUE','CONFIG_QUEUE','TASK_CLAIM'));
ALTER TABLE "SeedQueryBinding" ADD CONSTRAINT seed_binding_owner CHECK (
  ("ownerKind" = 'SEED' AND "seedId" IS NOT NULL AND "scanPlanId" IS NULL AND "legacyOwnerKey" IS NULL)
  OR ("ownerKind" = 'SCAN_PLAN' AND "seedId" IS NULL AND "scanPlanId" IS NOT NULL AND "legacyOwnerKey" IS NULL)
  OR ("ownerKind" = 'LEGACY' AND "seedId" IS NULL AND "scanPlanId" IS NULL AND "legacyOwnerKey" IS NOT NULL AND "legacyOwnerKey" <> ''));
ALTER TABLE "SeedQueryBinding" ADD CONSTRAINT seed_binding_revision CHECK (
  "ownerRevision" > 0 AND "validFromRevision" > 0 AND ("validToRevision" IS NULL OR "validToRevision" > "validFromRevision")
  AND "participationStatus" IN ('ACTIVE','PAUSED','REMOVED') AND jsonb_typeof("purposeSnapshot") = 'array');
ALTER TABLE "LegacyJobMapping" ADD CONSTRAINT seed_legacy_mapping_valid CHECK (
  "nativeJobId" <> '' AND "legacyKeyVersion" <> '' AND ("initialCheckpointDigest" IS NULL OR "initialCheckpointDigest" ~ '^[a-f0-9]{64}$'));
ALTER TABLE "SeedExecutionTask" ADD CONSTRAINT seed_task_valid CHECK (
  "cycleKey" <> '' AND "workUnitKey" <> '' AND "publicationRevision" > 0 AND "schedulePolicyVersion" <> ''
  AND state IN ('READY','LEASED','RUNNING','STOP_REQUESTED','COMMIT_PENDING','RECOVERING','RECOVERY_BLOCKED','COMPLETED','CANCELED')
  AND (outcome IS NULL OR outcome IN ('HAS_RESULTS','IDENTITY_FOUND','RELIABLE_NO_RESULTS','PARTIAL','RATE_LIMITED','TIMEOUT','FAILED','STOPPED')));
CREATE UNIQUE INDEX seed_query_execution_slot ON "SeedExecutionTask" ("queryId")
  WHERE state IN ('LEASED','RUNNING','STOP_REQUESTED','COMMIT_PENDING','RECOVERING','RECOVERY_BLOCKED');
ALTER TABLE "SeedTaskAttempt" ADD CONSTRAINT seed_task_attempt_valid CHECK (
  "attemptNo" > 0 AND "assignmentGeneration" >= 0 AND "leaseVersion" > 0 AND "lastReceiptSeq" >= 0
  AND "publicationRevision" > 0 AND "checkpointSequence" >= 0 AND "tokenHash" ~ '^[a-f0-9]{64}$' AND "configHash" ~ '^[a-f0-9]{64}$'
  AND "incarnationId" <> '' AND jsonb_typeof("bindingSnapshot") = 'array'
  AND state IN ('LEASED','RUNNING','STOP_REQUESTED','COMMIT_PENDING','RECOVERING','RECOVERY_BLOCKED','COMPLETED','CANCELED')
  AND ("claimRequestId" IS NULL) = ("claimPayloadHash" IS NULL)
  AND ("claimPayloadHash" IS NULL OR "claimPayloadHash" ~ '^[a-f0-9]{64}$')
  AND ("requestDeadline" IS NULL OR "requestDeadline" <= "leaseExpiresAt")
  AND ("primaryOwner" IS NULL OR (jsonb_typeof("primaryOwner") = 'object' AND "bindingSnapshot" @> jsonb_build_array("primaryOwner")))
  AND ("startedAt" IS NULL OR ("primaryOwner" IS NOT NULL AND "requestDeadline" IS NOT NULL AND "startedAt" < "requestDeadline")));
CREATE UNIQUE INDEX seed_task_active_attempt ON "SeedTaskAttempt" ("taskId")
  WHERE state IN ('LEASED','RUNNING','STOP_REQUESTED','COMMIT_PENDING');
ALTER TABLE "SeedRuntimeState" ADD CONSTRAINT seed_runtime_valid CHECK (
  "assignmentGeneration" >= 0 AND "desiredRevision" >= 0 AND "appliedRevision" >= 0 AND "seenCount" >= 0
  AND "checkpointVersion" >= 0 AND "checkpointSequence" >= 0 AND "stateSchemaVersion" > 0
  AND jsonb_typeof("lastAppliedBatchHashes") = 'array'
  AND ("checkpointSha" IS NULL OR "checkpointSha" ~ '^[a-f0-9]{64}$')
  AND ("checkpointDigest" IS NULL OR "checkpointDigest" ~ '^[a-f0-9]{64}$')
  AND ("checkpointRef" IS NULL) = ("checkpointSha" IS NULL)
  AND ("checkpointSequence" = 0 OR "checkpointRef" IS NOT NULL));
ALTER TABLE "SeedAttempt" ADD CONSTRAINT seed_batch_attempt_valid CHECK (
  "batchSha256" ~ '^[a-f0-9]{64}$' AND "finishedAt" >= "startedAt" AND "fetchedCount" >= 0 AND "insertedCount" >= 0 AND "updatedCount" >= 0
  AND "attributionQuality" IN ('EXACT_QUERY','HISTORICAL_QUERY','UNATTRIBUTED')
  AND ("attributionQuality" <> 'EXACT_QUERY' OR ("queryId" IS NOT NULL AND "taskAttemptId" IS NOT NULL))
  AND ("attributionQuality" <> 'HISTORICAL_QUERY' OR "queryId" IS NOT NULL)
  AND ("taskAttemptId" IS NULL OR "queryId" IS NOT NULL)
  AND ("primarySeedId" IS NULL OR "primaryScanPlanId" IS NULL)
  AND jsonb_typeof("bindingSnapshot") = 'array' AND jsonb_typeof("outcomeEvidence") = 'object'
  AND outcome IN ('HAS_RESULTS','IDENTITY_FOUND','RELIABLE_NO_RESULTS','PARTIAL','RATE_LIMITED','TIMEOUT','FAILED','STOPPED'));
ALTER TABLE "SeedAttemptMatch" ADD CONSTRAINT seed_match_role CHECK ("matchRole" IN ('PRIMARY','SHARED_QUERY','CONFIRMED_IDENTITY'));
ALTER TABLE "SeedPublication" ADD CONSTRAINT seed_publication_valid CHECK (
  revision > 0 AND ("parentRevision" IS NULL OR ("parentRevision" > 0 AND "parentRevision" < revision))
  AND "manifestHash" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("configSnapshot") = 'object' AND status = 'PUBLISHED' AND reason <> '');
ALTER TABLE "SeedCollectorReceipt" ADD CONSTRAINT seed_receipt_valid CHECK (
  sequence > 0 AND "payloadHash" ~ '^[a-f0-9]{64}$' AND "incarnationId" <> ''
  AND type IN ('DOWNLOADED','VALIDATED','APPLIED','REJECTED','STARTED','PROGRESS','COMMITTED','STOPPED','RECOVERED','NO_NEW_SOURCE_REQUESTS','DRAINED')
  AND ("publicationId" IS NULL) = ("publicationRevision" IS NULL)
  AND ("manifestHash" IS NULL OR "manifestHash" ~ '^[a-f0-9]{64}$') AND jsonb_typeof(payload) = 'object'
  AND ("applyStatus" IS NULL OR "applyStatus" IN ('DOWNLOADED','VALIDATED','APPLIED','REJECTED')));
ALTER TABLE "SeedImportJob" ADD CONSTRAINT seed_import_valid CHECK (
  "fileHash" ~ '^[a-f0-9]{64}$' AND "previewRevision" >= 0 AND status <> '' AND "idempotencyKey" <> '' AND "expiresAt" > "createdAt");
ALTER TABLE "CollectorNode" ADD CONSTRAINT collector_node_valid CHECK (
  "nodeId" <> '' AND "incarnationId" <> '' AND "registryRevision" >= 0 AND "codeRevision" <> ''
  AND status IN ('REGISTERED','VERIFIED','STANDBY_READY','ACTIVE','DRAINING','DISABLED','EXPIRED','UNREACHABLE','RECOVERING')
  AND ("capabilityDigest" IS NULL OR "capabilityDigest" ~ '^[a-f0-9]{64}$') AND jsonb_typeof("resourceSnapshot") = 'object');
ALTER TABLE "CollectorSourceControl" ADD CONSTRAINT collector_source_control_valid CHECK (
  channel <> '' AND "scopeKey" <> '' AND "restrictionCount" >= 0 AND "controlVersion" >= 0 AND "assignmentGeneration" >= 0
  AND "controlMode" IN ('LEGACY_QUEUE','CONFIG_QUEUE','TASK_CLAIM'));

CREATE FUNCTION public.saas_guard_seed_query_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF (NEW.id, NEW."dataSourceId", NEW."sourceKey", NEW.channel, NEW.mode, NEW."queryCountry", NEW."queryLanguage", NEW."normalizedParams", NEW."queryKey", NEW."queryKeyVersion", NEW."legacyDims")
    IS DISTINCT FROM (OLD.id, OLD."dataSourceId", OLD."sourceKey", OLD.channel, OLD.mode, OLD."queryCountry", OLD."queryLanguage", OLD."normalizedParams", OLD."queryKey", OLD."queryKeyVersion", OLD."legacyDims") THEN
    RAISE EXCEPTION 'IMMUTABLE_SEED_QUERY' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.saas_guard_seed_query_identity() FROM PUBLIC;
CREATE TRIGGER immutable_seed_query BEFORE UPDATE ON "SeedQuery" FOR EACH ROW EXECUTE FUNCTION public.saas_guard_seed_query_identity();

CREATE FUNCTION public.saas_reject_seed_immutable_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='LegacyJobMapping' THEN RAISE EXCEPTION 'IMMUTABLE_LEGACY_MAPPING' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='SeedPublication' THEN RAISE EXCEPTION 'IMMUTABLE_SEED_PUBLICATION' USING ERRCODE='23514'; END IF;
  RAISE EXCEPTION 'IMMUTABLE_SEED_RECEIPT' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION public.saas_reject_seed_immutable_mutation() FROM PUBLIC;
CREATE TRIGGER immutable_legacy_mapping BEFORE UPDATE OR DELETE ON "LegacyJobMapping" FOR EACH ROW EXECUTE FUNCTION public.saas_reject_seed_immutable_mutation();
CREATE TRIGGER immutable_seed_publication BEFORE UPDATE OR DELETE ON "SeedPublication" FOR EACH ROW EXECUTE FUNCTION public.saas_reject_seed_immutable_mutation();
CREATE TRIGGER immutable_seed_receipt BEFORE UPDATE OR DELETE ON "SeedCollectorReceipt" FOR EACH ROW EXECUTE FUNCTION public.saas_reject_seed_immutable_mutation();
CREATE TRIGGER immutable_seed_publication_truncate BEFORE TRUNCATE ON "SeedPublication" FOR EACH STATEMENT EXECUTE FUNCTION public.saas_reject_seed_immutable_mutation();
CREATE TRIGGER immutable_seed_receipt_truncate BEFORE TRUNCATE ON "SeedCollectorReceipt" FOR EACH STATEMENT EXECUTE FUNCTION public.saas_reject_seed_immutable_mutation();

CREATE FUNCTION public.saas_guard_seed_state_progress() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF (NEW."queryId", NEW."dataSourceId", NEW."sourceKey") IS DISTINCT FROM (OLD."queryId", OLD."dataSourceId", OLD."sourceKey")
    OR NEW."checkpointSequence" < OLD."checkpointSequence" OR NEW."assignmentGeneration" < OLD."assignmentGeneration" THEN
    RAISE EXCEPTION 'SEED_CHECKPOINT_REGRESSION' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.saas_guard_seed_state_progress() FROM PUBLIC;
CREATE TRIGGER seed_checkpoint_progress BEFORE UPDATE ON "SeedRuntimeState" FOR EACH ROW EXECUTE FUNCTION public.saas_guard_seed_state_progress();

CREATE FUNCTION public.saas_guard_seed_attempt_identity() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF (NEW."taskId", NEW."dataSourceId", NEW."sourceKey", NEW."attemptNo", NEW."nodeId", NEW."incarnationId", NEW."assignmentGeneration", NEW."leaseVersion", NEW."tokenHash", NEW."publicationRevision", NEW."configHash", NEW."claimRequestId", NEW."claimPayloadHash")
    IS DISTINCT FROM (OLD."taskId", OLD."dataSourceId", OLD."sourceKey", OLD."attemptNo", OLD."nodeId", OLD."incarnationId", OLD."assignmentGeneration", OLD."leaseVersion", OLD."tokenHash", OLD."publicationRevision", OLD."configHash", OLD."claimRequestId", OLD."claimPayloadHash")
    OR (OLD."startedAt" IS NOT NULL AND (NEW."bindingSnapshot", NEW."primaryOwner", NEW."startedAt") IS DISTINCT FROM (OLD."bindingSnapshot", OLD."primaryOwner", OLD."startedAt")) THEN
    RAISE EXCEPTION 'IMMUTABLE_SEED_ATTEMPT_IDENTITY' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.saas_guard_seed_attempt_identity() FROM PUBLIC;
CREATE TRIGGER seed_attempt_identity BEFORE UPDATE ON "SeedTaskAttempt" FOR EACH ROW EXECUTE FUNCTION public.saas_guard_seed_attempt_identity();

CREATE FUNCTION public.saas_guard_seed_fact_link() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE actual_query text; actual_key text; actual_run text;
BEGIN
  IF TG_TABLE_NAME='SeedAttempt' THEN
    IF NEW."taskAttemptId" IS NOT NULL THEN
      SELECT t."queryId" INTO actual_query FROM public."SeedTaskAttempt" a JOIN public."SeedExecutionTask" t ON t.id=a."taskId" WHERE a.id=NEW."taskAttemptId";
      IF actual_query IS DISTINCT FROM NEW."queryId" THEN RAISE EXCEPTION 'SEED_ATTEMPT_QUERY_MISMATCH' USING ERRCODE='23514'; END IF;
    END IF;
    SELECT "idempotencyKey" INTO actual_key FROM public."CollectionRun" WHERE id=NEW."runId";
    IF actual_key ~ '^(meta-service|google-service|snapchat-service|tiktok-service|pinterest-service|pinterest-native):'
      AND right(actual_key,64) IS DISTINCT FROM NEW."batchSha256" THEN RAISE EXCEPTION 'SEED_BATCH_RUN_MISMATCH' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='SeedEvidence' AND NEW."observationId" IS NOT NULL THEN
    SELECT "collectionRunId" INTO actual_run FROM public."AdObservation" WHERE id=NEW."observationId";
    IF actual_run IS DISTINCT FROM NEW."runId" THEN RAISE EXCEPTION 'SEED_EVIDENCE_RUN_MISMATCH' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.saas_guard_seed_fact_link() FROM PUBLIC;
CREATE TRIGGER seed_batch_fact_link BEFORE INSERT OR UPDATE ON "SeedAttempt" FOR EACH ROW EXECUTE FUNCTION public.saas_guard_seed_fact_link();
CREATE TRIGGER seed_evidence_fact_link BEFORE INSERT OR UPDATE ON "SeedEvidence" FOR EACH ROW EXECUTE FUNCTION public.saas_guard_seed_fact_link();

-- New tables and trigger functions do not broaden an existing app/runtime role.
REVOKE ALL ON "SeedDefinition", "SeedScanPlan", "SeedEvidence", "SeedRelation", "SeedQuery", "SeedQueryBinding", "LegacyJobMapping", "SeedExecutionTask", "SeedTaskAttempt", "SeedRuntimeState", "SeedAttempt", "SeedAttemptMatch", "SeedPublication", "SeedCollectorReceipt", "SeedImportJob", "CollectorNode", "CollectorSourceControl" FROM PUBLIC;
COMMIT;

