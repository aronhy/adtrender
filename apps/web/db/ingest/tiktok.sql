-- Apply as deployment owner. No runtime table privileges are required.
BEGIN;
CREATE SCHEMA IF NOT EXISTS tiktok_collector;
REVOKE ALL ON SCHEMA tiktok_collector FROM PUBLIC;
CREATE OR REPLACE FUNCTION tiktok_collector.ingest(raw text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
DECLARE
 b jsonb; a jsonb; e jsonb; m jsonb; p text; h text; sid text; rid text; tid text;
 aid text; oid text; avid text; avkey text; prov jsonb; aggregate_prov jsonb; avprov jsonb;
 old public."Ad"%ROWTYPE; observed timestamp; batch_observed timestamp;
 n integer; inserted integer:=0; updated integer:=0; historical integer:=0;
 seq integer; runstatus text; mt text; evref text; candidate_observed text;
BEGIN
  -- Managed control is enforced centrally when installed; legacy SQL remains compatible.
  IF to_regprocedure('seed_dispatch.guard_native_ingest(text,text)') IS NOT NULL THEN
    PERFORM seed_dispatch.guard_native_ingest('tiktok_commercial_library',raw);
  END IF;
 IF raw IS NULL OR octet_length(raw)>25000000 THEN RAISE EXCEPTION 'BATCH_TOO_LARGE_OR_NULL'; END IF;
 b:=raw::jsonb;
 IF jsonb_typeof(b) IS DISTINCT FROM 'object'
  OR b->>'sourceKey' IS DISTINCT FROM 'tiktok_commercial_library'
  OR b->>'platform' IS DISTINCT FROM 'TIKTOK'
  OR b->>'version' IS DISTINCT FROM 'tiktok-public-dom-1'
  OR jsonb_typeof(b->'ads') IS DISTINCT FROM 'array'
  OR jsonb_typeof(b->'evidence') IS DISTINCT FROM 'array'
  OR jsonb_typeof(b->'completedIds') IS DISTINCT FROM 'array'
  OR jsonb_typeof(b->'query') IS DISTINCT FROM 'object'
  OR jsonb_typeof(b->'coverage') IS DISTINCT FROM 'object'
  OR jsonb_typeof(b->'observedAt') IS DISTINCT FROM 'string'
  OR jsonb_typeof(b->'status') IS DISTINCT FROM 'string'
  OR ((jsonb_typeof(b->'errorCode') IN ('null','string')) IS NOT TRUE)
  OR b->>'status' NOT IN ('SUCCEEDED','PARTIAL','FAILED','NO_RESULTS')
  OR jsonb_typeof(b#>'{query,country}') IS DISTINCT FROM 'string'
  OR b#>>'{query,country}' !~ '^[A-Z]{2}$'
  OR jsonb_typeof(b#>'{query,startDate}') IS DISTINCT FROM 'string'
  OR jsonb_typeof(b#>'{query,endDate}') IS DISTINCT FROM 'string'
  OR b#>>'{query,startDate}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  OR b#>>'{query,endDate}' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  OR b#>'{coverage,completeSourceCoverage}' IS DISTINCT FROM 'false'::jsonb
  OR jsonb_typeof(b#>'{coverage,exhausted}') IS DISTINCT FROM 'boolean'
  OR jsonb_typeof(b#>'{coverage,reason}') IS DISTINCT FROM 'string'
 THEN RAISE EXCEPTION 'BATCH_INVALID'; END IF;
 IF (b#>>'{query,startDate}')::date>(b#>>'{query,endDate}')::date THEN RAISE EXCEPTION 'DATE_RANGE_INVALID'; END IF;
 n:=jsonb_array_length(b->'ads');
 IF n>20 OR jsonb_array_length(b->'evidence')>100 OR jsonb_array_length(b->'completedIds')>20 THEN RAISE EXCEPTION 'BATCH_LIMIT'; END IF;
 IF b->>'status'='NO_RESULTS' AND n<>0 THEN RAISE EXCEPTION 'NO_RESULTS_WITH_ADS'; END IF;
 IF b->>'observedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RAISE EXCEPTION 'TIME_INVALID'; END IF;
 batch_observed:=(b->>'observedAt')::timestamptz AT TIME ZONE 'UTC';
 IF batch_observed>now()+interval '1 day' THEN RAISE EXCEPTION 'TIME_INVALID'; END IF;
 -- Validate every evidence envelope, including failed/empty runs. Raw content is
 -- retained in the private archive, never returned or copied into audit logs.
 FOR e IN SELECT value FROM jsonb_array_elements(b->'evidence') LOOP
  IF jsonb_typeof(e) IS DISTINCT FROM 'object'
   OR jsonb_typeof(e->'url') IS DISTINCT FROM 'string'
   OR e->>'url' !~ '^https://library\.tiktok\.com/ads([/?]|$)'
   OR jsonb_typeof(e->'kind') IS DISTINCT FROM 'string'
   OR e->>'kind' NOT IN ('listing','detail')
   OR jsonb_typeof(e->'text') IS DISTINCT FROM 'string'
   OR jsonb_typeof(e->'html') IS DISTINCT FROM 'string'
   OR jsonb_typeof(e->'observedAt') IS DISTINCT FROM 'string'
   OR e->>'observedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
   OR (jsonb_typeof(e->'httpStatus') IN ('number','null')) IS NOT TRUE
  THEN RAISE EXCEPTION 'EVIDENCE_INVALID'; END IF;
  IF jsonb_typeof(e->'httpStatus')='number' AND (e->>'httpStatus' !~ '^[1-5][0-9]{2}$') THEN RAISE EXCEPTION 'HTTP_STATUS_INVALID'; END IF;
  IF (e->>'observedAt')::timestamptz>now()+interval '1 day' THEN RAISE EXCEPTION 'TIME_INVALID'; END IF;
  IF e->>'kind'='detail' AND (jsonb_typeof(e->'adId') IS DISTINCT FROM 'string'
   OR e->>'adId' !~ '^[0-9]{5,40}$'
   OR e->>'url' IS DISTINCT FROM 'https://library.tiktok.com/ads/detail/?ad_id='||(e->>'adId')) THEN RAISE EXCEPTION 'DETAIL_EVIDENCE_INVALID'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(b->'completedIds') x WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR x#>>'{}' !~ '^[0-9]{5,40}$')
  OR (SELECT count(DISTINCT x#>>'{}') FROM jsonb_array_elements(b->'completedIds') x)<>jsonb_array_length(b->'completedIds')
 THEN RAISE EXCEPTION 'COMPLETED_IDS_INVALID'; END IF;
 FOR a IN SELECT value FROM jsonb_array_elements(b->'ads') LOOP
  IF jsonb_typeof(a) IS DISTINCT FROM 'object'
   OR jsonb_typeof(a->'sourceAdId') IS DISTINCT FROM 'string'
   OR a->>'sourceAdId' !~ '^[0-9]{5,40}$'
   OR a->>'sourceUrl' IS DISTINCT FROM 'https://library.tiktok.com/ads/detail/?ad_id='||(a->>'sourceAdId')
   OR jsonb_typeof(a->'media') IS DISTINCT FROM 'array'
   OR jsonb_typeof(a->'reportedCountries') IS DISTINCT FROM 'array'
   OR jsonb_typeof(a->'sourceFields') IS DISTINCT FROM 'object'
   OR jsonb_typeof(a->'observedAt') IS DISTINCT FROM 'string'
   OR a->>'observedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
   OR jsonb_typeof(a->'headline') IS DISTINCT FROM 'null'
  THEN RAISE EXCEPTION 'AD_INVALID'; END IF;
  FOREACH p IN ARRAY ARRAY['advertiserName','sourceAdvertiserId','body','cta','landingPageUrl','firstShown','lastShown'] LOOP
   IF (jsonb_typeof(a->p) IN ('null','string')) IS NOT TRUE THEN RAISE EXCEPTION 'AD_FIELD_TYPE_INVALID'; END IF;
  END LOOP;
  IF a->>'sourceAdvertiserId' IS NOT NULL AND a->>'sourceAdvertiserId' !~ '^[0-9]{1,40}$' THEN RAISE EXCEPTION 'ADVERTISER_ID_INVALID'; END IF;
  IF a->>'advertiserAvatarUrl' IS NOT NULL AND (jsonb_typeof(a->'advertiserAvatarUrl') IS DISTINCT FROM 'string' OR a->>'advertiserAvatarUrl' !~ '^https://([a-z0-9-]+\.)*tiktokcdn(-(us|eu))?\.com/[^[:space:]]*$') THEN RAISE EXCEPTION 'ADVERTISER_LOGO_INVALID';END IF;
  IF a->>'landingPageUrl' IS NOT NULL AND a->>'landingPageUrl' !~ '^https?://[^[:space:]/@]+(/[^[:space:]]*)?$' THEN RAISE EXCEPTION 'LANDING_URL_INVALID'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each(a->'sourceFields') f WHERE jsonb_typeof(f.value) IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'SOURCE_FIELDS_INVALID'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(a->'reportedCountries') c WHERE jsonb_typeof(c) IS DISTINCT FROM 'string' OR c#>>'{}' !~ '^[A-Z]{2}$') THEN RAISE EXCEPTION 'COUNTRIES_INVALID'; END IF;
  IF (a->>'observedAt')::timestamptz>now()+interval '1 day' THEN RAISE EXCEPTION 'TIME_INVALID'; END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'evidence') ev WHERE ev->>'kind'='detail'
   AND ev->>'url'=a->>'sourceUrl' AND ev->>'adId'=a->>'sourceAdId' AND ev->'httpStatus'='200'::jsonb
   AND ev->>'observedAt'=a->>'observedAt'
   AND ev->>'text' ~* ('Ad[[:space:]]+ID[[:space:]:：]*'||(a->>'sourceAdId')||'([^0-9]|$)'))
  THEN RAISE EXCEPTION 'DETAIL_PROOF_REQUIRED'; END IF;
  IF jsonb_array_length(a->'media')>40 THEN RAISE EXCEPTION 'MEDIA_LIMIT'; END IF;
  FOR m IN SELECT value FROM jsonb_array_elements(a->'media') LOOP
   IF jsonb_typeof(m) IS DISTINCT FROM 'object' OR jsonb_typeof(m->'type') IS DISTINCT FROM 'string'
    OR m->>'type' NOT IN ('IMAGE','VIDEO') OR jsonb_typeof(m->'url') IS DISTINCT FROM 'string'
    OR m->>'url' !~ '^https://[^[:space:]/@]+/[^[:space:]]*$'
   THEN RAISE EXCEPTION 'MEDIA_INVALID'; END IF;
  END LOOP;
 END LOOP;
 IF (SELECT count(DISTINCT item->>'sourceAdId') FROM jsonb_array_elements(b->'ads') item)<>n
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(b->'ads') item WHERE NOT (b->'completedIds') ? (item->>'sourceAdId'))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(b->'completedIds') c WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'ads') item WHERE item->>'sourceAdId'=c))
 THEN RAISE EXCEPTION 'AD_IDS_INVALID'; END IF;
 h:=encode(sha256(convert_to(raw,'UTF8')),'hex');
 evref:='local-private:tiktok/'||h||'/batch.json';
 PERFORM pg_advisory_xact_lock(hashtextextended('tiktok-service-source',0));
 SELECT id INTO rid FROM public."CollectionRun" WHERE "idempotencyKey"='tiktok-service:'||h;
 IF FOUND THEN RETURN jsonb_build_object('status','ALREADY_IMPORTED','runId',rid,'inserted',0,'updated',0,'historical',0) || (SELECT jsonb_build_object('originalInserted',"insertedCount",'originalUpdated',"updatedCount",'committedAt',to_char("finishedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM public."CollectionRun" WHERE id=rid); END IF;
 SELECT id INTO STRICT sid FROM public."DataSource" WHERE key='tiktok_commercial_library';
 tid:=gen_random_uuid()::text; rid:=gen_random_uuid()::text;
 INSERT INTO public."CollectionTask"(id,"updatedAt","dataSourceId",name,query,status,"maxItems","maxAttempts")
 VALUES(tid,now(),sid,'TikTok public commercial library discovery',b->'query','PAUSED',greatest(1,n),1);
 runstatus:=CASE WHEN b->>'status'='NO_RESULTS' THEN 'SUCCEEDED' ELSE b->>'status' END;
 INSERT INTO public."CollectionRun"(id,"updatedAt","taskId","dataSourceId","idempotencyKey","querySnapshot","adapterVersion",status,"startedAt","finishedAt",attempt,"fetchedCount","errorCode",coverage,"evidenceReference")
 VALUES(rid,now(),tid,sid,'tiktok-service:'||h,b->'query',b->>'version',runstatus,batch_observed,now(),1,n,b->>'errorCode',b->'coverage'||jsonb_build_object('mode','tiktok-background-service','completeSourceCoverage',false,'batchStatus',b->>'status'),evref);
 -- Match application per-ad / per-advertiser locks and acquire in stable order.
 FOR p IN SELECT key FROM (
  SELECT sid||':'||(x->>'sourceAdId') AS key FROM jsonb_array_elements(b->'ads') x
  UNION SELECT 'advertiser:'||sid||':'||coalesce(x->>'sourceAdvertiserId','ad-local:'||(x->>'sourceAdId')) FROM jsonb_array_elements(b->'ads') x
 ) keys ORDER BY key LOOP PERFORM pg_advisory_xact_lock(hashtextextended(p,0)); END LOOP;
 FOR a IN SELECT value FROM jsonb_array_elements(b->'ads') LOOP
  observed:=(a->>'observedAt')::timestamptz AT TIME ZONE 'UTC';
  SELECT * INTO old FROM public."Ad" WHERE "dataSourceId"=sid AND "sourceAdId"=a->>'sourceAdId';
  SELECT jsonb_object_agg(key,jsonb_build_object('value',value,'source','tiktok-public-dom','parserVersion',b->>'version','observedAt',a->>'observedAt','evidenceSha256',h)) INTO prov FROM jsonb_each(a);
  prov:=prov||jsonb_build_object('queryCountry',jsonb_build_object('value',b#>>'{query,country}','meaning',CASE WHEN b#>>'{coverage,reason}'='MEDIA_REFRESH_DETAIL' THEN 'original-discovery-context' ELSE 'query-filter' END,'evidenceSha256',h),'sourceStatus',jsonb_build_object('value','UNKNOWN','meaning','not-disclosed'),'shownDatesMeaning','Source first/last shown labels; not campaign start/end dates');
  aggregate_prov:=prov;
  IF a->>'advertiserAvatarUrl' IS NULL THEN aggregate_prov:=aggregate_prov-'advertiserAvatarUrl';END IF;
  avid:=NULL;
  IF a->>'advertiserName' IS NOT NULL OR a->>'sourceAdvertiserId' IS NOT NULL THEN
   avkey:=coalesce(a->>'sourceAdvertiserId','ad-local:'||(a->>'sourceAdId'));
   avprov:=jsonb_build_object('identifier',jsonb_build_object('kind',CASE WHEN a->>'sourceAdvertiserId' IS NULL THEN 'source-ad-local' ELSE 'source-advertiser-id' END,'value',avkey),'name',prov->'advertiserName','observedAt',a->>'observedAt');
   SELECT id INTO avid FROM public."Advertiser" WHERE "dataSourceId"=sid AND "sourceAdvertiserId"=avkey;
   IF avid IS NULL THEN
    avid:=gen_random_uuid()::text;
    INSERT INTO public."Advertiser"(id,"updatedAt","dataSourceId","sourceAdvertiserId",name,"fieldProvenance") VALUES(avid,now(),sid,avkey,a->>'advertiserName',avprov);
   ELSE
    SELECT "fieldProvenance"->>'observedAt' INTO candidate_observed FROM public."Advertiser" WHERE id=avid;
    IF candidate_observed IS NULL OR candidate_observed::timestamptz<=observed AT TIME ZONE 'UTC' THEN
     UPDATE public."Advertiser" SET "updatedAt"=now(),name=a->>'advertiserName',"fieldProvenance"="fieldProvenance"||avprov WHERE id=avid;
    END IF;
   END IF;
   IF a->>'advertiserAvatarUrl' IS NOT NULL THEN
    UPDATE public."Advertiser" SET "updatedAt"=now(),"fieldProvenance"="fieldProvenance"||jsonb_build_object('avatarUrl',prov->'advertiserAvatarUrl') WHERE id=avid AND ("fieldProvenance"#>>'{avatarUrl,observedAt}' IS NULL OR ("fieldProvenance"#>>'{avatarUrl,observedAt}')::timestamptz<=observed AT TIME ZONE 'UTC');
   END IF;
  END IF;
  SELECT CASE count(DISTINCT value->>'type') WHEN 0 THEN 'UNKNOWN' WHEN 1 THEN min(value->>'type') ELSE 'MIXED' END INTO mt FROM jsonb_array_elements(a->'media');
  IF old.id IS NULL THEN
   aid:=gen_random_uuid()::text; inserted:=inserted+1;
   INSERT INTO public."Ad"(id,"updatedAt","dataSourceId","sourceAdId","advertiserId","sourceUrl",body,headline,cta,"landingPageUrl","publisherPlatforms","reportedCountries","mediaType","sourceStatus","statusObservedAt","sourceStartedAt","sourceEndedAt","firstObservedAt","lastObservedAt","fieldProvenance")
   VALUES(aid,now(),sid,a->>'sourceAdId',avid,a->>'sourceUrl',a->>'body',NULL,a->>'cta',a->>'landingPageUrl',ARRAY['TIKTOK'],ARRAY(SELECT jsonb_array_elements_text(a->'reportedCountries')),mt,'UNKNOWN',observed,NULL,NULL,observed,observed,prov);
  ELSE
   aid:=old.id;
   UPDATE public."Ad" SET "firstObservedAt"=least(coalesce("firstObservedAt",observed),observed) WHERE id=aid;
   IF old."lastObservedAt" IS NULL OR old."lastObservedAt"<=observed THEN
    updated:=updated+1;
    UPDATE public."Ad" SET "updatedAt"=now(),"advertiserId"=avid,"sourceUrl"=a->>'sourceUrl',body=a->>'body',headline=NULL,cta=a->>'cta',"landingPageUrl"=a->>'landingPageUrl',"publisherPlatforms"=ARRAY['TIKTOK'],"reportedCountries"=ARRAY(SELECT jsonb_array_elements_text(a->'reportedCountries')),"lastObservedAt"=observed,"mediaType"=mt,"sourceStatus"='UNKNOWN',"statusObservedAt"=observed,"sourceStartedAt"=NULL,"sourceEndedAt"=NULL,"fieldProvenance"="fieldProvenance"||aggregate_prov WHERE id=aid;
   ELSE historical:=historical+1;
   END IF;
  END IF;
  oid:=gen_random_uuid()::text;
  INSERT INTO public."AdObservation"(id,"adId","dataSourceId","collectionRunId","observedAt","sourceStatus","queryCountry",snapshot,"fieldProvenance","evidenceReference","evidenceSha256","parserVersion")
  VALUES(oid,aid,sid,rid,observed,'UNKNOWN',b#>>'{query,country}',a,prov,evref,h,b->>'version');
  seq:=0;
  FOR m IN SELECT value FROM jsonb_array_elements(a->'media') LOOP
   INSERT INTO public."MediaObject"(id,"updatedAt","adId","observationId","sourceUrl",type,status,"errorCode","displayOrder")
   VALUES(gen_random_uuid()::text,now(),aid,oid,m->>'url',m->>'type','UNAVAILABLE','PLATFORM_MEDIA_ADAPTER_PENDING',seq) ON CONFLICT ("adId","sourceUrl") DO NOTHING;
   seq:=seq+1;
  END LOOP;
  INSERT INTO public."RunItem"(id,"runId","dataSourceId","itemKey","sourceAdId","adId",status,"parserVersion","evidenceReference","evidenceSha256")
  VALUES(gen_random_uuid()::text,rid,sid,'tiktok:'||(a->>'sourceAdId'),a->>'sourceAdId',aid,CASE WHEN old.id IS NULL THEN 'INSERTED' WHEN old."lastObservedAt" IS NULL OR old."lastObservedAt"<=observed THEN 'UPDATED' ELSE 'INGESTED' END,b->>'version',evref,h);
 END LOOP;
 UPDATE public."CollectionRun" SET "insertedCount"=inserted,"updatedCount"=updated WHERE id=rid;
 INSERT INTO public."AuditEvent"(id,action,"targetType","targetId",metadata)
 VALUES(gen_random_uuid()::text,'TIKTOK_SERVICE_BATCH_IMPORTED','CollectionRun',rid,jsonb_build_object('count',n,'historicalCount',historical,'evidenceSha256',h));
 RETURN jsonb_build_object('status','IMPORTED','runId',rid,'inserted',inserted,'updated',updated,'historical',historical) || (SELECT jsonb_build_object('originalInserted',"insertedCount",'originalUpdated',"updatedCount",'committedAt',to_char("finishedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM public."CollectionRun" WHERE id=rid);
END;
$$;
REVOKE ALL ON FUNCTION tiktok_collector.ingest(text) FROM PUBLIC;
-- Read only the fixed source's failed video identities. No media URL, credential,
-- arbitrary filter or table access is exposed to the collector runtime.
CREATE OR REPLACE FUNCTION tiktok_collector.media_refresh_candidates(requested integer DEFAULT 2) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC' AS $$
BEGIN
 IF requested IS NULL OR requested<1 OR requested>2 THEN RAISE EXCEPTION 'MEDIA_REFRESH_LIMIT'; END IF;
 RETURN (
  SELECT coalesce(jsonb_agg(to_jsonb(candidate)),'[]'::jsonb) FROM (
   SELECT a."sourceAdId" AS "sourceAdId",latest.country AS country,latest.start_date AS "startDate",latest.end_date AS "endDate"
   FROM public."Ad" a JOIN public."DataSource" source ON source.id=a."dataSourceId"
   CROSS JOIN LATERAL (SELECT o."queryCountry" AS country,r."querySnapshot"->>'startDate' AS start_date,r."querySnapshot"->>'endDate' AS end_date
    FROM public."AdObservation" o JOIN public."CollectionRun" r ON r.id=o."collectionRunId" WHERE o."adId"=a.id AND o."dataSourceId"=source.id AND o."parserVersion"='tiktok-public-dom-1' ORDER BY o."observedAt" DESC,o.id DESC LIMIT 1) latest
   WHERE source.key='tiktok_commercial_library' AND a."sourceAdId" ~ '^[0-9]{5,40}$'
    AND a."sourceUrl"='https://library.tiktok.com/ads/detail/?ad_id='||a."sourceAdId"
    AND latest.country ~ '^[A-Z]{2}$' AND latest.start_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND latest.end_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND latest.start_date<latest.end_date
    AND EXISTS(SELECT 1 FROM public."MediaObject" m WHERE m."adId"=a.id AND m."storageKey" IS NULL AND m.status='FAILED' AND m."errorCode" IN ('MEDIA_HTTP_FAILED','MEDIA_TIMEOUT','MEDIA_NETWORK_FAILED','MEDIA_EXPIRED')
     AND (m.type='VIDEO' AND m."sourceUrl" ~ '^https://library\.tiktok\.com/api/v1/cdn/' OR m.type='IMAGE' AND m."sourceUrl" ~ '^https://p16-common-sign\.tiktokcdn\.com/(tos-useast2a-i-photomode-euttp|tos-no1a-i-photomode-no|ad-site-i18n-sg|tos-alisg-i-photomode-sg|tos-no1a-i-t5fjg24jzw-no)/[a-f0-9]{32}~tplv-tiktokx-origin[.]jpeg([?][^[:space:]]*)?$')
     AND NOT EXISTS(SELECT 1 FROM public."MediaObject" sibling WHERE sibling."adId"=a.id AND sibling.type=m.type
      AND (sibling.type='VIDEO' AND sibling."sourceUrl" ~ '^https://library\.tiktok\.com/api/v1/cdn/' OR sibling.type='IMAGE' AND sibling."sourceUrl" ~ '^https://p16-common-sign\.tiktokcdn\.com/(tos-useast2a-i-photomode-euttp|tos-no1a-i-photomode-no|ad-site-i18n-sg|tos-alisg-i-photomode-sg|tos-no1a-i-t5fjg24jzw-no)/[a-f0-9]{32}~tplv-tiktokx-origin[.]jpeg([?][^[:space:]]*)?$')
      AND (m.type='VIDEO' OR split_part(sibling."sourceUrl",'?',1)=split_part(m."sourceUrl",'?',1))
      AND (sibling."storageKey" IS NOT NULL OR sibling.status IN ('READY','CACHED','PENDING') OR sibling.status='UNAVAILABLE' AND sibling."errorCode"='PLATFORM_MEDIA_ADAPTER_PENDING')))
    AND NOT EXISTS(SELECT 1 FROM public."AdObservation" o JOIN public."CollectionRun" r ON r.id=o."collectionRunId" WHERE o."adId"=a.id AND r.coverage->>'reason'='MEDIA_REFRESH_DETAIL' AND o."observedAt">now()-interval '6 hours')
   ORDER BY a."lastObservedAt" NULLS FIRST,a.id LIMIT requested
  ) candidate
 );
END;
$$;
REVOKE ALL ON FUNCTION tiktok_collector.media_refresh_candidates(integer) FROM PUBLIC;
GRANT CONNECT ON DATABASE ad_research_test TO tiktok_collector_runtime;
GRANT USAGE ON SCHEMA tiktok_collector TO tiktok_collector_runtime;
GRANT EXECUTE ON FUNCTION tiktok_collector.ingest(text) TO tiktok_collector_runtime;
GRANT EXECUTE ON FUNCTION tiktok_collector.media_refresh_candidates(integer) TO tiktok_collector_runtime;
COMMIT;
