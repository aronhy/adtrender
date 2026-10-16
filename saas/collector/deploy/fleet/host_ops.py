"""Deployment RPC operations. No action runs merely by importing this module."""
import base64
import hashlib
import io
import json
import os
import re
import shutil
import stat
import subprocess
import tarfile
import time
import fcntl
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from fleet_config import PLATFORMS, rewrite_database_url, schedules, load

ROOT = Path('/opt/adtrender-collectors')
SYSTEMD = Path('/etc/systemd/system')
SOURCE_STATE = Path('/var/lib')
ASSIGNMENT_ROOT = Path('/var/lib/adtrender-collector-fleet')


def source_reserve(target):
    """Keep durable queue ownership: expiry alone cannot safely transfer a checkpoint."""
    ASSIGNMENT_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (ASSIGNMENT_ROOT/'assignments.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = ASSIGNMENT_ROOT/'assignments.json'
        owners = json.loads(path.read_text()) if path.exists() else {}
        for platform in target['platforms']:
            if platform in owners and owners[platform] != target['id']:
                raise ValueError('FLEET_CHECKPOINT_TRANSFER_REQUIRED')
        owners.update({p:target['id'] for p in target['platforms']})
        private_write(path, json.dumps(owners))
    return {'status':'ASSIGNMENT_RESERVED'}


def target_authorize(config, target, revision, permit):
    root = node_root(target)
    status = target_status(target)
    if not status['owned'] or status['revision'] != revision or not status.get('complete'):
        raise ValueError('FLEET_NODE_NOT_READY')
    # Old artifacts have autonomous runners; never authorize them through this protocol.
    if not (root/'current'/'authorization.py').is_file(): raise ValueError('FLEET_DISPATCH_RUNTIME_REQUIRED')
    now = datetime.now(timezone.utc).timestamp()
    issued_date = datetime.fromisoformat(permit['issuedAt']); until_date = datetime.fromisoformat(permit['validUntil'])
    if issued_date.tzinfo is None or until_date.tzinfo is None: raise ValueError('FLEET_AUTHORIZATION_INVALID')
    issued = issued_date.timestamp(); until = until_date.timestamp()
    if (not target['platforms'] or not target.get('enabled', True) or permit['schema'] != 1 or permit['scope'] != 'platform_queue'
            or permit['node'] != target['id'] or permit['revision'] != revision
            or permit['platforms'] != target['platforms'] or not 0 < until-issued <= 2400
            or abs(now-issued) > 60 or until <= now): raise ValueError('FLEET_AUTHORIZATION_INVALID')
    if target.get('expiresAt') and until > datetime.fromisoformat(target['expiresAt'].replace('Z', '+00:00')).timestamp():
        raise ValueError('FLEET_AUTHORIZATION_PAST_EXPIRY')
    # Updating platform ownership needs a new deployment/handoff, never a permit rewrite.
    old = load(root/'config'/'fleet.json')
    previous = next(n for n in old['targets'] if n['id'] == target['id'])
    mutable = {'enabled', 'expiresAt', 'autoDeploy'}
    if {k:v for k,v in previous.items() if k not in mutable} != {k:v for k,v in target.items() if k not in mutable}:
        raise ValueError('FLEET_REDEPLOY_REQUIRED')
    private_write(root/'config'/'fleet.json', json.dumps(config))
    private_write(root/'config'/'authorization.json', json.dumps(permit))
    timers = [f"adtrender-{target['id']}-{p}.timer" for p in target['platforms']]
    run(['systemctl','enable','--now',*timers])
    return {'status':'AUTHORIZED', 'validUntil':permit['validUntil']}


def target_revoke(target):
    root = node_root(target)
    (root/'config'/'authorization.json').unlink(missing_ok=True)
    # Use the deployed platform list, including assignments removed centrally.
    if (root/'config'/'fleet.json').exists():
        old = load(root/'config'/'fleet.json')
        target = next(n for n in old['targets'] if n['id'] == target['id'])
    if root.exists(): stop_target(target)
    return {'status':'REVOKED'}


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024*1024), b''): h.update(chunk)
    return h.hexdigest()


def member_path(value):
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or '..' in path.parts or '\\' in value or str(path) != value:
        raise ValueError('FLEET_ARCHIVE_PATH_INVALID')
    return path


