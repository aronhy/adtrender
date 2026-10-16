#!/usr/bin/env python3
"""Refresh central execution permissions; never builds an image or seeds a queue."""
import argparse
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from fleet_config import load
from registry import load_registry, resolve, registry_digest, now_seconds, timestamp, TTL_SECONDS
from release import required_secrets, SSHRemote

HERE = Path(__file__).resolve().parent


def authorize(remote, config, target, revision, digest, now=None):
    now = now_seconds() if now is None else now
    common = {'config':config, 'node':target['id'], 'revision':revision}
    until = now+TTL_SECONDS
    if target.get('expiresAt'): until = min(until, timestamp(target['expiresAt']))
    if not target['platforms'] or not target.get('enabled', True) or until-now <= target['shutdownSeconds']+15:
        return remote.rpc('target', 'target_revoke', **common)
    remote.rpc('source', 'source_reserve', **common)
    permit = {'schema':1, 'node':target['id'], 'revision':revision, 'scope':'platform_queue',
              'platforms':target['platforms'], 'registryDigest':digest,
              'issuedAt':datetime.fromtimestamp(now, timezone.utc).isoformat(),
              'validUntil':datetime.fromtimestamp(until, timezone.utc).isoformat()}
    return remote.rpc('target', 'target_authorize', **common, permit=permit)


def reconcile_node(remote, config, target, digest):
    common = {'config':config, 'node':target['id'], 'revision':'0'*40}
    status = remote.rpc('target', 'target_status', **common)
    if not target['platforms'] and status.get('revision'):
        remote.rpc('target','target_revoke',**{**common,'revision':status['revision']})
        return {'status':'IDLE_NO_ASSIGNMENT','revision':status['revision']}
    if not status['owned'] or not status.get('revision'): return {'status':'NOT_DEPLOYED'}
    if not target.get('enabled', True) or (target.get('expiresAt') and timestamp(target['expiresAt']) <= now_seconds()):
        return remote.rpc('target', 'target_revoke', **{**common, 'revision':status['revision']})
    if not status.get('complete'): return {'status':'DEPLOYMENT_INCOMPLETE'}
    return authorize(remote, config, target, status['revision'], digest)


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--registry'); parser.add_argument('--execute', action='store_true')
    args = parser.parse_args(); registry = load_registry(args.registry)
    config, states = resolve(load(HERE/'targets.json'), registry)
    if not args.execute:
        print(json.dumps({'status':'PLAN_ONLY', 'nodes':states})); return
    failed = False
    with tempfile.TemporaryDirectory(prefix='fleet-reconcile-') as directory:
        for target in config['targets']:
            try:
                secrets = required_secrets(config, [target], os.environ)
                node_dir = Path(directory)/target['id']; node_dir.mkdir(mode=0o700)
                remote = SSHRemote(config, target, secrets, node_dir, '/dev/null')
                result = reconcile_node(remote, config, target, registry_digest(registry))
                print(json.dumps({'node':target['id'], **result}), flush=True)
            except Exception:
                # No new permission on missing secrets, failed SSH, failed source check or stale deployment.
                # Existing permission expires locally even if the node cannot be reached to revoke it.
                failed = True; print(json.dumps({'node':target['id'], 'status':'UNREACHABLE_OR_NOT_READY'}), flush=True)
    if failed: raise RuntimeError('FLEET_RECONCILE_INCOMPLETE')


if __name__ == '__main__':
    try: main()
    except Exception as error:
        code = str(error) if re.fullmatch(r'FLEET_[A-Z_]+', str(error)) else 'FLEET_RECONCILE_FAILED'
        print(code, file=__import__('sys').stderr); raise SystemExit(1)
