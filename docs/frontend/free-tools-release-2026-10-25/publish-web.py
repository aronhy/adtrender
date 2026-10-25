#!/usr/bin/env python3
"""Publish only the reviewed Free Tools static overlay.

Usage: python3 publish-web.py stage|activate|rollback --plan /absolute/plan.json
Use ``--plan -`` to read the same JSON from stdin. The script may itself be sent
over SSH stdin when the plan is already a remote file. No SSH is performed here.

The tar contains manifest.json and regular public/... files only. Manifest files
are [{path, sha256, sizeBytes}]; artifactHash hashes that array as compact UTF-8
JSON (ensure_ascii=False). Plan pins its entire manifest and archive hashes.
Only a web pointer is activated. Docker is inspected; never modified.
"""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import urllib.request
import uuid


RELEASE = '20261025-free-tools-17-1'
CURRENT = '/www/wwwroot/adtrender/current'
APP_CURRENT = '/opt/ad-research-test/current'
CANDIDATE = '/www/wwwroot/adtrender/releases/' + RELEASE
EVIDENCE = '/opt/ad-research-test/backups/free-tools-17-20261025-1'
LOCK = '/opt/ad-research-test/growth-publish.lock'
ORIGIN = 'https://adtrender.com'
RUNTIME_NAMES = ('ds-meta-saas-test-api-1', 'ds-meta-saas-test-worker-1')
PROTECTED = {
    '/etc/ad-research-test/app.env',
    '/etc/ad-research-test/release.env',
    '/etc/ad-research-test/ds-meta-worker-runtime.yml',
    '/www/server/panel/vhost/nginx/adtrender.com.conf',
    '/www/server/panel/vhost/nginx/admin.adtrender.com.conf',
}
SLUGS = (
    'roas-calculator', 'ecommerce-profit-calculator', 'profit-margin-calculator',
    'roi-calculator', 'customer-lifetime-value-calculator',
    'shopify-cost-calculator', 'cpa-calculator', 'traffic-goal-calculator',
    'ad-budget-calculator', 'hook-generator', 'ad-finder', 'utm-link-builder',
    'privacy-policy-generator', 'refund-policy-generator',
    'terms-and-conditions-generator', 'returns-policy-generator',
    'shipping-policy-generator',
)
TOOL_PATHS = ('/tools', '/tools/guide') + tuple('/tools/' + slug for slug in SLUGS)
TOOL_FILES = {path.lstrip('/') + '/index.html' for path in TOOL_PATHS}
HASH = re.compile(r'[a-f0-9]{64}')
HASHED_ASSET = re.compile(r'assets/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,64}\.[A-Za-z0-9.]{1,16}')


class ReleaseError(RuntimeError):
    pass


def fail(code):
    raise ReleaseError(code)


def canonical(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            fail('DUPLICATE_JSON_KEY')
        value[key] = item
    return value


def parse_json(data):
    return json.loads(data, object_pairs_hook=unique_object)


def relative_name(name):
    if (not isinstance(name, str) or not name or any(char in name for char in '\\\x00%?#')
            or any(ord(char) < 32 for char in name)):
        fail('UNSAFE_RELATIVE_PATH')
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in ('', '.', '..') for part in name.split('/')):
        fail('UNSAFE_RELATIVE_PATH')
    if str(path) != name:
        fail('NON_CANONICAL_RELATIVE_PATH')
    return name


def absolute_path(value):
    if not isinstance(value, str) or not Path(value).is_absolute():
        fail('ABSOLUTE_PATH_REQUIRED')
    path = Path(value)
    if str(path) != value or path.resolve(strict=False) != path:
        fail('NON_CANONICAL_ABSOLUTE_PATH')
    return path


def plain_file(path):
    if not stat.S_ISREG(Path(path).lstat().st_mode):
        fail('REGULAR_FILE_REQUIRED')


