BEGIN;
-- CreateTable
CREATE TABLE "CollectorSourceAssignment" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "incarnationId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "controlMode" TEXT NOT NULL DEFAULT 'LEGACY_QUEUE',
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "tokenHash" TEXT NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "publicationRevision" INTEGER NOT NULL DEFAULT 0,
    "configHash" TEXT,
    "lastStopReceiptId" TEXT,

    CONSTRAINT "CollectorSourceAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CollectorSourceAssignment_sourceKey_channel_state_idx" ON "CollectorSourceAssignment"("sourceKey", "channel", "state");

-- CreateIndex
CREATE UNIQUE INDEX "CollectorSourceAssignment_sourceKey_channel_generation_key" ON "CollectorSourceAssignment"("sourceKey", "channel", "generation");

-- AddForeignKey
ALTER TABLE "CollectorSourceAssignment" ADD CONSTRAINT "CollectorSourceAssignment_dataSourceId_sourceKey_fkey" FOREIGN KEY ("dataSourceId", "sourceKey") REFERENCES "DataSource"("id", "key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectorSourceAssignment" ADD CONSTRAINT "CollectorSourceAssignment_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "CollectorNode"("nodeId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CollectorSourceAssignment" ADD CONSTRAINT collector_assignment_valid CHECK (
  generation > 0 AND "sourceKey" <> '' AND channel <> '' AND "incarnationId" <> ''
  AND "tokenHash" ~ '^[a-f0-9]{64}$' AND "publicationRevision" >= 0
  AND ("configHash" IS NULL OR "configHash" ~ '^[a-f0-9]{64}$')
  AND "controlMode" IN ('LEGACY_QUEUE','CONFIG_QUEUE','TASK_CLAIM') AND state IN ('ACTIVE','DRAINING','STOPPED'));
CREATE UNIQUE INDEX collector_source_current_assignment ON "CollectorSourceAssignment" ("sourceKey",channel) WHERE state IN ('ACTIVE','DRAINING');
REVOKE ALL ON "CollectorSourceAssignment" FROM PUBLIC;

CREATE SCHEMA seed_dispatch;
REVOKE ALL ON SCHEMA seed_dispatch FROM PUBLIC;

