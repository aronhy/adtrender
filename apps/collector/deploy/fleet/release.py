#!/usr/bin/env python3
"""Explicit fleet release. Default invocation prints a plan and opens no connection."""
import argparse
import base64
import json
import os
import re
import shlex
import subprocess
import tempfile
from pathlib import Path
from fleet_config import load, schedules
from registry import load_registry, resolve, deployable, registry_digest, timestamp, now_seconds
from host_ops import verify_release

HERE=Path(__file__).resolve().parent


def validate_runtime(actual, wanted):
    def version(value):
        if not re.fullmatch(r'\d+\.\d+\.\d+',value): raise ValueError('FLEET_VERSION_INVALID')
        return tuple(map(int,value.split('.')))
    if version(actual['node'])<version(wanted['nodeMinimum']) or any(actual[key]!=wanted[key] for key in ['playwright','prisma']):
        raise ValueError('FLEET_RUNTIME_VERSION_MISMATCH')


def runtime_identity(info):
    # Docker's classic and containerd stores may use different image IDs.
    # Verify the runnable content (configuration + ordered uncompressed layers).
    keys=('Architecture','Os','Config','RootFS')
    if any(key not in info for key in keys) or not isinstance(info['Config'],dict) or not isinstance(info['RootFS'],dict) or not info['RootFS'].get('Layers'):
        raise ValueError('FLEET_IMAGE_IDENTITY_INVALID')
    identity={key:info[key] for key in keys}
    # Docker API 1.50 removed non-image defaults, and 1.52 omits empty fields.
    # Normalize only documented defaults; retain every nonempty value.
    defaults={'Hostname','Domainname','AttachStdin','AttachStdout','AttachStderr','Tty','OpenStdin','StdinOnce','Image','NetworkDisabled','MacAddress','StopTimeout','Cmd','Entrypoint','Env','Labels','OnBuild','User','Volumes','WorkingDir'}
    identity['Config']={key:value for key,value in info['Config'].items()
        if not (key in defaults and (value is None or value is False or value=='' or value==[] or value=={}))}
    return identity


def verified_image(info, expected):
    if runtime_identity(info)!=expected: raise ValueError('FLEET_IMAGE_CONTENT_MISMATCH')
    image=info.get('Id','')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}',image): raise ValueError('FLEET_IMAGE_INVALID')
    return image


def required_secrets(config, targets, environ):
    if not targets: return {}
    environ = dict(environ)
    try:
        bundle = json.loads(environ.get('COLLECTOR_FLEET_SSH_PASSWORDS') or '{}')
        if not isinstance(bundle, dict) or any(not isinstance(v, str) for v in bundle.values()): raise ValueError()
    except ValueError: raise ValueError('FLEET_SECRET_BUNDLE_INVALID') from None
    # Legacy individual secret names remain supported for the first US rollout.
    environ.update(bundle)
    names={config['source']['passwordSecret'],*(target['passwordSecret'] for target in targets)}
    if any(not environ.get(name) for name in names): raise ValueError('FLEET_EXTERNAL_SSH_SECRETS_REQUIRED')
    return {name:environ[name] for name in names}


def check_credentials(config, targets, environ):
    available = []
    for target in targets:
        try: required_secrets(config, [target], environ)
        except ValueError: continue
        available.append(target['id'])
    if targets and not available: raise ValueError('FLEET_EXTERNAL_SSH_SECRETS_REQUIRED')
    return available


