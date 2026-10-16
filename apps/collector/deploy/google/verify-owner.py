#!/usr/bin/env python3
"""Owner-only rollback test of cross-platform dedupe and sparse-field provenance.
Synthetic variants stay inside a transaction that always rolls back.
"""
import json,base64,subprocess,copy
b=json.load(open('/var/lib/google-collector/evidence/search.json'))
b['ads']=b['ads'][:1]
b['ads'][0]['body']='ROLLBACK_ONLY_SOURCE_BODY'
b['verification']='rollback-only'
a=copy.deepcopy(b)
a['query']['kind']='YOUTUBE'
a['ads'][0]['publisherPlatform']='YOUTUBE'
a['ads'][0]['body']=None
for e in a['evidence']:
 if e['kind']=='listing':
  e['url']=e['url'].replace('platform=SEARCH','platform=YOUTUBE')
  e['html']=e['html'].replace('Platform filter button: selected Google Search','Platform filter button: selected YouTube')
def literal(v):return "convert_from(decode('"+base64.b64encode(json.dumps(v).encode()).decode()+"','base64'),'UTF8')"
ad=b['ads'][0]['sourceAdId']
if not ad.startswith('CR') or not ad[2:].isdigit():raise RuntimeError('ID_INVALID')
sql=f'''BEGIN;
SELECT google_collector.ingest({literal(b)});
SELECT google_collector.ingest({literal(a)});
DO $check$ DECLARE c int; platforms text[]; body text; provenance text; observations int; BEGIN
 SELECT count(*) INTO c FROM public."Ad" WHERE "sourceAdId"='{ad}' AND "dataSourceId"=(SELECT id FROM public."DataSource" WHERE key='google_ads_transparency');
 IF c<>1 THEN RAISE EXCEPTION 'DUPLICATE_CREATIVE';END IF;
 SELECT "publisherPlatforms",a.body,a."fieldProvenance"#>>'{{body,value}}' INTO platforms,body,provenance FROM public."Ad" a WHERE "sourceAdId"='{ad}' AND "dataSourceId"=(SELECT id FROM public."DataSource" WHERE key='google_ads_transparency');
 IF NOT (platforms @> ARRAY['SEARCH','YOUTUBE']) THEN RAISE EXCEPTION 'PLATFORM_LOST';END IF;
 IF body IS DISTINCT FROM 'ROLLBACK_ONLY_SOURCE_BODY' OR provenance IS DISTINCT FROM body THEN RAISE EXCEPTION 'SPARSE_PROVENANCE_LOST';END IF;
 SELECT count(*) INTO observations FROM public."AdObservation" o JOIN public."Ad" a ON a.id=o."adId" WHERE a."sourceAdId"='{ad}' AND o."parserVersion"='google-service-dom-1';
 IF observations<2 THEN RAISE EXCEPTION 'OBSERVATION_LOST';END IF;
 END $check$;
ROLLBACK;'''
subprocess.run(['docker','exec','-i','ds-meta-saas-test-database-1','psql','-X','-At','-v','ON_ERROR_STOP=1','-U','saas_migrator','-d','ad_research_test'],input=sql,text=True,check=True,stdout=subprocess.DEVNULL)
print(json.dumps({'crossPlatformDedupe':'PASS','platformUnion':'PASS','sparseFieldProvenance':'PASS','separateObservations':'PASS','rolledBack':True}))