def verify_release(root):
    root = Path(root); manifest = json.loads((root/'manifest.json').read_text())
    if manifest.get('schema') != 1 or manifest.get('cleanTree') is not True or not re.fullmatch(r'[0-9a-f]{40}', manifest.get('revision', '')):
        raise ValueError('FLEET_RELEASE_PROVENANCE_INVALID')
    wanted = set()
    if not manifest.get('files'): raise ValueError('FLEET_RELEASE_INVENTORY_INVALID')
    for item in manifest['files']:
        name = str(member_path(item['path']))
        if name in wanted or name == 'manifest.json' or not re.fullmatch(r'[0-9a-f]{64}', item['sha256']): raise ValueError('FLEET_RELEASE_INVENTORY_INVALID')
        wanted.add(name); path = root/name
        if any(parent.is_symlink() for parent in [path,*path.parents] if parent.is_relative_to(root)) or not path.is_file() or path.stat().st_size != item['bytes'] or digest(path) != item['sha256']:
            raise ValueError('FLEET_RELEASE_HASH_INVALID')
    actual = set()
    for path in root.rglob('*'):
        if path.is_symlink(): raise ValueError('FLEET_RELEASE_SYMLINK_INVALID')
        if path.is_file() and path != root/'manifest.json': actual.add(str(path.relative_to(root)))
        elif not path.is_file() and not path.is_dir(): raise ValueError('FLEET_RELEASE_SPECIAL_FILE_INVALID')
    if actual != wanted: raise ValueError('FLEET_RELEASE_INVENTORY_INVALID')
    return manifest


def extract_snapshot(archive, root):
    root = Path(root)
    with tarfile.open(archive) as tar:
        members = tar.getmembers(); seen = set()
        for member in members:
            path = member_path(member.name)
            if path.parts[0] not in PLATFORMS or not (member.isdir() or member.isfile()) or member.name in seen:
                raise ValueError('FLEET_SNAPSHOT_MEMBER_INVALID')
            seen.add(member.name)
            if member.size > 128*1024*1024: raise ValueError('FLEET_SNAPSHOT_FILE_TOO_LARGE')
        if sum(m.size for m in members)>shutil.disk_usage(root.parent).free-2*1024**3:
            raise ValueError('FLEET_SNAPSHOT_DISK_LOW')
        root.mkdir(parents=True, exist_ok=True)
        for member in members:
            target = root/member.name
            if any(parent.is_symlink() for parent in [target, *target.parents] if parent.is_relative_to(root)):
                raise ValueError('FLEET_SNAPSHOT_DESTINATION_SYMLINK')
            if member.isdir(): target.mkdir(parents=True, exist_ok=True, mode=0o700)
            else:
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with tar.extractfile(member) as source, target.open('xb') as output: shutil.copyfileobj(source, output)
                target.chmod(0o600)
            if os.geteuid() == 0: os.chown(target, 1000, 1000)


def activate_files(root, candidate):
    root = Path(root).resolve(); candidate = Path(candidate).resolve()
    if not candidate.is_dir() or not candidate.is_relative_to(root): raise ValueError('FLEET_CANDIDATE_OUTSIDE_NODE')
    current = root/'current'
    if current.exists() and not current.is_symlink(): raise ValueError('FLEET_CURRENT_NOT_SYMLINK')
    receipt = {'previous': str(current.resolve()) if current.is_symlink() else None, 'candidate': str(candidate)}
    temporary = root/'current.pending'; temporary.unlink(missing_ok=True); temporary.symlink_to(candidate); os.replace(temporary, current)
    return receipt


def rollback_files(root, receipt):
    root = Path(root); current = root/'current'
    if not current.is_symlink() or str(current.resolve()) != receipt['candidate']: raise ValueError('FLEET_ROLLBACK_DRIFT')
    if receipt['previous']:
        previous = Path(receipt['previous']).resolve()
        if not previous.is_relative_to(root.resolve()): raise ValueError('FLEET_ROLLBACK_PATH_INVALID')
        temporary = root/'current.pending'; temporary.unlink(missing_ok=True); temporary.symlink_to(previous); os.replace(temporary, current)
    else: current.unlink()


def run(args, timeout=30, check=True, input=None):
    result = subprocess.run(args, input=input, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode: raise RuntimeError('FLEET_COMMAND_FAILED')
    return result


def private_write(path, content):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name+'.pending')
    fd = os.open(temporary, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w') as handle: handle.write(content); handle.flush(); os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally: temporary.unlink(missing_ok=True)


def public_write(path, content, executable=False):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content); path.chmod(0o755 if executable else 0o644)


def node_root(target):
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,30}', target['id']): raise ValueError('FLEET_NODE_INVALID')
    return ROOT/target['id']


def snapshot_root(target, revision):
    if not re.fullmatch(r'[0-9a-f]{40}', revision): raise ValueError('FLEET_REVISION_INVALID')
    return Path('/var/lib/adtrender-collector-fleet')/target['id']/revision