def deploy(remote, config, target, artifact):
    if not target.get('enabled', True) or (target.get('expiresAt') and timestamp(target['expiresAt']) <= now_seconds()):
        raise ValueError('FLEET_NODE_INACTIVE')
    revision=artifact['manifest']['revision']; common={'config':config,'node':target['id'],'revision':revision}
    if not target['platforms']:
        status=remote.rpc('target','target_status',**common)
        if status['owned']: raise ValueError('FLEET_OWNED_QUEUE_REQUIRES_HANDOVER')
        if status.get('standby') and status.get('revision')==revision:
            return {'node':target['id'],'status':'ALREADY_STANDBY','revision':revision}
        validate_runtime(artifact['runtimeVersions'],artifact['manifest']['runtime'])
        image=remote.image(artifact['runtimeImage'],artifact['runtimeRef'],artifact['runtimeIdentity'])
        remote.rpc('target','target_standby',**common,artifact={**artifact,'runtimeImage':image})
        return {'node':target['id'],'status':'STANDBY_READY','revision':revision}
    remote.rpc('source','source_reserve',**common)
    status=remote.rpc('target','target_status',**common)
    # Recover an interrupted older CI run before another revision captures owners.
    for pending in status.get('pending',[]):
        prior={**common,'revision':pending['revision']}
        if pending['status']=='ACTIVATED':
            remote.rpc('source','source_commit',**{**prior,'revision':pending.get('handoverRevision') or pending['revision']})
            remote.rpc('target','target_complete',**prior)
        else:
            remote.rpc('target','target_rollback',**prior)
            if not pending['previous']:remote.rpc('source','source_resume',**prior)
    if status.get('pending'):status=remote.rpc('target','target_status',**common)
    if status.get('revision')==revision and status['owned'] and status.get('complete'):
        remote.rpc('source','source_commit',**{**common,'revision':status['handoverRevision']})
        return {'node':target['id'],'status':'ALREADY_DEPLOYED','revision':revision}
    inspected=remote.rpc('source','source_inspect',**common)
    validate_runtime(artifact['runtimeVersions'],artifact['manifest']['runtime'])
    inspected['image']=remote.image(artifact['runtimeImage'],artifact['runtimeRef'],artifact['runtimeIdentity'])
    prepared=False; paused=False; activated=False
    try:
        # Mark before RPC: a disconnected response may still have stopped workers.
        prepared=True
        remote.rpc('target','target_prepare',**common,artifact=artifact,inspected=inspected)
        remote.rpc('source','source_sql',**common,files=artifact['files'])
        remote.rpc('target','target_probe',**common)
        if not status['owned']:
            paused=True
            remote.rpc('source','source_pause',**common)
            snapshot=remote.rpc('source','source_snapshot',**common)
            remote.snapshot(snapshot,target,revision)
            remote.rpc('target','target_import',**common,snapshot=snapshot)
        remote.rpc('target','target_activate',**common,handoverRevision=status.get('handoverRevision') or revision)
        activated=True
        remote.rpc('source','source_commit',**{**common,'revision':status.get('handoverRevision') or revision})
        remote.rpc('target','target_complete',**common)
        return {'node':target['id'],'status':'DEPLOYED','revision':revision}
    except Exception:
        if activated: raise RuntimeError('FLEET_OWNER_COMMIT_PENDING_TARGET_RETAINED') from None
        if prepared:
            try: remote.rpc('target','target_rollback',**common)
            except Exception: raise RuntimeError('FLEET_TARGET_STOP_UNCONFIRMED_SOURCE_LEFT_PAUSED') from None
        if paused: remote.rpc('source','source_resume',**common)
        raise


