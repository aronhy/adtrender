#!/usr/bin/env python3
import datetime,fcntl,hashlib,json,os,pathlib,re,shutil,subprocess,sys,tarfile,time,urllib.error,urllib.request
P=pathlib.Path; ROOT=P('/opt/ad-research-test'); WEB=P('/www/wwwroot/adtrender'); CONFIG=P('/etc/ad-research-test'); SITE=P('/www/server/panel/vhost/nginx/adtrender.com.conf'); ORIGIN='https://adtrender.com'; API='ds-meta-saas-test-api-1'; WORKER='ds-meta-saas-test-worker-1'; DB='ds-meta-saas-test-database-1'
mode,raw=sys.argv[1:]; plan=json.loads(raw); version=plan['version']; assert re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}',version)
release=ROOT/'releases'/version; webrelease=WEB/'releases'/version; backup=ROOT/'backups'/('ui-'+version); image='ad-research-saas-test:'+version
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
 if 'baseline' in plan and state!={k:plan['baseline'][k] for k in state}:
  if mode!='inspect' and backup.exists():write_json(backup/('baseline-drift-'+mode+'-'+str(time.time_ns())+'.json'),{'expected':plan['baseline'],'actual':state})
  fail('LIVE_RUNTIME_OR_CONFIGURATION_DRIFT: review retained evidence; do not overwrite')
 return state
def atomic_bytes(path,data,mode=0o600):
 tmp=path.with_name(path.name+'.ui-new')
 if tmp.exists():fail('Pending configuration file exists')
 with tmp.open('xb') as f:f.write(data)
 tmp.chmod(mode);os.replace(tmp,path)