def source_inspect(config, target):
    source = config['source']; metadata = json.loads(run(['docker','inspect',source['databaseContainer']]).stdout)[0]
    ip = metadata['NetworkSettings']['Networks'][source['databaseNetwork']]['IPAddress']
    if not re.fullmatch(r'(?:\d{1,3}\.){3}\d{1,3}', ip): raise ValueError('FLEET_DATABASE_ADDRESS_INVALID')
    configs = {}
    for platform in target['platforms']:
        path = Path('/etc')/(platform+'-collector.env'); info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600: raise ValueError('FLEET_SOURCE_CREDENTIAL_MODE_INVALID')
        text = path.read_text(); database = next((line.split('=',1)[1] for line in text.splitlines() if line.startswith('DATABASE_URL=')),None)
        rewrite_database_url(database or '',platform,target['databaseRelay'])
        configs[platform] = text
    return {'databaseIP':ip,'configs':configs}


def source_pause(config, target, revision):
    record = snapshot_root(target,revision); record.mkdir(parents=True,exist_ok=True,mode=0o700)
    path = record/'handover.json'
    receipt=json.loads(path.read_text()) if path.exists() else None
    if receipt and receipt['committed']: raise ValueError('FLEET_SOURCE_ALREADY_TRANSFERRED')
    if not receipt or receipt.get('resumed'):
        services = {p:run(['systemctl','is-active',p+'-collector.service'],check=False).stdout.strip()=='active' for p in target['platforms']}
        enabled = {p:run(['systemctl','is-enabled',p+'-collector.service'],check=False).stdout.strip()=='enabled' for p in target['platforms']}
        receipt = {'services':services,'enabled':enabled,'committed':False,'revision':revision}
        private_write(path,json.dumps(receipt));(record/'snapshot.tar.gz').unlink(missing_ok=True)
    run(['systemctl','stop',*[p+'-collector.service' for p in target['platforms']]],timeout=360)
    for platform in target['platforms']:
        active=run(['docker','inspect','--format','{{.State.Running}}',platform+'-collector'],check=False)
        if active.returncode==0 and active.stdout.strip()=='true': raise ValueError('FLEET_SOURCE_CONTAINER_STILL_ACTIVE')
    return receipt


def source_snapshot(config, target, revision):
    record = snapshot_root(target,revision); receipt = json.loads((record/'handover.json').read_text())
    if receipt['committed']: raise ValueError('FLEET_SOURCE_ALREADY_TRANSFERRED')
    for p in target['platforms']:
        if run(['systemctl','is-active',p+'-collector.service'],check=False).stdout.strip()=='active': raise ValueError('FLEET_SOURCE_STILL_ACTIVE')
    archive = record/'snapshot.tar.gz'
    if not archive.exists():
        temporary=archive.with_suffix('.pending');temporary.unlink(missing_ok=True)
        try:
            with temporary.open('xb') as output,tarfile.open(fileobj=output,mode='w:gz') as tar:
                temporary.chmod(0o600)
                for platform in target['platforms']:
                    root = SOURCE_STATE/(platform+'-collector')/'evidence'
                    if root.is_symlink() or not (root/'state.json').is_file(): raise ValueError('FLEET_SOURCE_CHECKPOINT_MISSING')
                    for path in sorted(root.rglob('*')):
                        if path.name in ['SingletonLock','SingletonCookie','SingletonSocket','process.lock']: continue
                        if path.is_symlink() or not (path.is_dir() or path.is_file()): raise ValueError('FLEET_SOURCE_SPECIAL_FILE')
                        tar.add(path,arcname=platform+'/'+str(path.relative_to(root)),recursive=False)
            os.replace(temporary,archive)
        finally:temporary.unlink(missing_ok=True)
    return {'path':str(archive),'sha256':digest(archive),'bytes':archive.stat().st_size}


def source_finish(config, target, revision, committed):
    record = snapshot_root(target,revision); path = record/'handover.json'
    if not path.exists(): return {'status':'NO_HANDOVER'}
    receipt = json.loads(path.read_text())
    if committed:
        run(['systemctl','disable','--now',*[p+'-collector.service' for p in target['platforms']]],timeout=360)
        receipt['committed']=True;private_write(path,json.dumps(receipt));return {'status':'OWNER_TRANSFERRED'}
    if receipt['committed']: raise ValueError('FLEET_COMMITTED_OWNER_CANNOT_RESUME')
    enabled=[p+'-collector.service' for p,was_enabled in receipt.get('enabled',{}).items() if was_enabled]
    if enabled:run(['systemctl','enable',*enabled])
    active=[p+'-collector.service' for p,was_active in receipt['services'].items() if was_active]
    if active:run(['systemctl','start',*active])
    receipt['resumed']=True;private_write(path,json.dumps(receipt))
    return {'status':'SOURCE_RESUMED'}


def source_apply_sql(config, target, files):
    for platform in target['platforms']:
        text=files[platform+'.ingest.sql']
        run(['docker','exec','-i',config['source']['databaseContainer'],'psql','-X','-q','-v','ON_ERROR_STOP=1','-U','saas_migrator','-d','ad_research_test'],input=text,timeout=120)
    return {'status':'COLLECTOR_FUNCTIONS_UPDATED'}


