-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "email" TEXT,
    "username" TEXT,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "displayName" TEXT,
    "disabledAt" TIMESTAMP(3),
    "notificationPreference" JSONB NOT NULL DEFAULT '{}',
    "onboardingState" JSONB NOT NULL DEFAULT '{}',
    "onboardingCompletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMember" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'VIEWER',

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "workspaceRole" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "invitedByUserId" TEXT,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanVersion" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT,
    "priceMinor" INTEGER,
    "billingInterval" TEXT NOT NULL DEFAULT 'MONTH',
    "trialDays" INTEGER NOT NULL DEFAULT 0,
    "workspaceLimit" INTEGER NOT NULL DEFAULT 0,
    "memberLimit" INTEGER NOT NULL DEFAULT 0,
    "savedAdLimit" INTEGER NOT NULL DEFAULT 0,
    "monthlyAnalysisLimit" INTEGER NOT NULL DEFAULT 0,
    "providerPriceId" TEXT,

    CONSTRAINT "PlanVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,
    "planVersionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'UNCONFIGURED',
    "providerCustomerId" TEXT,
    "providerSubscriptionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'INACTIVE',
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "trialEndsAt" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "canceledAt" TIMESTAMP(3),
    "scheduledPlanVersionId" TEXT,
    "lastProviderEventAt" TIMESTAMP(3),
    "lastReconciledAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "provider" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "providerOccurredAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "errorCode" TEXT,
    "payloadReference" TEXT,
    "payloadSha256" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Entitlement" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "limit" INTEGER NOT NULL DEFAULT 0,
    "used" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "periodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "periodEnd" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'PLAN',
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Entitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageLedger" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,

    CONSTRAINT "UsageLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSource" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISABLED',
    "adapterVersion" TEXT NOT NULL,
    "configuration" JSONB NOT NULL DEFAULT '{}',
    "credentialReference" TEXT,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "lastSuccessfulAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,

    CONSTRAINT "DataSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionTask" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "name" TEXT NOT NULL,
    "query" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PAUSED',
    "scheduleCron" TEXT,
    "scheduleTimezone" TEXT NOT NULL DEFAULT 'UTC',
    "nextRunAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "maxItems" INTEGER NOT NULL DEFAULT 100,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,

    CONSTRAINT "CollectionTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "taskId" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "requestedByUserId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "querySnapshot" JSONB NOT NULL,
    "adapterVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseVersion" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "fetchedCount" INTEGER NOT NULL DEFAULT 0,
    "insertedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "quarantinedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "restrictionReason" TEXT,
    "coverage" JSONB NOT NULL DEFAULT '{}',
    "evidenceReference" TEXT,

    CONSTRAINT "CollectionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunItem" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runId" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "sourceAdId" TEXT,
    "adId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errorCode" TEXT,
    "evidenceReference" TEXT,
    "evidenceSha256" TEXT,
    "parserVersion" TEXT NOT NULL,

    CONSTRAINT "RunItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "version" TEXT NOT NULL,
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "activeRunId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Advertiser" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "sourceAdvertiserId" TEXT NOT NULL,
    "name" TEXT,
    "sourceUrl" TEXT,
    "pageDomain" TEXT,
    "fieldProvenance" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Advertiser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ad" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "sourceAdId" TEXT NOT NULL,
    "advertiserId" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "body" TEXT,
    "headline" TEXT,
    "cta" TEXT,
    "landingPageUrl" TEXT,
    "publisherPlatforms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reportedCountries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mediaType" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "sourceStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "statusObservedAt" TIMESTAMP(3),
    "sourceStartedAt" TIMESTAMP(3),
    "sourceEndedAt" TIMESTAMP(3),
    "firstObservedAt" TIMESTAMP(3),
    "lastObservedAt" TIMESTAMP(3),
    "fieldProvenance" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Ad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdObservation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adId" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "collectionRunId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "sourceStatus" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "queryCountry" TEXT,
    "snapshot" JSONB NOT NULL,
    "fieldProvenance" JSONB NOT NULL DEFAULT '{}',
    "evidenceReference" TEXT,
    "evidenceSha256" TEXT,
    "parserVersion" TEXT NOT NULL,

    CONSTRAINT "AdObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaObject" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "adId" TEXT NOT NULL,
    "observationId" TEXT,
    "sourceMediaId" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "mimeType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "storageKey" TEXT,
    "sha256" TEXT,
    "sizeBytes" BIGINT,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "downloadedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "errorCode" TEXT,

    CONSTRAINT "MediaObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Folder" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Folder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedAd" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "folderId" TEXT,
    "savedByUserId" TEXT,

    CONSTRAINT "SavedAd_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "savedAdId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "body" TEXT NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivateFile" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "PrivateFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisJob" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "requestedByUserId" TEXT,
    "adId" TEXT,
    "usageLedgerId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "inputSnapshot" JSONB NOT NULL,
    "inputSha256" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "leaseOwner" TEXT,
    "leaseVersion" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,

    CONSTRAINT "AnalysisJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisResult" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "analysisJobId" TEXT NOT NULL,
    "facts" JSONB NOT NULL,
    "inferences" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "limitations" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,

    CONSTRAINT "AnalysisResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" TEXT,
    "workspaceId" TEXT,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "requestId" TEXT,
    "supportAuthorizationReference" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailDelivery" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "recipientEmail" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT,
    "providerMessageId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "encryptedPayload" TEXT,
    "encryptionKeyVersion" TEXT,
    "payloadExpiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "EmailDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT,
    "userId" TEXT,
    "category" TEXT NOT NULL DEFAULT 'GENERAL',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT,
    "adId" TEXT,
    "name" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "ProductEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "principalHash" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Auth" (
    "id" TEXT NOT NULL,
    "userId" TEXT,

    CONSTRAINT "Auth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthIdentity" (
    "providerName" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "providerData" TEXT NOT NULL DEFAULT '{}',
    "authId" TEXT NOT NULL,

    CONSTRAINT "AuthIdentity_pkey" PRIMARY KEY ("providerName","providerUserId")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "OrganizationMember_userId_organizationId_idx" ON "OrganizationMember"("userId", "organizationId");

-- CreateIndex
CREATE INDEX "OrganizationMember_organizationId_role_idx" ON "OrganizationMember"("organizationId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userId_key" ON "OrganizationMember"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_id_organizationId_key" ON "Workspace"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_organizationId_slug_key" ON "Workspace"("organizationId", "slug");

-- CreateIndex
CREATE INDEX "WorkspaceMember_organizationId_userId_idx" ON "WorkspaceMember"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_organizationId_email_expiresAt_idx" ON "Invitation"("organizationId", "email", "expiresAt");

-- CreateIndex
CREATE INDEX "Invitation_workspaceId_organizationId_idx" ON "Invitation"("workspaceId", "organizationId");

-- CreateIndex
CREATE INDEX "PlanVersion_status_key_idx" ON "PlanVersion"("status", "key");

-- CreateIndex
CREATE UNIQUE INDEX "PlanVersion_key_version_key" ON "PlanVersion"("key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_organizationId_key" ON "Subscription"("organizationId");

-- CreateIndex
CREATE INDEX "Subscription_status_currentPeriodEnd_idx" ON "Subscription"("status", "currentPeriodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_id_organizationId_key" ON "Subscription"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_provider_providerSubscriptionId_key" ON "Subscription"("provider", "providerSubscriptionId");

-- CreateIndex
CREATE INDEX "BillingEvent_organizationId_createdAt_idx" ON "BillingEvent"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingEvent_status_createdAt_idx" ON "BillingEvent"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingEvent_provider_providerEventId_key" ON "BillingEvent"("provider", "providerEventId");

-- CreateIndex
CREATE INDEX "Entitlement_organizationId_key_validUntil_idx" ON "Entitlement"("organizationId", "key", "validUntil");

-- CreateIndex
CREATE UNIQUE INDEX "Entitlement_organizationId_key_periodStart_key" ON "Entitlement"("organizationId", "key", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "Entitlement_id_organizationId_key" ON "Entitlement"("id", "organizationId");

-- CreateIndex
CREATE INDEX "UsageLedger_entitlementId_status_idx" ON "UsageLedger"("entitlementId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "UsageLedger_organizationId_idempotencyKey_key" ON "UsageLedger"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "UsageLedger_id_organizationId_key" ON "UsageLedger"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "DataSource_key_key" ON "DataSource"("key");

-- CreateIndex
CREATE INDEX "CollectionTask_status_nextRunAt_idx" ON "CollectionTask"("status", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionTask_id_dataSourceId_key" ON "CollectionTask"("id", "dataSourceId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionRun_idempotencyKey_key" ON "CollectionRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CollectionRun_status_nextAttemptAt_queuedAt_idx" ON "CollectionRun"("status", "nextAttemptAt", "queuedAt");

-- CreateIndex
CREATE INDEX "CollectionRun_status_leaseExpiresAt_idx" ON "CollectionRun"("status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionRun_taskId_scheduledFor_key" ON "CollectionRun"("taskId", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionRun_id_dataSourceId_key" ON "CollectionRun"("id", "dataSourceId");

-- CreateIndex
CREATE INDEX "RunItem_runId_status_idx" ON "RunItem"("runId", "status");

-- CreateIndex
CREATE INDEX "RunItem_adId_dataSourceId_idx" ON "RunItem"("adId", "dataSourceId");

-- CreateIndex
CREATE UNIQUE INDEX "RunItem_runId_itemKey_key" ON "RunItem"("runId", "itemKey");

-- CreateIndex
CREATE INDEX "WorkerHeartbeat_lastSeenAt_idx" ON "WorkerHeartbeat"("lastSeenAt");

-- CreateIndex
CREATE INDEX "Advertiser_name_idx" ON "Advertiser"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Advertiser_dataSourceId_sourceAdvertiserId_key" ON "Advertiser"("dataSourceId", "sourceAdvertiserId");

-- CreateIndex
CREATE UNIQUE INDEX "Advertiser_id_dataSourceId_key" ON "Advertiser"("id", "dataSourceId");

-- CreateIndex
CREATE INDEX "Ad_lastObservedAt_id_idx" ON "Ad"("lastObservedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Ad_advertiserId_lastObservedAt_id_idx" ON "Ad"("advertiserId", "lastObservedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Ad_mediaType_sourceStatus_lastObservedAt_id_idx" ON "Ad"("mediaType", "sourceStatus", "lastObservedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Ad_publisherPlatforms_idx" ON "Ad" USING GIN ("publisherPlatforms");

-- CreateIndex
CREATE INDEX "Ad_reportedCountries_idx" ON "Ad" USING GIN ("reportedCountries");

-- CreateIndex
CREATE UNIQUE INDEX "Ad_dataSourceId_sourceAdId_key" ON "Ad"("dataSourceId", "sourceAdId");

-- CreateIndex
CREATE UNIQUE INDEX "Ad_id_dataSourceId_key" ON "Ad"("id", "dataSourceId");

-- CreateIndex
CREATE INDEX "AdObservation_adId_observedAt_idx" ON "AdObservation"("adId", "observedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "AdObservation_adId_collectionRunId_key" ON "AdObservation"("adId", "collectionRunId");

-- CreateIndex
CREATE UNIQUE INDEX "AdObservation_id_adId_key" ON "AdObservation"("id", "adId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaObject_storageKey_key" ON "MediaObject"("storageKey");

-- CreateIndex
CREATE INDEX "MediaObject_adId_displayOrder_idx" ON "MediaObject"("adId", "displayOrder");

-- CreateIndex
CREATE INDEX "MediaObject_status_expiresAt_idx" ON "MediaObject"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MediaObject_adId_sourceUrl_key" ON "MediaObject"("adId", "sourceUrl");

-- CreateIndex
CREATE INDEX "Folder_organizationId_workspaceId_idx" ON "Folder"("organizationId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Folder_id_workspaceId_organizationId_key" ON "Folder"("id", "workspaceId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Folder_workspaceId_name_key" ON "Folder"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "SavedAd_organizationId_workspaceId_createdAt_idx" ON "SavedAd"("organizationId", "workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SavedAd_folderId_workspaceId_organizationId_idx" ON "SavedAd"("folderId", "workspaceId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedAd_workspaceId_adId_key" ON "SavedAd"("workspaceId", "adId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedAd_id_workspaceId_organizationId_key" ON "SavedAd"("id", "workspaceId", "organizationId");

-- CreateIndex
CREATE INDEX "Note_organizationId_workspaceId_savedAdId_idx" ON "Note"("organizationId", "workspaceId", "savedAdId");

-- CreateIndex
CREATE UNIQUE INDEX "Note_id_workspaceId_organizationId_key" ON "Note"("id", "workspaceId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PrivateFile_storageKey_key" ON "PrivateFile"("storageKey");

-- CreateIndex
CREATE INDEX "PrivateFile_organizationId_workspaceId_createdAt_idx" ON "PrivateFile"("organizationId", "workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "PrivateFile_status_expiresAt_idx" ON "PrivateFile"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PrivateFile_id_workspaceId_organizationId_key" ON "PrivateFile"("id", "workspaceId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisJob_usageLedgerId_key" ON "AnalysisJob"("usageLedgerId");

-- CreateIndex
CREATE INDEX "AnalysisJob_organizationId_workspaceId_createdAt_idx" ON "AnalysisJob"("organizationId", "workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AnalysisJob_status_leaseExpiresAt_createdAt_idx" ON "AnalysisJob"("status", "leaseExpiresAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisJob_workspaceId_idempotencyKey_key" ON "AnalysisJob"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisJob_id_workspaceId_organizationId_key" ON "AnalysisJob"("id", "workspaceId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisResult_analysisJobId_key" ON "AnalysisResult"("analysisJobId");

-- CreateIndex
CREATE INDEX "AnalysisResult_organizationId_workspaceId_createdAt_idx" ON "AnalysisResult"("organizationId", "workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisResult_id_workspaceId_organizationId_key" ON "AnalysisResult"("id", "workspaceId", "organizationId");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_createdAt_idx" ON "AuditEvent"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditEvent_workspaceId_organizationId_idx" ON "AuditEvent"("workspaceId", "organizationId");

-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_createdAt_idx" ON "AuditEvent"("actorUserId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AuditEvent_expiresAt_idx" ON "AuditEvent"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDelivery_dedupeKey_key" ON "EmailDelivery"("dedupeKey");

-- CreateIndex
CREATE INDEX "EmailDelivery_status_nextAttemptAt_idx" ON "EmailDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_organizationId_createdAt_idx" ON "EmailDelivery"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_userId_createdAt_idx" ON "EmailDelivery"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_expiresAt_idx" ON "EmailDelivery"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDelivery_provider_providerMessageId_key" ON "EmailDelivery"("provider", "providerMessageId");

-- CreateIndex
CREATE INDEX "Feedback_organizationId_createdAt_idx" ON "Feedback"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Feedback_workspaceId_organizationId_idx" ON "Feedback"("workspaceId", "organizationId");

-- CreateIndex
CREATE INDEX "Feedback_status_createdAt_idx" ON "Feedback"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Feedback_expiresAt_idx" ON "Feedback"("expiresAt");

-- CreateIndex
CREATE INDEX "ProductEvent_organizationId_name_createdAt_idx" ON "ProductEvent"("organizationId", "name", "createdAt");

-- CreateIndex
CREATE INDEX "ProductEvent_workspaceId_organizationId_idx" ON "ProductEvent"("workspaceId", "organizationId");

-- CreateIndex
CREATE INDEX "ProductEvent_expiresAt_idx" ON "ProductEvent"("expiresAt");

-- CreateIndex
CREATE INDEX "RateLimitBucket_expiresAt_idx" ON "RateLimitBucket"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RateLimitBucket_scope_principalHash_windowStart_key" ON "RateLimitBucket"("scope", "principalHash", "windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "Auth_userId_key" ON "Auth"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_id_key" ON "Session"("id");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_organizationId_fkey" FOREIGN KEY ("workspaceId", "organizationId") REFERENCES "Workspace"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_organizationId_userId_fkey" FOREIGN KEY ("organizationId", "userId") REFERENCES "OrganizationMember"("organizationId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_workspaceId_organizationId_fkey" FOREIGN KEY ("workspaceId", "organizationId") REFERENCES "Workspace"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planVersionId_fkey" FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_scheduledPlanVersionId_fkey" FOREIGN KEY ("scheduledPlanVersionId") REFERENCES "PlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingEvent" ADD CONSTRAINT "BillingEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingEvent" ADD CONSTRAINT "BillingEvent_subscriptionId_organizationId_fkey" FOREIGN KEY ("subscriptionId", "organizationId") REFERENCES "Subscription"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLedger" ADD CONSTRAINT "UsageLedger_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLedger" ADD CONSTRAINT "UsageLedger_entitlementId_organizationId_fkey" FOREIGN KEY ("entitlementId", "organizationId") REFERENCES "Entitlement"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionTask" ADD CONSTRAINT "CollectionTask_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionTask" ADD CONSTRAINT "CollectionTask_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionRun" ADD CONSTRAINT "CollectionRun_taskId_dataSourceId_fkey" FOREIGN KEY ("taskId", "dataSourceId") REFERENCES "CollectionTask"("id", "dataSourceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionRun" ADD CONSTRAINT "CollectionRun_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunItem" ADD CONSTRAINT "RunItem_runId_dataSourceId_fkey" FOREIGN KEY ("runId", "dataSourceId") REFERENCES "CollectionRun"("id", "dataSourceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunItem" ADD CONSTRAINT "RunItem_adId_dataSourceId_fkey" FOREIGN KEY ("adId", "dataSourceId") REFERENCES "Ad"("id", "dataSourceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Advertiser" ADD CONSTRAINT "Advertiser_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ad" ADD CONSTRAINT "Ad_dataSourceId_fkey" FOREIGN KEY ("dataSourceId") REFERENCES "DataSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ad" ADD CONSTRAINT "Ad_advertiserId_dataSourceId_fkey" FOREIGN KEY ("advertiserId", "dataSourceId") REFERENCES "Advertiser"("id", "dataSourceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdObservation" ADD CONSTRAINT "AdObservation_adId_dataSourceId_fkey" FOREIGN KEY ("adId", "dataSourceId") REFERENCES "Ad"("id", "dataSourceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdObservation" ADD CONSTRAINT "AdObservation_collectionRunId_dataSourceId_fkey" FOREIGN KEY ("collectionRunId", "dataSourceId") REFERENCES "CollectionRun"("id", "dataSourceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaObject" ADD CONSTRAINT "MediaObject_adId_fkey" FOREIGN KEY ("adId") REFERENCES "Ad"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaObject" ADD CONSTRAINT "MediaObject_observationId_adId_fkey" FOREIGN KEY ("observationId", "adId") REFERENCES "AdObservation"("id", "adId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_workspaceId_organizationId_fkey" FOREIGN KEY ("workspaceId", "organizationId") REFERENCES "Workspace"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedAd" ADD CONSTRAINT "SavedAd_workspaceId_organizationId_fkey" FOREIGN KEY ("workspaceId", "organizationId") REFERENCES "Workspace"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedAd" ADD CONSTRAINT "SavedAd_adId_fkey" FOREIGN KEY ("adId") REFERENCES "Ad"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedAd" ADD CONSTRAINT "SavedAd_folderId_workspaceId_organizationId_fkey" FOREIGN KEY ("folderId", "workspaceId", "organizationId") REFERENCES "Folder"("id", "workspaceId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedAd" ADD CONSTRAINT "SavedAd_savedByUserId_fkey" FOREIGN KEY ("savedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_workspaceId_organizationId_fkey" FOREIGN KEY ("workspaceId", "organizationId") REFERENCES "Workspace"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_savedAdId_workspaceId_organizationId_fkey" FOREIGN KEY ("savedAdId", "workspaceId", "organizationId") REFERENCES "SavedAd"("id", "workspaceId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivateFile" ADD CONSTRAINT "PrivateFile_workspaceId_organizationId_fkey" FOREIGN KEY ("workspaceId", "organizationId") REFERENCES "Workspace"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisJob" ADD CONSTRAINT "AnalysisJob_workspaceId_organizationId_fkey" FOREIGN KEY ("workspaceId", "organizationId") REFERENCES "Workspace"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisJob" ADD CONSTRAINT "AnalysisJob_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisJob" ADD CONSTRAINT "AnalysisJob_adId_fkey" FOREIGN KEY ("adId") REFERENCES "Ad"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisJob" ADD CONSTRAINT "AnalysisJob_usageLedgerId_organizationId_fkey" FOREIGN KEY ("usageLedgerId", "organizationId") REFERENCES "UsageLedger"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisResult" ADD CONSTRAINT "AnalysisResult_workspaceId_organizationId_fkey" FOREIGN KEY ("workspaceId", "organizationId") REFERENCES "Workspace"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisResult" ADD CONSTRAINT "AnalysisResult_analysisJobId_workspaceId_organizationId_fkey" FOREIGN KEY ("analysisJobId", "workspaceId", "organizationId") REFERENCES "AnalysisJob"("id", "workspaceId", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_workspaceId_organizationId_fkey" FOREIGN KEY ("workspaceId", "organizationId") REFERENCES "Workspace"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_workspaceId_organizationId_fkey" FOREIGN KEY ("workspaceId", "organizationId") REFERENCES "Workspace"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_workspaceId_organizationId_fkey" FOREIGN KEY ("workspaceId", "organizationId") REFERENCES "Workspace"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductEvent" ADD CONSTRAINT "ProductEvent_adId_fkey" FOREIGN KEY ("adId") REFERENCES "Ad"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Auth" ADD CONSTRAINT "Auth_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthIdentity" ADD CONSTRAINT "AuthIdentity_authId_fkey" FOREIGN KEY ("authId") REFERENCES "Auth"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Auth"("id") ON DELETE CASCADE ON UPDATE CASCADE;

