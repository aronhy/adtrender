-- Executed by the deployment owner, never by the collector role.
-- The runtime role receives EXECUTE only; no table or credential access.
BEGIN;
CREATE SCHEMA IF NOT EXISTS pinterest_collector;
REVOKE ALL ON SCHEMA pinterest_collector FROM PUBLIC;
CREATE OR REPLACE FUNCTION pinterest_collector.ingest(raw text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b jsonb; a jsonb; m jsonb; h text; sid text; rid text; tid text; aid text; oid text;
old public."Ad"%ROWTYPE; observed timestamp; n int; inserted int:=0; updated int:=0; seq int; runstatus text; media_kind text;
BEGIN
  -- Managed control is enforced centrally when installed; legacy SQL remains compatible.
  IF to_regprocedure('seed_dispatch.guard_native_ingest(text,text)') IS NOT NULL THEN
    PERFORM seed_dispatch.guard_native_ingest('pinterest_ads_repository',raw);
  END IF;
 IF octet_length(raw)>25000000 THEN RAISE EXCEPTION 'BATCH_TOO_LARGE'; END IF;
 b:=raw::jsonb;
 IF b->>'sourceKey' IS DISTINCT FROM 'pinterest_ads_repository' OR b->>'platform' IS DISTINCT FROM 'PINTEREST'
 OR b->>'version' IS DISTINCT FROM 'pinterest-public-dom-1' OR jsonb_typeof(b->'ads') IS DISTINCT FROM 'array'
 OR (b#>>'{query,country}') IS NULL OR (b#>>'{query,country}') !~ '^[A-Z]{2}$'
 OR b->>'status' IS NULL OR b->>'status' NOT IN ('SUCCEEDED','PARTIAL','FAILED','NO_RESULTS') THEN RAISE EXCEPTION 'BATCH_INVALID'; END IF;
 n:=jsonb_array_length(b->'ads');IF n>20 THEN RAISE EXCEPTION 'BATCH_LIMIT'; END IF;
 h:=encode(sha256(convert_to(raw,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('pinterest-operator-source',0));
 SELECT id INTO rid FROM public."CollectionRun" WHERE "idempotencyKey"='pinterest-service:'||h;
 IF FOUND THEN RETURN jsonb_build_object('status','ALREADY_IMPORTED','runId',rid,'inserted',0,'updated',0) || (SELECT jsonb_build_object('originalInserted',"insertedCount",'originalUpdated',"updatedCount",'committedAt',to_char("finishedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM public."CollectionRun" WHERE id=rid);END IF;
 SELECT id INTO STRICT sid FROM public."DataSource" WHERE key='pinterest_ads_repository';
 tid:=gen_random_uuid()::text;rid:=gen_random_uuid()::text;
 INSERT INTO public."CollectionTask"(id,"updatedAt","dataSourceId",name,query,status,"maxItems","maxAttempts")
 VALUES(tid,now(),sid,'Pinterest full coverage service',b->'query','PAUSED',greatest(1,n),1);
 runstatus:=CASE WHEN b->>'status'='NO_RESULTS' THEN 'SUCCEEDED' ELSE b->>'status' END;
 INSERT INTO public."CollectionRun"(id,"updatedAt","taskId","dataSourceId","idempotencyKey","querySnapshot","adapterVersion",status,"startedAt","finishedAt",attempt,"fetchedCount","errorCode",coverage,"evidenceReference")
 VALUES(rid,now(),tid,sid,'pinterest-service:'||h,b->'query',b->>'version',runstatus,(b->>'observedAt')::timestamp,now(),1,n,b->>'errorCode',coalesce(b->'coverage','{}')||'{"mode":"pinterest-background-service","completeSourceCoverage":false}'::jsonb,'local-private:pinterest/'||h||'/batch.json');
 FOR a IN SELECT value FROM jsonb_array_elements(b->'ads') LOOP
  IF a->>'sourceAdId' IS NULL OR a->>'sourceAdId' !~ '^([0-9]+|[A-Fa-f0-9]{64})$' OR a->>'sourceUrl' IS DISTINCT FROM 'https://ads.pinterest.com/ads-repository/'||(a->>'sourceAdId')||'/'
   OR (nullif(a#>>'{sourceFields,Advertiser name}','') IS NULL AND (a#>>'{sourceFields,Ad status}') IS DISTINCT FROM 'Disapproved')
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'evidence') e WHERE e->>'url'=a->>'sourceUrl' AND e->>'httpStatus'='200' AND e->>'text'=a->>'rawText' AND e->>'html'=a->>'rawHtml')
   THEN RAISE EXCEPTION 'AD_INVALID'; END IF;
  IF jsonb_typeof(a->'reportedCountries') IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(a->'reportedCountries') c WHERE c !~ '^[A-Z]{2}$') THEN RAISE EXCEPTION 'COUNTRIES_INVALID'; END IF;
  IF jsonb_typeof(a->'media') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'MEDIA_INVALID'; END IF;
  media_kind:=CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(a->'media') asset WHERE asset->>'type'='VIDEO') THEN 'VIDEO' WHEN jsonb_array_length(a->'media')>0 THEN 'IMAGE' ELSE 'UNKNOWN' END;
  observed:=(a->>'observedAt')::timestamp;
  SELECT * INTO old FROM public."Ad" WHERE "dataSourceId"=sid AND "sourceAdId"=a->>'sourceAdId';
  IF NOT FOUND THEN
   aid:=gen_random_uuid()::text;inserted:=inserted+1;
   INSERT INTO public."Ad"(id,"updatedAt","dataSourceId","sourceAdId","sourceUrl",body,headline,"publisherPlatforms","reportedCountries","mediaType","firstObservedAt","lastObservedAt","fieldProvenance")
   VALUES(aid,now(),sid,a->>'sourceAdId',a->>'sourceUrl',nullif(a->>'body',''),nullif(a->>'headline',''),ARRAY['PINTEREST'],ARRAY(SELECT jsonb_array_elements_text(a->'reportedCountries')),media_kind,observed,observed,jsonb_build_object('source','pinterest-public-dom','evidenceSha256',h,'sourceFields',a->'sourceFields','bodyTruncated',a->'bodyTruncated'));
  ELSE
   aid:=old.id;updated:=updated+1;
   UPDATE public."Ad" SET "firstObservedAt"=least(coalesce("firstObservedAt",observed),observed) WHERE id=aid;
   IF old."lastObservedAt" IS NULL OR old."lastObservedAt"<=observed THEN
    UPDATE public."Ad" SET "updatedAt"=now(),body=CASE WHEN b#>>'{query,historyKind}'='HISTORY_RECHECK' THEN coalesce(nullif(a->>'body',''),body) ELSE nullif(a->>'body','') END,headline=CASE WHEN b#>>'{query,historyKind}'='HISTORY_RECHECK' THEN coalesce(nullif(a->>'headline',''),headline) ELSE nullif(a->>'headline','') END,"publisherPlatforms"=ARRAY['PINTEREST'],"reportedCountries"=ARRAY(SELECT jsonb_array_elements_text(a->'reportedCountries')),"lastObservedAt"=observed,"mediaType"=media_kind,"fieldProvenance"=jsonb_build_object('source','pinterest-public-dom','evidenceSha256',h,'sourceFields',a->'sourceFields','bodyTruncated',a->'bodyTruncated') WHERE id=aid;
   END IF;
  END IF;
  oid:=gen_random_uuid()::text;
  INSERT INTO public."AdObservation"(id,"adId","dataSourceId","collectionRunId","observedAt","queryCountry",snapshot,"fieldProvenance","evidenceReference","evidenceSha256","parserVersion")
   VALUES(oid,aid,sid,rid,observed,b#>>'{query,country}',a,jsonb_build_object('source','pinterest-public-dom','evidenceSha256',h),'local-private:pinterest/'||h||'/batch.json',h,b->>'version');
  seq:=0;
  FOR m IN SELECT value FROM jsonb_array_elements(a->'media') LOOP
   IF m->>'type' IS NULL OR m->>'type' NOT IN ('IMAGE','VIDEO') OR m->>'url' IS NULL THEN RAISE EXCEPTION 'MEDIA_INVALID';END IF;
   IF m->>'type'='IMAGE' AND m->>'url' !~ '^https://i\.pinimg\.com/[^[:space:]\\]+$' THEN RAISE EXCEPTION 'MEDIA_INVALID';END IF;
   IF m->>'type'='VIDEO' THEN
    IF m->>'url' !~ '^https://v\.pinimg\.com/videos/mc/[0-9]+p/([a-f0-9]{2}/){3}[a-f0-9]{32}[.]mp4([?][A-Za-z0-9%_.~!$&''()*+,;=:@/?-]*)?$'
     OR NOT EXISTS(SELECT 1 FROM regexp_matches(a->>'rawHtml','<(video|source)([[:space:]][^>]*)?[[:space:]]src[[:space:]]*=[[:space:]]*["'']([^"'']+)["'']','gi') tag WHERE replace(tag[3],'&amp;','&')=m->>'url')
     THEN RAISE EXCEPTION 'MEDIA_INVALID';END IF;
   END IF;
   INSERT INTO public."MediaObject"(id,"updatedAt","adId","observationId","sourceUrl",type,status,"errorCode","displayOrder")
    VALUES(gen_random_uuid()::text,now(),aid,oid,m->>'url',m->>'type','UNAVAILABLE','PLATFORM_MEDIA_ADAPTER_PENDING',seq) ON CONFLICT ("adId","sourceUrl") DO NOTHING;
   seq:=seq+1;
  END LOOP;
  INSERT INTO public."RunItem"(id,"runId","dataSourceId","itemKey","sourceAdId","adId",status,"parserVersion","evidenceSha256") VALUES(gen_random_uuid()::text,rid,sid,a->>'sourceAdId',a->>'sourceAdId',aid,CASE WHEN old.id IS NULL THEN 'INSERTED' ELSE 'UPDATED' END,b->>'version',h);
 END LOOP;
 UPDATE public."CollectionRun" SET "insertedCount"=inserted,"updatedCount"=updated WHERE id=rid;
 INSERT INTO public."AuditEvent"(id,action,"targetType","targetId",metadata) VALUES(gen_random_uuid()::text,'PINTEREST_SERVICE_BATCH_IMPORTED','CollectionRun',rid,jsonb_build_object('count',n,'evidenceSha256',h));
 RETURN jsonb_build_object('status','IMPORTED','runId',rid,'inserted',inserted,'updated',updated) || (SELECT jsonb_build_object('originalInserted',"insertedCount",'originalUpdated',"updatedCount",'committedAt',to_char("finishedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM public."CollectionRun" WHERE id=rid);
END;
$$;
REVOKE ALL ON FUNCTION pinterest_collector.ingest(text) FROM PUBLIC;
-- Role is provisioned with a random password by the deployment script.
GRANT CONNECT ON DATABASE ad_research_test TO pinterest_collector_runtime;
GRANT USAGE ON SCHEMA pinterest_collector TO pinterest_collector_runtime;
GRANT EXECUTE ON FUNCTION pinterest_collector.ingest(text) TO pinterest_collector_runtime;
COMMIT;