class Connection:
    def __init__(self, node, password, directory):
        self.directory=Path(directory)/node['id'];self.directory.mkdir(mode=0o700)
        self.password=self.directory/'password';self.password.write_text(password);self.password.chmod(0o600)
        self.askpass=self.directory/'askpass.sh';self.askpass.write_text('#!/bin/sh\nexec cat "$FLEET_PASSWORD_FILE"\n');self.askpass.chmod(0o700)
        hosts=self.directory/'known_hosts'
        host=node['host'] if node['port']==22 else '['+node['host']+']:'+str(node['port'])
        hosts.write_text(host+' '+node['publicHostKey']+'\n');hosts.chmod(0o600)
        self.args=['ssh','-T','-F','/dev/null','-p',str(node['port']),'-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(hosts),'-o','GlobalKnownHostsFile=/dev/null','-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-o','PreferredAuthentications=password,keyboard-interactive','-o','PubkeyAuthentication=no','-o','NumberOfPasswordPrompts=1',node['user']+'@'+node['host']]
        self.env={**os.environ,'SSH_ASKPASS':str(self.askpass),'SSH_ASKPASS_REQUIRE':'force','DISPLAY':'adtrender-ci:0','FLEET_PASSWORD_FILE':str(self.password)}
        self.privilege = node.get('privilege', 'root')
        # The child receives only its file reference, never all CI secrets.
        for key in list(self.env):
            if key.startswith('COLLECTOR_') and (key.endswith('_SSH_PASSWORD') or key == 'COLLECTOR_FLEET_SSH_PASSWORDS'): del self.env[key]
    def command(self,args): return [*self.args,shlex.join((['sudo','-n','--'] if self.privilege == 'sudo' else [])+args)]


class SSHRemote:
    def __init__(self, config, target, secrets, directory, image_archive):
        self.config=config;self.target=target
        self.image_archive=Path(image_archive)
        self.connections={role:Connection(node,secrets[node['passwordSecret']],directory) for role,node in [('source',config['source']),('target',target)]}
        modules={name:base64.b64encode((HERE/(name+'.py')).read_bytes()).decode() for name in ['fleet_config','host_ops']}
        self.bootstrap="import base64,types,sys;"+''.join("m=types.ModuleType(%r);sys.modules[%r]=m;exec(base64.b64decode(%r),m.__dict__);"%(name,name,body) for name,body in modules.items())+"sys.modules['host_ops'].rpc_main()"
    def rpc(self,host,action,**payload):
        connection=self.connections[host]
        if action=='target_prepare': payload['primaryPassword']=self.connections['source'].password.read_text()
        result=subprocess.run(connection.command(['python3','-B','-c',self.bootstrap]),env=connection.env,input=json.dumps({'action':action,**payload}),capture_output=True,text=True,timeout=1200)
        if result.returncode:
            code=result.stderr.strip()
            raise RuntimeError(code if re.fullmatch(r'FLEET_[A-Z_]+',code) else 'FLEET_RPC_FAILED_'+action.upper())
        try: return json.loads(result.stdout)
        except ValueError: raise RuntimeError('FLEET_RPC_RESPONSE_INVALID') from None
    def pipe(self,left,right):
        source=self.connections['source'];target=self.connections['target']
        sender=subprocess.Popen(source.command(left),env=source.env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
        try:
            receiver=subprocess.Popen(target.command(right),env=target.env,stdin=sender.stdout,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            sender.stdout.close()
            try:
                if receiver.wait(timeout=1800) or sender.wait(timeout=60): raise RuntimeError('FLEET_STREAM_TRANSFER_FAILED')
            finally:
                if receiver.poll() is None: receiver.kill();receiver.wait()
        finally:
            if sender.poll() is None: sender.kill();sender.wait()
    def image(self,image,reference,expected):
        if not re.fullmatch(r'sha256:[0-9a-f]{64}',image): raise ValueError('FLEET_IMAGE_INVALID')
        if not re.fullmatch(r'adtrender-collector-runtime:[0-9a-f]{40}',reference): raise ValueError('FLEET_IMAGE_REFERENCE_INVALID')
        target=self.connections['target']
        def inspect():
            return subprocess.run(target.command(['docker','image','inspect',reference]),env=target.env,capture_output=True,text=True,timeout=30)
        result=inspect()
        if not result.returncode:
            try: return verified_image(json.loads(result.stdout)[0],expected)
            except ValueError as error:
                if str(error)!='FLEET_IMAGE_CONTENT_MISMATCH': raise
        # A CI retry can rebuild the same commit with different layer metadata.
        # Replace only this release tag from the supplied archive, then verify.
        # Never use a source-host ID remotely or run an unverified cached image.
        with self.image_archive.open('rb') as handle:
            loaded=subprocess.run(target.command(['docker','load']),env=target.env,stdin=handle,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=1800)
        if loaded.returncode:raise RuntimeError('FLEET_RUNTIME_IMAGE_TRANSFER_FAILED')
        result=inspect()
        if result.returncode: raise RuntimeError('FLEET_RUNTIME_IMAGE_MISSING')
        try: info=json.loads(result.stdout)[0]
        except (ValueError,IndexError,TypeError): raise RuntimeError('FLEET_IMAGE_INSPECT_INVALID') from None
        return verified_image(info,expected)
    def snapshot(self,snapshot,target,revision):
        source_path=Path(snapshot['path'])
        expected=Path('/var/lib/adtrender-collector-fleet')/target['id']/revision/'snapshot.tar.gz'
        if source_path!=expected: raise ValueError('FLEET_SNAPSHOT_TRANSFER_PATH_INVALID')
        destination='/opt/adtrender-collectors/'+target['id']+'/incoming/'+revision+'.tar.gz'
        script="import os,sys,shutil;from pathlib import Path;p=Path(sys.argv[1]);p.parent.mkdir(parents=True,exist_ok=True,mode=0o700);t=p.with_suffix('.pending');f=os.open(t,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);h=os.fdopen(f,'wb');shutil.copyfileobj(sys.stdin.buffer,h);h.flush();os.fsync(h.fileno());h.close();os.replace(t,p)"
        self.pipe(['cat',str(source_path)],['python3','-B','-c',script,destination])


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',default=str(HERE/'targets.json'));parser.add_argument('--registry');parser.add_argument('--artifact');parser.add_argument('--runtime-image');parser.add_argument('--image-archive');parser.add_argument('--execute',action='store_true');parser.add_argument('--check-credentials',action='store_true');args=parser.parse_args()
    registry=load_registry(args.registry);config,states=resolve(load(args.config),registry);targets=[t for t in config['targets'] if deployable(t)]
    if args.check_credentials: check_credentials(config, targets, os.environ)
    if not args.execute:
        print(json.dumps({'status':'PLAN_ONLY','branch':config['releaseBranch'],'nodes':states,'targets':[{'id':t['id'],'host':t['host'],'platforms':t['platforms'],'aliases':t['aliases'],'minutes':schedules(t)} for t in targets],'requiredSecrets':sorted({config['source']['passwordSecret'],*(t['passwordSecret'] for t in targets)}) if targets else []}));return
    if not targets: print(json.dumps({'status':'NO_ELIGIBLE_TARGETS','nodes':states})); return
    if not args.artifact or not args.image_archive or not re.fullmatch(r'sha256:[0-9a-f]{64}',args.runtime_image or ''): raise ValueError('FLEET_ARTIFACT_AND_RUNTIME_IMAGE_REQUIRED')
    root=Path(args.artifact);manifest=verify_release(root)
    if load(root/'targets.json')['source']!=config['source']: raise ValueError('FLEET_SOURCE_CONFIG_DRIFT')
    versions=subprocess.run(['docker','run','--rm','--read-only','--network','none','--workdir','/opt/ad-research/app',args.runtime_image,'node','-e',"console.log(JSON.stringify({node:process.versions.node,playwright:require('playwright/package.json').version,prisma:require('@prisma/client/package.json').version}))"],capture_output=True,text=True,check=True,timeout=30)
    reference='adtrender-collector-runtime:'+manifest['revision']
    info=json.loads(subprocess.run(['docker','image','inspect',reference],capture_output=True,text=True,check=True,timeout=30).stdout)[0]
    if info['Id']!=args.runtime_image: raise ValueError('FLEET_IMAGE_REFERENCE_DRIFT')
    artifact={'runtimeRef':reference,'runtimeIdentity':runtime_identity(info),'manifest':manifest,'runtimeImage':args.runtime_image,'runtimeVersions':json.loads(versions.stdout),'files':{item['path']:base64.b64encode((root/item['path']).read_bytes()).decode() for item in manifest['files']}}
    validate_runtime(artifact['runtimeVersions'],manifest['runtime'])
    with tempfile.TemporaryDirectory(prefix='adtrender-fleet-') as directory:
        failed=False
        for target in targets:
            target_directory=Path(directory)/target['id'];target_directory.mkdir(mode=0o700)
            try:
                secrets=required_secrets(config,[target],os.environ)
                remote=SSHRemote(config,target,secrets,target_directory,args.image_archive)
                result=deploy(remote,config,target,artifact)
                from reconcile import authorize
                result['assignment']=authorize(remote,config,target,manifest['revision'],registry_digest(registry)) if target['platforms'] else {'status':'IDLE_NO_ASSIGNMENT'}
                print(json.dumps(result),flush=True)
            except Exception as error:
                code=str(error) if re.fullmatch(r'FLEET_[A-Z_]+',str(error)) else 'FLEET_DEPLOY_FAILED'
                failed=True;print(json.dumps({'node':target['id'],'status':'DEPLOY_FAILED','errorCode':code}),flush=True)
        if failed: raise RuntimeError('FLEET_SOME_NODES_FAILED')


if __name__=='__main__':
    try:main()
    except Exception as error:
        code=str(error) if re.fullmatch(r'FLEET_[A-Z_]+',str(error)) else 'FLEET_RELEASE_FAILED'
        print(code,file=__import__('sys').stderr);raise SystemExit(1)
