#!/usr/bin/env python3
"""Bound one existing daemon run; source checkpoints and policies stay unchanged."""
import argparse
import fcntl
import json
import os
import re
import signal
import shutil
import subprocess
import time
import stat
import uuid
from pathlib import Path
from fleet_config import PLATFORMS, load
from authorization import seconds_left


def docker_command(target, platform, root, image, recover_only=False):
    if platform not in target['platforms'] or not re.fullmatch(r'sha256:[0-9a-f]{64}', image): raise ValueError('FLEET_RUN_INVALID')
    root = Path(root); name = f"adtrender-{target['id']}-{platform}"
    command = ['docker', 'run', '--rm', '--name', name, '--init',
            '--label', 'adtrender.fleet.node='+target['id'], '--label', 'adtrender.fleet.platform='+platform,
            '--label', 'adtrender.fleet.role=collector',
            '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges:true', '--security-opt', 'seccomp='+str(root/'current'/'seccomp_profile.json'),
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m,mode=1777',
            '--tmpfs', '/home/node:rw,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=0700',
            '--shm-size', '128m', '--memory', str(target['memoryMiB'])+'m', '--cpus', target['cpus'], '--pids-limit', '256',
            '--network', target['network'], '--env-file', str(root/'config'/(platform+'.env')),
            '-v', str(root/'state'/platform)+':/data:rw',
            '-v', str((root/'current').resolve())+':/opt/ad-research/app/collector-fleet:ro',
            '--log-driver', 'json-file', '--log-opt', 'max-size=2m', '--log-opt', 'max-file=2',
            image, 'node', '/opt/ad-research/app/collector-fleet/'+platform+'.mjs']
    if target.get('controlMode'):
        index=command.index(image)
        manifest=json.loads((root/'current'/'manifest.json').read_text())
        command[index:index]=['--env-file',str(root/'config'/'node-control.env'),
                              '-e','COLLECTOR_CONTROL_MODE='+target['controlMode'],
                              '-e','COLLECTOR_NODE_ID='+target['id'],
                              '-e','COLLECTOR_RECEIPT_DIR=/dispatch',
                              '-e','COLLECTOR_CODE_REVISION='+manifest['revision'],
                              '-e','COLLECTOR_CAPABILITY_DIGEST='+manifest.get('capabilityDigest',''),
                              '-v',str(root/'dispatch')+':/dispatch:rw']
    if recover_only: command.append('--recover-only')
    return command


def control_ready(root):
    try:
        file=Path(root)/'config'/'node-control.env';info=file.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o600: return False
        values=dict(line.split('=',1) for line in file.read_text().splitlines() if line and not line.startswith('#'))
        uuid.UUID(values['COLLECTOR_INCARNATION_ID'])
        manifest=json.loads((Path(root)/'current'/'manifest.json').read_text())
        return bool(values['COLLECTOR_CONTROL_URL'].startswith('https://') and len(values['COLLECTOR_NODE_TOKEN'])>=32 and re.fullmatch(r'[a-f0-9]{64}',manifest.get('capabilityDigest','')))
    except (OSError,ValueError,KeyError): return False


