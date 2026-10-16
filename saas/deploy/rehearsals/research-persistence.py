#!/usr/bin/env python3
"""Explicit operator rehearsal for the isolated Netcup test project only.

Run on the server beside research-persistence-probe.mjs. A successful run creates
synthetic data through the native API, restarts only this API/worker, verifies
persistence and tenant permissions, then removes exactly its own fixture.
Private session state is root-only, never printed; a failure retains its path for
inspection. Does not test signup, mail delivery, providers, media or real users.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time
import urllib.request
import uuid

ROOT = Path('/opt/ad-research-test')
APP_ENV = Path('/etc/ad-research-test/app.env')
RELEASE_ENV = Path('/etc/ad-research-test/release.env')
OVERRIDE = '/etc/ad-research-test/ds-meta-worker-runtime.yml'
API = 'ds-meta-saas-test-api-1'
WORKER = 'ds-meta-saas-test-worker-1'
DB = 'ds-meta-saas-test-database-1'


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, timeout=kwargs.pop('timeout', 60), **kwargs)
    if result.returncode:
        raise RuntimeError('REMOTE_COMMAND_FAILED')
    return result.stdout.strip()


def containers():
    ids = run(['docker', 'ps', '-aq']).split()
    rows = json.loads(run(['docker', 'inspect', *ids]))
    return {x['Name'].lstrip('/'): {'id': x['Id'], 'image': x['Image'], 'startedAt': x['State']['StartedAt'], 'running': x['State']['Running']} for x in rows}


def safe_write(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'w') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())


def sql(query):
    return run(['docker', 'exec', DB, 'psql', '-U', 'saas_migrator', '-d', 'ad_research_test', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query])


def health_and_worker():
    health = None
    for _ in range(45):
        try:
            with urllib.request.urlopen('http://127.0.0.1:13001/health', timeout=3) as response:
                health = json.load(response)
            if health == {'status': 'degraded', 'api': 'ok', 'database': 'ok', 'worker': 'ok', 'source': 'paused', 'email': 'ok'}:
                break
        except Exception:
            pass
        time.sleep(1)
    else:
        raise RuntimeError('HEALTH_NOT_READY')
    started = run(['docker', 'inspect', WORKER, '--format', '{{.State.StartedAt}}'])
    for _ in range(30):
        result = subprocess.run(['docker', 'logs', '--since', started, WORKER], capture_output=True, text=True, timeout=10)
        if result.returncode:
            raise RuntimeError('WORKER_LOG_READ_FAILED')
        events = []
        for line in result.stdout.splitlines():
            try:
                event = json.loads(line)
                if event.get('event') == 'worker_started':
                    events.append(event)
            except ValueError:
                pass
        if events:
            worker = events[-1].get('workerId', '')
            if not re.fullmatch(r'saas-[a-f0-9-]{36}', worker):
                raise RuntimeError('WORKER_ID_INVALID')
            if sql('SELECT count(*) FROM "WorkerHeartbeat" WHERE id=\'' + worker + '\' AND status<>\'STOPPED\' AND "lastSeenAt">now()-interval \'45 seconds\';') == '1':
                return {'health': health, 'freshCurrentProcessHeartbeat': True}
        time.sleep(1)
    raise RuntimeError('CURRENT_WORKER_NOT_READY')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    if not args.execute or not re.fullmatch(r'\d{8}-test-\d+', args.release) or not re.fullmatch(r'[0-9a-f]{40}', args.source_commit):
        raise SystemExit('EXPLICIT_TEST_RELEASE_AND_EXECUTE_REQUIRED')
    if os.geteuid() != 0 or ROOT.is_symlink() or not ROOT.is_dir():
        raise SystemExit('TEST_HOST_GUARD_REJECTED')
    os.umask(0o077)
    release = ROOT / 'releases' / args.release
    if (ROOT / 'current').resolve() != release.resolve():
        raise SystemExit('CURRENT_RELEASE_MISMATCH')
    manifest = json.loads((release / 'release-manifest.json').read_text())
    if manifest.get('releaseId') != args.release or manifest.get('sourceCommit') != args.source_commit or manifest.get('workingTreeDirty') is not False:
        raise SystemExit('RELEASE_MANIFEST_MISMATCH')
    selected = [line for line in RELEASE_ENV.read_text().splitlines() if line.startswith('AD_RESEARCH_RELEASE_ID=')]
    if selected != ['AD_RESEARCH_RELEASE_ID=' + args.release]:
        raise SystemExit('RELEASE_ENV_MISMATCH')
    before = containers()
    image = run(['docker', 'image', 'inspect', 'ad-research-saas-test:' + args.release, '--format', '{{.Id}}'])
    if any(before[x]['image'] != image or not before[x]['running'] for x in [API, WORKER]):
        raise SystemExit('RUNNING_IMAGE_MISMATCH')
    env_hash = hashlib.sha256(APP_ENV.read_bytes()).hexdigest()
    migrations = sql('SELECT json_agg(json_build_object(\'name\',migration_name,\'checksum\',checksum) ORDER BY migration_name) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;')
    expected = [{'name': p.parent.name, 'checksum': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted((release / 'app/.wasp/out/db/migrations').glob('*/migration.sql'))]
    if json.loads(migrations) != expected or len(expected) != 7:
        raise SystemExit('MIGRATION_CHECKSUM_MISMATCH')
    probe = Path(__file__).with_name('research-persistence-probe.mjs').read_text()
    run_id = str(uuid.uuid4())
    directory = ROOT / 'backups' / ('research-persistence-' + run_id)
    directory.mkdir(mode=0o700)
    state = {'runId': run_id, 'users': {role: {'id': str(uuid.uuid4()), 'authId': str(uuid.uuid4()), 'sessionId': secrets.token_hex(32)} for role in ['ownerA', 'ownerB', 'viewer']}, 'sourceId': str(uuid.uuid4()), 'adId': str(uuid.uuid4())}
    state_path = directory / 'private-state.json'
    safe_write(state_path, state)
    report = {'version': 1, 'startedAt': now(), 'releaseId': args.release, 'sourceCommit': args.source_commit, 'image': image, 'syntheticOnly': True, 'realCustomerAcceptance': False, 'realSignupOrLoginTested': False, 'providerAcceptance': False, 'phases': [], 'probeSha256': hashlib.sha256(probe.encode()).hexdigest()}
    fixture_attempted = False
    stage = 'PREFLIGHT'

    def save_state():
        next_path = directory / 'private-state.next.json'
        safe_write(next_path, state)
        os.replace(next_path, state_path)

    def phase(name):
        nonlocal state
        payload = 'const input = ' + json.dumps({'phase': name, 'state': state}, ensure_ascii=True) + ';\n' + probe
        output = run(['docker', 'exec', '-i', API, 'node', '--input-type=module', '-'], input=payload, timeout=90)
        data = json.loads(output)
        state = data['state']
        save_state()
        report['phases'].append({'phase': name, 'ok': data['ok'], 'report': data.get('report'), 'checkedAt': now()})
        if data.get('ok') is not True:
            raise RuntimeError('PROBE_' + name.upper() + '_FAILED')
        return data.get('report')

    try:
        health_and_worker()
        phase('preflight')
        stage = 'SEED'
        fixture_attempted = True
        phase('seed')
        stage = 'VERIFY_BEFORE_RESTART'
        phase('verify')
        stage = 'RESTART_API_AND_WORKER'
        compose = ['docker', 'compose', '--project-name', 'ds-meta-saas-test', '--env-file', str(RELEASE_ENV), '-f', 'compose.yml', '-f', OVERRIDE]
        run([*compose, 'config', '--quiet'], cwd=release / 'deploy/container')
        run([*compose, 'restart', 'api', 'worker'], cwd=release / 'deploy/container', timeout=180)
        report['restart'] = health_and_worker()
        after = containers()
        for name in [API, WORKER]:
            if after[name]['id'] != before[name]['id'] or after[name]['image'] != image or after[name]['startedAt'] == before[name]['startedAt']:
                raise RuntimeError('PROCESS_RESTART_NOT_PROVEN')
        stage = 'VERIFY_AFTER_RESTART'
        phase('verify')
        report['persistenceAcrossApiAndWorkerRestart'] = True
    except Exception:
        report['status'] = 'FAILED'
        report['failedStage'] = stage
    finally:
        try:
            if fixture_attempted:
                stage = 'CLEANUP'
                phase('cleanup')
                report['fixtureCleanupVerified'] = True
            current = containers()
            for name, prior in before.items():
                if name not in [API, WORKER] and current.get(name) != prior:
                    raise RuntimeError('UNRELATED_CONTAINER_CHANGED')
            if hashlib.sha256(APP_ENV.read_bytes()).hexdigest() != env_hash or (ROOT / 'current').resolve() != release.resolve():
                raise RuntimeError('CONFIG_OR_RELEASE_CHANGED')
            if sql('SELECT json_agg(json_build_object(\'name\',migration_name,\'checksum\',checksum) ORDER BY migration_name) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;') != migrations:
                raise RuntimeError('MIGRATIONS_CHANGED')
            report['unchangedContainersExceptApiAndWorker'] = len(before) - 2
            report['unchangedExistingContainers'] = sum(not name.startswith('ds-meta-saas-test-') for name in before)
            report['databaseAndGarageUnchanged'] = True
            report['appEnvSha256'] = env_hash
            report['migrationChecksumsUnchanged'] = True
            report['finalRuntime'] = health_and_worker()
            if report.get('status') != 'FAILED' and report.get('fixtureCleanupVerified') and report.get('persistenceAcrossApiAndWorkerRestart'):
                report['status'] = 'RESEARCH_PERSISTENCE_VERIFIED'
        except Exception:
            report['status'] = 'FAILED'
            report['cleanupOrFinalCheckFailed'] = True
        report['finishedAt'] = now()
        report['reportPath'] = str(directory / 'report.json')
        if report['status'] == 'RESEARCH_PERSISTENCE_VERIFIED':
            state_path.unlink()
            report['privateSessionStateRemoved'] = True
        else:
            report['privateStateRetainedAt'] = str(state_path)
        safe_write(directory / 'report.json', report)
        print(json.dumps(report, ensure_ascii=False))
    return 0 if report['status'] == 'RESEARCH_PERSISTENCE_VERIFIED' else 1


if __name__ == '__main__':
    raise SystemExit(main())