def worker_units(target):
    root=node_root(target); units={}
    for platform,minutes in schedules(target).items():
        name=f"adtrender-{target['id']}-{platform}"
        units[name+'.service']=f'''[Unit]
Description=AdTrender {platform} collector on {target['id']}
Requires=docker.service {target['databaseRelay']}.service
After=docker.service {target['databaseRelay']}.service
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 -B {root}/current/runner.py --node {target['id']} --platform {platform}
TimeoutStartSec={target['runSeconds']+target['shutdownSeconds']*2+60}
TimeoutStopSec={target['shutdownSeconds']+60}
KillMode=process
UMask=0077
NoNewPrivileges=true
'''
        units[name+'.timer']=f'''[Unit]
Description=AdTrender staggered {platform} slot
[Timer]
OnCalendar=*-*-* *:{','.join(f'{m:02}' for m in minutes)}:00
AccuracySec=1s
Persistent=true
Unit={name}.service
[Install]
WantedBy=timers.target
'''
    return units


def stop_target(target):
    timers=[f"adtrender-{target['id']}-{p}.timer" for p in target['platforms']]
    services=[f"adtrender-{target['id']}-{p}.service" for p in target['platforms']]
    if timers: run(['systemctl','stop',*timers],check=False)
    if services: run(['systemctl','stop',*services],timeout=target['shutdownSeconds']+60,check=False)
    remaining=run(['docker','ps','--filter','label=adtrender.fleet.node='+target['id'],'--format','{{.Names}}']).stdout.strip()
    if remaining: raise ValueError('FLEET_TARGET_STILL_COLLECTING')
    return timers


def extra_units(config,target,candidate):
    root=node_root(target);relay=target['databaseRelay'];feed=f"adtrender-{target['id']}-candidates"
    units=worker_units(target)
    units[relay+'.service']=f'''[Unit]
Description=Private encrypted collector database relay
Requires=docker.service
After=docker.service network-online.target
[Service]
Type=simple
EnvironmentFile={root}/config/relay.env
LoadCredential=primary-password:{root}/config/relay/primary-password
ExecStartPre=-/usr/bin/docker rm -f {relay}
ExecStart=/bin/sh {candidate}/relay-run.sh
ExecStop=/usr/bin/docker stop --time 15 {relay}
Restart=on-failure
RestartSec=15
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
'''
    units[feed+'.service']=f'''[Unit]
Description=Mirror source-owned Snapchat candidate feed
Requires={relay}.service
After={relay}.service
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 -B {root}/current/candidate-refresh.py --node {target['id']}
TimeoutStartSec=60
UMask=0077
NoNewPrivileges=true
'''
    units[feed+'.timer']=f'''[Unit]
Description=Refresh Snapchat candidates hourly
[Timer]
OnCalendar=hourly
Persistent=true
Unit={feed}.service
[Install]
WantedBy=timers.target
'''
    return units


def transaction(target,revision): return node_root(target)/'transactions'/revision


def target_status(target):
    root=node_root(target);owner=root/'owner.json'
    owned=json.loads(owner.read_text()) if owner.exists() else None
    revision=None
    if (root/'current').is_symlink(): revision=json.loads((root/'current'/'manifest.json').read_text())['revision']
    receipt=root/'transactions'/str(revision)/'receipt.json'
    complete=receipt.exists() and json.loads(receipt.read_text()).get('status')=='COMPLETED'
    pending=[]
    for path in sorted((root/'transactions').glob('*/receipt.json'),key=lambda p:p.stat().st_mtime):
        value=json.loads(path.read_text())
        if value['status'] in ['PREPARING','ACTIVATED']:
            pending.append({'revision':path.parent.name,'status':value['status'],'previous':value['previous'],'handoverRevision':value.get('handoverRevision')})
    standby_path=root/'standby.json'
    standby=not owned and standby_path.exists() and json.loads(standby_path.read_text()).get('revision')==revision
    return {'owned':bool(owned),'revision':revision,'complete':complete or standby,'standby':standby,'pending':pending,'handoverRevision':owned['handoverRevision'] if owned else None}


