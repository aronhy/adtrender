#!/usr/bin/env python3
"""Isolated filesystem/fake-runtime tests. Never SSH or contact a service."""
import copy
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('publish_web', Path(__file__).with_name('publish-web.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class Fixture:
    def __init__(self, root):
        self.root = Path(root).resolve()
        releases = self.root / 'web' / 'releases'
        self.old = releases / 'previous'
        self.old.mkdir(parents=True)
        self.current = self.root / 'web' / 'current'
        self.current.symlink_to(self.old)
        self.app = self.root / 'app'
        self.app.mkdir()
        self.app_pointer = self.root / 'app-current'
        self.app_pointer.symlink_to(self.app)
        self.protected = self.root / 'protected.env'
        self.protected.write_text('private fixture only')
        self.evidence = self.root / 'evidence'
        self.evidence.mkdir()
        self.archive = self.evidence / 'artifact.tar.gz'
        for name, content in {
            '200.html': b'original app shell', 'robots.txt': b'original robots',
            'assets/existing-12345678.js': b'unchanged old bundle',
            'tools/index.html': b'old tools', 'account.html': b'old account',
            'licenses/old.txt': b'old license',
        }.items():
            target = self.old / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        self.runtime = {
            name: {'id': str(index) * 64, 'image': 'sha256:' + str(index + 2) * 64,
                   'startedAt': '2026-10-22T10:00:00Z'}
            for index, name in enumerate(release.RUNTIME_NAMES, start=1)
        }
        baseline = {
            'pointers': {str(self.current): str(self.old), str(self.app_pointer): str(self.app)},
            'protectedHashes': {str(self.protected): release.file_hash(self.protected)},
            'runtime': copy.deepcopy(self.runtime), 'webFiles': release.inventory(self.old),
            'nginxToolFallback': True,
            'health': {'api': 'ok', 'database': 'ok', 'worker': 'ok', 'email': 'ok', 'source': 'stale'},
        }
        self.plan = {
            'releaseId': release.RELEASE, 'sourceCommit': 'a' * 40,
            'archive': str(self.archive), 'archiveSHA256': '0' * 64,
            'manifestSHA256': '0' * 64, 'artifactHash': '0' * 64,
            'baseline': baseline, 'current': str(self.current),
            'candidate': str(releases / release.RELEASE), 'evidenceDir': str(self.evidence),
            'lockPath': str(self.root / 'publish.lock'), 'origin': release.ORIGIN,
        }
        self.contents = {
            'public/' + path.lstrip('/') + '/index.html':
                ('<!doctype html><title>Approved copy</title><link rel="canonical" href="' + release.ORIGIN + path + '">').encode()
            for path in release.TOOL_PATHS
        }
        self.contents.update({
            'public/assets/free-tools-abcdef12.js': b'new tools bundle',
            'public/free-tools/assets/font.woff2': b'font fixture',
            'public/free-tools/assets/icons/LICENSE': b'MIT fixture',
            'public/robots.txt': b'new robots',
            'public/sitemap.xml': b'new sitemap',
        })
        self.http_requests = []
        self.bad_readback = None
        self.bad_health_after_switch = False
        self.make_archive()

    def make_archive(self, transform=None, extra=None):
        files = [{'path': path, 'sha256': release.sha(data), 'sizeBytes': len(data)}
                 for path, data in sorted(self.contents.items())]
        manifest = {'releaseId': release.RELEASE, 'sourceCommit': self.plan['sourceCommit'],
                    'toolPaths': list(release.TOOL_PATHS), 'files': files,
                    'artifactHash': release.sha(release.canonical(files))}
        if transform:
            transform(manifest)
        raw = json.dumps(manifest, indent=2).encode()
        self.plan.update(manifestSHA256=release.sha(raw), artifactHash=manifest['artifactHash'])
        with tarfile.open(self.archive, 'w:gz') as archive:
            for name, data in [('manifest.json', raw), *sorted(self.contents.items())]:
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            if extra:
                name, data, kind = extra
                info = tarfile.TarInfo(name)
                info.type = kind
                info.size = len(data)
                if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                    info.linkname = '../outside'
                archive.addfile(info, io.BytesIO(data))
        self.plan['archiveSHA256'] = release.file_hash(self.archive)

    def http(self, origin, path):
        self.http_requests.append(path)
        if path == '/health':
            value = copy.deepcopy(self.plan['baseline']['health'])
            if self.bad_health_after_switch and self.current.resolve() != self.old:
                value['database'] = 'unavailable'
            return 200, {}, json.dumps(value).encode()
        active = self.current.resolve()
        if path == '/':
            target = active / '200.html'
        elif path in release.TOOL_PATHS:
            target = active / path.lstrip('/') / 'index.html'
        else:
            target = active / path.lstrip('/')
        data = target.read_bytes()
        if self.bad_readback == path:
            data += b'corrupt'
        return 200, {'Cache-Control': 'no-store'}, data

    def publisher(self):
        return release.Publisher(self.plan, runtime=lambda: copy.deepcopy(self.runtime),
                                 http=self.http, allow_test_paths=True)


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.fx = Fixture(self.temp.name)

    def failure(self, code, phase='stage'):
        with self.assertRaisesRegex(release.ReleaseError, code):
            getattr(self.fx.publisher(), phase)()

    def assert_services_unchanged(self):
        self.assertEqual(self.fx.protected.read_text(), 'private fixture only')
        self.assertEqual(self.fx.app_pointer.resolve(), self.fx.app)
        self.assertEqual(release.inventory(self.fx.old), self.fx.plan['baseline']['webFiles'])
        self.assertEqual(self.fx.runtime, self.fx.plan['baseline']['runtime'])

    def test_stage_only_preserves_every_unapproved_file_and_never_contacts_http(self):
        with mock.patch.object(release.subprocess, 'run', side_effect=AssertionError('service command')):
            result = self.fx.publisher().stage()
        self.assertEqual(result['status'], 'WEB_STAGED_NOT_ACTIVE')
        self.assertEqual(self.fx.current.resolve(), self.fx.old)
        self.assertEqual(self.fx.http_requests, [])
        candidate = Path(self.fx.plan['candidate'])
        self.assertEqual((candidate / '200.html').read_bytes(), b'original app shell')
        self.assertEqual((candidate / 'assets/existing-12345678.js').read_bytes(), b'unchanged old bundle')
        self.assertTrue((self.fx.evidence / 'stage.json').is_file())
        self.assert_services_unchanged()

    def test_activate_and_explicit_rollback_only_switch_web_pointer(self):
        publisher = self.fx.publisher()
        publisher.stage()
        with mock.patch.object(release.subprocess, 'run', side_effect=AssertionError('service command')):
            result = publisher.activate()
            self.assertEqual(result['status'], 'DEPLOYED')
            self.assertEqual(self.fx.current.resolve(), Path(self.fx.plan['candidate']))
            restored = publisher.rollback()
        self.assertEqual(restored['status'], 'ROLLED_BACK')
        self.assertEqual(self.fx.current.resolve(), self.fx.old)
        self.assertTrue((self.fx.evidence / 'activation.json').is_file())
        self.assertTrue((self.fx.evidence / 'rollback.json').is_file())
        self.assert_services_unchanged()

    def test_archive_path_traversal(self):
        self.fx.make_archive(extra=('../escape', b'bad', tarfile.REGTYPE))
        self.failure('UNSAFE_RELATIVE_PATH')
        self.assertFalse((self.fx.root / 'escape').exists())

    def test_absolute_archive_path(self):
        self.fx.make_archive(extra=('/tmp/escape', b'bad', tarfile.REGTYPE))
        self.failure('UNSAFE_RELATIVE_PATH')

    def test_encoded_web_path_traversal_is_rejected(self):
        self.fx.contents['public/free-tools/assets/%2e%2e/escape'] = b'bad'
        self.fx.make_archive()
        self.failure('UNSAFE_RELATIVE_PATH')

    def test_query_or_fragment_path_cannot_hide_unserved_asset(self):
        self.fx.contents['public/free-tools/assets/icon.svg?download'] = b'bad'
        self.fx.make_archive()
        self.failure('UNSAFE_RELATIVE_PATH')

    def test_file_directory_prefix_collision_is_rejected(self):
        self.fx.contents['public/free-tools/assets/collision'] = b'file'
        self.fx.contents['public/free-tools/assets/collision/nested'] = b'nested'
        self.fx.make_archive()
        self.failure('OVERLAY_FILE_DIRECTORY_COLLISION')

    def test_archive_symlink(self):
        self.fx.make_archive(extra=('public/free-tools/assets/symlink', b'', tarfile.SYMTYPE))
        self.failure('ARCHIVE_ENTRY_TYPE_OR_DUPLICATE')

    def test_archive_hardlink(self):
        self.fx.make_archive(extra=('public/free-tools/assets/hardlink', b'', tarfile.LNKTYPE))
        self.failure('ARCHIVE_ENTRY_TYPE_OR_DUPLICATE')

    def test_unknown_override(self):
        self.fx.contents['public/200.html'] = b'changed main application'
        self.fx.make_archive()
        self.failure('OVERLAY_PATH_NOT_AUTHORIZED')

    def test_unknown_tool_even_when_well_formed(self):
        self.fx.contents['public/tools/not-approved/index.html'] = b'unknown'
        self.fx.make_archive()
        self.failure('OVERLAY_PATH_NOT_AUTHORIZED')

    def test_hash_named_asset_required(self):
        self.fx.contents['public/assets/unhashed.js'] = b'new'
        self.fx.make_archive()
        self.failure('OVERLAY_PATH_NOT_AUTHORIZED')

    def test_existing_asset_different_bytes_rejected(self):
        self.fx.contents['public/assets/existing-12345678.js'] = b'overwritten'
        self.fx.make_archive()
        self.failure('EXISTING_ASSET_BYTES_CHANGED')

    def test_existing_asset_identical_allowed(self):
        self.fx.contents['public/assets/existing-12345678.js'] = b'unchanged old bundle'
        self.fx.make_archive()
        self.assertEqual(self.fx.publisher().stage()['status'], 'WEB_STAGED_NOT_ACTIVE')

    def test_exact_archive_inventory(self):
        self.fx.make_archive(extra=('public/free-tools/assets/unlisted.svg', b'new', tarfile.REGTYPE))
        self.failure('ARCHIVE_EXACT_INVENTORY_MISMATCH')

    def test_duplicate_archive_entry(self):
        self.fx.make_archive(extra=('public/robots.txt', b'duplicate', tarfile.REGTYPE))
        self.failure('ARCHIVE_ENTRY_TYPE_OR_DUPLICATE')

    def test_archive_digest_mismatch(self):
        self.fx.plan['archiveSHA256'] = 'b' * 64
        self.failure('ARCHIVE_HASH_MISMATCH')

    def test_manifest_digest_mismatch(self):
        self.fx.plan['manifestSHA256'] = 'b' * 64
        self.failure('MANIFEST_HASH_MISMATCH')

    def test_artifact_digest_mismatch(self):
        self.fx.plan['artifactHash'] = 'b' * 64
        self.failure('ARTIFACT_HASH_MISMATCH')

    def test_source_commit_mismatch(self):
        self.fx.make_archive(transform=lambda m: m.update(sourceCommit='c' * 40))
        self.failure('SOURCE_PROVENANCE_MISMATCH')

    def test_tool_path_set_is_fixed(self):
        self.fx.make_archive(transform=lambda m: m['toolPaths'].__setitem__(1, '/tools/unreviewed'))
        self.failure('APPROVED_TOOL_PATHS_MISMATCH')

    def test_missing_tool_html(self):
        self.fx.contents.pop('public/tools/guide/index.html')
        self.fx.make_archive()
        self.failure('TOOL_HTML_INVENTORY_INCOMPLETE')

    def test_metadata_mismatch(self):
        self.fx.contents['public/tools/guide/index.html'] = b'<title>guide</title>'
        self.fx.make_archive()
        self.failure('TOOL_HTML_METADATA_INVALID')

    def test_protected_configuration_drift(self):
        self.fx.protected.write_text('changed outside')
        self.failure('PROTECTED_CONFIGURATION_DRIFT')

    def test_runtime_drift_between_stage_and_activation(self):
        self.fx.publisher().stage()
        self.fx.runtime[release.RUNTIME_NAMES[0]]['startedAt'] = '2026-10-25T00:00:00Z'
        self.failure('API_OR_WORKER_RUNTIME_DRIFT', 'activate')
        self.assertEqual(self.fx.current.resolve(), self.fx.old)

    def test_old_web_drift(self):
        self.fx.publisher().stage()
        (self.fx.old / 'account.html').write_text('changed outside')
        self.failure('OLD_WEB_FILES_DRIFT', 'activate')

    def test_app_pointer_drift(self):
        self.fx.publisher().stage()
        self.fx.app_pointer.unlink()
        self.fx.app_pointer.symlink_to(self.fx.old)
        self.failure('PROTECTED_POINTER_DRIFT', 'activate')

    def test_candidate_modified_after_stage(self):
        self.fx.publisher().stage()
        (Path(self.fx.plan['candidate']) / '200.html').write_text('tampered')
        self.failure('CANDIDATE_FILES_DRIFT', 'activate')

    def test_staged_plan_cannot_be_substituted(self):
        self.fx.publisher().stage()
        self.fx.plan['unusedSubstitution'] = True
        self.failure('RECEIPT_PLAN_MISMATCH', 'activate')

    def test_health_failure_after_switch_automatically_restores_only_web(self):
        self.fx.publisher().stage()
        self.fx.bad_health_after_switch = True
        self.failure('ROLLED_BACK:PUBLIC_HEALTH_BASELINE_FAILED', 'activate')
        self.assertEqual(self.fx.current.resolve(), self.fx.old)
        value = json.loads((self.fx.evidence / 'activation.json').read_text())
        self.assertEqual(value['status'], 'ROLLED_BACK')
        self.assert_services_unchanged()

    def test_public_readback_failure_automatically_restores_only_web(self):
        self.fx.publisher().stage()
        self.fx.bad_readback = '/tools/shipping-policy-generator'
        self.failure('ROLLED_BACK:PUBLIC_FILE_READBACK_FAILED', 'activate')
        self.assertEqual(self.fx.current.resolve(), self.fx.old)
        self.assert_services_unchanged()

    def test_unknown_web_pointer_is_never_overwritten(self):
        self.fx.publisher().stage()
        self.fx.current.unlink()
        self.fx.current.symlink_to(self.fx.app)
        self.failure('WEB_POINTER_DRIFT', 'activate')
        self.assertEqual(self.fx.current.resolve(), self.fx.app)

    def test_rollback_requires_known_candidate(self):
        publisher = self.fx.publisher()
        publisher.stage()
        publisher.activate()
        self.fx.current.unlink()
        self.fx.current.symlink_to(self.fx.app)
        self.failure('WEB_POINTER_DRIFT', 'rollback')
        self.assertEqual(self.fx.current.resolve(), self.fx.app)

    def test_rollback_recovers_crash_after_known_pointer_switch(self):
        publisher = self.fx.publisher()
        publisher.stage()
        publisher.record('activation-started.json', {'status': 'ACTIVATING'})
        publisher.pointer(publisher.candidate, publisher.old)
        self.assertFalse((self.fx.evidence / 'activation.json').exists())
        self.assertEqual(publisher.rollback()['status'], 'ROLLED_BACK')
        self.assertEqual(self.fx.current.resolve(), self.fx.old)
        self.assert_services_unchanged()

    def test_rollback_can_restore_old_site_when_candidate_is_corrupted(self):
        publisher = self.fx.publisher()
        publisher.stage()
        publisher.activate()
        (publisher.candidate / 'tools/index.html').write_text('corrupted after activation')
        self.assertEqual(publisher.rollback()['status'], 'ROLLED_BACK')
        self.assertEqual(self.fx.current.resolve(), self.fx.old)
        self.assert_services_unchanged()

    def test_rollback_requires_actual_activation_attempt(self):
        publisher = self.fx.publisher()
        publisher.stage()
        publisher.pointer(publisher.candidate, publisher.old)
        self.failure('ACTIVATION_EVIDENCE_REQUIRED', 'rollback')

    def test_public_cache_policy_failure_restores_old_pointer(self):
        publisher = self.fx.publisher()
        publisher.stage()
        original_http = publisher.http
        publisher.http = lambda origin, path: (lambda r: (r[0], {}, r[2]))(original_http(origin, path))
        with self.assertRaisesRegex(release.ReleaseError, 'ROLLED_BACK:HTML_CACHE_POLICY_CHANGED'):
            publisher.activate()
        self.assertEqual(self.fx.current.resolve(), self.fx.old)

    def test_candidate_extra_unknown_file_rejected(self):
        self.fx.publisher().stage()
        (Path(self.fx.plan['candidate']) / 'unknown.txt').write_text('unexpected')
        self.failure('CANDIDATE_FILES_DRIFT', 'activate')

    def test_runtime_drift_after_switch_restores_only_pointer(self):
        publisher = self.fx.publisher()
        publisher.stage()
        original = publisher.pointer
        def switch(target, expected):
            original(target, expected)
            if target == publisher.candidate:
                self.fx.runtime[release.RUNTIME_NAMES[1]]['startedAt'] = 'external change'
        publisher.pointer = switch
        with self.assertRaisesRegex(release.ReleaseError, 'ROLLED_BACK:API_OR_WORKER_RUNTIME_DRIFT'):
            publisher.activate()
        self.assertEqual(self.fx.current.resolve(), self.fx.old)
        self.assertEqual(self.fx.runtime[release.RUNTIME_NAMES[1]]['startedAt'], 'external change')

    def test_configuration_drift_after_switch_is_not_silently_reverted(self):
        publisher = self.fx.publisher()
        publisher.stage()
        original = publisher.pointer
        def switch(target, expected):
            original(target, expected)
            if target == publisher.candidate:
                self.fx.protected.write_text('external update')
        publisher.pointer = switch
        with self.assertRaisesRegex(release.ReleaseError, 'ROLLED_BACK:PROTECTED_CONFIGURATION_DRIFT'):
            publisher.activate()
        self.assertEqual(self.fx.current.resolve(), self.fx.old)
        self.assertEqual(self.fx.protected.read_text(), 'external update')

    def test_stage_refuses_retries_preserving_receipts(self):
        self.fx.publisher().stage()
        self.failure('CANDIDATE_ALREADY_EXISTS')

    def test_activation_refuses_retries_after_automatic_rollback(self):
        self.fx.publisher().stage()
        self.fx.bad_readback = '/tools'
        self.failure('ROLLED_BACK:', 'activate')
        self.fx.bad_readback = None
        self.failure('RECEIPT_ALREADY_EXISTS', 'activate')

    def test_baseline_symlink_is_rejected(self):
        external = self.fx.root / 'external'
        external.write_text('not a regular baseline file')
        (self.fx.old / 'link').symlink_to(external)
        self.failure('REGULAR_FILE_REQUIRED')

    def test_json_duplicate_keys_rejected(self):
        with self.assertRaisesRegex(release.ReleaseError, 'DUPLICATE_JSON_KEY'):
            release.parse_json(b'{"key":1,"key":2}')

    def test_cli_production_paths_cannot_be_changed_by_input_plan(self):
        with self.assertRaisesRegex(release.ReleaseError, 'PRODUCTION_LAYOUT_MISMATCH'):
            release.Publisher(self.fx.plan)


if __name__ == '__main__':
    unittest.main(verbosity=2)
