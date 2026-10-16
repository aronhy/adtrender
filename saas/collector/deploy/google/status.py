#!/usr/bin/env python3
"""Owner-only operational readback. Emits counts and public job metadata, no credentials/media URLs."""
import json,subprocess,pathlib,datetime
query='''SELECT json_build_object(
'ads',(SELECT count(DISTINCT o."adId") FROM "AdObservation" o WHERE o."parserVersion"='google-service-dom-1'),
'observations',(SELECT count(*) FROM "AdObservation" WHERE "parserVersion"='google-service-dom-1'),
'runs',(SELECT count(*) FROM "CollectionRun" WHERE "adapterVersion"='google-service-dom-1'),
'inserted',(SELECT coalesce(sum("insertedCount"),0) FROM "CollectionRun" WHERE "adapterVersion"='google-service-dom-1'),
'updated',(SELECT coalesce(sum("updatedCount"),0) FROM "CollectionRun" WHERE "adapterVersion"='google-service-dom-1'),
'discoveredAdvertisers',(SELECT count(*) FROM "Advertiser" WHERE "fieldProvenance"->>'method'='google-public-discovery'),
'platforms',(SELECT coalesce(json_agg(x),'[]') FROM (SELECT o.snapshot->>'publisherPlatform' AS platform,count(DISTINCT o."adId") AS ads FROM "AdObservation" o WHERE o."parserVersion"='google-service-dom-1' GROUP BY 1) x),
'countries',(SELECT coalesce(json_agg(DISTINCT "querySnapshot"->>'country'),'[]') FROM "CollectionRun" WHERE "adapterVersion"='google-service-dom-1' AND status IN ('SUCCEEDED','PARTIAL')),
'media',(SELECT coalesce(json_agg(x),'[]') FROM (SELECT m.type,m.status,count(*) FROM "MediaObject" m WHERE EXISTS(SELECT 1 FROM "AdObservation" o WHERE o."adId"=m."adId" AND o."parserVersion"='google-service-dom-1') GROUP BY 1,2) x),
'badPlayerBodies',(SELECT count(*) FROM "AdObservation" WHERE "parserVersion"='google-service-dom-1' AND snapshot->>'body' ~ '^(Visit advertiser|Sponsored)[[:space:]]*$'),
'latest',(SELECT coalesce(json_agg(x),'[]') FROM (SELECT "sourceAdId",snapshot->>'publisherPlatform' AS platform,snapshot->>'mediaType' AS format,jsonb_array_length(coalesce(snapshot->'variants','[]')) AS variants,jsonb_array_length(coalesce(snapshot->'videoReferences','[]')) AS video_references FROM "AdObservation" o JOIN "Ad" a ON a.id=o."adId" WHERE o."parserVersion"='google-service-dom-1' ORDER BY o."observedAt" DESC LIMIT 8) x)
);'''
r=subprocess.run(['docker','exec','-i','ds-meta-saas-test-database-1','psql','-X','-At','-v','ON_ERROR_STOP=1','-U','saas_migrator','-d','ad_research_test'],input=query,text=True,capture_output=True,check=True)
state=json.loads(pathlib.Path('/var/lib/google-collector/evidence/status.json').read_text())
services={n:subprocess.run(['systemctl','is-active',n+'-collector.service'],text=True,capture_output=True).stdout.strip() for n in ['google','meta','pinterest']}
print(json.dumps({'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'services':services,'enabled':subprocess.run(['systemctl','is-enabled','google-collector.service'],text=True,capture_output=True).stdout.strip(),'database':json.loads(r.stdout),'status':state},ensure_ascii=False))