def stage_artifact(config,target,revision,artifact):
    root=node_root(target);root.mkdir(parents=True,exist_ok=True,mode=0o700)
    if artifact['manifest']['revision']!=revision: raise ValueError('FLEET_REVISION_DRIFT')
    candidate=root/'releases'/revision;candidate.parent.mkdir(parents=True,exist_ok=True)
    staged=root/'releases'/(revision+'.pending');shutil.rmtree(staged,ignore_errors=True);staged.mkdir(mode=0o755)
    for name,body in artifact['files'].items():
        path=staged/str(member_path(name));path.parent.mkdir(parents=True,exist_ok=True)
        data=base64.b64decode(body,validate=True)
        if len(data)>32*1024*1024: raise ValueError('FLEET_RELEASE_FILE_TOO_LARGE')
        path.write_bytes(data);path.chmod(0o644)
    public_write(staged/'manifest.json',json.dumps(artifact['manifest']))
    verify_release(staged)
    # Runtime registry is managed separately from the immutable code artifact.
    if load(staged/'targets.json')['source']!=config['source']: raise ValueError('FLEET_SOURCE_CONFIG_DRIFT')
    if candidate.exists():
        if verify_release(candidate)!=artifact['manifest']: raise ValueError('FLEET_IMMUTABLE_RELEASE_DRIFT')
        shutil.rmtree(staged)
    else:os.replace(staged,candidate)
    required={p+'.mjs' for p in PLATFORMS}|{'runner.py','authorization.py','seccomp_profile.json','relay-run.sh','relay-askpass.sh','runtime.Dockerfile','candidate-refresh.py'}
    if not required<=set(artifact['files']): raise ValueError('FLEET_RELEASE_FILES_MISSING')
    return candidate


def target_prepare(config,target,revision,artifact,inspected,password):
    root=node_root(target);candidate=stage_artifact(config,target,revision,artifact)
    if set(inspected['configs'])!=set(target['platforms']): raise ValueError('FLEET_PLATFORM_CONFIG_MISSING')
    tx=transaction(target,revision);receipt=tx/'receipt.json'
    if receipt.exists() and json.loads(receipt.read_text())['status'] in ['COMPLETED','ROLLED_BACK','ACTIVATED']: shutil.rmtree(tx)
    units=extra_units(config,target,candidate)
    if not receipt.exists():
        tx.mkdir(parents=True,mode=0o700)
        timers=[name for name in units if name.endswith('.timer')]
        active=[name for name in timers if run(['systemctl','is-active',name],check=False).stdout.strip()=='active']
        prior={'status':'PREPARING','image':inspected['image'],'previous':str((root/'current').resolve()) if (root/'current').is_symlink() else None,'candidate':str(candidate),'timers':active,'relayActive':run(['systemctl','is-active',target['databaseRelay']+'.service'],check=False).stdout.strip()=='active','owner':json.loads((root/'owner.json').read_text()) if (root/'owner.json').exists() else None,'units':{name:base64.b64encode((SYSTEMD/name).read_bytes()).decode() if (SYSTEMD/name).exists() else None for name in units}}
        if (root/'config').exists(): shutil.copytree(root/'config',tx/'config')
        private_write(receipt,json.dumps(prior))
    stop_target(target);run(['systemctl','stop',f"adtrender-{target['id']}-candidates.timer",f"adtrender-{target['id']}-candidates.service"],timeout=75,check=False)
    (root/'config'/'authorization.json').unlink(missing_ok=True)
    private_write(root/'config'/'fleet.json',json.dumps(config))
    run(['systemctl','stop',target['databaseRelay']+'.service'],check=False)
    if run(['docker','network','inspect',target['network']],check=False).returncode:
        run(['docker','network','create','--label','adtrender.fleet.role=collector-network',target['network']])
    relay_dir=root/'config'/'relay';relay_dir.mkdir(parents=True,exist_ok=True,mode=0o700)
    source=config['source'];host=source['host'] if source['port']==22 else '['+source['host']+']:'+str(source['port'])
    private_write(relay_dir/'known_hosts',host+' '+source['publicHostKey']+'\n')
    private_write(relay_dir/'primary-password',password)
    public_write(relay_dir/'askpass.sh',(candidate/'relay-askpass.sh').read_text(),executable=True)
    private_write(relay_dir/'ssh.conf',f'''Host primary
 HostName {source['host']}
 Port {source['port']}
 User {source['user']}
 StrictHostKeyChecking yes
 UserKnownHostsFile /relay/known_hosts
 GlobalKnownHostsFile /dev/null
 PreferredAuthentications password,keyboard-interactive
 PubkeyAuthentication no
 NumberOfPasswordPrompts 1
 ExitOnForwardFailure yes
 ConnectTimeout 15
 ServerAliveInterval 15
 ServerAliveCountMax 3
''')
    for platform,text in inspected['configs'].items():
        lines=text.splitlines();databases=[line.split('=',1)[1] for line in lines if line.startswith('DATABASE_URL=')]
        if len(databases)!=1: raise ValueError('FLEET_DATABASE_CONFIG_INVALID')
        state_key=platform.upper()+'_STATE_DIR='
        lines=[line for line in lines if not line.startswith(('DATABASE_URL=',state_key))]
        lines+=['DATABASE_URL='+rewrite_database_url(databases[0],platform,target['databaseRelay']),state_key+'/data']
        private_write(root/'config'/(platform+'.env'),'\n'.join(lines)+'\n')
    image=inspected['image']
    if not re.fullmatch(r'sha256:[0-9a-f]{64}',image): raise ValueError('FLEET_IMAGE_INVALID')
    import ipaddress
    ipaddress.ip_address(inspected['databaseIP'])
    actual_image=run(['docker','image','inspect','--format','{{.Id}}',image]).stdout.strip()
    if actual_image!=image: raise ValueError('FLEET_RUNTIME_IMAGE_MISSING')
    relay_image=image
    private_write(root/'config'/'runtime.json',json.dumps({'image':image,'relayImage':relay_image}))
    private_write(root/'config'/'relay.env','\n'.join(['FLEET_RELAY_NAME='+target['databaseRelay'],'FLEET_NETWORK='+target['network'],'FLEET_RELAY_DIR='+str(relay_dir),'FLEET_RELAY_IMAGE='+relay_image,'FLEET_DATABASE_IP='+inspected['databaseIP']])+'\n')
    for name,text in units.items(): public_write(SYSTEMD/name,text)
    run(['systemctl','daemon-reload']);run(['systemctl','enable','--now',target['databaseRelay']+'.service'])
    return {'status':'PREPARED'}


