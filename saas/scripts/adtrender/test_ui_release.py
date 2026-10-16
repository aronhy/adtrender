import ast,hashlib,json,pathlib,re,tempfile,unittest
P=pathlib.Path
SOURCE=P(__file__).with_name('ui_release_remote.py').read_text()
module=ast.parse(SOURCE)
nodes=[n for n in module.body if isinstance(n,(ast.Import,ast.ImportFrom,ast.FunctionDef))]
ns={};exec(compile(ast.Module(body=nodes,type_ignores=[]),'<remote-functions>','exec'),ns)
ns.update(mode='inspect',P=P,sha=lambda b:hashlib.sha256(b).hexdigest(),DB='fake-database')
class Safety(unittest.TestCase):
 def test_env_single_change(self):
  actual=ns['env_set'](b'KEEP=x\nAD_RESEARCH_RELEASE_ID=before\n','AD_RESEARCH_RELEASE_ID','after','before')
  self.assertEqual(actual,b'KEEP=x\nAD_RESEARCH_RELEASE_ID=after\n')
 def test_env_missing_flag_added(self):
  self.assertEqual(ns['env_set'](b'KEEP=x','GROWTH_ATTRIBUTION_ENABLED','true'),b'KEEP=x\nGROWTH_ATTRIBUTION_ENABLED=true\n')
 def test_env_duplicate_and_drift_refused(self):
  for data in [b'KEY=old\nKEY=old\n',b'KEY=other\n',b'']:
   with self.assertRaisesRegex(RuntimeError,'baseline'):ns['env_set'](data,'KEY','new','old')
 def test_psql_scalar_booleans_and_json(self):
  for output,expected in [('t',True),('f',False),('0',0),('[]',[]),('{"ok":true}',{'ok':True})]:
   ns['text']=lambda args,value=output:value
   self.assertEqual(ns['sql']('SELECT'),expected)
 def test_baseline_refuses_pointer_or_any_runtime_change(self):
  state={'app':'/app/old','web':'/web/old','containers':['stable']}
  ns.update(plan={'expectedApp':'/app/old','expectedWeb':'/web/old','baseline':state.copy()},snapshot=lambda:state)
  self.assertEqual(ns['baseline'](),state)
  state['containers']=['changed']
  with self.assertRaisesRegex(RuntimeError,'DRIFT'):ns['baseline']()
  state['app']='/app/new'
  with self.assertRaisesRegex(RuntimeError,'DRIFT'):ns['baseline']()
 def test_manifest_content_inventory_and_symlinks(self):
  with tempfile.TemporaryDirectory() as temp:
   root=P(temp);(root/'public').mkdir();data=b'HTML';(root/'public/200.html').write_bytes(data)
   entry={'path':'public/200.html','sha256':ns['sha'](data),'sizeBytes':4}
   digest=ns['sha'](json.dumps([entry],separators=(',',':'),ensure_ascii=False).encode());manifest={'sourceCommit':'a'*40,'workingTreeDirty':False,'releaseId':'test','artifactHash':digest,'publicApiUrl':'https://adtrender.com','files':[entry]}
   (root/'release-manifest.json').write_text(json.dumps(manifest))
   ns.update(release=root,version='test',ORIGIN='https://adtrender.com',plan={'sourceCommit':'a'*40,'artifactHash':digest})
   self.assertEqual(ns['verify_release'](),manifest)
   (root/'public/200.html').write_bytes(b'evil')
   with self.assertRaisesRegex(RuntimeError,'checksum'):ns['verify_release']()
   (root/'public/200.html').write_bytes(data);(root/'extra').write_bytes(b'no')
   with self.assertRaisesRegex(RuntimeError,'inventory'):ns['verify_release']()
   (root/'extra').unlink();(root/'extra').symlink_to(root/'public/200.html')
   with self.assertRaisesRegex(RuntimeError,'symlink'):ns['verify_release']()
 def test_immutable_image_pin(self):
  with tempfile.TemporaryDirectory() as temp:
   ns.update(backup=P(temp),CONFIG=P('/config'),log=None,run=lambda *a,**kw:None)
   digest='sha256:'+'1'*64
   ns['compose'](P('/release'),{'api':digest,'worker':digest})
   pin=(P(temp)/'compose-image-pin.yml').read_text()
   self.assertEqual(pin.count(digest),2);self.assertEqual(pin.count('pull_policy: never'),2)
   with self.assertRaisesRegex(RuntimeError,'immutable'):ns['compose'](P('/release'),{'api':'mutable:tag','worker':digest})
 def test_baseline_images_require_both_identities(self):
  ns.update(API='api-container',WORKER='worker-container')
  digest='sha256:'+'1'*64
  expected={'api':digest,'worker':digest}
  self.assertEqual(ns['baseline_images']({'containers':[f'id /api-container {digest} date running',f'id /worker-container {digest} date running']}),expected)
  with self.assertRaisesRegex(RuntimeError,'missing'):ns['baseline_images']({'containers':[]})


