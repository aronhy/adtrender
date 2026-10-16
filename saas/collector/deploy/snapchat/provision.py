#!/usr/bin/env python3
"""Run on the deployment host as owner. Never prints generated credentials."""
import subprocess,secrets,os,pathlib
psql=['docker','exec','-i','ds-meta-saas-test-database-1','psql','-X','-At','-v','ON_ERROR_STOP=1','-U','saas_migrator','-d','ad_research_test']
def sql(s):return subprocess.check_output(psql,input=s,text=True).strip()
path=pathlib.Path('/etc/snapchat-collector.env')
exists=sql("SELECT count(*) FROM pg_roles WHERE rolname='snapchat_collector_runtime';")=='1'
if not exists:
 password=secrets.token_urlsafe(36)
 sql("CREATE ROLE snapchat_collector_runtime LOGIN PASSWORD '"+password+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 3; ALTER ROLE snapchat_collector_runtime SET statement_timeout='30s'; ALTER ROLE snapchat_collector_runtime SET idle_in_transaction_session_timeout='60s';")
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f:f.write('DATABASE_URL=postgresql://snapchat_collector_runtime:'+password+'@database:5432/ad_research_test?schema=public\nSNAPCHAT_STATE_DIR=/data\n')
elif not path.exists():raise RuntimeError('ROLE_EXISTS_WITHOUT_CONFIG')
print(sql(pathlib.Path('/opt/snapchat-collector/code/ingest.sql').read_text()))
runtime=pathlib.Path('/etc/snapchat-collector-runtime.env')
image=os.environ.get('SNAPCHAT_IMAGE') or (runtime.read_text().strip().split('=',1)[1] if runtime.exists() else subprocess.check_output(['docker','inspect','pinterest-collector','--format','{{.Image}}'],text=True).strip())
if not image.startswith('sha256:') or len(image)!=71:raise RuntimeError('IMMUTABLE_IMAGE_REQUIRED')
fd=os.open('/etc/snapchat-collector-runtime.env',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:f.write('SNAPCHAT_IMAGE='+image+'\n')
print('runtime_role_and_function_ready')