def target_probe(target,revision):
    root=node_root(target);candidate=root/'releases'/revision
    runtime=json.loads((root/'config'/'runtime.json').read_text())
    available=next(int(line.split()[1])//1024 for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))
    if available<target['minimumAvailableMiB'] or shutil.disk_usage(root).free<target['minimumFreeDiskMiB']*1024**2:
        raise ValueError('FLEET_TARGET_HEADROOM_LOW')
    # Read-only catalog queries; no live source request or test batch is imported.
    query="SELECT current_user AS username, r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls AS elevated, has_schema_privilege(current_user,'public','CREATE') AS creates, has_function_privilege(current_user,$1,'EXECUTE') AS ingests, EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) AS tables FROM pg_roles r WHERE r.rolname=current_user"
    code="const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();(async()=>{const rows=await db.$queryRawUnsafe(process.argv[2],process.argv[1]+'_collector.ingest(text)');const r=rows[0];if(!r||r.username!==process.argv[1]+'_collector_runtime'||r.elevated||r.creates||r.tables||!r.ingests)throw Error('ROLE_INVALID');await db.$disconnect()})().catch(()=>process.exit(1))"
    common=['docker','run','--rm','--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--network',target['network'],'--memory','256m','--cpus','0.25','--pids-limit','64','--workdir','/opt/ad-research/app']
    for platform in target['platforms']:
        ok=False
        for _ in range(6):
            probe=run([*common,'--env-file',str(root/'config'/(platform+'.env')),runtime['image'],'node','-e',code,platform,query],timeout=30,check=False)
            if probe.returncode==0:ok=True;break
            time.sleep(2)
        if not ok: raise ValueError('FLEET_DATABASE_RELAY_OR_ROLE_INVALID')
    probe_browser(target,candidate,runtime['image'])
    return {'status':'PRIVATE_DB_AND_OFFLINE_BROWSER_VERIFIED'}


def probe_browser(target,candidate,image):
    browser="(async()=>{const b=await require('playwright').chromium.launch({channel:'chromium',headless:true,chromiumSandbox:true});const p=await b.newPage();await p.goto('about:blank');await b.close()})().catch(()=>process.exit(1))"
    run(['docker','run','--rm','--network','none','--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--security-opt','seccomp='+str(candidate/'seccomp_profile.json'),'--tmpfs','/tmp:rw,nosuid,nodev,size=128m,mode=1777','--tmpfs','/home/node:rw,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=0700','--shm-size','128m','--memory',str(target['memoryMiB'])+'m','--cpus',target['cpus'],'--pids-limit','256','--workdir','/opt/ad-research/app',image,'node','-e',browser],timeout=60)


def target_standby(config,target,revision,artifact):
    root=node_root(target);status=target_status(target)
    if target['platforms'] or status['owned'] or status['pending']: raise ValueError('FLEET_STANDBY_REQUIRES_UNASSIGNED_NODE')
    candidate=stage_artifact(config,target,revision,artifact)
    image=artifact['runtimeImage']
    if not re.fullmatch(r'sha256:[0-9a-f]{64}',image): raise ValueError('FLEET_IMAGE_INVALID')
    if run(['docker','image','inspect','--format','{{.Id}}',image]).stdout.strip()!=image: raise ValueError('FLEET_RUNTIME_IMAGE_MISSING')
    if shutil.disk_usage(root).free<target['minimumFreeDiskMiB']*1024**2: raise ValueError('FLEET_SNAPSHOT_DISK_LOW')
    probe_browser(target,candidate,image)
    prior_path=root/'standby.json';prior=json.loads(prior_path.read_text()) if prior_path.exists() else {}
    # Standby receives code and an offline-tested runtime, no DB password, seeds or timers.
    private_write(root/'config'/'fleet.json',json.dumps(config))
    private_write(root/'config'/'runtime.json',json.dumps({'image':image}))
    (root/'config'/'authorization.json').unlink(missing_ok=True)
    activate_files(root,candidate)
    private_write(prior_path,json.dumps({'revision':revision,'image':image,'previousRevision':prior.get('revision'),'previousImage':prior.get('image')}))
    keep={revision,prior.get('revision')}
    for path in (root/'releases').iterdir():
        if path.is_dir() and not path.is_symlink() and re.fullmatch(r'[0-9a-f]{40}',path.name) and path.name not in keep: shutil.rmtree(path)
    old_image=prior.get('previousImage')
    if old_image and old_image not in {image,prior.get('image')} and re.fullmatch(r'sha256:[0-9a-f]{64}',old_image):run(['docker','image','rm',old_image],check=False)
    return {'status':'STANDBY_READY','revision':revision}


def target_import(target,revision,snapshot):
    root=node_root(target)
    if target_status(target)['owned']: raise ValueError('FLEET_OWNED_STATE_CANNOT_BE_REPLACED')
    stop_target(target)
    archive=root/'incoming'/(revision+'.tar.gz')
    if archive.stat().st_size!=snapshot['bytes'] or digest(archive)!=snapshot['sha256']: raise ValueError('FLEET_SNAPSHOT_HASH_INVALID')
    pending=root/'state.pending';shutil.rmtree(pending,ignore_errors=True)
    extract_snapshot(archive,pending)
    for platform in target['platforms']:
        path=pending/platform
        if not (path/'state.json').is_file(): raise ValueError('FLEET_SOURCE_CHECKPOINT_MISSING')
        checkpoint=json.loads((path/'state.json').read_text())
        if checkpoint.get('schema')!=1: raise ValueError('FLEET_CHECKPOINT_SCHEMA_INVALID')
        for directory,dirs,files in os.walk(path): os.chmod(directory,0o700);os.chown(directory,1000,1000)
    old=root/'state.before-import';shutil.rmtree(old,ignore_errors=True)
    if (root/'state').exists(): os.replace(root/'state',old)
    os.replace(pending,root/'state');shutil.rmtree(old,ignore_errors=True);archive.unlink()
    return {'status':'CHECKPOINTS_IMPORTED'}


def target_activate(config,target,revision,handover_revision):
    root=node_root(target);tx=transaction(target,revision);receipt=json.loads((tx/'receipt.json').read_text())
    for platform in target['platforms']:
        if not (root/'state'/platform/'state.json').is_file(): raise ValueError('FLEET_TARGET_CHECKPOINT_MISSING')
    if (root/'current').is_symlink() and str((root/'current').resolve())==receipt['candidate']: pass
    else: activate_files(root,receipt['candidate'])
    if not re.fullmatch(r'[0-9a-f]{40}',handover_revision): raise ValueError('FLEET_HANDOVER_REVISION_INVALID')
    private_write(root/'owner.json',json.dumps({'handoverRevision':handover_revision,'revision':revision}))
    # Validate the mirrored catalog before enabling a timer that consumes it.
    if 'snapchat' in target['platforms']:
        run(['python3','-B',str(root/'current'/'candidate-refresh.py'),'--node',target['id']],timeout=60)
    # Collection timers start only after the central controller issues a permit.
    timers=[name for name in extra_units(config,target,Path(receipt['candidate'])) if name.endswith('-candidates.timer') and 'snapchat' in target['platforms']]
    if timers: run(['systemctl','enable','--now',*timers])
    for timer in timers:
        if run(['systemctl','is-active',timer]).stdout.strip()!='active': raise ValueError('FLEET_TIMER_NOT_ACTIVE')
    receipt['status']='ACTIVATED';receipt['handoverRevision']=handover_revision;private_write(tx/'receipt.json',json.dumps(receipt))
    return {'status':'READY_AWAITING_ASSIGNMENT'}


def target_rollback(config,target,revision):
    root=node_root(target);tx=transaction(target,revision);path=tx/'receipt.json'
    if not path.exists():return {'status':'NO_STAGED_CHANGE'}
    receipt=json.loads(path.read_text())
    current=str((root/'current').resolve()) if (root/'current').is_symlink() else None
    if current not in [receipt['previous'],receipt['candidate']]:raise ValueError('FLEET_ROLLBACK_DRIFT')
    stop_target(target)
    feed=f"adtrender-{target['id']}-candidates"
    run(['systemctl','stop',feed+'.timer',feed+'.service'],timeout=75,check=False)
    run(['systemctl','stop',target['databaseRelay']+'.service'],timeout=45,check=False)
    if (root/'current').is_symlink() and str((root/'current').resolve())==receipt['candidate']: rollback_files(root,receipt)
    if (root/'config').exists(): shutil.rmtree(root/'config')
    if (tx/'config').exists(): shutil.copytree(tx/'config',root/'config')
    owner=root/'owner.json'
    if 'owner' in receipt:
        if receipt['owner'] is None: owner.unlink(missing_ok=True)
        else: private_write(owner,json.dumps(receipt['owner']))
    elif receipt['previous']:
        previous_revision=json.loads((Path(receipt['previous'])/'manifest.json').read_text())['revision']
        if owner.exists():
            prior=json.loads(owner.read_text());prior['revision']=previous_revision;private_write(owner,json.dumps(prior))
    else: owner.unlink(missing_ok=True)
    for name,body in receipt['units'].items():
        if body is None:
            run(['systemctl','disable',name],check=False);(SYSTEMD/name).unlink(missing_ok=True)
        else: public_write(SYSTEMD/name,base64.b64decode(body).decode())
    run(['systemctl','daemon-reload'])
    if receipt['relayActive']: run(['systemctl','start',target['databaseRelay']+'.service'])
    if receipt['timers']: run(['systemctl','start',*receipt['timers']])
    receipt['status']='ROLLED_BACK';private_write(path,json.dumps(receipt))
    return {'status':'STOP_CONFIRMED_AND_PREVIOUS_RELEASE_RESTORED'}


def target_complete(target,revision):
    tx=transaction(target,revision);receipt=json.loads((tx/'receipt.json').read_text());receipt['status']='COMPLETED';private_write(tx/'receipt.json',json.dumps(receipt))
    # Keep the current and previous release only; collector state is never pruned.
    keep={revision,Path(receipt['previous']).name if receipt['previous'] else revision}
    runtime_keep={json.loads((node_root(target)/'config'/'runtime.json').read_text())['image']}
    if (tx/'config'/'runtime.json').exists():runtime_keep.add(json.loads((tx/'config'/'runtime.json').read_text())['image'])
    for path in (node_root(target)/'releases').iterdir():
        if path.is_dir() and not path.is_symlink() and re.fullmatch(r'[0-9a-f]{40}',path.name) and path.name not in keep:
            shutil.rmtree(path)
    for path in (node_root(target)/'transactions').iterdir():
        if path.name not in keep and path.is_dir() and not path.is_symlink():
            images=set()
            info=path/'receipt.json'
            if info.exists():images.add(json.loads(info.read_text()).get('image'))
            runtime=path/'config'/'runtime.json'
            if runtime.exists():images.add(json.loads(runtime.read_text())['image'])
            for image in images:
                if image and image not in runtime_keep and re.fullmatch(r'sha256:[0-9a-f]{64}',image):run(['docker','image','rm',image],check=False)
            shutil.rmtree(path)
    return {'status':'COMPLETED'}


def rpc_main():
    import sys
    if os.geteuid()!=0: raise RuntimeError('FLEET_ROOT_REQUIRED')
    try:
        request=json.load(sys.stdin);config=request['config']
        # Reuse the strict file-backed configuration validator without persistent writes.
        import tempfile
        with tempfile.NamedTemporaryFile(mode='w',suffix='.json') as handle:
            json.dump(config,handle);handle.flush();config=load(handle.name)
        target=next(t for t in config['targets'] if t['id']==request['node']);revision=request['revision']
        snapshot_root(target,revision)
        action=request['action']
        if action=='source_inspect': result=source_inspect(config,target)
        elif action=='source_reserve': result=source_reserve(target)
        elif action=='source_pause': result=source_pause(config,target,revision)
        elif action=='source_snapshot': result=source_snapshot(config,target,revision)
        elif action=='source_commit': result=source_finish(config,target,revision,True)
        elif action=='source_resume': result=source_finish(config,target,revision,False)
        elif action=='source_sql': result=source_apply_sql(config,target,{p+'.ingest.sql':base64.b64decode(request['files'][p+'.ingest.sql'],validate=True).decode() for p in target['platforms']})
        elif action=='target_status': result=target_status(target)
        elif action=='target_standby': result=target_standby(config,target,revision,request['artifact'])
        elif action=='target_prepare': result=target_prepare(config,target,revision,request['artifact'],request['inspected'],request['primaryPassword'])
        elif action=='target_probe': result=target_probe(target,revision)
        elif action=='target_import': result=target_import(target,revision,request['snapshot'])
        elif action=='target_activate': result=target_activate(config,target,revision,request['handoverRevision'])
        elif action=='target_rollback': result=target_rollback(config,target,revision)
        elif action=='target_complete': result=target_complete(target,revision)
        elif action=='target_authorize': result=target_authorize(config,target,revision,request['permit'])
        elif action=='target_revoke': result=target_revoke(target)
        else: raise ValueError('FLEET_RPC_ACTION_INVALID')
        print(json.dumps(result))
    except Exception as error:
        code=str(error) if re.fullmatch(r'FLEET_[A-Z_]+',str(error)) else 'FLEET_REMOTE_OPERATION_FAILED'
        print(code,file=sys.stderr);raise SystemExit(1)
