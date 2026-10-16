#!/usr/bin/env python3
"""Fixed-artifact growth release driver. prepare/inspect are read-only remotely.
Only stage/activate/rollback with --execute may write the server.
"""
import argparse,hashlib,json,pathlib,re,shlex,subprocess,tarfile
import ssh_connection as ssh
BASE=pathlib.Path(__file__).resolve().parent; HELPER=BASE/'growth_release_remote.py'
sha=lambda b:hashlib.sha256(b).hexdigest()
def remote(mode,plan):
 env,common=ssh.connection()
 command='python3 - '+shlex.join([mode,json.dumps(plan,separators=(',',':'))])
 run=subprocess.run(['ssh',*common,ssh.HOST,command],input=HELPER.read_bytes(),env=env,stdout=subprocess.PIPE,check=True)
 return json.loads(run.stdout)
def load(root): return json.loads((root/'plan.json').read_text())
p=argparse.ArgumentParser(description=__doc__); sub=p.add_subparsers(dest='mode',required=True)
q=sub.add_parser('prepare'); q.add_argument('--artifact-dir',required=True); q.add_argument('--source-commit',required=True); q.add_argument('--version',default='20261007-growth'); q.add_argument('--expected-app',required=True); q.add_argument('--expected-web',required=True); q.add_argument('--output',required=True)
for mode in ['inspect','stage','activate','rollback']:
 q=sub.add_parser(mode); q.add_argument('--plan-dir',required=True)
 if mode!='inspect':q.add_argument('--execute',action='store_true')
a=p.parse_args()
if a.mode=='prepare':
 artifact=pathlib.Path(a.artifact_dir).resolve(strict=True); out=pathlib.Path(a.output).absolute()
 if out.exists():raise RuntimeError('Plan output already exists')
 ssh.release_id(a.version)
 if not re.fullmatch(r'[0-9a-f]{40}',a.source_commit):raise RuntimeError('Fixed full commit required')
 m=json.loads((artifact/'release-manifest.json').read_text())
 if m['sourceCommit']!=a.source_commit or m['workingTreeDirty'] is not False or m['releaseId']!=a.version or m['publicApiUrl']!='https://adtrender.com':raise RuntimeError('Fixed clean release provenance required')
 expected={e['path']:e for e in m['files']}
 if len(expected)!=len(m['files']):raise RuntimeError('Duplicate artifact inventory')
 actual={str(f.relative_to(artifact)) for f in artifact.rglob('*') if f.is_file()}
 if actual!=set(expected)|{'release-manifest.json'}:raise RuntimeError('Artifact inventory mismatch')
 for name,e in expected.items():
  f=artifact/name
  if f.is_symlink() or not f.resolve().is_relative_to(artifact) or sha(f.read_bytes())!=e['sha256'] or f.stat().st_size!=e['sizeBytes']:raise RuntimeError('Artifact file mismatch')
 for f in artifact.rglob('*'):
  if f.is_symlink():raise RuntimeError('Artifact symlink rejected')
 plan={'version':a.version,'sourceCommit':a.source_commit,'artifactHash':m['artifactHash'],'expectedApp':a.expected_app,'expectedWeb':a.expected_web,'migrationName':'20261007190000_growth_attribution'}
 # Capture the live configuration/container fingerprint without modifying it.
 plan['baseline']=remote('inspect',plan)
 out.mkdir(mode=0o700)
 with tarfile.open(out/'bundle.tar.gz','w:gz',format=tarfile.PAX_FORMAT) as archive:
  for name in ['release-manifest.json',*sorted(expected)]:archive.add(artifact/name,arcname=name,recursive=False)
 plan['archiveSHA256']=sha((out/'bundle.tar.gz').read_bytes())
 (out/'plan.json').write_text(json.dumps(plan,indent=2)+'\n')
 print(json.dumps({'status':'PREPARED_NOT_DEPLOYED','planDir':str(out),'version':a.version,'sourceCommit':a.source_commit,'archiveSHA256':plan['archiveSHA256']}))
else:
 root=pathlib.Path(a.plan_dir).resolve(strict=True); plan=load(root)
 if a.mode=='inspect':print(json.dumps(remote('inspect',plan),indent=2))
 else:
  if not a.execute:raise RuntimeError('Remote writes disabled: explicit --execute required')
  if a.mode=='stage':
   if sha((root/'bundle.tar.gz').read_bytes())!=plan['archiveSHA256']:raise RuntimeError('Local archive changed')
   remote('reserve',plan)
   env,common=ssh.connection(); destination='/opt/ad-research-test/backups/growth-'+plan['version']+'/bundle.tar.gz'
   subprocess.run(['scp',*common,str(root/'bundle.tar.gz'),ssh.HOST+':'+destination],env=env,stdin=subprocess.DEVNULL,check=True)
  result=remote(a.mode,plan)
  (root/(a.mode+'-result.json')).write_text(json.dumps(result,indent=2)+'\n'); print(json.dumps(result,indent=2))
