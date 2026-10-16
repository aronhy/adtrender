#!/usr/bin/env python3
import datetime,fcntl,hashlib,json,os,pathlib,re,shutil,subprocess,sys,tarfile,time,urllib.error,urllib.request
P=pathlib.Path; ROOT=P('/opt/ad-research-test'); WEB=P('/www/wwwroot/adtrender'); CONFIG=P('/etc/ad-research-test'); SITE=P('/www/server/panel/vhost/nginx/adtrender.com.conf'); ORIGIN='https://adtrender.com'; API='ds-meta-saas-test-api-1'; WORKER='ds-meta-saas-test-worker-1'; DB='ds-meta-saas-test-database-1'
mode,raw=sys.argv[1:]; plan=json.loads(raw); version=plan['version']; assert re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}',version)
release=ROOT/'releases'/version; webrelease=WEB/'releases'/version; backup=ROOT/'backups'/('history-'+version); image='ad-research-saas-test:'+version
sha=lambda b:hashlib.sha256(b).hexdigest()
now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
def fail(m):raise RuntimeError(m)
def run(args,**kwargs):return subprocess.run(args,check=True,**kwargs)
def text(args):return subprocess.check_output(args,text=True).strip()
def write_json(p,obj):p.write_text(json.dumps(obj,indent=2)+'\n');p.chmod(0o600)
def app():return str((ROOT/'current').resolve(strict=True))
def web():return str((WEB/'current').resolve(strict=True))
def containers():
 ids=text(['docker','ps','-aq']).split()
 fmt='{{.Id}} {{.Name}} {{.Image}} {{.State.StartedAt}} {{.State.Status}}'
 return sorted(text(['docker','inspect','--format',fmt,*ids]).splitlines()) if ids else []
def unaffected(items):return [x for x in items if not any('/'+name+' ' in x for name in [API,WORKER])]
def snapshot():
 files={name:sha((CONFIG/name).read_bytes()) for name in ['app.env','release.env','ds-meta-worker-runtime.yml','seccomp_profile.json']}
 other=[(p.name,sha(p.read_bytes())) for p in sorted(SITE.parent.glob('*.conf')) if p!=SITE and p.is_file()]
 return {'app':app(),'web':web(),'configSHA256':files,'nginxSHA256':sha(SITE.read_bytes()),'otherVhostsSHA256':sha(json.dumps(other).encode()),'containers':containers()}
def baseline():
 state=snapshot()
 if state['app']!=plan['expectedApp'] or state['web']!=plan['expectedWeb']:fail('LIVE_POINTER_DRIFT: rebuild/reconcile before publishing')
 if 'baseline' in plan and state!=plan['baseline']:fail('LIVE_RUNTIME_OR_CONFIGURATION_DRIFT: refresh reviewed plan; do not overwrite')
 return state
def atomic_bytes(path,data,mode=0o600):
 tmp=path.with_name(path.name+'.history-new')
 if tmp.exists():fail('Pending configuration file exists')
 with tmp.open('xb') as f:f.write(data)
 tmp.chmod(mode);os.replace(tmp,path)
def link(path,target):
 tmp=path.with_name(path.name+'.history-new')
 if tmp.exists() or tmp.is_symlink():fail('Pending release pointer exists')
 tmp.symlink_to(target);os.replace(tmp,path)
def env_set(data,key,value,expected=None):
 s=data.decode(); pattern=re.compile(r'^'+re.escape(key)+r'=([^\r\n]*)$',re.M); matches=pattern.findall(s)
 if len(matches)>1 or (expected is not None and matches!=[expected]):fail('Environment baseline key mismatch: '+key)
 s=pattern.sub(key+'='+value,s) if matches else s.rstrip('\n')+'\n'+key+'='+value+'\n'
 return s.encode()
def migrations(directory):
 folder=directory/'app/.wasp/out/db/migrations'
 return [{'name':p.parent.name,'checksum':sha(p.read_bytes())} for p in sorted(folder.glob('*/migration.sql'))]
def sql(query,database='ad_research_test',readonly=True):
 if readonly:query='BEGIN READ ONLY; '+query+'; COMMIT;'
 output=text(['docker','exec',DB,'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-U','saas_migrator','-d',database,'-c',query])
 return {'t':True,'f':False}[output] if output in ['t','f'] else json.loads(output) if output else None
