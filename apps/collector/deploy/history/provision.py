#!/usr/bin/env python3
"""Run as deployment owner; never prints generated credentials or env contents."""
import subprocess,secrets,os,pathlib
psql=['docker','exec','-i','ds-meta-saas-test-database-1','psql','-X','-At','-v','ON_ERROR_STOP=1','-U','saas_migrator','-d','ad_research_test']
def sql(s):return subprocess.check_output(psql,input=s,text=True).strip()
path=pathlib.Path('/etc/history-collector.env')
exists=sql("SELECT count(*) FROM pg_roles WHERE rolname='history_collector_runtime';")=='1'
if not exists:
 password=secrets.token_urlsafe(36)
 sql("CREATE ROLE history_collector_runtime LOGIN PASSWORD '"+password+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 2; ALTER ROLE history_collector_runtime SET statement_timeout='60s'; ALTER ROLE history_collector_runtime SET idle_in_transaction_session_timeout='60s';")
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f:f.write('DATABASE_URL=postgresql://history_collector_runtime:'+password+'@database:5432/ad_research_test?schema=public\nHISTORY_STATE_DIR=/data\n')
elif not path.exists():raise RuntimeError('ROLE_EXISTS_WITHOUT_CONFIG')
sql("GRANT CONNECT ON DATABASE ad_research_test TO history_collector_runtime;")
# Native ingest owner privileges are used inside finish(); runtime never gets them.
for schema in ['meta','google','tiktok','pinterest','snapchat']:
 if sql("SELECT to_regprocedure('"+schema+"_collector.ingest(text)') IS NOT NULL;")!='t':raise RuntimeError('NATIVE_INGEST_MISSING_'+schema.upper())
print(sql(pathlib.Path('/opt/history-collector/code/schema.sql').read_text()))
runtime=pathlib.Path('/etc/history-collector-runtime.env')
image=os.environ.get('HISTORY_IMAGE') or (runtime.read_text().strip().split('=',1)[1] if runtime.exists() else subprocess.check_output(['docker','inspect','tiktok-collector','--format','{{.Image}}'],text=True).strip())
if not image.startswith('sha256:') or len(image)!=71:raise RuntimeError('IMMUTABLE_IMAGE_REQUIRED')
fd=os.open(runtime,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:f.write('HISTORY_IMAGE='+image+'\n')
print('history_role_and_functions_ready')
