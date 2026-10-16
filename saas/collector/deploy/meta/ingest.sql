-- Deploy as schema owner. Collector runtime receives only this function.
BEGIN;
CREATE SCHEMA IF NOT EXISTS meta_collector;
REVOKE ALL ON SCHEMA meta_collector FROM PUBLIC;
CREATE OR REPLACE FUNCTION meta_collector.ingest(raw text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b jsonb; a jsonb; m jsonb; h text; sid text; rid text; tid text; aid text; oid text; avid text; avkey text;
old public."Ad"%ROWTYPE; observed timestamp; n int; inserted int:=0; updated int:=0; seq int; runstatus text; prov jsonb; aggregate_prov jsonb; p text; mt text; ast text;
BEGIN
  -- Managed control is enforced centrally when installed; legacy SQL remains compatible.
  IF to_regprocedure('seed_dispatch.guard_native_ingest(text,text)') IS NOT NULL THEN
    PERFORM seed_dispatch.guard_native_ingest('meta_ad_library',raw);
  END IF;
 IF octet_length(raw)>25000000 THEN RAISE EXCEPTION 'BATCH_TOO_LARGE'; END IF;
 b:=raw::jsonb;
 IF b->>'sourceKey' IS DISTINCT FROM 'meta_ad_library' OR b->>'platform' IS DISTINCT FROM 'META'
 OR b->>'version' IS DISTINCT FROM 'meta-service-dom-1' OR jsonb_typeof(b->'ads') IS DISTINCT FROM 'array'
 OR jsonb_typeof(b->'evidence') IS DISTINCT FROM 'array'
 OR (b#>>'{query,country}') IS NULL OR (b#>>'{query,country}') !~ '^[A-Z]{2}$'
 OR b->>'status' IS NULL OR b->>'status' NOT IN ('SUCCEEDED','PARTIAL','FAILED','NO_RESULTS') THEN RAISE EXCEPTION 'BATCH_INVALID'; END IF;
 n:=jsonb_array_length(b->'ads');IF n>20 THEN RAISE EXCEPTION 'BATCH_LIMIT'; END IF;
 observed:=(b->>'observedAt')::timestamp;IF observed IS NULL OR observed>now()+interval '1 day' THEN RAISE EXCEPTION 'TIME_INVALID';END IF;
 h:=encode(sha256(convert_to(raw,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('meta-service-source',0));
 SELECT id INTO rid FROM public."CollectionRun" WHERE "idempotencyKey"='meta-service:'||h;
 IF FOUND THEN RETURN jsonb_build_object('status','ALREADY_IMPORTED','runId',rid,'inserted',0,'updated',0) || (SELECT jsonb_build_object('originalInserted',"insertedCount",'originalUpdated',"updatedCount",'committedAt',to_char("finishedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM public."CollectionRun" WHERE id=rid);END IF;
 SELECT id INTO STRICT sid FROM public."DataSource" WHERE key='meta_ad_library';
 tid:=gen_random_uuid()::text;rid:=gen_random_uuid()::text;
 INSERT INTO public."CollectionTask"(id,"updatedAt","dataSourceId",name,query,status,"maxItems","maxAttempts")
 VALUES(tid,now(),sid,'Meta independent ecommerce discovery',b->'query','PAUSED',greatest(1,n),1);
 runstatus:=CASE WHEN b->>'status'='NO_RESULTS' THEN 'SUCCEEDED' ELSE b->>'status' END;
 INSERT INTO public."CollectionRun"(id,"updatedAt","taskId","dataSourceId","idempotencyKey","querySnapshot","adapterVersion",status,"startedAt","finishedAt",attempt,"fetchedCount","errorCode",coverage,"evidenceReference")
 VALUES(rid,now(),tid,sid,'meta-service:'||h,b->'query',b->>'version',runstatus,observed,now(),1,n,b->>'errorCode',coalesce(b->'coverage','{}')||'{"mode":"meta-background-service","completeSourceCoverage":false}'::jsonb,'local-private:meta/'||h||'/batch.json');
 -- Acquire the same ad/advertiser keys as application ingest, in sorted order.
 FOR p IN SELECT key FROM (
  SELECT sid||':'||(x->>'sourceAdId') AS key FROM jsonb_array_elements(b->'ads') x
  UNION SELECT 'advertiser:'||sid||':'||encode(sha256(convert_to(x->>'advertiserPageUrl','UTF8')),'hex') FROM jsonb_array_elements(b->'ads') x WHERE x->>'advertiserPageUrl' ~ '^https://(www\.|m\.)?facebook\.com/'
 ) keys ORDER BY key LOOP PERFORM pg_advisory_xact_lock(hashtextextended(p,0)); END LOOP;
 FOR a IN SELECT value FROM jsonb_array_elements(b->'ads') LOOP
  IF a->>'source' IS DISTINCT FROM 'meta' OR a->>'sourceAdId' IS NULL OR a->>'sourceAdId' !~ '^[0-9]{5,}$'
   OR a->>'sourceUrl' IS DISTINCT FROM 'https://www.facebook.com/ads/library/?id='||(a->>'sourceAdId')
   OR a->>'queryCountry' IS DISTINCT FROM b#>>'{query,country}'
   OR jsonb_typeof(a->'media') IS DISTINCT FROM 'array'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'evidence') e WHERE e->>'url' LIKE 'https://www.facebook.com/ads/library/%' AND (
    e->>'text' ~ ('(Library ID|资料库编号)[[:space:]]*[:：][[:space:]]*'||(a->>'sourceAdId')||'([^0-9]|$)')
    -- Adjacent DOM spans can merge the ID with a date digit in textContent.
    OR e->>'html' ~ ('(^|>)[[:space:]]*<span>[[:space:]]*(Library ID|资料库编号)[[:space:]]*[:：][[:space:]]*'||(a->>'sourceAdId')||'[[:space:]]*</span>')))
   THEN RAISE EXCEPTION 'AD_INVALID'; END IF;
  IF a->>'status' IS NULL OR a->>'status' NOT IN ('active','inactive','unknown') THEN RAISE EXCEPTION 'STATUS_INVALID';END IF;
  IF a->>'advertiserAvatarUrl' IS NOT NULL AND (jsonb_typeof(a->'advertiserAvatarUrl') IS DISTINCT FROM 'string' OR a->>'advertiserAvatarUrl' !~ '^https://([a-z0-9-]+\.)*(fbcdn\.net|facebook\.com|fbsbx\.com|cdninstagram\.com)/[^[:space:]]*$') THEN RAISE EXCEPTION 'ADVERTISER_LOGO_INVALID';END IF;
  IF jsonb_typeof(a->'platforms') NOT IN ('null','array') OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(a->'platforms')='array' THEN a->'platforms' ELSE '[]' END) x WHERE x NOT IN ('Facebook','Instagram','Messenger','Audience Network','Threads')) THEN RAISE EXCEPTION 'PLATFORMS_INVALID';END IF;
  -- Match the main ingest lock to serialize with operator/legacy imports.
  SELECT * INTO old FROM public."Ad" WHERE "dataSourceId"=sid AND "sourceAdId"=a->>'sourceAdId';
  SELECT jsonb_object_agg(key,jsonb_build_object('value',value,'source','meta-public-dom','parserVersion',b->>'version','observedAt',observed,'evidenceSha256',h)) INTO prov FROM jsonb_each(a);
  prov:=prov||jsonb_build_object('queryCountry',jsonb_build_object('value',a->>'queryCountry','meaning','query-filter','evidenceSha256',h));
  aggregate_prov:=prov;
  IF a->>'advertiserAvatarUrl' IS NULL THEN aggregate_prov:=aggregate_prov-'advertiserAvatarUrl';END IF;
  avid:=NULL;p:=a->>'advertiserPageUrl';
  IF p ~ '^https://(www\.|m\.)?facebook\.com/' THEN
   avkey:='page-url-sha256:'||encode(sha256(convert_to(p,'UTF8')),'hex');
   SELECT id INTO avid FROM public."Advertiser" WHERE "dataSourceId"=sid AND "sourceAdvertiserId"=avkey;
   IF avid IS NULL THEN
    avid:=gen_random_uuid()::text;
    INSERT INTO public."Advertiser"(id,"updatedAt","dataSourceId","sourceAdvertiserId",name,"sourceUrl","pageDomain","fieldProvenance") VALUES(avid,now(),sid,avkey,a->>'advertiserName',p,'facebook.com',jsonb_build_object('identifier',jsonb_build_object('kind','observed-page-url-hash','value',p),'name',prov->'advertiserName'));
   END IF;
   IF a->>'advertiserAvatarUrl' IS NOT NULL THEN
    UPDATE public."Advertiser" SET "updatedAt"=now(),"fieldProvenance"="fieldProvenance"||jsonb_build_object('avatarUrl',prov->'advertiserAvatarUrl') WHERE id=avid AND ("fieldProvenance"#>>'{avatarUrl,observedAt}' IS NULL OR ("fieldProvenance"#>>'{avatarUrl,observedAt}')::timestamp<=observed);
   END IF;
  END IF;
  SELECT CASE count(DISTINCT value->>'type') WHEN 0 THEN 'UNKNOWN' WHEN 1 THEN upper(min(value->>'type')) ELSE 'MIXED' END INTO mt FROM jsonb_array_elements(a->'media');ast:=upper(a->>'status');
  IF old.id IS NULL THEN
   aid:=gen_random_uuid()::text;inserted:=inserted+1;
   INSERT INTO public."Ad"(id,"updatedAt","dataSourceId","sourceAdId","advertiserId","sourceUrl",body,headline,cta,"landingPageUrl","publisherPlatforms","reportedCountries","mediaType","sourceStatus","statusObservedAt","sourceStartedAt","sourceEndedAt","firstObservedAt","lastObservedAt","fieldProvenance")
   VALUES(aid,now(),sid,a->>'sourceAdId',avid,a->>'sourceUrl',a->>'body',a->>'headline',a->>'cta',a->>'landingPageUrl',ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(a->'platforms')='array' THEN a->'platforms' ELSE '[]' END)),ARRAY[]::text[],mt,ast,observed,(a->>'startDate')::date,(a->>'endDate')::date,observed,observed,prov);
  ELSE
   aid:=old.id;updated:=updated+1;
   UPDATE public."Ad" SET "firstObservedAt"=least(coalesce("firstObservedAt",observed),observed) WHERE id=aid;
   IF old."lastObservedAt" IS NULL OR old."lastObservedAt"<=observed THEN
    UPDATE public."Ad" SET "updatedAt"=now(),"advertiserId"=coalesce(avid,"advertiserId"),body=a->>'body',headline=a->>'headline',cta=a->>'cta',"landingPageUrl"=a->>'landingPageUrl',"publisherPlatforms"=ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(a->'platforms')='array' THEN a->'platforms' ELSE '[]' END)),"lastObservedAt"=observed,"mediaType"=mt,"sourceStatus"=ast,"statusObservedAt"=observed,"sourceStartedAt"=(a->>'startDate')::date,"sourceEndedAt"=(a->>'endDate')::date,"fieldProvenance"="fieldProvenance"||aggregate_prov WHERE id=aid;
   END IF;
  END IF;
  oid:=gen_random_uuid()::text;
  INSERT INTO public."AdObservation"(id,"adId","dataSourceId","collectionRunId","observedAt","sourceStatus","queryCountry",snapshot,"fieldProvenance","evidenceReference","evidenceSha256","parserVersion")
   VALUES(oid,aid,sid,rid,observed,ast,b#>>'{query,country}',a,prov,'local-private:meta/'||h||'/batch.json',h,b->>'version');
  seq:=0;
  FOR m IN SELECT value FROM jsonb_array_elements(a->'media') LOOP
   IF m->>'type' IS NULL OR m->>'type' NOT IN ('image','video') OR m->>'url' IS NULL THEN RAISE EXCEPTION 'MEDIA_INVALID';END IF;
   -- Unknown hosts remain in raw evidence; never send them to the downloader.
   IF m->>'url' ~ '^https://([a-z0-9-]+\.)*(fbcdn\.net|facebook\.com|fbsbx\.com)/' THEN
    INSERT INTO public."MediaObject"(id,"updatedAt","adId","observationId","sourceUrl",type,status,"displayOrder") VALUES(gen_random_uuid()::text,now(),aid,oid,m->>'url',upper(m->>'type'),'PENDING',seq) ON CONFLICT ("adId","sourceUrl") DO NOTHING;
   END IF;seq:=seq+1;
  END LOOP;
  INSERT INTO public."RunItem"(id,"runId","dataSourceId","itemKey","sourceAdId","adId",status,"parserVersion","evidenceReference","evidenceSha256") VALUES(gen_random_uuid()::text,rid,sid,'meta:'||(a->>'sourceAdId'),a->>'sourceAdId',aid,CASE WHEN old.id IS NULL THEN 'INSERTED' ELSE 'UPDATED' END,b->>'version','local-private:meta/'||h||'/batch.json',h);
 END LOOP;
 UPDATE public."CollectionRun" SET "insertedCount"=inserted,"updatedCount"=updated WHERE id=rid;
 INSERT INTO public."AuditEvent"(id,action,"targetType","targetId",metadata) VALUES(gen_random_uuid()::text,'META_SERVICE_BATCH_IMPORTED','CollectionRun',rid,jsonb_build_object('count',n,'evidenceSha256',h));
 RETURN jsonb_build_object('status','IMPORTED','runId',rid,'inserted',inserted,'updated',updated) || (SELECT jsonb_build_object('originalInserted',"insertedCount",'originalUpdated',"updatedCount",'committedAt',to_char("finishedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM public."CollectionRun" WHERE id=rid);
END;
$$;
REVOKE ALL ON FUNCTION meta_collector.ingest(text) FROM PUBLIC;
GRANT CONNECT ON DATABASE ad_research_test TO meta_collector_runtime;
GRANT USAGE ON SCHEMA meta_collector TO meta_collector_runtime;
GRANT EXECUTE ON FUNCTION meta_collector.ingest(text) TO meta_collector_runtime;
COMMIT;
