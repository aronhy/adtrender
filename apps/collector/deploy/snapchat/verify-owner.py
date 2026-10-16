#!/usr/bin/env python3
"""Owner-only regression; altered records are always rolled back, never persist as collected ads."""
import json,base64,subprocess,copy,datetime
b=json.load(open('/var/lib/snapchat-collector/evidence/probe.json'))
b['ads']=b['ads'][:1]
b['observedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
b['ads'][0]['body']='ROLLBACK_ONLY_BODY'
b['verification']='rollback-only'
a=copy.deepcopy(b)
a['observedAt']=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=1)).isoformat()
a['ads'][0]['body']=None
a['ads'][0]['mediaType']='UNKNOWN'
a['ads'][0]['sourceStatus']='UNKNOWN'
def literal(v):return "convert_from(decode('"+base64.b64encode(json.dumps(v).encode()).decode()+"','base64'),'UTF8')"
ad=b['ads'][0]['sourceAdId']
import re
if not re.fullmatch('[a-f0-9-]{36}',ad):raise RuntimeError('ID_INVALID')
sql=f'''BEGIN;
SELECT snapchat_collector.ingest({literal(b)});
SELECT snapchat_collector.ingest({literal(a)});
DO $check$ DECLARE c int; platforms text[]; body text; provenance text; observations int; state text; media text; BEGIN
 SELECT count(*) INTO c FROM public."Ad" WHERE "sourceAdId"='{ad}' AND "dataSourceId"=(SELECT id FROM public."DataSource" WHERE key='snapchat_ads_gallery');
 IF c<>1 THEN RAISE EXCEPTION 'DUPLICATE_CREATIVE';END IF;
 SELECT "publisherPlatforms",a.body,a."fieldProvenance"#>>'{{body,value}}',"sourceStatus","mediaType" INTO platforms,body,provenance,state,media FROM public."Ad" a WHERE "sourceAdId"='{ad}' AND "dataSourceId"=(SELECT id FROM public."DataSource" WHERE key='snapchat_ads_gallery');
 IF platforms IS DISTINCT FROM ARRAY['SNAPCHAT'] THEN RAISE EXCEPTION 'PLATFORM_LOST';END IF;
 IF body IS DISTINCT FROM 'ROLLBACK_ONLY_BODY' OR provenance IS DISTINCT FROM body THEN RAISE EXCEPTION 'SPARSE_PROVENANCE_LOST';END IF;
 IF state='UNKNOWN' OR media='UNKNOWN' THEN RAISE EXCEPTION 'KNOWN_FIELDS_LOST';END IF;
 SELECT count(*) INTO observations FROM public."AdObservation" o JOIN public."Ad" a ON a.id=o."adId" WHERE a."sourceAdId"='{ad}' AND o."parserVersion"='snapchat-service-public-1';
 IF observations<2 THEN RAISE EXCEPTION 'OBSERVATION_LOST';END IF;
 END $check$;
ROLLBACK;'''
subprocess.run(['docker','exec','-i','ds-meta-saas-test-database-1','psql','-X','-At','-v','ON_ERROR_STOP=1','-U','saas_migrator','-d','ad_research_test'],input=sql,text=True,check=True,stdout=subprocess.DEVNULL)
print(json.dumps({'dedupe':'PASS','platform':'PASS','sparseFieldProvenance':'PASS','knownStatusAndMedia':'PASS','separateObservations':'PASS','rolledBack':True}))