def run_slot(target, platform, root, lock, backend, *, available_mib, free_disk_mib, recover_only=False):
    if platform not in target['platforms']: raise ValueError('FLEET_PLATFORM_INVALID')
    result = {'node': target['id'], 'platform': platform}
    root = Path(root); lock = Path(lock); lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open('a') as held:
        try: fcntl.flock(held, fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: return {**result, 'status': 'SKIPPED_BUSY'}
        if backend.live(target['id']): return {**result, 'status': 'SKIPPED_BUSY'}
        if available_mib < target['minimumAvailableMiB'] or free_disk_mib < target['minimumFreeDiskMiB']:
            return {**result, 'status': 'SKIPPED_RESOURCES'}
        if target.get('controlMode') and not control_ready(root): return {**result,'status':'IDLE_NO_CONTROL'}
        # Recovery never opens a source; central HTTP still validates preserved SHA evidence.
        authorized_seconds = target['runSeconds'] if recover_only else seconds_left(root, target, platform)
        if authorized_seconds <= 0: return {**result, 'status': 'IDLE_NO_ASSIGNMENT'}
        runtime = json.loads((root/'config'/'runtime.json').read_text())
        profile = root/'state'/platform/'browser-profile'
        for name in ['SingletonLock', 'SingletonCookie', 'SingletonSocket']:
            (profile/name).unlink(missing_ok=True)
        if platform == 'tiktok': (root/'state'/platform/'process.lock').unlink(missing_ok=True)
        name = f"adtrender-{target['id']}-{platform}"
        process = None
        try:
            process = backend.start(docker_command(target, platform, root, runtime['image'],recover_only))
            try: code = process.wait(timeout=min(target['runSeconds'], authorized_seconds))
            except subprocess.TimeoutExpired:
                backend.stop(name, target['shutdownSeconds'])
                code = process.wait(timeout=target['shutdownSeconds']+15)
            return {**result, 'status': 'FINISHED' if code == 0 else 'FAILED', 'exitCode': code}
        finally:
            # Keep the cross-platform lock until the actual container is gone.
            if process is not None:
                backend.stop(name, target['shutdownSeconds'])
                if not backend.wait_removed(name, target['shutdownSeconds']+15): raise RuntimeError('FLEET_CONTAINER_NOT_STOPPED')
                process.wait(timeout=15)


class Docker:
    def live(self, node):
        r = subprocess.run(['docker', 'ps', '--filter', 'label=adtrender.fleet.node='+node, '--filter', 'label=adtrender.fleet.role=collector', '--format', '{{.Names}}'], capture_output=True, text=True, check=True)
        return r.stdout.splitlines()

    def start(self, args): return subprocess.Popen(args)

    def stop(self, name, seconds):
        r = subprocess.run(['docker', 'inspect', '--format', '{{index .Config.Labels "adtrender.fleet.node"}}', name], capture_output=True, text=True)
        if r.returncode: return
        if not r.stdout.strip() or not name.startswith('adtrender-'+r.stdout.strip()+'-'): raise RuntimeError('FLEET_CONTAINER_OWNER_MISMATCH')
        subprocess.run(['docker', 'stop', '--time', str(seconds), name], capture_output=True, timeout=seconds+15, check=True)

    def wait_removed(self, name, seconds):
        end = time.monotonic()+seconds
        while time.monotonic() < end:
            r = subprocess.run(['docker', 'inspect', '--format', '{{.State.Running}}', name], capture_output=True, text=True)
            if r.returncode or r.stdout.strip() != 'true': return True
            time.sleep(1)
        return False


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--node', required=True); parser.add_argument('--platform', choices=PLATFORMS, required=True);parser.add_argument('--recover-only',action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,30}',args.node):raise ValueError('FLEET_NODE_INVALID')
    def stop(signum,frame): raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    if os.geteuid() != 0: raise RuntimeError('FLEET_ROOT_REQUIRED')
    root = Path('/opt/adtrender-collectors')/args.node
    config = load(root/'config'/'fleet.json'); target = next(n for n in config['targets'] if n['id'] == args.node)
    if target.get('controlMode'):
        (root/'dispatch').mkdir(exist_ok=True,mode=0o700);os.chown(root/'dispatch',1000,1000)
    memory = next(int(line.split()[1])//1024 for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))
    result = run_slot(target, args.platform, root, Path('/run/lock')/('adtrender-'+args.node+'.lock'), Docker(), available_mib=memory, free_disk_mib=shutil.disk_usage(root).free//(1024*1024),recover_only=args.recover_only)
    print(json.dumps(result)); return 0 if result['status'] != 'FAILED' else 1


if __name__ == '__main__':
    try: raise SystemExit(main())
    except KeyboardInterrupt: print('FLEET_SLOT_STOPPED'); raise SystemExit(0)
    except Exception: print('FLEET_SLOT_FAILED', file=__import__('sys').stderr); raise SystemExit(1)