def db_migrations(database='ad_research_test'):
 return sql("SELECT COALESCE(json_agg(x ORDER BY x.name),'[]'::json) FROM (SELECT migration_name AS name,checksum FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) x",database)
def inspect_schema():
 before=baseline()
 old=migrations(P(plan['expectedApp']));database=db_migrations()
 unfinished=sql('SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL')
 if baseline()!=before:fail('LIVE_RUNTIME_OR_CONFIGURATION_DRIFT during schema inspection')
 return {'baseline':before,'oldMigrations':old,'databaseMigrations':database,'unfinishedMigrations':unfinished}

def verify_release():
 manifest=release/'release-manifest.json'; m=json.loads(manifest.read_text())
 if sha(json.dumps(m['files'],separators=(',',':'),ensure_ascii=False).encode())!=m['artifactHash']:fail('Artifact inventory hash mismatch')
 if m['sourceCommit']!=plan['sourceCommit'] or m['workingTreeDirty'] is not False or m['releaseId']!=version or m['artifactHash']!=plan['artifactHash'] or m['publicApiUrl']!=ORIGIN:fail('Release provenance mismatch')
 expected={entry['path']:entry for entry in m['files']}
 if len(expected)!=len(m['files']):fail('Duplicate artifact inventory')
 actual=set()
 for path in release.rglob('*'):
  if path.is_symlink():fail('Artifact symlink rejected')
  if path.is_file():actual.add(str(path.relative_to(release)))
  elif not path.is_dir():fail('Artifact special file rejected')
 if actual!=set(expected)|{'release-manifest.json'}:fail('Artifact inventory mismatch')
 for name,entry in expected.items():
  rel=P(name); path=release/rel
  if rel.is_absolute() or '..' in rel.parts or not path.resolve().is_relative_to(release.resolve()):fail('Unsafe artifact path')
  if sha(path.read_bytes())!=entry['sha256'] or path.stat().st_size!=entry['sizeBytes']:fail('Artifact checksum mismatch')
 return m
def verify_staged():
 path=backup/'staged.json'
 if path.is_symlink() or not path.is_file():fail('Staged image proof missing or unsafe')
 staged=json.loads(path.read_bytes())
 if staged.get('status')!='STAGED_NOT_ACTIVE' or staged.get('version')!=version or not re.fullmatch(r'sha256:[0-9a-f]{64}',staged.get('imageId','')):fail('Staged image proof invalid')
 if staged['imageId']!=text(['docker','image','inspect','--format','{{.Id}}',image]) or staged.get('manifestSHA256')!=sha((release/'release-manifest.json').read_bytes()):fail('Staged image or manifest drift')
 return staged

def check_migrations(allow_applied=False):
 old=migrations(P(plan['expectedApp'])); new=migrations(release)
 applied=[next((e for e in new if e['name']==name),None) for name in plan['alreadyAppliedMigrationNames']]
 pending=[next((e for e in new if e['name']==name),None) for name in plan['migrationNames']]
 if any(e is None for e in applied+pending) or new!=old+applied+pending:fail('Expected exactly the reviewed migration layout')
 baseline_db=old+applied
 if db_migrations()!=(new if allow_applied else baseline_db):fail('Database migration checksums drift' if allow_applied else 'Database migration baseline drift')
 if sql('SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL')!=0:fail('Unfinished migration requires review')
 oldlock=P(plan['expectedApp'])/'app/.wasp/out/db/migrations/migration_lock.toml'; newlock=release/'app/.wasp/out/db/migrations/migration_lock.toml'
 if oldlock.read_bytes()!=newlock.read_bytes():fail('Migration provider lock changed')
 return baseline_db,new
def http(path,payload=None):
 headers={'Origin':ORIGIN,'Content-Type':'application/json'} if payload is not None else {}
 request=urllib.request.Request(ORIGIN+path,data=payload,headers=headers)
 try:
  with urllib.request.urlopen(request,timeout=15) as response:return response.status,response.headers.get('Content-Type',''),response.read()
 except urllib.error.HTTPError as error:return error.code,error.headers.get('Content-Type',''),error.read()
