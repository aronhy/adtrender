BEGIN;
CREATE OR REPLACE FUNCTION seed_dispatch.guard_native_ingest(source_key text, raw text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC' AS $$
DECLARE durable public."AuditEvent"%ROWTYPE; ctx jsonb; hash text; pending public."AuditEvent"%ROWTYPE; attempt public."SeedTaskAttempt"%ROWTYPE;
  task public."SeedExecutionTask"%ROWTYPE; query public."SeedQuery"%ROWTYPE; node public."CollectorNode"%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."CollectorSourceControl" WHERE "sourceKey"=source_key AND "controlMode"<>'LEGACY_QUEUE') THEN RETURN; END IF;
  BEGIN ctx:=nullif(current_setting('seed_dispatch.execution',true),'')::jsonb;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'MANAGED_INGEST_REQUIRED'; END;
  IF ctx IS NULL OR jsonb_typeof(ctx)<>'object' OR ctx->>'sourceKey' IS DISTINCT FROM source_key THEN RAISE EXCEPTION 'MANAGED_INGEST_REQUIRED'; END IF;
  hash:=encode(sha256(convert_to(raw,'UTF8')),'hex');
  SELECT * INTO durable FROM public."AuditEvent" WHERE id=ctx->>'durableId' AND action='SEED_RAW_OBJECT_DURABLE';
  IF NOT FOUND OR durable.metadata->>'sourceKey' IS DISTINCT FROM source_key OR durable.metadata->>'batchHash' IS DISTINCT FROM hash
    OR durable.metadata->>'objectReference' IS NULL OR durable.metadata->>'objectKey' IS NULL
    OR durable."targetId" IS DISTINCT FROM coalesce(ctx->>'preparedId',ctx->>'registrationId')
    THEN RAISE EXCEPTION 'RAW_OBJECT_NOT_DURABLE'; END IF;
  IF ctx->>'kind' NOT IN ('TASK','LEGACY_RECOVERY') THEN RAISE EXCEPTION 'MANAGED_INGEST_REQUIRED'; END IF;
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

-- These anchors can only be inserted by the application coordinator. Runtime
-- roles retain the original source RPC and cannot mint or alter AuditEvent rows.
CREATE FUNCTION seed_dispatch.immutable_evidence_anchor() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF OLD.action IN ('SEED_RAW_OBJECT_DURABLE','SEED_UNIT_PREPARED','SEED_LEGACY_PENDING_REGISTERED','SEED_BATCH_COMMITTED') THEN
    RAISE EXCEPTION 'IMMUTABLE_SEED_EVIDENCE_ANCHOR' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION seed_dispatch.immutable_evidence_anchor() FROM PUBLIC;
CREATE TRIGGER immutable_seed_evidence_anchor BEFORE UPDATE OR DELETE ON public."AuditEvent" FOR EACH ROW EXECUTE FUNCTION seed_dispatch.immutable_evidence_anchor();
COMMIT;