-- Native importers invoke this guard before their existing evidence validation.
-- A custom setting alone is insufficient: the guard verifies the secret token
-- against the historical attempt and the central PREPARED/legacy SHA allowlist.
CREATE FUNCTION seed_dispatch.guard_native_ingest(source_key text, raw text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $$
DECLARE ctx jsonb; hash text; pending public."AuditEvent"%ROWTYPE; attempt public."SeedTaskAttempt"%ROWTYPE;
  task public."SeedExecutionTask"%ROWTYPE; query public."SeedQuery"%ROWTYPE; node public."CollectorNode"%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."CollectorSourceControl" WHERE "sourceKey"=source_key AND "controlMode"<>'LEGACY_QUEUE') THEN RETURN; END IF;
  BEGIN ctx:=nullif(current_setting('seed_dispatch.execution',true),'')::jsonb;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'MANAGED_INGEST_REQUIRED'; END;
  IF ctx IS NULL OR jsonb_typeof(ctx)<>'object' OR ctx->>'sourceKey' IS DISTINCT FROM source_key THEN RAISE EXCEPTION 'MANAGED_INGEST_REQUIRED'; END IF;
  hash:=encode(sha256(convert_to(raw,'UTF8')),'hex');
  IF ctx->>'kind'='LEGACY_RECOVERY' THEN
    SELECT * INTO pending FROM public."AuditEvent" WHERE id=ctx->>'registrationId' AND action='SEED_LEGACY_PENDING_REGISTERED';
    IF NOT FOUND OR pending."actorUserId" IS NULL OR pending.metadata->>'sourceKey' IS DISTINCT FROM source_key
      OR NOT (pending.metadata->'batchHashes' ? hash) OR pending.metadata->>'nodeId' IS DISTINCT FROM ctx->>'nodeId'
      OR pending.metadata->>'incarnationId' IS DISTINCT FROM ctx->>'incarnationId' THEN RAISE EXCEPTION 'LEGACY_PENDING_NOT_REGISTERED'; END IF;
    SELECT * INTO node FROM public."CollectorNode" WHERE "nodeId"=ctx->>'nodeId';
    IF NOT FOUND OR node."incarnationId" IS DISTINCT FROM ctx->>'incarnationId' THEN RAISE EXCEPTION 'MACHINE_IDENTITY_REJECTED'; END IF;
    RETURN;
  END IF;
  SELECT * INTO pending FROM public."AuditEvent" WHERE id=ctx->>'preparedId' AND action='SEED_UNIT_PREPARED';
  IF NOT FOUND OR pending.metadata->>'sourceKey' IS DISTINCT FROM source_key OR NOT (pending.metadata->'expectedBatchHashes' ? hash)
    OR pending.metadata->>'attemptId' IS DISTINCT FROM ctx->>'attemptId' THEN RAISE EXCEPTION 'UNPREPARED_BATCH'; END IF;
  SELECT * INTO attempt FROM public."SeedTaskAttempt" WHERE id=ctx->>'attemptId';
  IF NOT FOUND OR attempt."sourceKey" IS DISTINCT FROM source_key OR attempt."startedAt" IS NULL
    OR attempt."tokenHash" IS DISTINCT FROM encode(sha256(convert_to(coalesce(ctx->>'grantToken',''),'UTF8')),'hex')
    OR attempt."nodeId" IS DISTINCT FROM pending.metadata->>'nodeId' OR attempt."incarnationId" IS DISTINCT FROM pending.metadata->>'incarnationId'
    OR pending."createdAt">attempt."leaseExpiresAt" THEN RAISE EXCEPTION 'LEASE_LOST'; END IF;
  SELECT * INTO task FROM public."SeedExecutionTask" WHERE id=attempt."taskId";
  SELECT * INTO query FROM public."SeedQuery" WHERE id=task."queryId";
  IF coalesce(ctx->>'recover','false')<>'true' THEN
    SELECT * INTO node FROM public."CollectorNode" WHERE "nodeId"=attempt."nodeId";
    IF attempt."leaseExpiresAt"<=timezone('UTC',clock_timestamp()) OR attempt.state NOT IN ('RUNNING','STOP_REQUESTED','COMMIT_PENDING')
      OR query."assignmentGeneration"<>attempt."assignmentGeneration" OR node."incarnationId" IS DISTINCT FROM attempt."incarnationId"
      OR NOT node.enabled OR (node."expiresAt" IS NOT NULL AND node."expiresAt"<=timezone('UTC',clock_timestamp())) THEN RAISE EXCEPTION 'LEASE_LOST'; END IF;
  END IF;
END $$;
REVOKE ALL ON FUNCTION seed_dispatch.guard_native_ingest(text,text) FROM PUBLIC;

CREATE FUNCTION seed_dispatch.ingest_authorized(raw text, execution jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $$
DECLARE result jsonb; prior text;
BEGIN
  prior:=current_setting('seed_dispatch.execution',true);
  PERFORM set_config('seed_dispatch.execution',execution::text,true);
  PERFORM seed_dispatch.guard_native_ingest(execution->>'sourceKey',raw);
  CASE execution->>'sourceKey'
    WHEN 'meta_ad_library' THEN EXECUTE 'SELECT meta_collector.ingest($1)' INTO result USING raw;
    WHEN 'google_ads_transparency' THEN EXECUTE 'SELECT google_collector.ingest($1)' INTO result USING raw;
    WHEN 'snapchat_ads_gallery' THEN EXECUTE 'SELECT snapchat_collector.ingest($1)' INTO result USING raw;
    WHEN 'tiktok_commercial_library' THEN EXECUTE 'SELECT tiktok_collector.ingest($1)' INTO result USING raw;
    WHEN 'pinterest_ads_repository' THEN EXECUTE 'SELECT pinterest_collector.ingest($1)' INTO result USING raw;
    ELSE RAISE EXCEPTION 'SOURCE_INVALID';
  END CASE;
  PERFORM set_config('seed_dispatch.execution',coalesce(prior,''),true);
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION seed_dispatch.ingest_authorized(text,jsonb) FROM PUBLIC;
-- Application coordination gets a single validated RPC, never a source-runtime
-- role membership or public table privileges. Production application of this
-- new permission is a separate deployment approval; this task uses local owner.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='saas_app') THEN
    GRANT USAGE ON SCHEMA seed_dispatch TO saas_app;
    GRANT EXECUTE ON FUNCTION seed_dispatch.ingest_authorized(text,jsonb) TO saas_app;
  END IF;
END $$;
COMMIT;