def nginx(args):
 binary=shutil.which('nginx') or '/www/server/nginx/sbin/nginx'
 run([binary,*args],stdout=log,stderr=subprocess.STDOUT)
def baseline_images(state):
 result={}
 for line in state['containers']:
  fields=line.split()
  if fields[1] in ['/'+API,'/'+WORKER]:result['api' if fields[1]=='/'+API else 'worker']=fields[2]
 if set(result)!={'api','worker'} or any(not re.fullmatch(r'sha256:[0-9a-f]{64}',v) for v in result.values()):fail('Baseline application image identity missing')
 return result
def compose(directory,images):
 if set(images)!={'api','worker'} or any(not re.fullmatch(r'sha256:[0-9a-f]{64}',v) for v in images.values()):fail('Invalid immutable image identity')
 pin=backup/'compose-image-pin.yml';pin.write_text('services:\n'+''.join('  '+service+':\n    image: '+identity+'\n    pull_policy: never\n' for service,identity in images.items()));pin.chmod(0o600)
 args=['docker','compose','--project-name','ds-meta-saas-test','--env-file',str(CONFIG/'release.env'),'-f','compose.yml','-f',str(CONFIG/'ds-meta-worker-runtime.yml'),'-f',str(pin)]
 run([*args,'config','--quiet'],cwd=directory/'deploy/container',stdout=log,stderr=subprocess.STDOUT)
 run([*args,'up','-d','--no-deps','--no-build','--pull','never','api','worker'],cwd=directory/'deploy/container',stdout=log,stderr=subprocess.STDOUT)
def verify_app(images,require_history=False):
 for _ in range(30):
  try:
   status,_,body=http('/health'); health=json.loads(body); auth=json.loads(http('/auth/options')[2])
   if status==200 and all(health.get(k)=='ok' for k in ['api','database','worker']) and auth.get('google') is True:break
  except Exception:pass
  time.sleep(3)
 else:fail('API/worker did not recover')
 for service,name in [('api',API),('worker',WORKER)]:
  if text(['docker','inspect','--format','{{.Image}}',name])!=images[service]:fail('API/worker image mismatch')
  if require_history:
   flag=text(['docker','exec',name,'node','-e','process.stdout.write(String(process.env.HISTORY_PROJECTOR_ENABLED === "true"))'])
   if flag!='true':fail('History runtime flag missing')
 return health

def backup_restore(old_migrations):
 dump=backup/'database-before-history.dump'
 with dump.open('xb') as stream:run(['docker','exec',DB,'pg_dump','-U','saas_migrator','-d','ad_research_test','--format=custom','--no-owner','--no-acl'],stdout=stream,stderr=log)
 dump.chmod(0o600)
 restore='ad_research_restore_history_'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d%H%M%S')
 if sql("SELECT count(*) FROM pg_database WHERE datname='"+restore+"'",'postgres'):fail('Restore candidate already exists')
 run(['docker','exec',DB,'createdb','-U','saas_migrator',restore],stdout=log,stderr=log)
 try:
  sql('REVOKE CONNECT ON DATABASE "'+restore+'" FROM PUBLIC','postgres',False)
  if sql("SELECT has_database_privilege('saas_app','"+restore+"','CONNECT')",'postgres'):fail('App must not access restore database')
  with dump.open('rb') as stream:run(['docker','exec','-i',DB,'pg_restore','--exit-on-error','--no-owner','--no-acl','-U','saas_migrator','-d',restore],stdin=stream,stdout=log,stderr=log)
  if db_migrations(restore)!=old_migrations:fail('Restored migration checksums differ')
  invalid=sql("SELECT json_build_object('constraints',(SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated),'indexes',(SELECT count(*) FROM pg_index x JOIN pg_class c ON c.oid=x.indexrelid WHERE c.relnamespace='public'::regnamespace AND NOT indisvalid))",restore)
  if invalid!={'constraints':0,'indexes':0}:fail('Restored constraints/indexes invalid')
  result={'sha256':sha(dump.read_bytes()),'bytes':dump.stat().st_size,'restoreVerified':True,'restoredMigrationCount':len(old_migrations),'restoreDatabase':restore}
 finally:
  # Only the unique database created by this function is removed; no existing DB is targeted.
  run(['docker','exec',DB,'dropdb','-U','saas_migrator',restore],stdout=log,stderr=log)
 write_json(backup/'database-backup-verification.json',result);return result

