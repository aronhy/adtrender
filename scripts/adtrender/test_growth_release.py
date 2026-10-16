import ast,hashlib,json,pathlib,re,tempfile,unittest
P=pathlib.Path
SOURCE=P(__file__).with_name('growth_release_remote.py').read_text()
module=ast.parse(SOURCE)
nodes=[n for n in module.body if isinstance(n,(ast.Import,ast.ImportFrom,ast.FunctionDef))]
ns={};exec(compile(ast.Module(body=nodes,type_ignores=[]),'<remote-functions>','exec'),ns)
ns.update(P=P,sha=lambda b:hashlib.sha256(b).hexdigest(),DB='fake-database')
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
   manifest={'sourceCommit':'a'*40,'workingTreeDirty':False,'releaseId':'test','artifactHash':'b'*64,'publicApiUrl':'https://adtrender.com','files':[entry]}
   (root/'release-manifest.json').write_text(json.dumps(manifest))
   ns.update(release=root,version='test',ORIGIN='https://adtrender.com',plan={'sourceCommit':'a'*40,'artifactHash':'b'*64})
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
if __name__=='__main__':unittest.main()