def inventory(root):
    root = Path(root)
    if not stat.S_ISDIR(root.lstat().st_mode):
        fail('REAL_DIRECTORY_REQUIRED')
    result = {}
    for parent, directories, files in os.walk(root, followlinks=False):
        for name in directories:
            if not stat.S_ISDIR((Path(parent) / name).lstat().st_mode):
                fail('DIRECTORY_SYMLINK_OR_SPECIAL_FILE')
        for name in files:
            path = Path(parent) / name
            plain_file(path)
            relative = relative_name(path.relative_to(root).as_posix())
            result[relative] = {'sha256': file_hash(path), 'bytes': path.stat().st_size}
    return dict(sorted(result.items()))


def inventory_hash(value):
    return sha(canonical(dict(sorted(value.items()))))


def runtime_state():
    fmt = '{"name":{{json .Name}},"id":{{json .Id}},"image":{{json .Image}},"startedAt":{{json .State.StartedAt}}}'
    result = subprocess.run(['docker', 'inspect', '--format', fmt, *RUNTIME_NAMES],
                            capture_output=True, timeout=25)
    if result.returncode:
        fail('RUNTIME_INSPECTION_FAILED')
    rows = [parse_json(line) for line in result.stdout.splitlines() if line]
    value = {}
    for row in rows:
        name = row.pop('name').lstrip('/')
        if name in value:
            fail('RUNTIME_DUPLICATE_IDENTITY')
        value[name] = row
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        fail('PUBLIC_REDIRECT_REJECTED')


def public_get(origin, path):
    request = urllib.request.Request(origin + path, headers={
        'Cache-Control': 'no-cache', 'User-Agent': 'AdTrender-Free-Tools-Release/1',
    })
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
        return response.status, dict(response.headers.items()), response.read()


class Metadata(HTMLParser):
    def __init__(self):
        super().__init__()
        self.titles = 0
        self.canonicals = []

    def handle_starttag(self, tag, attrs):
        if tag == 'title':
            self.titles += 1
        if tag == 'link':
            value = dict(attrs)
            if value.get('rel', '').lower() == 'canonical':
                self.canonicals.append(value.get('href'))