def resume_activation(before,old_migrations):
 # Recovery is deliberately restricted to one known, pre-runtime ACL failure.
 path=backup/'deployment.json'
 if path.is_symlink() or not path.is_file():fail('Resume failed record missing or unsafe')
 original=path.read_bytes();record=json.loads(original)
 if record.get('status')!='failed' or record.get('error')!='Archive read-only grant verification failed':fail('Resume requires the exact pre-runtime archive ACL failure')
 if any(record.get(k)!=plan[k] for k in ['version','sourceCommit','artifactHash']):fail('Resume release provenance mismatch')
 if record.get('before')!=before or before!=plan['baseline']:fail('Resume original runtime baseline mismatch')
 mutated=['changedConfigSHA256','changedNginxSHA256','retainedOldAssets','health','appCurrent','publicCurrent','completedAtUtc','runtimeChanged','rollbackVerifiedAtUtc','rollbackHealth','rollbackError']
 if any(k in record for k in mutated) or webrelease.exists() or webrelease.is_symlink():fail('Resume refused: runtime activation may already have started')
 previous=ROOT/'previous'
 if previous.exists() and not previous.is_symlink():fail('Resume previous pointer is not a symlink')
 if (os.readlink(previous) if previous.is_symlink() else None)!=record.get('previousTarget'):fail('Resume previous pointer drift')
 for path in [CONFIG/'app.env',CONFIG/'release.env',SITE,ROOT/'current',ROOT/'previous',WEB/'current']:
  pending=path.with_name(path.name+'.history-new')
  if pending.exists() or pending.is_symlink():fail('Pending configuration or release pointer exists')
 if SITE.stat().st_mode&0o777!=record.get('nginxMode'):fail('Resume nginx mode drift')
 for name,digest in [('app.env',before['configSHA256']['app.env']),('release.env',before['configSHA256']['release.env']),('nginx.conf',before['nginxSHA256'])]:
  path=backup/name
  if path.is_symlink() or not path.is_file() or sha(path.read_bytes())!=digest:fail('Resume original configuration backup changed')
 verification=backup/'database-backup-verification.json';dump=backup/'database-before-history.dump'
 if verification.is_symlink() or not verification.is_file() or dump.is_symlink() or not dump.is_file():fail('Resume verified database backup missing or unsafe')
 proof=json.loads(verification.read_bytes())
 if record.get('databaseBackup')!=proof or proof.get('restoreVerified') is not True or proof.get('restoredMigrationCount')!=len(old_migrations) or proof.get('bytes')!=dump.stat().st_size or proof.get('sha256')!=sha(dump.read_bytes()) or dump.stat().st_size==0:fail('Resume verified database backup mismatch')
 preserved=backup/'deployment-before-acl-resume.json'
 if preserved.exists() or preserved.is_symlink():fail('Resume failed record already preserved; inspect before retry')
 with preserved.open('xb') as stream:stream.write(original)
 preserved.chmod(0o600)
 record.pop('error');record.update(status='preparing',resumedAtUtc=now(),resumedFromFailure='Archive read-only grant verification failed')
 return record

def archive_readonly_grants():
 # Existing defaults can grant app CRUD on a newly created table. Narrow this
 # table only; capture/guard roles and unrelated default privileges are retained.
 sql('''BEGIN;
REVOKE ALL PRIVILEGES ON TABLE public."ArchiveMediaCapture" FROM saas_app, PUBLIC;
DO $archive_acl$
DECLARE columns text;
BEGIN
 SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO columns
 FROM pg_attribute WHERE attrelid='public."ArchiveMediaCapture"'::regclass AND attnum>0 AND NOT attisdropped;
 EXECUTE format('REVOKE ALL PRIVILEGES (%s) ON TABLE public."ArchiveMediaCapture" FROM saas_app, PUBLIC',columns);
END $archive_acl$;
GRANT SELECT ON TABLE public."ArchiveMediaCapture" TO saas_app;
COMMIT;''',readonly=False)
 effective=sql('''SELECT has_table_privilege('saas_app','public."ArchiveMediaCapture"','SELECT')
 AND NOT has_table_privilege('saas_app','public."ArchiveMediaCapture"','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
 AND NOT has_any_column_privilege('saas_app','public."ArchiveMediaCapture"','INSERT,UPDATE,REFERENCES')
 AND NOT EXISTS (
  SELECT 1 FROM pg_roles r
  WHERE pg_has_role('saas_app',r.oid,'MEMBER')
   AND (r.rolsuper
    OR has_table_privilege(r.oid,'public."ArchiveMediaCapture"','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR has_any_column_privilege(r.oid,'public."ArchiveMediaCapture"','INSERT,UPDATE,REFERENCES'))
 )''')
 if effective is not True:fail('Archive read-only grant verification failed')

