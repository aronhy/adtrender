import json
import base64
import ipaddress
import re
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit, unquote

PLATFORMS = ('pinterest', 'google', 'tiktok', 'snapchat')


def load(path):
    return validate(json.loads(Path(path).read_text()))


def validate(value):
    if set(value) != {'schema', 'releaseBranch', 'source', 'targets'} or value['schema'] != 1 or value['releaseBranch'] != 'main':
        raise ValueError('FLEET_CONFIG_INVALID')
    common = {'id', 'host', 'port', 'user', 'publicHostKey', 'passwordSecret'}
    source_keys = common | {'databaseContainer', 'databaseNetwork'}
    target_keys = common | {'platforms', 'aliases', 'autoDeploy', 'memoryMiB', 'cpus', 'minimumAvailableMiB', 'minimumFreeDiskMiB', 'runSeconds', 'shutdownSeconds', 'cycleMinutes', 'network', 'databaseRelay'}
    ids = set(); owners = set()
    for node, keys in [(value['source'], source_keys), *((n, target_keys) for n in value['targets'])]:
        optional = {'privilege', 'enabled', 'expiresAt', 'controlMode'} if keys == target_keys else set()
        if not keys <= set(node) or set(node) - keys - optional or not re.fullmatch(r'[a-z][a-z0-9-]{0,30}', node['id']) or node['id'] in ids:
            raise ValueError('FLEET_NODE_INVALID')
        ids.add(node['id'])
        try: ipaddress.ip_address(node['host'])
        except ValueError: raise ValueError('FLEET_HOST_INVALID') from None
        if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}', node['user']) or type(node['port']) is not int or not 1 <= node['port'] <= 65535:
            raise ValueError('FLEET_SSH_INVALID')
        if (node['user'] == 'root' and node.get('privilege', 'root') != 'root') or (node['user'] != 'root' and node.get('privilege') != 'sudo'):
            raise ValueError('FLEET_PRIVILEGE_INVALID')
        if 'enabled' in node and type(node['enabled']) is not bool: raise ValueError('FLEET_ENABLED_INVALID')
        if 'controlMode' in node and node['controlMode'] not in ['LEGACY_QUEUE','CONFIG_QUEUE','TASK_CLAIM']: raise ValueError('FLEET_CONTROL_MODE_INVALID')
        if node.get('expiresAt') is not None:
            from datetime import datetime
            try:
                if datetime.fromisoformat(node['expiresAt'].replace('Z', '+00:00')).tzinfo is None: raise ValueError()
            except (ValueError, AttributeError): raise ValueError('FLEET_DATE_INVALID') from None
        if not re.fullmatch(r'COLLECTOR_[A-Z0-9_]+_SSH_PASSWORD', node['passwordSecret']):
            raise ValueError('FLEET_SECRET_REFERENCE_INVALID')
        key = node['publicHostKey'].split()
        if len(key) != 2 or key[0] != 'ssh-ed25519': raise ValueError('FLEET_HOST_KEY_INVALID')
        try:
            if len(base64.b64decode(key[1], validate=True)) != 51: raise ValueError()
        except ValueError: raise ValueError('FLEET_HOST_KEY_INVALID') from None
    for target in value['targets']:
        platforms = target['platforms']
        if not isinstance(platforms, list) or len(set(platforms)) != len(platforms) or not set(platforms) <= set(PLATFORMS) or owners.intersection(platforms):
            raise ValueError('FLEET_PLATFORM_OWNER_INVALID')
        owners.update(platforms)
        if target['aliases'] != ({'youtube': 'google'} if 'google' in platforms else {}): raise ValueError('FLEET_ALIAS_INVALID')
        if type(target['autoDeploy']) is not bool: raise ValueError('FLEET_AUTO_DEPLOY_INVALID')
        numeric = ['memoryMiB', 'minimumAvailableMiB', 'minimumFreeDiskMiB', 'runSeconds', 'shutdownSeconds', 'cycleMinutes']
        if any(type(target[k]) is not int for k in numeric): raise ValueError('FLEET_RESOURCE_INVALID')
        if not re.fullmatch(r'0\.[0-9]+|1(?:\.0+)?', target['cpus']) or not 0 < float(target['cpus']) <= 1:
            raise ValueError('FLEET_CPU_INVALID')
        if not 256 <= target['memoryMiB'] <= 1024 or target['minimumAvailableMiB'] < target['memoryMiB'] + 128:
            raise ValueError('FLEET_MEMORY_INVALID')
        if target['minimumFreeDiskMiB'] < 2048 or not 60 <= target['runSeconds'] <= 300 or not 60 <= target['shutdownSeconds'] <= 600:
            raise ValueError('FLEET_RESOURCE_INVALID')
        if target['cycleMinutes'] < 20 or 60 % target['cycleMinutes'] or (platforms and target['cycleMinutes'] % len(platforms)):
            raise ValueError('FLEET_SCHEDULE_INVALID')
        for key in ['network', 'databaseRelay']:
            if not re.fullmatch(r'adtrender-[a-z0-9-]{1,60}', target[key]): raise ValueError('FLEET_NETWORK_INVALID')
    for key in ['databaseContainer', 'databaseNetwork']:
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}', value['source'][key]): raise ValueError('FLEET_SOURCE_INVALID')
    return value


def schedules(target):
    if not target['platforms']: return {}
    cycle = target['cycleMinutes']; spacing = cycle // len(target['platforms'])
    return {platform: list(range(index * spacing, 60, cycle)) for index, platform in enumerate(target['platforms'])}


def rewrite_database_url(value, platform, relay):
    if platform not in PLATFORMS or not re.fullmatch(r'adtrender-[a-z0-9-]+', relay): raise ValueError('FLEET_DATABASE_INVALID')
    parsed = urlsplit(value)
    if parsed.scheme not in ['postgres', 'postgresql'] or unquote(parsed.username or '') != platform + '_collector_runtime' or not parsed.password or parsed.path != '/ad_research_test' or parsed.fragment:
        raise ValueError('FLEET_RESTRICTED_DATABASE_ROLE_REQUIRED')
    return urlunsplit((parsed.scheme, parsed.netloc.rsplit('@', 1)[0] + '@' + relay + ':5432', parsed.path, parsed.query, ''))
