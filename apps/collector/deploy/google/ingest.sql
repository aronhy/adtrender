-- Schema owner deploys; runtime can only invoke this constrained importer.
BEGIN;
CREATE SCHEMA IF NOT EXISTS google_collector;
REVOKE ALL ON SCHEMA google_collector FROM PUBLIC;
CREATE OR REPLACE FUNCTION google_collector.ingest(raw text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE b jsonb; a jsonb; m jsonb; av jsonb; h text; sid text; rid text; tid text; aid text; oid text; avid text;
old public."Ad"%ROWTYPE; observed timestamp; n int; inserted int:=0; updated int:=0; seq int; runstatus text; prov jsonb; aggregate_prov jsonb; p text;
BEGIN
  -- Managed control is enforced centrally when installed; legacy SQL remains compatible.
  IF to_regprocedure('seed_dispatch.guard_native_ingest(text,text)') IS NOT NULL THEN
    PERFORM seed_dispatch.guard_native_ingest('google_ads_transparency',raw);
  END IF;
 IF octet_length(raw)>25000000 THEN RAISE EXCEPTION 'BATCH_TOO_LARGE';END IF;
 b:=raw::jsonb;
 IF b->>'sourceKey' IS DISTINCT FROM 'google_ads_transparency' OR b->>'version' IS DISTINCT FROM 'google-service-dom-1'
 OR jsonb_typeof(b->'ads') IS DISTINCT FROM 'array' OR jsonb_typeof(b->'advertisers') IS DISTINCT FROM 'array'
 OR jsonb_typeof(b->'evidence') IS DISTINCT FROM 'array' OR b#>>'{query,country}' IS NULL OR b#>>'{query,country}' !~ '^[A-Z]{2}$'
 OR b#>>'{query,kind}' IS NULL OR b#>>'{query,kind}' NOT IN ('DISCOVER','SEARCH','YOUTUBE','SERP')
 OR b->>'status' IS NULL OR b->>'status' NOT IN ('SUCCEEDED','PARTIAL','FAILED','NO_RESULTS') THEN RAISE EXCEPTION 'BATCH_INVALID';END IF;
 n:=jsonb_array_length(b->'ads');IF n>20 OR jsonb_array_length(b->'advertisers')>20 THEN RAISE EXCEPTION 'BATCH_LIMIT';END IF;
 IF n>0 AND b#>>'{query,kind}' NOT IN ('SEARCH','YOUTUBE') THEN RAISE EXCEPTION 'STABLE_CREATIVE_REQUIRED';END IF;
 observed:=(b->>'observedAt')::timestamp;IF observed IS NULL OR observed>now()+interval '1 day' THEN RAISE EXCEPTION 'TIME_INVALID';END IF;
 h:=encode(sha256(convert_to(raw,'UTF8')),'hex');PERFORM pg_advisory_xact_lock(hashtextextended('google-service-source',0));
 SELECT id INTO rid FROM public."CollectionRun" WHERE "idempotencyKey"='google-service:'||h;
 IF FOUND THEN RETURN jsonb_build_object('status','ALREADY_IMPORTED','runId',rid,'inserted',0,'updated',0) || (SELECT jsonb_build_object('originalInserted',"insertedCount",'originalUpdated',"updatedCount",'committedAt',to_char("finishedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM public."CollectionRun" WHERE id=rid);END IF;
 SELECT id INTO STRICT sid FROM public."DataSource" WHERE key='google_ads_transparency';
 tid:=gen_random_uuid()::text;rid:=gen_random_uuid()::text;
 INSERT INTO public."CollectionTask"(id,"updatedAt","dataSourceId",name,query,status,"maxItems","maxAttempts") VALUES(tid,now(),sid,'Google independent '||(b#>>'{query,kind}'),b->'query','PAUSED',greatest(1,n),1);
 runstatus:=CASE WHEN b->>'status'='NO_RESULTS' THEN 'SUCCEEDED' ELSE b->>'status' END;
 INSERT INTO public."CollectionRun"(id,"updatedAt","taskId","dataSourceId","idempotencyKey","querySnapshot","adapterVersion",status,"startedAt","finishedAt",attempt,"fetchedCount","errorCode",coverage,"evidenceReference")
 VALUES(rid,now(),tid,sid,'google-service:'||h,b->'query',b->>'version',runstatus,observed,now(),1,n,b->>'errorCode',coalesce(b->'coverage','{}')||jsonb_build_object('mode','google-background-service','completeSourceCoverage',false,'advertisersDiscovered',jsonb_array_length(b->'advertisers')),'local-private:google/'||h||'/batch.json');
 FOR p IN SELECT key FROM (
 SELECT sid||':'||(x->>'sourceAdId') AS key FROM jsonb_array_elements(b->'ads') x
 UNION SELECT 'advertiser:'||sid||':'||(x->>'advertiserId') FROM jsonb_array_elements((b->'ads')||(b->'advertisers')) x
 UNION SELECT 'advertiser:'||sid||':'||encode(sha256(convert_to('https://adstransparency.google.com/advertiser/'||(x->>'advertiserId'),'UTF8')),'hex') FROM jsonb_array_elements((b->'ads')||(b->'advertisers')) x
 ) keys ORDER BY key LOOP PERFORM pg_advisory_xact_lock(hashtextextended(p,0));END LOOP;
 -- Persist discovered advertiser identities even before a creative has been fetched.
 FOR av IN SELECT value FROM jsonb_array_elements(b->'advertisers') LOOP
 IF av->>'advertiserId' IS NULL OR av->>'advertiserId' !~ '^AR[0-9]{5,}$'
 OR av->>'sourceUrl' IS DISTINCT FROM 'https://adstransparency.google.com/advertiser/'||(av->>'advertiserId')
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'evidence') e WHERE e->>'kind'='advertiser' AND split_part(e->>'url','?',1)=av->>'sourceUrl') THEN RAISE EXCEPTION 'ADVERTISER_EVIDENCE_REQUIRED';END IF;
 INSERT INTO public."Advertiser"(id,"updatedAt","dataSourceId","sourceAdvertiserId",name,"sourceUrl","fieldProvenance")
 VALUES(gen_random_uuid()::text,now(),sid,av->>'advertiserId',av->>'name',av->>'sourceUrl',jsonb_build_object('method','google-public-discovery','observedAt',observed,'evidenceSha256',h))
 ON CONFLICT ("dataSourceId","sourceAdvertiserId") DO NOTHING;
 END LOOP;
 FOR a IN SELECT value FROM jsonb_array_elements(b->'ads') LOOP
 IF a->>'sourceAdId' IS NULL OR a->>'sourceAdId' !~ '^CR[0-9]{5,}$' OR a->>'advertiserId' IS NULL OR a->>'advertiserId' !~ '^AR[0-9]{5,}$'
 OR a->>'sourceUrl' IS DISTINCT FROM 'https://adstransparency.google.com/advertiser/'||(a->>'advertiserId')||'/creative/'||(a->>'sourceAdId')
 OR a->>'queryCountry' IS DISTINCT FROM b#>>'{query,country}' OR a->>'publisherPlatform' IS DISTINCT FROM b#>>'{query,kind}'
 OR a->>'sourceStatus' IS DISTINCT FROM 'UNKNOWN' OR a->>'mediaType' IS NULL OR a->>'mediaType' NOT IN ('TEXT','IMAGE','VIDEO','UNKNOWN')
 OR jsonb_typeof(a->'media') IS DISTINCT FROM 'array' OR a->'reportedCountries' IS DISTINCT FROM '[]'::jsonb
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'evidence') e WHERE e->>'kind'='detail' AND e->>'adId'=a->>'sourceAdId' AND split_part(e->>'url','?',1)=a->>'sourceUrl' AND length(e->>'html')>0)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b->'evidence') e WHERE e->>'kind'='listing' AND e->>'platformVerified'='true' AND e->>'url' LIKE 'https://adstransparency.google.com/%'
 AND e->>'url' ~ ('[?&]platform='||(a->>'publisherPlatform')||'(&|$)') AND position(a->>'sourceAdId' in e->>'html')>0
 AND position('Platform filter button: selected '||CASE WHEN a->>'publisherPlatform'='SEARCH' THEN 'Google Search' ELSE 'YouTube' END in e->>'html')>0) THEN RAISE EXCEPTION 'AD_EVIDENCE_INVALID';END IF;
 SELECT jsonb_object_agg(key,jsonb_build_object('value',value,'source','google-public-creative','parserVersion',b->>'version','observedAt',observed,'evidenceSha256',h)) INTO prov FROM jsonb_each(a) WHERE key NOT IN ('variants','media');
 prov:=prov||jsonb_build_object('queryCountry',jsonb_build_object('value',a->>'queryCountry','meaning','query-filter','evidenceSha256',h),'sourceLastShown',jsonb_build_object('value',a->>'sourceLastShown','meaning','last-shown-not-end-date','evidenceSha256',h));
 INSERT INTO public."Advertiser"(id,"updatedAt","dataSourceId","sourceAdvertiserId",name,"sourceUrl","fieldProvenance")
 VALUES(gen_random_uuid()::text,now(),sid,a->>'advertiserId',a->>'advertiserName','https://adstransparency.google.com/advertiser/'||(a->>'advertiserId'),jsonb_build_object('evidenceSha256',h,'name',prov->'advertiserName'))
 ON CONFLICT ("dataSourceId","sourceAdvertiserId") DO NOTHING;
 SELECT id INTO STRICT avid FROM public."Advertiser" WHERE "dataSourceId"=sid AND "sourceAdvertiserId"=a->>'advertiserId';
 SELECT * INTO old FROM public."Ad" WHERE "dataSourceId"=sid AND "sourceAdId"=a->>'sourceAdId';
 IF old.id IS NULL THEN
 aid:=gen_random_uuid()::text;inserted:=inserted+1;
 INSERT INTO public."Ad"(id,"updatedAt","dataSourceId","sourceAdId","advertiserId","sourceUrl",body,headline,cta,"landingPageUrl","publisherPlatforms","reportedCountries","mediaType","sourceStatus","statusObservedAt","firstObservedAt","lastObservedAt","fieldProvenance")
 VALUES(aid,now(),sid,a->>'sourceAdId',avid,a->>'sourceUrl',a->>'body',a->>'headline',a->>'cta',a->>'landingPageUrl',ARRAY[a->>'publisherPlatform'],ARRAY[]::text[],a->>'mediaType','UNKNOWN',observed,observed,observed,prov);
 ELSE
 aid:=old.id;updated:=updated+1;
 UPDATE public."Ad" SET "firstObservedAt"=least(coalesce("firstObservedAt",observed),observed),"publisherPlatforms"=ARRAY(SELECT DISTINCT x FROM unnest("publisherPlatforms"||ARRAY[a->>'publisherPlatform']) x ORDER BY x) WHERE id=aid;
 IF old."lastObservedAt" IS NULL OR old."lastObservedAt"<=observed THEN
 aggregate_prov:=prov;
 FOR p IN SELECT unnest(ARRAY['body','headline','cta','landingPageUrl']) LOOP
 IF a->>p IS NULL THEN aggregate_prov:=aggregate_prov-p;END IF;
 END LOOP;
 UPDATE public."Ad" SET "updatedAt"=now(),"advertiserId"=avid,"sourceUrl"=a->>'sourceUrl',body=coalesce(a->>'body',body),headline=coalesce(a->>'headline',headline),cta=coalesce(a->>'cta',cta),"landingPageUrl"=coalesce(a->>'landingPageUrl',"landingPageUrl"),"lastObservedAt"=observed,"mediaType"=CASE WHEN a->>'mediaType'='UNKNOWN' THEN "mediaType" ELSE a->>'mediaType' END,"fieldProvenance"="fieldProvenance"||aggregate_prov WHERE id=aid;
 END IF;END IF;
 oid:=gen_random_uuid()::text;
 INSERT INTO public."AdObservation"(id,"adId","dataSourceId","collectionRunId","observedAt","sourceStatus","queryCountry",snapshot,"fieldProvenance","evidenceReference","evidenceSha256","parserVersion")
 VALUES(oid,aid,sid,rid,observed,'UNKNOWN',b#>>'{query,country}',a,prov,'local-private:google/'||h||'/batch.json',h,b->>'version');
 seq:=0;
 FOR m IN SELECT value FROM jsonb_array_elements(a->'media') LOOP
 IF m->>'type' IS NULL OR m->>'type' NOT IN ('image','video') OR m->>'url' IS NULL
 OR m->>'url' !~ '^https://(tpc\.googlesyndication\.com|([a-z0-9-]+\.)*(ytimg\.com|googleusercontent\.com|ggpht\.com|gstatic\.com|googlevideo\.com))/' THEN RAISE EXCEPTION 'MEDIA_INVALID';END IF;
 INSERT INTO public."MediaObject"(id,"updatedAt","adId","observationId","sourceUrl",type,status,"errorCode","displayOrder")
 VALUES(gen_random_uuid()::text,now(),aid,oid,m->>'url',upper(m->>'type'),'UNAVAILABLE','PLATFORM_MEDIA_ADAPTER_PENDING',seq) ON CONFLICT ("adId","sourceUrl") DO NOTHING;seq:=seq+1;
 END LOOP;
 INSERT INTO public."RunItem"(id,"runId","dataSourceId","itemKey","sourceAdId","adId",status,"parserVersion","evidenceReference","evidenceSha256") VALUES(gen_random_uuid()::text,rid,sid,'google:'||(a->>'sourceAdId'),a->>'sourceAdId',aid,CASE WHEN old.id IS NULL THEN 'INSERTED' ELSE 'UPDATED' END,b->>'version','local-private:google/'||h||'/batch.json',h);
 END LOOP;
 UPDATE public."CollectionRun" SET "insertedCount"=inserted,"updatedCount"=updated WHERE id=rid;
 INSERT INTO public."AuditEvent"(id,action,"targetType","targetId",metadata) VALUES(gen_random_uuid()::text,'GOOGLE_SERVICE_BATCH_IMPORTED','CollectionRun',rid,jsonb_build_object('count',n,'evidenceSha256',h));
 RETURN jsonb_build_object('status','IMPORTED','runId',rid,'inserted',inserted,'updated',updated) || (SELECT jsonb_build_object('originalInserted',"insertedCount",'originalUpdated',"updatedCount",'committedAt',to_char("finishedAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) FROM public."CollectionRun" WHERE id=rid);
END;
$$;
REVOKE ALL ON FUNCTION google_collector.ingest(text) FROM PUBLIC;
GRANT CONNECT ON DATABASE ad_research_test TO google_collector_runtime;
GRANT USAGE ON SCHEMA google_collector TO google_collector_runtime;
GRANT EXECUTE ON FUNCTION google_collector.ingest(text) TO google_collector_runtime;
COMMIT;
