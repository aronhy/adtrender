"""Mutable central node registry. Public metadata only; no SSH or source access."""
import argparse
import copy
import fcntl
import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from fleet_config import PLATFORMS, validate

HERE = Path(__file__).resolve().parent
TTL_SECONDS = 2400


def timestamp(value):
    if not isinstance(value, str): raise ValueError('FLEET_DATE_INVALID')
    try: result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError: raise ValueError('FLEET_DATE_INVALID') from None
    if result.tzinfo is None: raise ValueError('FLEET_DATE_TIMEZONE_REQUIRED')
    return result.timestamp()


def now_seconds(): return datetime.now(timezone.utc).timestamp()


def validate_registry(value):
    if not isinstance(value, dict) or set(value) != {'schema', 'nodes', 'assignments'} or value['schema'] != 1 or not isinstance(value['nodes'], list) or not value['nodes']:
        raise ValueError('FLEET_REGISTRY_INVALID')
    ids = set()
    required = {'id', 'region', 'host', 'port', 'user', 'privilege', 'publicHostKey', 'verified', 'enabled', 'autoDeploy', 'expiresAt'}
    template = json.loads((HERE/'targets.json').read_text())
    hosts = {template['source']['host']}
    for node in value['nodes']:
        if not isinstance(node, dict) or set(node) != required or node['id'] in ids or node['host'] in hosts:
            raise ValueError('FLEET_REGISTRY_NODE_INVALID')
        ids.add(node['id']); hosts.add(node['host'])
        if any(type(node[k]) is not bool for k in ['verified', 'enabled', 'autoDeploy']) or node['region'] not in ['US', 'SG', 'JP', 'HK', 'OTHER']:
            raise ValueError('FLEET_REGISTRY_NODE_INVALID')
        if node['expiresAt'] is not None: timestamp(node['expiresAt'])
        if node['verified'] and not node['publicHostKey']: raise ValueError('FLEET_VERIFIED_KEY_REQUIRED')
        if node['publicHostKey'] is not None and not isinstance(node['publicHostKey'], str): raise ValueError('FLEET_HOST_KEY_INVALID')
        # Reuse deployment validation even for nodes pending host identity verification.
        candidate = target_for(template['targets'][0], node, list(PLATFORMS))
        candidate['publicHostKey'] = node['publicHostKey'] or template['targets'][0]['publicHostKey']
        validate({**template, 'targets': [candidate]})
    if not isinstance(value['assignments'], dict) or not set(value['assignments']) <= set(PLATFORMS): raise ValueError('FLEET_ASSIGNMENT_INVALID')
    if any(owner not in ids for owner in value['assignments'].values()): raise ValueError('FLEET_ASSIGNMENT_NODE_UNKNOWN')
    return value


def load_registry(path=None, environ=None):
    environ = os.environ if environ is None else environ
    raw = environ.get('COLLECTOR_FLEET_REGISTRY') if path is None else None
    return validate_registry(json.loads(raw or Path(path or HERE/'registry.json').read_text()))


def target_for(template, node, platforms):
    target = copy.deepcopy(template)
    target.update({k:node[k] for k in ['id', 'host', 'port', 'user', 'publicHostKey', 'autoDeploy', 'expiresAt', 'enabled', 'privilege']})
    target.update(passwordSecret='COLLECTOR_'+node['id'].upper().replace('-', '_')+'_SSH_PASSWORD', platforms=platforms,
                  aliases={'youtube':'google'} if 'google' in platforms else {},
                  network='adtrender-collectors-'+node['id'], databaseRelay='adtrender-collector-db-'+node['id'])
    # A newly added node cannot inherit the autonomous legacy queue bootstrap.
    if node['id'] != template['id']: target['controlMode'] = 'CONFIG_QUEUE'
    if platforms and target['cycleMinutes'] % len(platforms): target['cycleMinutes'] = 60
    return target


def node_status(node, assigned, now):
    if not node['enabled']: return 'DISABLED'
    if node['expiresAt'] is not None and timestamp(node['expiresAt']) <= now: return 'EXPIRED'
    if not node['verified']: return 'PENDING_VERIFICATION'
    if not assigned: return 'IDLE_NO_ASSIGNMENT'
    return 'READY'


def resolve(base, registry, now=None):
    now = now_seconds() if now is None else now
    registry = validate_registry(registry); config = copy.deepcopy(base); config['targets'] = []; states = []
    for node in registry['nodes']:
        platforms = [p for p in PLATFORMS if registry['assignments'].get(p) == node['id']]
        status = node_status(node, platforms, now)
        states.append({'id':node['id'], 'region':node['region'], 'status':status, 'expiresAt':node['expiresAt'], 'platforms':platforms})
        # Include verified retired nodes so reconciliation can revoke their old permissions.
        if node['verified']:
            config['targets'].append(target_for(base['targets'][0], node, platforms))
    validate(config)
    return config, states


def deployable(target, now=None):
    now = now_seconds() if now is None else now
    return target['autoDeploy'] and target.get('enabled', True) and (target.get('expiresAt') is None or timestamp(target['expiresAt']) > now)


def registry_digest(value): return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def update_file(path, mutation):
    path = Path(path)
    with path.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = load_registry(path, {}); mutation(current); validate_registry(current)
        fd, name = tempfile.mkstemp(prefix=path.name+'.', dir=path.parent)
        try:
            with os.fdopen(fd, 'w') as output:
                json.dump(current, output, indent=2); output.write('\n'); output.flush(); os.fsync(output.fileno())
            os.replace(name, path)
        finally:
            Path(name).unlink(missing_ok=True)
    return current


def main():
    parser = argparse.ArgumentParser(description='Central server registry; never connects to servers.')
    parser.add_argument('--file', default=str(HERE/'registry.json'))
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('list')
    for action in ['enable', 'disable', 'expire', 'assign', 'unassign']:
        p = sub.add_parser(action)
        if action == 'unassign': p.add_argument('platform', choices=PLATFORMS)
        else: p.add_argument('node')
        if action == 'expire': p.add_argument('at', help='ISO 8601 with timezone, or unknown')
        if action == 'assign': p.add_argument('platform', choices=PLATFORMS)
    p = sub.add_parser('add'); p.add_argument('node_file', help='One public node JSON record; no credentials')
    args = parser.parse_args()
    def change(value):
        if args.command == 'add': value['nodes'].append(json.loads(Path(args.node_file).read_text())); return
        if args.command == 'unassign': value['assignments'].pop(args.platform, None); return
        node = next((n for n in value['nodes'] if n['id'] == args.node), None)
        if node is None: raise ValueError('FLEET_NODE_UNKNOWN')
        if args.command in ['enable', 'disable']: node['enabled'] = args.command == 'enable'
        if args.command == 'expire': node['expiresAt'] = None if args.at == 'unknown' else args.at
        if args.command == 'assign': value['assignments'][args.platform] = args.node
    value = load_registry(args.file, {}) if args.command == 'list' else update_file(args.file, change)
    _, states = resolve(json.loads((HERE/'targets.json').read_text()), value)
    print(json.dumps({'nodes':states, 'registryDigest':registry_digest(value)}, indent=2))


if __name__ == '__main__':
    try: main()
    except Exception as error:
        code = str(error) if re.fullmatch(r'FLEET_[A-Z_]+', str(error)) else 'FLEET_REGISTRY_FAILED'
        print(code, file=__import__('sys').stderr); raise SystemExit(1)
