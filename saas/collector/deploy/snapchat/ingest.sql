BEGIN;
CREATE SCHEMA IF NOT EXISTS snapchat_collector;
REVOKE ALL ON SCHEMA snapchat_collector FROM PUBLIC;
CREATE OR REPLACE FUNCTION snapchat_collector.ingest(raw text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b jsonb; a jsonb; m jsonb; h text; sid text; rid text; tid text; aid text; oid text; old public."Ad"%ROWTYPE;
observed timestamp; n int; inserted int:=0; updated int:=0; seq int; prov jsonb; aggregate_prov jsonb; p text;
BEGIN
  -- Managed control is enforced centrally when installed; legacy SQL remains compatible.
  IF to_regprocedure('seed_dispatch.guard_native_ingest(text,text)') IS NOT NULL THEN
    PERFORM seed_dispatch.guard_native_ingest('snapchat_ads_gallery',raw);
  END IF;
 IF octet_length(raw)>25000000 THEN RAISE EXCEPTION 'BATCH_TOO_LARGE'; END IF;
 b:=raw::jsonb;
 IF b->>'sourceKey' IS DISTINCT FROM 'snapchat_ads_gallery' OR b->>'version' IS DISTINCT FROM 'snapchat-service-public-1'
 OR jsonb_typeof(b->'ads') IS DISTINCT FROM 'array' OR jsonb_typeof(b->'evidence') IS DISTINCT FROM 'array'
 OR coalesce(length(b#>>'{query,publisher}'),0) NOT BETWEEN 1 AND 200
 OR b#>>'{query,country}' IS NULL OR b#>>'{query,country}' NOT IN ('ALL','AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','TR')
 OR b->>'status' IS NULL OR b->>'status' NOT IN ('SUCCEEDED','PARTIAL','FAILED','NO_RESULTS') THEN RAISE EXCEPTION 'BATCH_INVALID'; END IF;
 n:=jsonb_array_length(b->'ads');IF n>20 THEN RAISE EXCEPTION 'BATCH_LIMIT';END IF;
 observed:=(b->>'observedAt')::timestamp;IF observed IS NULL OR observed>now()+interval '1 day' THEN RAISE EXCEPTION 'TIME_INVALID';END IF;
 h:=encode(sha256(convert_to(raw,'UTF8')),'hex');PERFORM pg_advisory_xact_lock(hashtextextended('snapchat-service-source',0));
 SELECT id INTO rid FROM public."CollectionRun" WHERE "idempotencyKey"='snapchat-service:'||h;
 IF FOUND THEN RETURN jsonb_build_object('status','ALREADY_IMPORTED','runId',rid,'inserted',0,'updated',0) || (SELECT jsonb_build_object('originalInserted',"insertedCount",'originalUpdated',"updatedCount",'committedAt',to_char("finishedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM public."CollectionRun" WHERE id=rid);END IF;
 SELECT id INTO STRICT sid FROM public."DataSource" WHERE key='snapchat_ads_gallery';
 tid:=gen_random_uuid()::text;rid:=gen_random_uuid()::text;
 INSERT INTO public."CollectionTask"(id,"updatedAt","dataSourceId",name,query,status,"maxItems","maxAttempts") VALUES(tid,now(),sid,'Snapchat independent publisher watch',b->'query','PAUSED',greatest(1,n),1);
 INSERT INTO public."CollectionRun"(id,"updatedAt","taskId","dataSourceId","idempotencyKey","querySnapshot","adapterVersion",status,"startedAt","finishedAt",attempt,"fetchedCount","errorCode",coverage,"evidenceReference")
 VALUES(rid,now(),tid,sid,'snapchat-service:'||h,b->'query',b->>'version',CASE WHEN b->>'status'='NO_RESULTS' THEN 'SUCCEEDED' ELSE b->>'status' END,observed,now(),1,n,b->>'errorCode',coalesce(b->'coverage','{}')||jsonb_build_object('mode','snapchat-background-service','completeSourceCoverage',false),'local-private:snapchat/'||h||'/batch.json');
 FOR p IN SELECT DISTINCT sid||':'||(x->>'sourceAdId') FROM jsonb_array_elements(b->'ads') x ORDER BY 1 LOOP PERFORM pg_advisory_xact_lock(hashtextextended(p,0));END LOOP;
 FOR a IN SELECT value FROM jsonb_array_elements(b->'ads') LOOP
 IF a->>'sourceAdId' IS NULL OR a->>'sourceAdId' !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR a->>'sourceUrl' IS DISTINCT FROM 'https://adsgallery.snap.com/?adId='||(a->>'sourceAdId')
 OR a->>'publisherPlatform' IS DISTINCT FROM 'SNAPCHAT' OR a->>'sourceStatus' IS NULL OR a->>'sourceStatus' NOT IN ('ACTIVE','INACTIVE','UNKNOWN')
 OR a->>'queryCountry' IS DISTINCT FROM nullif(b#>>'{query,country}','ALL')
 OR a->>'mediaType' IS NULL OR a->>'mediaType' NOT IN ('IMAGE','VIDEO','UNKNOWN')
 OR jsonb_typeof(a->'reportedCountries') IS DISTINCT FROM 'array' OR jsonb_typeof(a->'media') IS DISTINCT FROM 'array'
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(a->'reportedCountries') c WHERE c !~ '^[A-Z]{2}$')
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'evidence') e WHERE e->>'kind'='public-response' AND e->>'url' LIKE 'https://adsapi.snapchat.com/v1/ads_library/%' AND e->>'url'='https://adsapi.snapchat.com/v1/ads_library/ads/'||(a->>'sourceAdId') AND e#>>'{raw,request_status}'='SUCCESS' AND e#>'{raw,ad_preview}'=a->'raw' AND e#>>'{raw,ad_preview,id}'=a->>'sourceAdId' AND e->>'status'='200')
 OR (NOT (coalesce(b#>>'{query,historyKind}','')='HISTORY_RECHECK' AND b#>>'{query,targetSourceAdId}' IS NOT DISTINCT FROM a->>'sourceAdId' AND EXISTS(SELECT 1 FROM public."Ad" existing WHERE existing."dataSourceId"=sid AND existing."sourceAdId"=a->>'sourceAdId' AND existing."sourceUrl"=a->>'sourceUrl')) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'evidence') e CROSS JOIN LATERAL jsonb_array_elements(e#>'{raw,ad_previews}') item WHERE e->>'url' LIKE 'https://adsapi.snapchat.com/v1/ads_library/ads/search?%' AND e#>>'{request,paying_advertiser_name}'=b#>>'{query,publisher}' AND e#>'{request,countries}'=CASE WHEN b#>>'{query,country}'='ALL' THEN '[]'::jsonb ELSE jsonb_build_array(CASE WHEN b#>>'{query,country}'='GR' THEN 'el' ELSE lower(b#>>'{query,country}') END) END AND item#>>'{ad_preview,id}'=a->>'sourceAdId' AND item->>'sub_request_status'='SUCCESS' AND e#>>'{raw,request_status}'='SUCCESS' AND e->>'status'='200'))
 THEN RAISE EXCEPTION 'AD_EVIDENCE_INVALID';END IF;
 IF a->>'advertiserAvatarUrl' IS NOT NULL AND (jsonb_typeof(a->'advertiserAvatarUrl') IS DISTINCT FROM 'string' OR a->>'advertiserAvatarUrl' !~ '^https://([a-z0-9-]+\.)*sc-cdn\.net/[^[:space:]]*$' OR a->>'advertiserAvatarUrl' IS DISTINCT FROM a#>>'{raw,profile_logo_url}') THEN RAISE EXCEPTION 'ADVERTISER_LOGO_INVALID';END IF;
 SELECT jsonb_object_agg(key,jsonb_build_object('value',value,'source','snapchat-public-gallery','parserVersion',b->>'version','observedAt',observed,'evidenceSha256',h)) INTO prov FROM jsonb_each(a) WHERE key NOT IN ('raw','media');
 prov:=prov||jsonb_build_object('queryCountry',jsonb_build_object('value',a->'queryCountry','meaning','query-filter-not-delivery-proof','evidenceSha256',h),'advertiserIdentity',jsonb_build_object('meaning','publisher-name-not-stable-advertiser-id','evidenceSha256',h));
 -- Pending older batches already contain the authoritative source logo in raw.
 IF a->>'advertiserAvatarUrl' IS NULL AND a#>>'{raw,profile_logo_url}' ~ '^https://([a-z0-9-]+\.)*sc-cdn\.net/[^[:space:]]*$' THEN
  prov:=prov||jsonb_build_object('advertiserAvatarUrl',jsonb_build_object('value',a#>>'{raw,profile_logo_url}','source','snapchat-public-gallery','sourceField','profile_logo_url','parserVersion',b->>'version','observedAt',observed,'evidenceSha256',h));
 END IF;
 SELECT * INTO old FROM public."Ad" WHERE "dataSourceId"=sid AND "sourceAdId"=a->>'sourceAdId';
 IF old.id IS NULL THEN
 aid:=gen_random_uuid()::text;inserted:=inserted+1;
 INSERT INTO public."Ad"(id,"updatedAt","dataSourceId","sourceAdId","sourceUrl",body,headline,cta,"landingPageUrl","publisherPlatforms","reportedCountries","mediaType","sourceStatus","statusObservedAt","sourceStartedAt","sourceEndedAt","firstObservedAt","lastObservedAt","fieldProvenance")
 VALUES(aid,now(),sid,a->>'sourceAdId',a->>'sourceUrl',a->>'body',a->>'headline',a->>'cta',a->>'landingPageUrl',ARRAY['SNAPCHAT'],ARRAY(SELECT jsonb_array_elements_text(a->'reportedCountries')),a->>'mediaType',a->>'sourceStatus',observed,(a->>'sourceStartedAt')::timestamp,(a->>'sourceEndedAt')::timestamp,observed,observed,prov);
 ELSE
 aid:=old.id;updated:=updated+1;
 UPDATE public."Ad" SET "firstObservedAt"=least(coalesce("firstObservedAt",observed),observed) WHERE id=aid;
 IF old."lastObservedAt" IS NULL OR old."lastObservedAt"<=observed THEN
 aggregate_prov:=prov;
 IF aggregate_prov#>>'{advertiserAvatarUrl,value}' IS NULL THEN aggregate_prov:=aggregate_prov-'advertiserAvatarUrl';END IF;
 FOR p IN SELECT unnest(ARRAY['body','headline','cta','landingPageUrl','sourceStartedAt','sourceEndedAt']) LOOP IF a->>p IS NULL THEN aggregate_prov:=aggregate_prov-p;END IF;END LOOP;
 IF a->>'sourceStatus'='UNKNOWN' THEN aggregate_prov:=aggregate_prov-'sourceStatus';END IF;
 IF a->>'mediaType'='UNKNOWN' THEN aggregate_prov:=aggregate_prov-'mediaType';END IF;
 aggregate_prov:=jsonb_set(aggregate_prov,'{reportedCountries}',jsonb_build_object('value',ARRAY(SELECT DISTINCT x FROM unnest(old."reportedCountries"||ARRAY(SELECT jsonb_array_elements_text(a->'reportedCountries'))) x ORDER BY x),'meaning','union-over-observations','evidenceSha256',h,'previousEvidenceSha256',old."fieldProvenance"#>>'{reportedCountries,evidenceSha256}'));
 UPDATE public."Ad" SET "updatedAt"=now(),"sourceUrl"=a->>'sourceUrl',body=coalesce(a->>'body',body),headline=coalesce(a->>'headline',headline),cta=coalesce(a->>'cta',cta),"landingPageUrl"=coalesce(a->>'landingPageUrl',"landingPageUrl"),"reportedCountries"=ARRAY(SELECT DISTINCT x FROM unnest("reportedCountries"||ARRAY(SELECT jsonb_array_elements_text(a->'reportedCountries'))) x ORDER BY x),"sourceStatus"=CASE WHEN a->>'sourceStatus'='UNKNOWN' THEN "sourceStatus" ELSE a->>'sourceStatus' END,"statusObservedAt"=CASE WHEN a->>'sourceStatus'='UNKNOWN' THEN "statusObservedAt" ELSE observed END,"sourceStartedAt"=coalesce((a->>'sourceStartedAt')::timestamp,"sourceStartedAt"),"sourceEndedAt"=coalesce((a->>'sourceEndedAt')::timestamp,"sourceEndedAt"),"lastObservedAt"=observed,"mediaType"=CASE WHEN a->>'mediaType'='UNKNOWN' THEN "mediaType" ELSE a->>'mediaType' END,"fieldProvenance"="fieldProvenance"||aggregate_prov WHERE id=aid;
 END IF;END IF;
 oid:=gen_random_uuid()::text;
 INSERT INTO public."AdObservation"(id,"adId","dataSourceId","collectionRunId","observedAt","sourceStatus","queryCountry",snapshot,"fieldProvenance","evidenceReference","evidenceSha256","parserVersion") VALUES(oid,aid,sid,rid,observed,a->>'sourceStatus',nullif(b#>>'{query,country}','ALL'),a,prov,'local-private:snapchat/'||h||'/batch.json',h,b->>'version');
 seq:=0;
 FOR m IN SELECT value FROM jsonb_array_elements(a->'media') LOOP
 IF m->>'type' IS NULL OR m->>'type' NOT IN ('image','video') OR m->>'url' IS NULL OR m->>'url' !~ '^https://([a-z0-9-]+\.)*sc-cdn\.net/' THEN RAISE EXCEPTION 'MEDIA_INVALID';END IF;
 INSERT INTO public."MediaObject"(id,"updatedAt","adId","observationId","sourceUrl",type,status,"errorCode","displayOrder") VALUES(gen_random_uuid()::text,now(),aid,oid,m->>'url',upper(m->>'type'),'UNAVAILABLE','PLATFORM_MEDIA_ADAPTER_PENDING',seq) ON CONFLICT ("adId","sourceUrl") DO NOTHING;seq:=seq+1;
 END LOOP;
 INSERT INTO public."RunItem"(id,"runId","dataSourceId","itemKey","sourceAdId","adId",status,"parserVersion","evidenceReference","evidenceSha256") VALUES(gen_random_uuid()::text,rid,sid,'snapchat:'||(a->>'sourceAdId'),a->>'sourceAdId',aid,CASE WHEN old.id IS NULL THEN 'INSERTED' ELSE 'UPDATED' END,b->>'version','local-private:snapchat/'||h||'/batch.json',h);
 END LOOP;
 UPDATE public."CollectionRun" SET "insertedCount"=inserted,"updatedCount"=updated WHERE id=rid;
 INSERT INTO public."AuditEvent"(id,action,"targetType","targetId",metadata) VALUES(gen_random_uuid()::text,'SNAPCHAT_SERVICE_BATCH_IMPORTED','CollectionRun',rid,jsonb_build_object('count',n,'evidenceSha256',h));
 RETURN jsonb_build_object('status','IMPORTED','runId',rid,'inserted',inserted,'updated',updated) || (SELECT jsonb_build_object('originalInserted',"insertedCount",'originalUpdated',"updatedCount",'committedAt',to_char("finishedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM public."CollectionRun" WHERE id=rid);
END;
$$;
REVOKE ALL ON FUNCTION snapchat_collector.ingest(text) FROM PUBLIC;
GRANT CONNECT ON DATABASE ad_research_test TO snapchat_collector_runtime;
GRANT USAGE ON SCHEMA snapchat_collector TO snapchat_collector_runtime;
GRANT EXECUTE ON FUNCTION snapchat_collector.ingest(text) TO snapchat_collector_runtime;
COMMIT;