def restore_runtime(record):
 # Never replace another publisher's changes. Our known candidate or original state only.
 for name in ['ds-meta-worker-runtime.yml','seccomp_profile.json']:
  if sha((CONFIG/name).read_bytes())!=record['before']['configSHA256'][name]:fail('Rollback stopped: external worker runtime changed')
 for name in ['app.env','release.env']:
  digest=sha((CONFIG/name).read_bytes())
  if digest not in [record['before']['configSHA256'][name],record.get('changedConfigSHA256',{}).get(name)]:fail('Rollback stopped: environment changed externally')
 if sha(SITE.read_bytes()) not in [record['before']['nginxSHA256'],record.get('changedNginxSHA256')]:fail('Rollback stopped: nginx changed externally')
 if app() not in [plan['expectedApp'],str(release)] or web() not in [plan['expectedWeb'],str(webrelease)]:fail('Rollback stopped: current pointer changed externally')
 current_previous=os.readlink(ROOT/'previous') if (ROOT/'previous').is_symlink() else None
 if current_previous not in [record['previousTarget'],plan['expectedApp']]:fail('Rollback stopped: previous pointer changed externally')
 staged=json.loads((backup/'staged.json').read_text());allowed=baseline_images(record['before'])
 for service,name in [('api',API),('worker',WORKER)]:
  if text(['docker','inspect','--format','{{.Image}}',name]) not in [allowed[service],staged['imageId']]:fail('Rollback stopped: application image changed externally')
 old_images=baseline_images(record['before']);record['status']='rolling-back-runtime';write_json(backup/'deployment.json',record)
 try:
  for name in ['app.env','release.env']:atomic_bytes(CONFIG/name,(backup/name).read_bytes())
  atomic_bytes(SITE,(backup/'nginx.conf').read_bytes(),record['nginxMode'])
  nginx(['-t']);compose(P(plan['expectedApp']),old_images)
 finally:
  link(ROOT/'current',plan['expectedApp']);link(WEB/'current',plan['expectedWeb'])
  if record['previousTarget'] is not None:link(ROOT/'previous',record['previousTarget'])
  elif (ROOT/'previous').is_symlink():(ROOT/'previous').unlink()
 try:record['rollbackHealth']=verify_app(old_images)
 except BaseException as error:
  record.update(status='rollback-runtime-restored-health-failed',rollbackError=str(error));write_json(backup/'deployment.json',record);raise
 nginx(['-s','reload'])
 for path in ['/','/signup']:
  status,_,body=http(path)
  if status!=200 or body!=(P(plan['expectedWeb'])/'200.html').read_bytes():fail('Rollback public HTML mismatch')
 record['rollbackVerifiedAtUtc']=now()
 record['status']='rolled-back-runtime-only';record['databaseDownMigrationExecuted']=False;write_json(backup/'deployment.json',record)
 return {'status':record['status'],'appCurrent':app(),'publicCurrent':web(),'databaseSchemaRetained':True,'backup':str(backup)}