class Publisher:
    def __init__(self, plan, *, runtime=None, http=None, allow_test_paths=False):
        self.plan = plan
        self.runtime = runtime or runtime_state
        self.http = http or public_get
        if plan.get('releaseId') != RELEASE:
            fail('RELEASE_ID_MISMATCH')
        self.current = Path(plan.get('current', CURRENT))
        self.candidate = absolute_path(plan.get('candidate', CANDIDATE))
        self.evidence = absolute_path(plan.get('evidenceDir', EVIDENCE))
        self.lock = absolute_path(plan.get('lockPath', LOCK))
        self.archive = absolute_path(plan['archive'])
        self.origin = plan.get('origin', ORIGIN)
        self.baseline = plan['baseline']
        pointers = self.baseline.get('pointers', {})
        if str(self.current) not in pointers:
            fail('WEB_POINTER_BASELINE_MISSING')
        self.old = absolute_path(pointers[str(self.current)])
        if self.current.parent.resolve(strict=True) != self.current.parent:
            fail('WEB_POINTER_PARENT_SYMLINK')
        if self.candidate == self.old or self.candidate.parent != self.old.parent:
            fail('CANDIDATE_LOCATION_INVALID')
        if self.candidate.name != RELEASE:
            fail('CANDIDATE_VERSION_INVALID')
        if self.archive.parent != self.evidence:
            fail('ARCHIVE_MUST_BE_INSIDE_EVIDENCE')
        if not allow_test_paths:
            if (str(self.current) != CURRENT or str(self.candidate) != CANDIDATE
                    or str(self.evidence) != EVIDENCE or str(self.lock) != LOCK
                    or self.origin != ORIGIN or APP_CURRENT not in pointers
                    or not PROTECTED.issubset(self.baseline.get('protectedHashes', {}))):
                fail('PRODUCTION_LAYOUT_MISMATCH')
        if not self.baseline.get('nginxToolFallback'):
            fail('EXISTING_TOOL_FALLBACK_REQUIRED')
        if not re.fullmatch(r'[a-f0-9]{40}', plan.get('sourceCommit', '')):
            fail('SOURCE_COMMIT_INVALID')
        for key in ('archiveSHA256', 'manifestSHA256', 'artifactHash'):
            if not HASH.fullmatch(plan.get(key, '')):
                fail('PLAN_DIGEST_INVALID')
        if set(self.baseline.get('runtime', {})) != set(RUNTIME_NAMES):
            fail('RUNTIME_BASELINE_INCOMPLETE')
        for item in self.baseline['runtime'].values():
            if (set(item) != {'id', 'image', 'startedAt'}
                    or not HASH.fullmatch(item['id'])
                    or not re.fullmatch(r'sha256:[a-f0-9]{64}', item['image'])
                    or not isinstance(item['startedAt'], str) or not item['startedAt']):
                fail('RUNTIME_BASELINE_INVALID')
        for key, value in self.baseline.get('protectedHashes', {}).items():
            absolute_path(key)
            if not HASH.fullmatch(value):
                fail('PROTECTED_HASH_INVALID')
        self.old_files = self.baseline['webFiles']
        if not self.old_files or '200.html' not in self.old_files:
            fail('WEB_BASELINE_INCOMPLETE')
        for key, value in self.old_files.items():
            relative_name(key)
            if (set(value) != {'sha256', 'bytes'} or not HASH.fullmatch(value['sha256'])
                    or type(value['bytes']) is not int or value['bytes'] < 0):
                fail('WEB_BASELINE_INVALID')
        self.plan_hash = sha(canonical(plan))

    @contextlib.contextmanager
    def locked(self):
        if self.lock.is_symlink():
            fail('PUBLISHER_LOCK_SYMLINK')
        with self.lock.open('a') as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                fail('ANOTHER_PUBLISHER_ACTIVE')
            yield

    def check_baseline(self, active):
        if not self.current.is_symlink() or self.current.resolve(strict=True) != active:
            fail('WEB_POINTER_DRIFT')
        for name, expected in self.baseline['pointers'].items():
            if name == str(self.current):
                continue
            if str(Path(name).resolve(strict=True)) != expected:
                fail('PROTECTED_POINTER_DRIFT')
        for name, expected in self.baseline['protectedHashes'].items():
            plain_file(name)
            if file_hash(name) != expected:
                fail('PROTECTED_CONFIGURATION_DRIFT')
        if self.runtime() != self.baseline['runtime']:
            fail('API_OR_WORKER_RUNTIME_DRIFT')
        if inventory(self.old) != self.old_files:
            fail('OLD_WEB_FILES_DRIFT')

    def allowed_overlay(self, name, info):
        if name in TOOL_FILES or name in ('robots.txt', 'sitemap.xml'):
            return
        if name.startswith('free-tools/assets/') or HASHED_ASSET.fullmatch(name):
            if name in self.old_files and info != self.old_files[name]:
                fail('EXISTING_ASSET_BYTES_CHANGED')
            return
        fail('OVERLAY_PATH_NOT_AUTHORIZED')

    def archive_content(self):
        plain_file(self.archive)
        if file_hash(self.archive) != self.plan['archiveSHA256']:
            fail('ARCHIVE_HASH_MISMATCH')
        contents = {}
        with tarfile.open(self.archive, mode='r:*') as handle:
            members = handle.getmembers()
            if not members or len(members) > 10000:
                fail('ARCHIVE_INVENTORY_SIZE_INVALID')
            total = 0
            for member in members:
                name = relative_name(member.name)
                if not member.isfile() or name in contents:
                    fail('ARCHIVE_ENTRY_TYPE_OR_DUPLICATE')
                total += member.size
                if member.size < 0 or member.size > 100 * 1024 * 1024 or total > 512 * 1024 * 1024:
                    fail('ARCHIVE_EXPANSION_LIMIT')
                stream = handle.extractfile(member)
                if stream is None:
                    fail('ARCHIVE_FILE_UNREADABLE')
                contents[name] = stream.read(member.size + 1)
                if len(contents[name]) != member.size:
                    fail('ARCHIVE_FILE_SIZE_MISMATCH')
        raw = contents.get('manifest.json', b'')
        if sha(raw) != self.plan['manifestSHA256']:
            fail('MANIFEST_HASH_MISMATCH')
        manifest = parse_json(raw)
        if (manifest.get('releaseId') != RELEASE
                or manifest.get('sourceCommit') != self.plan['sourceCommit']):
            fail('SOURCE_PROVENANCE_MISMATCH')
        paths = manifest.get('toolPaths', [])
        if len(paths) != len(TOOL_PATHS) or set(paths) != set(TOOL_PATHS):
            fail('APPROVED_TOOL_PATHS_MISMATCH')
        files = manifest.get('files', [])
        if (not files or sha(canonical(files)) != self.plan['artifactHash']
                or manifest.get('artifactHash') != self.plan['artifactHash']):
            fail('ARTIFACT_HASH_MISMATCH')
        overlay = {}
        expected_archive = {'manifest.json'}
        for entry in files:
            if set(entry) != {'path', 'sha256', 'sizeBytes'}:
                fail('MANIFEST_ENTRY_SHAPE_INVALID')
            path = relative_name(entry['path'])
            if not path.startswith('public/') or path in expected_archive:
                fail('MANIFEST_ENTRY_PATH_OR_DUPLICATE')
            expected_archive.add(path)
            name = relative_name(path[len('public/'):])
            if not HASH.fullmatch(entry['sha256']) or type(entry['sizeBytes']) is not int:
                fail('MANIFEST_ENTRY_DIGEST_INVALID')
            data = contents.get(path)
            if data is None or len(data) != entry['sizeBytes'] or sha(data) != entry['sha256']:
                fail('ARTIFACT_FILE_MISMATCH')
            info = {'sha256': entry['sha256'], 'bytes': entry['sizeBytes']}
            self.allowed_overlay(name, info)
            overlay[name] = info
        if set(contents) != expected_archive:
            fail('ARCHIVE_EXACT_INVENTORY_MISMATCH')
        for name in overlay:
            if any(parent.as_posix() in overlay for parent in PurePosixPath(name).parents):
                fail('OVERLAY_FILE_DIRECTORY_COLLISION')
        if not TOOL_FILES.issubset(overlay):
            fail('TOOL_HTML_INVENTORY_INCOMPLETE')
        for tool in TOOL_PATHS:
            parser = Metadata()
            parser.feed(contents['public/' + tool.lstrip('/') + '/index.html'].decode('utf-8'))
            if parser.titles != 1 or parser.canonicals != [self.origin + tool]:
                fail('TOOL_HTML_METADATA_INVALID')
        expected = dict(self.old_files)
        expected.update(overlay)
        return manifest, contents, overlay, dict(sorted(expected.items()))

    def record(self, name, value):
        target = self.evidence / name
        if target.exists() or target.is_symlink():
            fail('RECEIPT_ALREADY_EXISTS')
        temp = self.evidence / ('.' + name + '.' + uuid.uuid4().hex)
        value = {'releaseId': RELEASE, 'planHash': self.plan_hash,
                 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), **value}
        with temp.open('xb') as output:
            output.write(json.dumps(value, indent=2, ensure_ascii=False).encode() + b'\n')
            output.flush()
            os.fsync(output.fileno())
        temp.chmod(0o600)
        os.replace(temp, target)
        return value

    def read_receipt(self, name):
        path = self.evidence / name
        plain_file(path)
        value = parse_json(path.read_bytes())
        if value.get('planHash') != self.plan_hash or value.get('releaseId') != RELEASE:
            fail('RECEIPT_PLAN_MISMATCH')
        return value

    def staged_files(self):
        receipt = self.read_receipt('stage.json')
        if receipt.get('status') != 'WEB_STAGED_NOT_ACTIVE':
            fail('STAGE_NOT_COMPLETE')
        _, _, _, expected = self.archive_content()
        if (receipt.get('candidateInventoryHash') != inventory_hash(expected)
                or inventory(self.candidate) != expected):
            fail('CANDIDATE_FILES_DRIFT')
        return expected

    def pointer(self, target, expected):
        if not self.current.is_symlink() or self.current.resolve(strict=True) != expected:
            fail('PRE_SWITCH_POINTER_DRIFT')
        temp = self.current.with_name(self.current.name + '.free-tools-' + uuid.uuid4().hex)
        try:
            temp.symlink_to(target)
            os.replace(temp, self.current)
        finally:
            if temp.is_symlink():
                temp.unlink()

    def health(self):
        status, _, body = self.http(self.origin, '/health')
        if status != 200:
            fail('PUBLIC_HEALTH_HTTP_FAILED')
        value = parse_json(body)
        fields = ('api', 'database', 'worker', 'email')
        if (any(value.get(key) != 'ok' for key in fields)
                or value.get('source') != self.baseline.get('health', {}).get('source')):
            fail('PUBLIC_HEALTH_BASELINE_FAILED')
        return {key: value.get(key) for key in (*fields, 'source')}

    def public_readback(self, candidate):
        checks = [('/', self.old_files['200.html'])]
        if candidate:
            _, _, overlay, _ = self.archive_content()
            for name, info in sorted(overlay.items()):
                path = '/' + name[:-len('/index.html')] if name in TOOL_FILES else '/' + name
                checks.append((path, info))
        else:
            checks.append(('/tools', self.old_files['tools/index.html']))
        for path, expected in checks:
            status, headers, body = self.http(self.origin, path)
            if status != 200 or len(body) != expected['bytes'] or sha(body) != expected['sha256']:
                fail('PUBLIC_FILE_READBACK_FAILED')
            if path == '/' or path.startswith('/tools'):
                cache = next((value for key, value in headers.items() if key.lower() == 'cache-control'), '')
                if 'no-store' not in cache:
                    fail('HTML_CACHE_POLICY_CHANGED')
        return len(checks)

    def stage(self):
        with self.locked():
            self.check_baseline(self.old)
            _, contents, overlay, expected = self.archive_content()
            if self.candidate.exists() or self.candidate.is_symlink():
                fail('CANDIDATE_ALREADY_EXISTS')
            self.evidence.mkdir(mode=0o700, exist_ok=True)
            self.record('stage-started.json', {'status': 'STAGING'})
            try:
                shutil.copytree(self.old, self.candidate, symlinks=False)
                for name in sorted(overlay):
                    target = self.candidate / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(contents['public/' + name])
                for root, directories, files in os.walk(self.candidate):
                    Path(root).chmod(0o755)
                    for name in files:
                        (Path(root) / name).chmod(0o644)
                if inventory(self.candidate) != expected:
                    fail('CANDIDATE_OVERLAY_NOT_EXACT')
                self.check_baseline(self.old)
                return self.record('stage.json', {
                    'status': 'WEB_STAGED_NOT_ACTIVE', 'candidate': str(self.candidate),
                    'previousWeb': str(self.old), 'overlayFiles': len(overlay),
                    'preservedFiles': len(self.old_files) - len(set(overlay) & set(self.old_files)),
                    'candidateInventoryHash': inventory_hash(expected),
                    'sourceCommit': self.plan['sourceCommit'],
                    'artifactHash': self.plan['artifactHash'],
                })
            except BaseException as error:
                self.record('stage-failed.json', {'status': 'STAGE_FAILED', 'reason': error_code(error)})
                raise

    def activate(self):
        with self.locked():
            self.check_baseline(self.old)
            self.staged_files()
            self.health()
            self.record('activation-started.json', {'status': 'ACTIVATING'})
            switched = False
            try:
                self.check_baseline(self.old)
                self.pointer(self.candidate, self.old)
                switched = True
                self.check_baseline(self.candidate)
                self.staged_files()
                health = self.health()
                checked = self.public_readback(True)
                self.check_baseline(self.candidate)
                return self.record('activation.json', {
                    'status': 'DEPLOYED', 'candidate': str(self.candidate),
                    'previousWeb': str(self.old), 'sourceCommit': self.plan['sourceCommit'],
                    'artifactHash': self.plan['artifactHash'], 'publicFilesVerified': checked,
                    'health': health, 'apiWorkerConfigUnchanged': True,
                })
            except BaseException as error:
                issues = []
                if switched:
                    try:
                        if inventory(self.old) != self.old_files:
                            fail('OLD_WEB_FILES_DRIFT_DURING_RECOVERY')
                        self.pointer(self.old, self.candidate)
                    except BaseException as recovery:
                        issues.append(error_code(recovery))
                result = self.record('activation.json', {
                    'status': ('ROLLBACK_NEEDS_ATTENTION' if issues else
                               'ROLLED_BACK' if switched else 'ABORTED_BEFORE_SWITCH'),
                    'reason': error_code(error), 'issues': issues, 'webOnly': True,
                })
                raise ReleaseError(result['status'] + ':' + error_code(error)) from None

    def rollback(self):
        with self.locked():
            # Also recover a process killed after pointer replacement but before
            # activation.json was written. The pinned start/stage receipts and
            # exact known candidate pointer suffice; a broken candidate need not
            # pass its own checksum in order to restore the untouched old site.
            if not (self.evidence / 'activation-started.json').is_file():
                fail('ACTIVATION_EVIDENCE_REQUIRED')
            started = self.read_receipt('activation-started.json')
            staged = self.read_receipt('stage.json')
            if (started.get('status') != 'ACTIVATING'
                    or staged.get('status') != 'WEB_STAGED_NOT_ACTIVE'
                    or staged.get('candidate') != str(self.candidate)
                    or staged.get('previousWeb') != str(self.old)):
                fail('ACTIVATION_EVIDENCE_INVALID')
            activation = self.evidence / 'activation.json'
            if activation.exists() or activation.is_symlink():
                receipt = self.read_receipt('activation.json')
                if receipt.get('status') not in ('DEPLOYED', 'ROLLBACK_NEEDS_ATTENTION'):
                    fail('CANDIDATE_ACTIVATION_REQUIRED')
            self.check_baseline(self.candidate)
            self.record('rollback-started.json', {'status': 'ROLLING_BACK'})
            try:
                self.pointer(self.old, self.candidate)
                self.check_baseline(self.old)
                health = self.health()
                checked = self.public_readback(False)
                return self.record('rollback.json', {
                    'status': 'ROLLED_BACK', 'restoredWeb': str(self.old),
                    'health': health, 'publicFilesVerified': checked, 'webOnly': True,
                })
            except BaseException as error:
                self.record('rollback.json', {'status': 'ROLLBACK_NEEDS_ATTENTION',
                                             'reason': error_code(error), 'webOnly': True})
                raise


def error_code(error):
    return str(error) if isinstance(error, ReleaseError) else type(error).__name__


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=('stage', 'activate', 'rollback'))
    parser.add_argument('--plan', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        raw = sys.stdin.buffer.read() if args.plan == '-' else Path(args.plan).read_bytes()
        publisher = Publisher(parse_json(raw))
        print(json.dumps(getattr(publisher, args.phase)(), ensure_ascii=False))
    except BaseException as error:
        if isinstance(error, (KeyboardInterrupt, SystemExit)):
            raise
        print(json.dumps({'status': 'FAILED', 'phase': args.phase, 'reason': error_code(error)}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