class RuntimeOnly(unittest.TestCase):
 def setUp(self):
  self.n={};exec(compile(ast.Module(body=nodes,type_ignores=[]),'<remote-functions>','exec'),self.n)
  self.n.update(P=P,sha=lambda b:hashlib.sha256(b).hexdigest(),API='api',WORKER='worker',mode='inspect')
 def test_schema_and_migrations_must_match_without_writes(self):
  with tempfile.TemporaryDirectory() as temp:
   old=P(temp)/'old';new=P(temp)/'new'
   for root in [old,new]:
    folder=root/'app/.wasp/out/db/migrations/0001';folder.mkdir(parents=True)
    (folder/'migration.sql').write_text('CREATE TABLE fixture(id int);')
    (folder.parent/'migration_lock.toml').write_text('provider="postgresql"')
    (folder.parent.parent/'schema.prisma').write_text('schema fixture')
   expected=self.n['migrations'](old);self.n.update(plan={'expectedApp':str(old)},release=new,db_migrations=lambda:expected,sql=lambda q:0)
   self.assertEqual(self.n['check_migrations'](),expected)
   self.n['db_migrations']=lambda:[]
   with self.assertRaisesRegex(RuntimeError,'identical'):self.n['check_migrations']()
   self.n['db_migrations']=lambda:expected
   (new/'app/.wasp/out/db/schema.prisma').write_text('changed schema')
   with self.assertRaisesRegex(RuntimeError,'schema'):self.n['check_migrations']()
 def test_unrelated_containers_and_protected_settings_remain_strict(self):
  before={'nginxSHA256':'n','otherVhostsSHA256':'o','configSHA256':{'app.env':'a','ds-meta-worker-runtime.yml':'r','seccomp_profile.json':'s'},'containers':['id /collector image started running']}
  self.n['protected_unchanged'](before,before)
  for mutate in [lambda x:x.update(containers=[]),lambda x:x['configSHA256'].update({'app.env':'changed'}),lambda x:x.update(nginxSHA256='changed')]:
   after=json.loads(json.dumps(before));mutate(after)
   with self.assertRaises(RuntimeError):self.n['protected_unchanged'](after,before)
 def test_worker_freshness_rejects_missing_old_or_restarting_identity(self):
  from types import SimpleNamespace
  identity='a'*64+' 2026-10-07T12:00:00.123456789Z';event=json.dumps({'event':'worker_started','workerId':'saas-11111111-2222-3333-4444-555555555555'})
  queries=[]
  self.n.update(text=lambda a:identity,run=lambda *a,**k:SimpleNamespace(stdout=event),sql=lambda q:(queries.append(q) or True))
  proof=self.n['fresh_worker_process']();self.assertEqual(proof['workerId'],'saas-11111111-2222-3333-4444-555555555555')
  self.assertIn("id='saas-11111111-2222-3333-4444-555555555555'",queries[0]);self.assertIn('2026-10-07T12:00:00.123456789Z',queries[0])
  self.n['sql']=lambda q:False
  with self.assertRaisesRegex(RuntimeError,'stale'):self.n['fresh_worker_process']()
  self.n['sql']=lambda q:True;self.n['run']=lambda *a,**k:SimpleNamespace(stdout='')
  with self.assertRaisesRegex(RuntimeError,'announced'):self.n['fresh_worker_process']()
  identities=iter([identity,'b'*64+' 2026-10-07T12:00:01.000Z']);self.n.update(text=lambda a:next(identities),run=lambda *a,**k:SimpleNamespace(stdout=event))
  with self.assertRaisesRegex(RuntimeError,'restarted'):self.n['fresh_worker_process']()
 def test_rollback_restores_pointers_even_when_old_worker_health_fails(self):
  with tempfile.TemporaryDirectory() as temp:
   root=P(temp).resolve()/'app';web=P(temp).resolve()/'web';config=P(temp).resolve()/'config';backup=P(temp).resolve()/'backup'
   for q in [root,web,config,backup]:q.mkdir()
   old=root/'old';new=root/'new';oldweb=web/'old';newweb=web/'new'
   for q in [old,new,oldweb,newweb]:q.mkdir()
   (root/'current').symlink_to(new);(root/'previous').symlink_to(old);(web/'current').symlink_to(newweb)
   (config/'release.env').write_bytes(b'candidate');(backup/'release.env').write_bytes(b'old')
   digest='sha256:'+'1'*64
   before={'app':str(old),'web':str(oldweb),'nginxSHA256':'n','otherVhostsSHA256':'o','configSHA256':{'app.env':'a','release.env':'oldhash','ds-meta-worker-runtime.yml':'r','seccomp_profile.json':'s'},'containers':[f'id /api {digest} date running',f'id /worker {digest} date running']}
   current=json.loads(json.dumps(before));current.update(app=str(new),web=str(newweb));current['configSHA256']['release.env']='newhash'
   record={'before':before,'previousTarget':None,'changedReleaseEnvSHA256':'newhash','migrations':[]}
   def unhealthy(images):raise RuntimeError('old worker unavailable')
   self.n.update(ROOT=root,WEB=web,CONFIG=config,backup=backup,release=new,webrelease=newweb,plan={'expectedApp':str(old),'expectedWeb':str(oldweb)},snapshot=lambda:current,compose=lambda *a:None,verify_app=unhealthy)
   with self.assertRaisesRegex(RuntimeError,'old worker'):self.n['restore_runtime'](record)
   self.assertEqual((root/'current').resolve(),old);self.assertEqual((web/'current').resolve(),oldweb);self.assertFalse((root/'previous').exists());self.assertEqual((config/'release.env').read_bytes(),b'old')
   self.assertEqual(json.loads((backup/'deployment.json').read_text())['status'],'rollback-runtime-restored-health-failed')


class DriverSafety(unittest.TestCase):
 def test_remote_error_keeps_full_stderr_private(self):
  import tempfile,stat
  source=P(__file__).with_name('ui_release.py').read_text();tree=ast.parse(source)
  fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='private_error')
  local={'tempfile':tempfile};exec(compile(ast.Module(body=[fn],type_ignores=[]),'<driver-function>','exec'),local)
  raw=b'private-plan-body-and-config-path\nRuntimeError: LIVE_RUNTIME_OR_CONFIGURATION_DRIFT\n'
  error=local['private_error']('stage',b'',raw);message=str(error)
  self.assertNotIn('private-plan-body-and-config-path',message);self.assertIn('LIVE_RUNTIME_OR_CONFIGURATION_DRIFT',message)
  path=P(message.split('private error log: ',1)[1])
  try:self.assertEqual(stat.S_IMODE(path.stat().st_mode),0o600);self.assertIn(raw,path.read_bytes())
  finally:path.unlink()

if __name__=='__main__':unittest.main()