if mode=='inspect':print(json.dumps(baseline()));sys.exit(0)
if mode=='inspect-schema':print(json.dumps(inspect_schema()));sys.exit(0)
if mode not in ['reserve','stage','activate','resume-activate','rollback']:fail('Unknown mode')
os.umask(0o077)
with (ROOT/'growth-publish.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 if mode=='reserve':
  baseline()
  if backup.exists() or release.exists() or webrelease.exists():fail('Version exists: choose a new suffix and regenerate reviewed plan')
  backup.mkdir(mode=0o700);write_json(backup/'plan.json',plan);print(json.dumps({'status':'reserved'}));sys.exit(0)
 if json.loads((backup/'plan.json').read_text())!=plan:fail('Frozen plan mismatch')
 log=(backup/(mode+'.log')).open('ab')
 try:
  if mode=='stage':
   baseline();archive=backup/'bundle.tar.gz'
   if sha(archive.read_bytes())!=plan['archiveSHA256']:fail('Archive hash mismatch')
   with tarfile.open(archive) as tar:
    names=tar.getnames()
    if len(names)!=len(set(names)):fail('Duplicate archive entries')
    m=json.loads(tar.extractfile('release-manifest.json').read())
    expected={x['path']:x for x in m['files']}
    if set(names)!=set(expected)|{'release-manifest.json'}:fail('Unexpected archive files')
    if m['sourceCommit']!=plan['sourceCommit'] or m['workingTreeDirty'] is not False or m['releaseId']!=version or m['artifactHash']!=plan['artifactHash']:fail('Release provenance mismatch')
    release.mkdir(mode=0o750)
    for member in tar:
     rel=P(member.name)
     if not member.isfile() or rel.is_absolute() or '..' in rel.parts:fail('Unsafe archive file')
     data=tar.extractfile(member).read();entry=expected.get(member.name)
     if entry and (sha(data)!=entry['sha256'] or len(data)!=entry['sizeBytes']):fail('Artifact checksum mismatch')
     dest=release/rel;dest.parent.mkdir(parents=True,exist_ok=True,mode=0o755);dest.write_bytes(data);dest.chmod(0o755 if dest.suffix=='.sh' else 0o644)
   for directory in release.rglob('*'):
    if directory.is_dir():directory.chmod(0o755)
   release.chmod(0o755)
   verify_release();check_migrations()
   run(['docker','build','--tag',image,'--file','deploy/container/Dockerfile','.'],cwd=release,stdout=log,stderr=subprocess.STDOUT)
   baseline();staged={'status':'STAGED_NOT_ACTIVE','version':version,'imageId':text(['docker','image','inspect','--format','{{.Id}}',image]),'manifestSHA256':sha((release/'release-manifest.json').read_bytes())};write_json(backup/'staged.json',staged);print(json.dumps(staged));sys.exit(0)
  if mode=='rollback':print(json.dumps(restore_runtime(json.loads((backup/'deployment.json').read_text()))));sys.exit(0)
  verify_release();staged=verify_staged()
  resuming=mode=='resume-activate'
  if not resuming and (backup/'deployment.json').exists():fail('Previous activation record exists; preserve evidence before retry')
  before=baseline();old,new=check_migrations(allow_applied=resuming)
  if resuming:record=resume_activation(before,old)
  else:
   record={'status':'preparing','version':version,'sourceCommit':plan['sourceCommit'],'artifactHash':plan['artifactHash'],'before':before,'previousTarget':os.readlink(ROOT/'previous') if (ROOT/'previous').is_symlink() else None,'nginxMode':SITE.stat().st_mode&0o777,'startedAtUtc':now()}
   for name in ['app.env','release.env']:shutil.copyfile(CONFIG/name,backup/name);(backup/name).chmod(0o600)
   shutil.copyfile(SITE,backup/'nginx.conf');(backup/'nginx.conf').chmod(0o600)
  write_json(backup/'deployment.json',record)
  runtime_changed=False
  try:
   if not resuming:
    record['databaseBackup']=backup_restore(old);baseline()
    run(['docker','run','--rm','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges:true','--tmpfs','/tmp:rw,nosuid,nodev,size=128m,mode=1777','--env-file',str(CONFIG/'migration.env'),'--network','ds-meta-saas-test_data',staged['imageId'],'node','node_modules/prisma/build/index.js','migrate','deploy','--schema=.wasp/out/db/schema.prisma'],stdout=log,stderr=subprocess.STDOUT)
   if db_migrations()!=new:fail('Applied migration checksums differ')
   sql('GRANT SELECT, INSERT, UPDATE, DELETE ON "AdDailySnapshot", "AdHistoryEvent", "AdHistoryProjectionTask", "AdHistoryBackfillCursor" TO saas_app',readonly=False)
   grants=sql("SELECT bool_and(has_table_privilege('saas_app', t, p)) FROM unnest(ARRAY['public.\"AdDailySnapshot\"','public.\"AdHistoryEvent\"','public.\"AdHistoryProjectionTask\"','public.\"AdHistoryBackfillCursor\"']) t CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p")
   if grants is not True:fail('Application table grants incomplete')
   archive_readonly_grants()
   baseline()
   shutil.copytree(release/'public',webrelease)
   retained_assets=0
   for oldasset in (P(plan['expectedWeb'])/'assets').rglob('*'):
    if oldasset.is_symlink():fail('Unexpected old asset')
    if oldasset.is_dir():continue
    if not oldasset.is_file():fail('Unexpected old asset')
    dest=webrelease/'assets'/oldasset.relative_to(P(plan['expectedWeb'])/'assets')
    if dest.exists():
     if sha(dest.read_bytes())!=sha(oldasset.read_bytes()):fail('Asset name collision')
    else:dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(oldasset,dest);retained_assets+=1
   record['retainedOldAssets']=retained_assets
   for path in [webrelease,*webrelease.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
   run(['runuser','-u','www','--','test','-r',str(webrelease/'200.html')],stdout=log,stderr=log)
   new_app=env_set((backup/'app.env').read_bytes(),'HISTORY_PROJECTOR_ENABLED','true')
   new_release=env_set((backup/'release.env').read_bytes(),'AD_RESEARCH_RELEASE_ID',version,P(plan['expectedApp']).name)
   new_site=(backup/'nginx.conf').read_bytes()
   record['changedConfigSHA256']={'app.env':sha(new_app),'release.env':sha(new_release)};record['changedNginxSHA256']=sha(new_site);write_json(backup/'deployment.json',record)
   baseline();runtime_changed=True;record['runtimeChanged']=True;write_json(backup/'deployment.json',record)
   atomic_bytes(CONFIG/'app.env',new_app);atomic_bytes(CONFIG/'release.env',new_release);atomic_bytes(SITE,new_site,record['nginxMode']);nginx(['-t']);candidate_images={'api':staged['imageId'],'worker':staged['imageId']};compose(release,candidate_images)
   record['health']=verify_app(candidate_images,True);nginx(['-s','reload'])
   status,content_type,body=http('/growth/consent',b'{}')
   if status!=400 or 'json' not in content_type or b'INVALID_GROWTH_REQUEST' not in body:fail('Growth reverse proxy rejection probe failed')
   if app()!=plan['expectedApp'] or web()!=plan['expectedWeb']:fail('Pointers drifted before final activation')
   link(ROOT/'previous',plan['expectedApp']);link(ROOT/'current',str(release));link(WEB/'current',str(webrelease))
   for path in ['/','/signup','/privacy']:
    status,_,body=http(path)
    if status!=200 or body!=(webrelease/'200.html').read_bytes():fail('Public HTML mismatch')
   after=snapshot()
   if after['app']!=str(release) or after['web']!=str(webrelease):fail('Activated pointer drift')
   if after['nginxSHA256']!=record['changedNginxSHA256'] or any(after['configSHA256'][key]!=record['changedConfigSHA256'][key] for key in ['app.env','release.env']):fail('Activated configuration drift')
   if unaffected(after['containers'])!=unaffected(before['containers']):fail('Unrelated container state changed')
   if after['otherVhostsSHA256']!=before['otherVhostsSHA256'] or any(after['configSHA256'][key]!=before['configSHA256'][key] for key in ['ds-meta-worker-runtime.yml','seccomp_profile.json']):fail('Protected configuration changed')
   record.update(status='active',completedAtUtc=now(),migrations=new,applicationGrantsVerified=True,appCurrent=app(),publicCurrent=web(),rollbackApp=plan['expectedApp'],rollbackWeb=plan['expectedWeb'],databaseDownMigrationExecuted=False)
   write_json(backup/'deployment.json',record);print(json.dumps({k:record[k] for k in ['status','version','sourceCommit','completedAtUtc','appCurrent','publicCurrent','rollbackApp','rollbackWeb']}))
  except BaseException as error:
   record['error']=str(error);record['status']='failed';write_json(backup/'deployment.json',record)
   if runtime_changed:restore_runtime(record)
   raise
 finally:log.close()
