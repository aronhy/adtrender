#!/usr/bin/env python3
"""Owner-only readback; never emits credentials, raw responses, cursors or signed media URLs."""
import json,subprocess,pathlib,datetime
query='''SELECT json_build_object(
'ads',(SELECT count(DISTINCT "adId") FROM "AdObservation" WHERE "parserVersion"='snapchat-service-public-1'),
'observations',(SELECT count(*) FROM "AdObservation" WHERE "parserVersion"='snapchat-service-public-1'),
'runs',(SELECT count(*) FROM "CollectionRun" WHERE "adapterVersion"='snapchat-service-public-1'),
'platforms',(SELECT json_agg(x) FROM (SELECT snapshot->>'publisherPlatform' AS platform,count(*) FROM "AdObservation" WHERE "parserVersion"='snapchat-service-public-1' GROUP BY 1) x),
'media',(SELECT json_agg(x) FROM (SELECT m.type,m.status,count(*) FROM "MediaObject" m WHERE EXISTS(SELECT 1 FROM "AdObservation" o WHERE o."adId"=m."adId" AND o."parserVersion"='snapchat-service-public-1') GROUP BY 1,2) x),
'countries',(SELECT json_agg(DISTINCT c) FROM "AdObservation" o CROSS JOIN LATERAL jsonb_array_elements_text(o.snapshot->'reportedCountries') c WHERE o."parserVersion"='snapchat-service-public-1'),
'latest',(SELECT json_agg(x) FROM (SELECT a."sourceAdId",o.snapshot->>'headline' AS headline,o.snapshot->>'advertiserName' AS publisher,o.snapshot->>'mediaType' AS format FROM "AdObservation" o JOIN "Ad" a ON a.id=o."adId" WHERE o."parserVersion"='snapchat-service-public-1' ORDER BY o."observedAt" DESC LIMIT 4) x)
);'''
r=subprocess.run(['docker','exec','-i','ds-meta-saas-test-database-1','psql','-X','-At','-v','ON_ERROR_STOP=1','-U','saas_migrator','-d','ad_research_test'],input=query,text=True,capture_output=True,check=True)
services={n:subprocess.run(['systemctl','is-active',n+'-collector.service'],text=True,capture_output=True).stdout.strip() for n in ['snapchat','google','meta','tiktok','pinterest']}
print(json.dumps({'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'services':services,'enabled':subprocess.run(['systemctl','is-enabled','snapchat-collector.service'],text=True,capture_output=True).stdout.strip(),'database':json.loads(r.stdout),'status':json.loads(pathlib.Path('/var/lib/snapchat-collector/evidence/status.json').read_text())},ensure_ascii=False))