def link(path,target):
 tmp=path.with_name(path.name+'.ui-new')
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
def verify_release():
 manifest=release/'release-manifest.json'; m=json.loads(manifest.read_text())
 if m['sourceCommit']!=plan['sourceCommit'] or m['workingTreeDirty'] is not False or m['releaseId']!=version or m['artifactHash']!=plan['artifactHash'] or m['publicApiUrl']!=ORIGIN:fail('Release provenance mismatch')
 if sha(json.dumps(m['files'],separators=(',',':'),ensure_ascii=False).encode())!=m['artifactHash']:fail('Artifact inventory hash mismatch')
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
def check_migrations():
 old=migrations(P(plan['expectedApp'])); new=migrations(release)
 if new!=old or db_migrations()!=new:fail('Runtime-only release requires identical old/new/database migration checksums')
 if sql('SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL')!=0:fail('Unfinished migration requires review')
 for name in ['schema.prisma','migrations/migration_lock.toml']:
  oldfile=P(plan['expectedApp'])/'app/.wasp/out/db'/name;newfile=release/'app/.wasp/out/db'/name
  if oldfile.read_bytes()!=newfile.read_bytes():fail('Runtime-only database schema/provider lock changed')
 return new
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
def fresh_worker_process():
 identity=text(['docker','inspect','--format','{{.Id}} {{.State.StartedAt}}',WORKER]);parts=identity.split()
 if len(parts)!=2 or not re.fullmatch(r'[0-9a-f]{64}',parts[0]) or not re.fullmatch(r'[0-9T:.+-]+Z',parts[1]):fail('Invalid worker container identity')
 started=parts[1]
 result=run(['docker','logs','--since',started,WORKER],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
 events=[]
 for line in result.stdout.splitlines():
  try:event=json.loads(line)
  except (ValueError,TypeError):continue
  if isinstance(event,dict) and event.get('event')=='worker_started':events.append(event)
 if not events:fail('New worker process has not announced its identity')
 worker_id=events[-1].get('workerId')
 if not isinstance(worker_id,str) or not re.fullmatch(r'saas-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',worker_id):fail('Invalid worker process identity')
 # Both literals are constrained above; sql() always wraps this probe in BEGIN READ ONLY.
 query="SELECT EXISTS (SELECT 1 FROM public.\"WorkerHeartbeat\" WHERE id='"+worker_id+"' AND \"startedAt\">=timezone('UTC','"+started+"'::timestamptz) AND \"lastSeenAt\">=timezone('UTC','"+started+"'::timestamptz) AND \"lastSeenAt\">timezone('UTC',now()-interval '90 seconds') AND status<>'STOPPED' AND capabilities @> ARRAY['mail','collection']::text[])"
 if sql(query) is not True:fail('Exact new worker heartbeat is stale or incomplete')
 if text(['docker','inspect','--format','{{.Id}} {{.State.StartedAt}}',WORKER])!=identity:fail('Worker restarted during identity verification')
 return {'workerId':worker_id,'containerStartedAt':started,'startedAfterContainer':True,'lastSeenAfterContainer':True,'freshWithinSeconds':90,'capabilities':['mail','collection']}

def verify_app(images):
 for _ in range(30):
  try:
   status,_,body=http('/health');health=json.loads(body);auth=json.loads(http('/auth/options')[2])
   if status==200 and all(health.get(k)=='ok' for k in ['api','database','worker','email']) and health.get('source')==plan['expectedSourceHealth'] and auth.get('google') is True:
    health['workerProcess']=fresh_worker_process();break
  except Exception:pass
  time.sleep(3)
 else:fail('API/database/worker/email or preserved source health did not recover')
 for service,name in [('api',API),('worker',WORKER)]:
  if text(['docker','inspect','--format','{{.Image}}',name])!=images[service]:fail('API/worker image mismatch')
  flag=text(['docker','exec',name,'node','-e','process.stdout.write(String(process.env.GROWTH_ATTRIBUTION_ENABLED === "true"))'])
  if flag!='true':fail('Existing growth runtime flag must remain true')
 return health

def verify_candidate(image_id):
 if not re.fullmatch(r'sha256:[0-9a-f]{64}',image_id):fail('Invalid candidate immutable image')
 labels=json.loads(text(['docker','image','inspect','--format','{{json .Config.Labels}}',image_id])) or {}
 if labels.get('adtrender.sourceCommit')!=plan['sourceCommit'] or labels.get('adtrender.artifactHash')!=plan['artifactHash']:fail('Candidate image provenance mismatch')
 code="const fs=require('node:fs');if(process.getuid()!==1000)throw Error('DEFAULT_USER_NOT_NODE');for(const p of ['.wasp/out/db/schema.prisma','.wasp/out/server/bundle/server.js','dist-worker/index.mjs'])fs.accessSync(p,fs.constants.R_OK);const m=JSON.parse(fs.readFileSync('../release-manifest.json'));if(m.sourceCommit!==process.argv[1]||m.artifactHash!==process.argv[2])throw Error('MANIFEST_MISMATCH');console.log('NODE_RUNTIME_FILES_READABLE')"
 run(['docker','run','--rm','--network','none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges:true',image_id,'node','-e',code,plan['sourceCommit'],plan['artifactHash']],stdout=log,stderr=subprocess.STDOUT)
 return {'defaultUid':1000,'schemaReadable':True,'serverBundleReadable':True,'workerBundleReadable':True,'manifestMatches':True}

def protected_unchanged(state,before):
 if state['nginxSHA256']!=before['nginxSHA256'] or state['otherVhostsSHA256']!=before['otherVhostsSHA256']:fail('Protected nginx configuration changed')
 for name in ['app.env','ds-meta-worker-runtime.yml','seccomp_profile.json']:
  if state['configSHA256'][name]!=before['configSHA256'][name]:fail('Protected configuration changed: '+name)
 if unaffected(state['containers'])!=unaffected(before['containers']):fail('Unrelated container state changed; manual baseline review required')

def restore_runtime(record):
 current=snapshot();protected_unchanged(current,record['before'])
 if current['configSHA256']['release.env'] not in [record['before']['configSHA256']['release.env'],record.get('changedReleaseEnvSHA256')]:fail('Rollback stopped: release env changed externally')
 if app() not in [plan['expectedApp'],str(release)] or web() not in [plan['expectedWeb'],str(webrelease)]:fail('Rollback stopped: current pointer changed externally')
 current_previous=os.readlink(ROOT/'previous') if (ROOT/'previous').is_symlink() else None
 if current_previous not in [record['previousTarget'],plan['expectedApp']]:fail('Rollback stopped: previous pointer changed externally')
 atomic_bytes(CONFIG/'release.env',(backup/'release.env').read_bytes())
 old_images=baseline_images(record['before']);record['status']='rolling-back-runtime';write_json(backup/'deployment.json',record)
 try:
  compose(P(plan['expectedApp']),old_images)
 finally:
  # Finish restoring all routing pointers even if container recreation or later health verification fails.
  link(ROOT/'current',plan['expectedApp']);link(WEB/'current',plan['expectedWeb'])
  if record['previousTarget'] is not None:link(ROOT/'previous',record['previousTarget'])
  elif (ROOT/'previous').is_symlink():(ROOT/'previous').unlink()
 try:record['rollbackHealth']=verify_app(old_images)
 except BaseException as error:
  record.update(status='rollback-runtime-restored-health-failed',rollbackError=str(error));write_json(backup/'deployment.json',record);raise
 for path in ['/','/login','/signup','/app']:
  status,_,body=http(path)
  if status!=200 or body!=(P(plan['expectedWeb'])/'200.html').read_bytes():fail('Rollback public HTML mismatch')
 after=snapshot();protected_unchanged(after,record['before'])
 if after['configSHA256']['release.env']!=record['before']['configSHA256']['release.env']:fail('Rollback release environment mismatch')
 if db_migrations()!=record['migrations']:fail('Database migrations changed during runtime-only rollback')
 record.update(status='rolled-back-runtime-only',rollbackVerifiedAtUtc=now(),databaseDownMigrationExecuted=False)
 write_json(backup/'deployment.json',record)
 return {'status':record['status'],'appCurrent':app(),'publicCurrent':web(),'databaseSchemaRetained':True,'backup':str(backup)}

if mode=='inspect':
 result=baseline();result['migrationChecksums']=db_migrations();result['schemaSHA256']=sha((P(plan['expectedApp'])/'app/.wasp/out/db/schema.prisma').read_bytes());print(json.dumps(result));sys.exit(0)
if mode not in ['reserve','stage','resume-stage','activate','rollback']:fail('Unknown mode')
os.umask(0o077)
with (ROOT/'growth-publish.lock').open('a') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 if mode=='reserve':
  baseline()
  if backup.exists() or release.exists() or webrelease.exists():fail('Version exists: inspect retained evidence; use resume-stage only for the same frozen plan')
  if subprocess.run(['docker','image','inspect',image],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:fail('Candidate image tag already exists; choose a fresh release version')
  backup.mkdir(mode=0o700);write_json(backup/'plan.json',plan);print(json.dumps({'status':'reserved'}));sys.exit(0)
 if json.loads((backup/'plan.json').read_text())!=plan:fail('Frozen plan mismatch')
 log=(backup/(mode+'.log')).open('ab')
 try:
  if mode in ['stage','resume-stage']:
   baseline();archive=backup/'bundle.tar.gz'
   if sha(archive.read_bytes())!=plan['archiveSHA256']:fail('Archive hash mismatch')
   if mode=='stage':
    if release.exists():fail('Release exists; inspect then explicitly resume-stage')
    with tarfile.open(archive) as tar:
     names=tar.getnames()
     if len(names)!=len(set(names)):fail('Duplicate archive entries')
     m=json.loads(tar.extractfile('release-manifest.json').read());expected={x['path']:x for x in m['files']}
     if set(names)!=set(expected)|{'release-manifest.json'}:fail('Unexpected archive files')
     if m['sourceCommit']!=plan['sourceCommit'] or m['workingTreeDirty'] is not False or m['releaseId']!=version or m['artifactHash']!=plan['artifactHash']:fail('Release provenance mismatch')
     release.mkdir(mode=0o750)
     for member in tar:
      rel=P(member.name)
      if not member.isfile() or rel.is_absolute() or '..' in rel.parts:fail('Unsafe archive file')
      data=tar.extractfile(member).read();entry=expected.get(member.name)
      if entry and (sha(data)!=entry['sha256'] or len(data)!=entry['sizeBytes']):fail('Artifact checksum mismatch')
      dest=release/rel;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(data);dest.chmod(0o755 if dest.suffix=='.sh' else 0o644)
    # umask(077) must not make the Linux image's default node user unable to traverse COPY directories.
    for directory in release.rglob('*'):
     if directory.is_dir():directory.chmod(0o755)
   verify_release();migration_list=check_migrations()
   existing=subprocess.run(['docker','image','inspect','--format','{{.Id}}',image],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
   if mode=='stage' or existing.returncode!=0:
    run(['docker','build','--tag',image,'--label','adtrender.sourceCommit='+plan['sourceCommit'],'--label','adtrender.artifactHash='+plan['artifactHash'],'--file','deploy/container/Dockerfile','.'],cwd=release,stdout=log,stderr=subprocess.STDOUT)
   image_id=text(['docker','image','inspect','--format','{{.Id}}',image])
   if (backup/'staged.json').exists() and json.loads((backup/'staged.json').read_text())['imageId']!=image_id:fail('Previously staged image identity changed')
   smoke=verify_candidate(image_id)
   baseline();check_migrations()
   staged={'status':'STAGED_NOT_ACTIVE','version':version,'imageId':image_id,'manifestSHA256':sha((release/'release-manifest.json').read_bytes()),'migrations':migration_list,'nodeFileSmoke':smoke,'resumed':mode=='resume-stage'}
   write_json(backup/'staged.json',staged);print(json.dumps(staged));sys.exit(0)
  if mode=='rollback':print(json.dumps(restore_runtime(json.loads((backup/'deployment.json').read_text()))));sys.exit(0)
  verify_release();staged=json.loads((backup/'staged.json').read_text())
  if staged['imageId']!=text(['docker','image','inspect','--format','{{.Id}}',image]) or staged['manifestSHA256']!=sha((release/'release-manifest.json').read_bytes()):fail('Staged image or manifest drift')
  if (backup/'deployment.json').exists():fail('Prior activation record exists; preserve failure evidence and review rollback/new version')
  verify_candidate(staged['imageId']);before=baseline();migration_list=check_migrations()
  if migration_list!=staged['migrations']:fail('Staged database baseline changed')
  record={'status':'preparing','version':version,'sourceCommit':plan['sourceCommit'],'artifactHash':plan['artifactHash'],'before':before,'migrations':migration_list,'previousTarget':os.readlink(ROOT/'previous') if (ROOT/'previous').is_symlink() else None,'startedAtUtc':now(),'databaseWritesExecuted':False,'databaseBackupTaken':False}
  shutil.copyfile(CONFIG/'release.env',backup/'release.env');(backup/'release.env').chmod(0o600);write_json(backup/'deployment.json',record)
  runtime_changed=False
  try:
   if webrelease.exists():fail('Public release already exists; preserve failed scene and review before retry')
   shutil.copytree(release/'public',webrelease);retained=0
   for oldasset in (P(plan['expectedWeb'])/'assets').rglob('*'):
    if oldasset.is_symlink():fail('Unexpected old asset')
    if oldasset.is_dir():continue
    if not oldasset.is_file():fail('Unexpected old asset')
    dest=webrelease/'assets'/oldasset.relative_to(P(plan['expectedWeb'])/'assets')
    if dest.exists():
     if sha(dest.read_bytes())!=sha(oldasset.read_bytes()):fail('Asset name collision')
    else:dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(oldasset,dest);retained+=1
   record['retainedOldAssets']=retained
   for path in [webrelease,*webrelease.rglob('*')]:path.chmod(0o755 if path.is_dir() else 0o644)
   run(['runuser','-u','www','--','test','-r',str(webrelease/'200.html')],stdout=log,stderr=log)
   new_env=env_set((backup/'release.env').read_bytes(),'AD_RESEARCH_RELEASE_ID',version,P(plan['expectedApp']).name)
   record['changedReleaseEnvSHA256']=sha(new_env);write_json(backup/'deployment.json',record)
   baseline();check_migrations();nginx(['-t']);runtime_changed=True
   atomic_bytes(CONFIG/'release.env',new_env);candidate_images={'api':staged['imageId'],'worker':staged['imageId']};compose(release,candidate_images)
   record['health']=verify_app(candidate_images)
   status,ctype,body=http('/growth/consent',b'{}')
   if status!=400 or 'json' not in ctype or b'INVALID_GROWTH_REQUEST' not in body:fail('Existing growth rejection probe changed')
   if app()!=plan['expectedApp'] or web()!=plan['expectedWeb']:fail('Pointers drifted before final activation')
   link(ROOT/'previous',plan['expectedApp']);link(ROOT/'current',str(release));link(WEB/'current',str(webrelease))
   for path in ['/','/login','/signup','/request-password-reset','/app','/app/overview','/app/ads','/app/research','/app/settings']:
    status,_,body=http(path)
    if status!=200 or body!=(webrelease/'200.html').read_bytes():fail('Public HTML mismatch')
   after=snapshot();protected_unchanged(after,before)
   if after['app']!=str(release) or after['web']!=str(webrelease) or after['configSHA256']['release.env']!=record['changedReleaseEnvSHA256']:fail('Activated pointer/release environment drift')
   check_migrations()
   record.update(status='active',completedAtUtc=now(),appCurrent=app(),publicCurrent=web(),rollbackApp=plan['expectedApp'],rollbackWeb=plan['expectedWeb'],databaseDownMigrationExecuted=False)
   write_json(backup/'deployment.json',record);print(json.dumps({k:record[k] for k in ['status','version','sourceCommit','completedAtUtc','appCurrent','publicCurrent','rollbackApp','rollbackWeb']}))
  except BaseException as error:
   record['error']=str(error);record['status']='failed';write_json(backup/'deployment.json',record)
   if runtime_changed:restore_runtime(record)
   raise
 finally:log.close()
