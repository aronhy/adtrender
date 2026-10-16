-- Apply as schema owner after the native source ingest functions. No public grants.
BEGIN;
CREATE SCHEMA IF NOT EXISTS history_collector;
REVOKE ALL ON SCHEMA history_collector FROM PUBLIC;
CREATE TABLE IF NOT EXISTS history_collector.target (
 ad_id text PRIMARY KEY REFERENCES public."Ad"(id) ON DELETE CASCADE,
 source_key text NOT NULL CHECK (source_key IN ('meta_ad_library','google_ads_transparency','tiktok_commercial_library','pinterest_ads_repository','snapchat_ads_gallery')),
 source_ad_id text NOT NULL, source_url text, country text, discovery_query jsonb NOT NULL DEFAULT '{}',
 publisher_platforms text[] NOT NULL DEFAULT '{}', source_status text NOT NULL DEFAULT 'UNKNOWN',
 seeded_at timestamptz NOT NULL DEFAULT now(), next_due_at timestamptz NOT NULL DEFAULT now(),
 last_attempt_at timestamptz, last_observed_at timestamptz, failures int NOT NULL DEFAULT 0,
 lease_token uuid, lease_until timestamptz, UNIQUE(source_key,source_ad_id)
);
CREATE INDEX IF NOT EXISTS history_target_due ON history_collector.target(next_due_at,source_key);
CREATE TABLE IF NOT EXISTS history_collector.attempt (
 id uuid PRIMARY KEY, ad_id text NOT NULL REFERENCES history_collector.target(ad_id) ON DELETE CASCADE,
 lease_token uuid NOT NULL, scheduled_at timestamptz NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 outcome text NOT NULL DEFAULT 'RUNNING' CHECK(outcome IN ('RUNNING','OBSERVED','NOT_OBSERVED','FAILED','UNSUPPORTED','ABANDONED')),
 error_code text, collection_run_id text, evidence_sha256 text, result_sha256 text,
 evidence_reference text, result jsonb
);
CREATE INDEX IF NOT EXISTS history_attempt_ad_date ON history_collector.attempt(ad_id,started_at DESC);
CREATE INDEX IF NOT EXISTS history_attempt_started ON history_collector.attempt(started_at);
CREATE TABLE IF NOT EXISTS history_collector.source_control (
 source_key text PRIMARY KEY, not_before timestamptz NOT NULL DEFAULT now(), restrictions int NOT NULL DEFAULT 0,
 reason text
);
INSERT INTO history_collector.source_control(source_key) SELECT unnest(ARRAY['meta_ad_library','google_ads_transparency','tiktok_commercial_library','pinterest_ads_repository','snapchat_ads_gallery']) ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION history_collector.legacy_source_allowed(source text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE allowed boolean;
BEGIN
 -- Match central assignSource: ownership checks and the ensuing lease write
 -- remain serialized until this transaction commits. VOLATILE reads ownership
 -- again after a concurrent assignment commits while this lock was awaited.
 PERFORM pg_advisory_xact_lock(hashtextextended('seed-dispatch:source:'||source,0));
 -- Old installations without central dispatch retain their original behavior.
 -- A centrally registered source stays managed after its old owner retires.
 IF to_regclass('public."CollectorSourceAssignment"') IS NOT NULL THEN
  EXECUTE 'SELECT NOT EXISTS(SELECT 1 FROM public."CollectorSourceAssignment" WHERE "sourceKey"=$1)' INTO allowed USING source;
  IF NOT allowed THEN RETURN false; END IF;
 END IF;
 IF to_regclass('public."CollectorSourceControl"') IS NULL THEN RETURN true; END IF;
 EXECUTE 'SELECT NOT EXISTS(SELECT 1 FROM public."CollectorSourceControl" WHERE "sourceKey"=$1 AND "controlMode" IN (''CONFIG_QUEUE'',''TASK_CLAIM''))'
 INTO allowed USING source;
 RETURN allowed;
END $$;
CREATE OR REPLACE FUNCTION history_collector.seed() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n int;
BEGIN
 -- Every known identity with a real observation is admitted, including unsupported URLs.
 -- No copied current Ad row is represented as a new observation.
 INSERT INTO history_collector.target(ad_id,source_key,source_ad_id,source_url,country,discovery_query,publisher_platforms,source_status,last_observed_at,next_due_at)
 SELECT a.id,d.key,a."sourceAdId",a."sourceUrl",o."queryCountry",coalesce(r."querySnapshot",'{}'),a."publisherPlatforms",coalesce(o."sourceStatus",'UNKNOWN'),o."observedAt" AT TIME ZONE 'UTC',greatest(now(),(o."observedAt" AT TIME ZONE 'UTC')+CASE WHEN o."sourceStatus"='INACTIVE' THEN interval '7 days' ELSE interval '1 day' END)
 FROM public."Ad" a JOIN public."DataSource" d ON d.id=a."dataSourceId"
 JOIN LATERAL (SELECT * FROM public."AdObservation" x WHERE x."adId"=a.id ORDER BY x."observedAt" DESC,x.id DESC LIMIT 1) o ON true
 LEFT JOIN public."CollectionRun" r ON r.id=o."collectionRunId"
 WHERE d.key IN (SELECT source_key FROM history_collector.source_control)
 ON CONFLICT(ad_id) DO UPDATE SET
 source_url=EXCLUDED.source_url,country=EXCLUDED.country,discovery_query=EXCLUDED.discovery_query,
 publisher_platforms=EXCLUDED.publisher_platforms,source_status=EXCLUDED.source_status,last_observed_at=EXCLUDED.last_observed_at,
 next_due_at=CASE WHEN history_collector.target.failures>0 AND (SELECT attempt.outcome FROM history_collector.attempt WHERE attempt.ad_id=EXCLUDED.ad_id ORDER BY attempt.started_at DESC,attempt.id DESC LIMIT 1) IN ('FAILED','ABANDONED') THEN greatest(history_collector.target.next_due_at,EXCLUDED.next_due_at) ELSE EXCLUDED.next_due_at END
 WHERE (history_collector.target.last_observed_at IS NULL OR EXCLUDED.last_observed_at>history_collector.target.last_observed_at)
 AND (history_collector.target.lease_until IS NULL OR history_collector.target.lease_until<=now());
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN jsonb_build_object('seeded',n,'total',(SELECT count(*) FROM history_collector.target));
END $$;
CREATE OR REPLACE FUNCTION history_collector.claim() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t history_collector.target%ROWTYPE; token uuid; attempt_id uuid;
BEGIN
 -- One lock coordinates leases and source spacing across all daemon instances.
 PERFORM pg_advisory_xact_lock(hashtextextended('history-claim',0));
 UPDATE history_collector.attempt a SET outcome='ABANDONED',finished_at=now(),error_code='LEASE_EXPIRED'
 FROM history_collector.target x WHERE a.ad_id=x.ad_id AND a.lease_token=x.lease_token AND a.outcome='RUNNING' AND x.lease_until<=now();
 UPDATE history_collector.target SET lease_token=NULL,lease_until=NULL,next_due_at=greatest(next_due_at,now()+interval '10 minutes'),failures=failures+1 WHERE lease_until<=now();
 SELECT x.* INTO t FROM history_collector.target x JOIN history_collector.source_control c USING(source_key)
 WHERE x.next_due_at<=now() AND x.lease_token IS NULL AND c.not_before<=now()
 AND history_collector.legacy_source_allowed(x.source_key)
 ORDER BY x.next_due_at,x.ad_id LIMIT 1 FOR UPDATE OF x SKIP LOCKED;
 IF NOT FOUND THEN RETURN NULL; END IF;
 token:=gen_random_uuid();attempt_id:=gen_random_uuid();
 UPDATE history_collector.target SET lease_token=token,lease_until=now()+interval '10 minutes',last_attempt_at=now() WHERE ad_id=t.ad_id;
 UPDATE history_collector.source_control SET not_before=now()+interval '2 minutes' WHERE source_key=t.source_key;
 INSERT INTO history_collector.attempt(id,ad_id,lease_token,scheduled_at) VALUES(attempt_id,t.ad_id,token,t.next_due_at);
 RETURN jsonb_build_object('attemptId',attempt_id,'leaseToken',token,'leaseUntil',now()+interval '10 minutes','adId',t.ad_id,'sourceKey',t.source_key,'sourceAdId',t.source_ad_id,'sourceUrl',t.source_url,'country',t.country,'discoveryQuery',t.discovery_query,'publisherPlatforms',t.publisher_platforms);
END $$;
CREATE OR REPLACE FUNCTION history_collector.finish(attempt_id uuid, token uuid, raw text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET timezone='UTC' AS $$
DECLARE t history_collector.target%ROWTYPE; a history_collector.attempt%ROWTYPE; b jsonb; result jsonb; imported jsonb; h text; bh text; code text; outcome_value text; state_value text; native_schema text; delay interval; retry_ms bigint; archive text;
BEGIN
 IF raw IS NULL OR octet_length(raw)>25000000 THEN RAISE EXCEPTION 'HISTORY_RESULT_SIZE'; END IF;
 result:=raw::jsonb;h:=encode(sha256(convert_to(raw,'UTF8')),'hex');
 SELECT * INTO STRICT a FROM history_collector.attempt WHERE id=attempt_id FOR UPDATE;
 IF a.lease_token IS DISTINCT FROM token THEN RAISE EXCEPTION 'HISTORY_LEASE_INVALID';END IF;
 IF a.outcome<>'RUNNING' THEN IF a.result_sha256=h THEN RETURN a.result;ELSE RAISE EXCEPTION 'HISTORY_ATTEMPT_FINISHED';END IF;END IF;
 SELECT * INTO STRICT t FROM history_collector.target WHERE ad_id=a.ad_id FOR UPDATE;
 IF t.lease_token IS DISTINCT FROM token OR t.lease_until<=now() THEN RAISE EXCEPTION 'HISTORY_LEASE_EXPIRED';END IF;
 outcome_value:=result->>'outcome';code:=result->>'errorCode';
 IF outcome_value IS NULL OR outcome_value NOT IN ('OBSERVED','NOT_OBSERVED','FAILED','UNSUPPORTED') OR (code IS NOT NULL AND code !~ '^[A-Z][A-Z_0-9]{2,100}$') THEN RAISE EXCEPTION 'HISTORY_RESULT_INVALID';END IF;
 b:=result->'batch';
 IF outcome_value='OBSERVED' THEN
  IF jsonb_typeof(b) IS DISTINCT FROM 'object' OR b->>'sourceKey' IS DISTINCT FROM t.source_key
  OR b#>>'{query,historyKind}' IS DISTINCT FROM 'HISTORY_RECHECK' OR b#>>'{query,targetSourceAdId}' IS DISTINCT FROM t.source_ad_id
  OR b#>>'{query,attemptId}' IS DISTINCT FROM attempt_id::text
  OR b#>>'{query,country}' IS DISTINCT FROM coalesce(t.country,'ALL')
  OR jsonb_typeof(b->'ads') IS DISTINCT FROM 'array' OR jsonb_array_length(b->'ads')<>1
  OR b#>>'{ads,0,sourceAdId}' IS DISTINCT FROM t.source_ad_id OR b#>>'{ads,0,sourceUrl}' IS DISTINCT FROM t.source_url
  OR b->>'status' IS DISTINCT FROM 'SUCCEEDED' OR code IS NOT NULL OR jsonb_typeof(b->'observedAt') IS DISTINCT FROM 'string'
  OR (b->>'observedAt')::timestamptz<a.started_at-interval '1 minute' OR (b->>'observedAt')::timestamptz>now()+interval '1 minute'
  THEN RAISE EXCEPTION 'HISTORY_BATCH_INVALID';END IF;
  native_schema:=CASE t.source_key WHEN 'meta_ad_library' THEN 'meta_collector' WHEN 'google_ads_transparency' THEN 'google_collector' WHEN 'tiktok_commercial_library' THEN 'tiktok_collector' WHEN 'pinterest_ads_repository' THEN 'pinterest_collector' WHEN 'snapchat_ads_gallery' THEN 'snapchat_collector' END;
  IF result->>'batchRaw' IS NULL OR (result->>'batchRaw')::jsonb IS DISTINCT FROM b THEN RAISE EXCEPTION 'HISTORY_BATCH_RAW_MISMATCH';END IF;
  -- The original JSON string is the exact byte sequence archived by the daemon.
  EXECUTE format('SELECT %I.ingest($1::text)',native_schema) INTO imported USING (result->>'batchRaw');
  SELECT "sourceStatus" INTO state_value FROM public."AdObservation" WHERE "collectionRunId"=imported->>'runId' AND "adId"=t.ad_id ORDER BY "observedAt" DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'HISTORY_OBSERVATION_MISSING';END IF;
  bh:=encode(sha256(convert_to(result->>'batchRaw','UTF8')),'hex');archive:='local-private:'||replace(native_schema,'_collector','')||'/'||bh||'/batch.json';
 ELSE
  IF b IS NOT NULL AND b<>'null'::jsonb THEN RAISE EXCEPTION 'HISTORY_FAILURE_WITH_BATCH';END IF;
  archive:='local-private:history/'||attempt_id||'/result.json';
 END IF;
 delay:=CASE WHEN (outcome_value='OBSERVED' AND state_value='INACTIVE') OR (outcome_value IN ('NOT_OBSERVED','UNSUPPORTED') AND t.source_status='INACTIVE') THEN interval '7 days' WHEN outcome_value IN ('OBSERVED','NOT_OBSERVED','UNSUPPORTED') THEN interval '1 day' ELSE least(interval '1 day',interval '15 minutes'*power(2,least(t.failures,6))) END;
 IF code ~ '(403|429|RATE_LIMIT|ACCESS_BLOCK|LOGIN|CHALLENGE|RESTRICTED)' THEN
  retry_ms:=CASE WHEN result->>'retryAfterMs' ~ '^[0-9]{1,12}$' THEN least((result->>'retryAfterMs')::bigint,604800000) ELSE 0 END;
  UPDATE history_collector.source_control SET restrictions=restrictions+1,reason=code,
   not_before=greatest(not_before,now()+greatest(interval '6 hours'*power(2,least(restrictions,4)),retry_ms*interval '1 millisecond')) WHERE source_key=t.source_key;
  delay:=greatest(delay,interval '6 hours');
 ELSIF outcome_value='OBSERVED' THEN UPDATE history_collector.source_control SET restrictions=0,reason=NULL WHERE source_key=t.source_key;END IF;
 UPDATE history_collector.target SET lease_token=NULL,lease_until=NULL,next_due_at=now()+delay,failures=CASE WHEN outcome_value='FAILED' THEN failures+1 ELSE 0 END,
 source_status=CASE WHEN outcome_value='OBSERVED' THEN coalesce(state_value,'UNKNOWN') ELSE source_status END,
 last_observed_at=CASE WHEN outcome_value='OBSERVED' THEN (b->>'observedAt')::timestamptz ELSE last_observed_at END WHERE ad_id=t.ad_id;
 imported:=jsonb_build_object('outcome',outcome_value,'runId',imported->>'runId','nextDueAt',now()+delay);
 UPDATE history_collector.attempt SET finished_at=now(),outcome=outcome_value,error_code=code,collection_run_id=imported->>'runId',result_sha256=h,evidence_sha256=coalesce(bh,h),evidence_reference=archive,result=imported WHERE id=attempt_id;
 RETURN imported;
END $$;
CREATE OR REPLACE FUNCTION history_collector.status() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('at',now(),'dailyTimezone','Asia/Shanghai','targets',(SELECT count(*) FROM history_collector.target),'due',(SELECT count(*) FROM history_collector.target WHERE next_due_at<=now()),'leased',(SELECT count(*) FROM history_collector.target WHERE lease_until>now()),'sources',(SELECT jsonb_agg(jsonb_build_object('sourceKey',c.source_key,'dailyLimit',NULL,'notBefore',c.not_before,'reason',c.reason,'due',(SELECT count(*) FROM history_collector.target t WHERE t.source_key=c.source_key AND t.next_due_at<=now()))) FROM history_collector.source_control c),'attempts24h',(SELECT coalesce(jsonb_object_agg(outcome,n),'{}') FROM (SELECT outcome,count(*) n FROM history_collector.attempt WHERE started_at>=now()-interval '24 hours' GROUP BY outcome) s));
$$;
-- Existing installations may retain the legacy daily_limit column for compatibility.
-- It is unused; the status key above explicitly reports no daily limit as JSON null.
-- App reads only this redacted, cross-discovery-scope operational summary.
CREATE OR REPLACE VIEW history_collector.public_daily WITH (security_barrier=true) AS
 SELECT ad_id, day, outcome, checked_at, attempt_count, failure_count
 FROM (
  SELECT ad_id,to_char(started_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,
   outcome,coalesce(finished_at,started_at) AS checked_at,
   count(*) OVER(PARTITION BY ad_id,(started_at AT TIME ZONE 'Asia/Shanghai')::date)::int AS attempt_count,
   sum(CASE WHEN outcome IN ('FAILED','ABANDONED') THEN 1 ELSE 0 END) OVER(PARTITION BY ad_id,(started_at AT TIME ZONE 'Asia/Shanghai')::date)::int AS failure_count,
   row_number() OVER(PARTITION BY ad_id,(started_at AT TIME ZONE 'Asia/Shanghai')::date ORDER BY started_at DESC,id DESC) AS latest
  FROM history_collector.attempt
 ) days WHERE latest=1;
REVOKE ALL ON ALL TABLES IN SCHEMA history_collector FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA history_collector FROM PUBLIC;
GRANT USAGE ON SCHEMA history_collector TO history_collector_runtime;
GRANT EXECUTE ON FUNCTION history_collector.seed(),history_collector.claim(),history_collector.finish(uuid,uuid,text),history_collector.status(),history_collector.legacy_source_allowed(text) TO history_collector_runtime;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='saas_app') THEN
  GRANT USAGE ON SCHEMA history_collector TO saas_app;
  GRANT SELECT ON history_collector.public_daily TO saas_app;
 END IF;
END $$;
COMMIT;
