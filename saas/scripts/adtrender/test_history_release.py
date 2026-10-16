import ast
import copy
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import urlparse

P = pathlib.Path
SOURCE = P(__file__).with_name('history_release_remote.py').read_text()
TREE = ast.parse(SOURCE)
NODES = [n for n in TREE.body if isinstance(n, (ast.Import, ast.ImportFrom, ast.FunctionDef))]


def functions():
    ns = {}
    exec(compile(ast.Module(body=NODES, type_ignores=[]), '<history-remote-functions>', 'exec'), ns)
    ns.update(P=P, sha=lambda b: hashlib.sha256(b).hexdigest())
    return ns


class ResumeSafety(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = P(self.tmp.name)
        self.backup, self.config = self.root/'backup', self.root/'config'
        self.app, self.web = self.root/'app', self.root/'web'
        for path in [self.backup, self.config, self.app, self.web]:
            path.mkdir()
        self.site = self.root/'nginx.conf'
        self.site.write_bytes(b'old site')
        config_sha = {}
        for name in ['app.env', 'release.env']:
            content = ('old '+name).encode()
            (self.config/name).write_bytes(content)
            (self.backup/name).write_bytes(content)
            config_sha[name] = hashlib.sha256(content).hexdigest()
        (self.backup/'nginx.conf').write_bytes(self.site.read_bytes())
        self.before = {'app': '/old/app', 'web': '/old/web', 'configSHA256': config_sha,
                       'nginxSHA256': hashlib.sha256(self.site.read_bytes()).hexdigest()}
        self.plan = {'version': 'fixture', 'sourceCommit': 'a'*40, 'artifactHash': 'b'*64,
                     'expectedApp': '/old/app', 'expectedWeb': '/old/web', 'baseline': self.before}
        self.old = [{'name': 'baseline', 'checksum': 'c'*64}]
        dump = self.backup/'database-before-history.dump'
        dump.write_bytes(b'verified original dump')
        self.proof = {'sha256': hashlib.sha256(dump.read_bytes()).hexdigest(),
                      'bytes': dump.stat().st_size, 'restoreVerified': True,
                      'restoredMigrationCount': 1, 'restoreDatabase': 'fixture_restore'}
        (self.backup/'database-backup-verification.json').write_text(json.dumps(self.proof))
        self.record = {'status': 'failed', 'error': 'Archive read-only grant verification failed',
                       'version': 'fixture', 'sourceCommit': 'a'*40, 'artifactHash': 'b'*64,
                       'before': self.before, 'previousTarget': None,
                       'nginxMode': self.site.stat().st_mode & 0o777,
                       'databaseBackup': self.proof, 'startedAtUtc': '2026-10-08T00:00:00Z'}
        self.write_record()
        self.ns = functions()
        self.ns.update(ROOT=self.app, WEB=self.web, CONFIG=self.config, SITE=self.site,
                       backup=self.backup, webrelease=self.web/'new', plan=self.plan,
                       version='fixture', now=lambda: '2026-10-08T01:00:00Z')

    def write_record(self):
        (self.backup/'deployment.json').write_text(json.dumps(self.record, indent=2)+'\n')

    def resume(self):
        self.assertTrue('resume_activation' in self.ns, 'Missing guarded recovery for completed migrations before runtime activation')
        return self.ns['resume_activation'](self.before, self.old)

    def test_valid_recovery_preserves_failed_record_and_original_backup(self):
        original = (self.backup/'deployment.json').read_bytes()
        dump = (self.backup/'database-before-history.dump').read_bytes()
        resumed = self.resume()
        self.assertEqual(resumed['status'], 'preparing')
        self.assertNotIn('error', resumed)
        self.assertEqual(resumed['databaseBackup'], self.proof)
        self.assertEqual((self.backup/'deployment-before-acl-resume.json').read_bytes(), original)
        self.assertEqual((self.backup/'deployment.json').read_bytes(), original)
        self.assertEqual((self.backup/'database-before-history.dump').read_bytes(), dump)

    def test_other_errors_status_or_provenance_cannot_resume(self):
        for change in [{'error':'Some different failure'}, {'status':'active'},
                       {'sourceCommit':'d'*40}, {'artifactHash':'e'*64}, {'version':'other'}]:
            with self.subTest(change=change):
                original = copy.deepcopy(self.record)
                self.record.update(change); self.write_record()
                with self.assertRaises(RuntimeError): self.resume()
                self.assertFalse((self.backup/'deployment-before-acl-resume.json').exists())
                self.record = original

    def test_runtime_mutation_marks_and_changed_baseline_are_rejected(self):
        for key in ['changedConfigSHA256', 'changedNginxSHA256', 'retainedOldAssets',
                    'health', 'appCurrent', 'runtimeChanged', 'rollbackVerifiedAtUtc']:
            with self.subTest(key=key):
                self.record[key] = {}; self.write_record()
                with self.assertRaisesRegex(RuntimeError, 'runtime'): self.resume()
                self.record.pop(key)
        self.record['before'] = dict(self.before, app='/different/app'); self.write_record()
        with self.assertRaisesRegex(RuntimeError, 'baseline'): self.resume()

    def test_dump_restore_proof_must_match_and_verify_old_baseline(self):
        for change in [{'restoreVerified':False}, {'restoredMigrationCount':2}, {'sha256':'d'*64}, {'bytes':0}]:
            with self.subTest(change=change):
                proof = dict(self.proof, **change)
                self.record['databaseBackup'] = proof; self.write_record()
                (self.backup/'database-backup-verification.json').write_text(json.dumps(proof))
                with self.assertRaisesRegex(RuntimeError, 'backup'): self.resume()
        self.record['databaseBackup'] = self.proof; self.write_record()
        (self.backup/'database-backup-verification.json').write_text(json.dumps(self.proof))
        (self.backup/'database-before-history.dump').write_bytes(b'changed dump')
        with self.assertRaisesRegex(RuntimeError, 'backup'): self.resume()

    def test_old_environment_and_site_backups_cannot_drift_or_be_symlinks(self):
        for name in ['app.env', 'release.env', 'nginx.conf']:
            with self.subTest(name=name):
                path = self.backup/name; original = path.read_bytes()
                path.write_bytes(b'changed')
                with self.assertRaisesRegex(RuntimeError, 'backup'): self.resume()
                path.unlink(); path.symlink_to(self.config/'app.env')
                with self.assertRaisesRegex(RuntimeError, 'backup'): self.resume()
                path.unlink(); path.write_bytes(original)

    def test_existing_web_candidate_previous_drift_and_pending_files_are_rejected(self):
        candidate = self.web/'new'; candidate.mkdir()
        with self.assertRaisesRegex(RuntimeError, 'runtime'): self.resume()
        candidate.rmdir()
        (self.app/'previous').symlink_to('/different')
        with self.assertRaisesRegex(RuntimeError, 'previous'): self.resume()
        (self.app/'previous').unlink()
        pending = self.config/'app.env.history-new'; pending.write_bytes(b'pending')
        with self.assertRaisesRegex(RuntimeError, 'Pending'): self.resume()

    def test_failed_record_preservation_is_never_overwritten(self):
        preserved = self.backup/'deployment-before-acl-resume.json'; preserved.write_bytes(b'first evidence')
        with self.assertRaisesRegex(RuntimeError, 'preserved'): self.resume()
        self.assertEqual(preserved.read_bytes(), b'first evidence')


class MigrationsAndDriverSafety(unittest.TestCase):
    def test_resume_requires_complete_exact_new_migration_checksums(self):
        with tempfile.TemporaryDirectory() as temp:
            root=P(temp); old, new=root/'old', root/'new'
            names=['0001_base', '0002_hotfix', '0003_history', '0004_archive']
            for directory, selected in [(old,names[:1]), (new,names)]:
                folder=directory/'app/.wasp/out/db/migrations'; folder.mkdir(parents=True)
                (folder/'migration_lock.toml').write_text('provider="postgresql"')
                for name in selected:
                    (folder/name).mkdir(); (folder/name/'migration.sql').write_text(name)
            ns=functions(); expected=ns['migrations'](new)
            ns.update(plan={'expectedApp':str(old),'alreadyAppliedMigrationNames':names[1:2],
                            'migrationNames':names[2:]}, release=new, sql=lambda q:0,
                      db_migrations=lambda:expected)
            with self.assertRaisesRegex(RuntimeError, 'baseline'): ns['check_migrations']()
            try: actual=ns['check_migrations'](allow_applied=True)
            except TypeError: self.fail('Resume mode must independently require all reviewed migrations already applied')
            self.assertEqual(actual, (expected[:2], expected))
            ns['db_migrations']=lambda:expected[:-1]
            with self.assertRaisesRegex(RuntimeError, 'migration'): ns['check_migrations'](allow_applied=True)
            ns['db_migrations']=lambda:[*expected[:-1],dict(expected[-1],checksum='d'*64)]
            with self.assertRaisesRegex(RuntimeError, 'migration'): ns['check_migrations'](allow_applied=True)

    def test_staged_image_and_manifest_identity_are_required_before_recovery(self):
        with tempfile.TemporaryDirectory() as temp:
            root=P(temp); backup=root/'backup'; release=root/'release'
            backup.mkdir(); release.mkdir(); (release/'release-manifest.json').write_bytes(b'fixed manifest')
            digest='sha256:'+'1'*64
            staged={'status':'STAGED_NOT_ACTIVE','version':'fixture','imageId':digest,
                    'manifestSHA256':hashlib.sha256(b'fixed manifest').hexdigest()}
            (backup/'staged.json').write_text(json.dumps(staged))
            ns=functions(); ns.update(backup=backup,release=release,version='fixture',
                                      image='fixed:fixture',text=lambda args:digest)
            self.assertTrue('verify_staged' in ns, 'Recovery must verify immutable staged identity before preserving failure evidence')
            self.assertEqual(ns['verify_staged'](),staged)
            ns['text']=lambda args:'sha256:'+'2'*64
            with self.assertRaisesRegex(RuntimeError,'Staged'): ns['verify_staged']()
            ns['text']=lambda args:digest
            (release/'release-manifest.json').write_bytes(b'changed manifest')
            with self.assertRaisesRegex(RuntimeError,'Staged'): ns['verify_staged']()
            (release/'release-manifest.json').write_bytes(b'fixed manifest')
            for change in [{'status':'active'},{'version':'other'},{'imageId':'mutable:tag'}]:
                (backup/'staged.json').write_text(json.dumps(dict(staged,**change)))
                with self.assertRaisesRegex(RuntimeError,'Staged'): ns['verify_staged']()

    def test_resume_cli_refuses_without_explicit_execute_before_network(self):
        with tempfile.TemporaryDirectory() as temp:
            (P(temp)/'plan.json').write_text('{}')
            result=subprocess.run([sys.executable,str(P(__file__).with_name('history_release.py')),
                                   'resume-activate','--plan-dir',temp],capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('explicit --execute required',result.stderr)


class PrepareMigrationLayoutSafety(unittest.TestCase):
    def setUp(self):
        tree=ast.parse(P(__file__).with_name('history_release.py').read_text())
        nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef)]
        self.ns={'pathlib':P,'re':__import__('re'),'sha':lambda b:hashlib.sha256(b).hexdigest()}
        exec(compile(ast.Module(body=nodes,type_ignores=[]),'<history-driver-functions>','exec'),self.ns)
        self.base=[{'name':f'20261001{i:06d}_baseline','checksum':hashlib.sha256(str(i).encode()).hexdigest()} for i in range(8)]
        self.delta=[{'name':name,'checksum':hashlib.sha256(name.encode()).hexdigest()} for name in [
            '20261008120000_media_download_retry','20261008160000_ad_history_foundation','20261008170000_ad_media_archive']]

    def layout(self,old,new,database,unfinished=0):
        self.assertTrue('migration_plan_layout' in self.ns,'Prepare must derive reviewed migration layout from exact server checksums')
        return self.ns['migration_plan_layout'](old,new,database,unfinished)

    def test_first_history_rollout_keeps_reviewed_one_applied_two_pending(self):
        result=self.layout(self.base,self.base+self.delta,self.base+self.delta[:1])
        self.assertEqual(result,{'alreadyAppliedMigrationNames':[self.delta[0]['name']],
                                 'migrationNames':[entry['name'] for entry in self.delta[1:]]})

    def test_same_schema_followup_has_no_applied_or_pending_deltas(self):
        full=self.base+self.delta
        self.assertEqual(self.layout(full,full,full),{'alreadyAppliedMigrationNames':[],'migrationNames':[]})

    def test_any_checksum_drift_or_missing_old_database_prefix_is_refused(self):
        full=self.base+self.delta
        for old,new,database in [(self.base,full,[dict(self.base[0],checksum='f'*64),*full[1:]]),
                                 (self.base,[dict(self.base[0],checksum='f'*64),*full[1:]],self.base),
                                 (full,full,self.base), (self.base,full,full+[dict(self.delta[-1],name='future')])]:
            with self.subTest(old=len(old),new=len(new),database=len(database)):
                with self.assertRaisesRegex(RuntimeError,'migration'): self.layout(old,new,database)

    def test_unknown_additive_migration_and_unfinished_rows_are_refused(self):
        unknown={'name':'20261008200000_unreviewed','checksum':'d'*64}
        with self.assertRaisesRegex(RuntimeError,'reviewed'): self.layout(self.base,self.base+self.delta+[unknown],self.base)
        with self.assertRaisesRegex(RuntimeError,'Unfinished'): self.layout(self.base,self.base+self.delta,self.base,1)

    def test_duplicate_names_malformed_checksums_and_reordered_known_deltas_are_refused(self):
        for new in [self.base+self.delta+[self.delta[-1]],
                    self.base+[dict(self.delta[0],checksum='malformed')],
                    self.base+[self.delta[1],self.delta[0],self.delta[2]]]:
            with self.subTest(new=new[-1]['name']):
                with self.assertRaises(RuntimeError): self.layout(self.base,new,self.base)

    def test_remote_schema_inspection_is_readonly_and_checks_baseline_twice(self):
        ns=functions(); before={'app':'/old/app','web':'/old/web'}; calls=[]
        ns.update(plan={'expectedApp':'/old/app'},baseline=lambda:(calls.append('baseline') or before),
                  migrations=lambda path:(calls.append('old-migrations') or self.base),
                  db_migrations=lambda:(calls.append('database-migrations') or self.base+self.delta),
                  sql=lambda query:(calls.append('unfinished') or 0))
        self.assertTrue('inspect_schema' in ns,'Need remotely read-only checksum inspection')
        self.assertEqual(ns['inspect_schema'](),{'baseline':before,'oldMigrations':self.base,
                                                'databaseMigrations':self.base+self.delta,'unfinishedMigrations':0})
        self.assertEqual(calls,['baseline','old-migrations','database-migrations','unfinished','baseline'])
        states=iter([before,dict(before,app='/drift')]);ns['baseline']=lambda:next(states)
        with self.assertRaisesRegex(RuntimeError,'DRIFT'): ns['inspect_schema']()


class ArchiveAclSafety(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('SAAS_TEST_DATABASE_URL'), 'Requires isolated local PostgreSQL fixture')
    def test_real_postgres_removes_table_and_column_writes_without_global_changes(self):
        url=urlparse(os.environ['SAAS_TEST_DATABASE_URL'])
        self.assertIn(url.hostname, ['localhost','127.0.0.1'], 'ACL verification is local only')
        env=dict(os.environ,PGHOST=url.hostname,PGPORT=str(url.port or 5432),PGUSER=url.username,
                 PGPASSWORD=url.password or '',PGDATABASE=url.path.lstrip('/'))
        ns=functions(); queries=[]
        ns['sql']=lambda query,readonly=True:(queries.append((query,readonly)) or (True if readonly else None))
        ns['archive_readonly_grants']()
        mutation=queries[0][0].removeprefix('BEGIN;').removesuffix('COMMIT;')
        verification=queries[1][0]
        script='''BEGIN;
SET LOCAL client_min_messages=warning;
DO $fixture$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='saas_app') THEN CREATE ROLE saas_app NOLOGIN; END IF;
END $fixture$;
CREATE TEMP TABLE saved_default_acl AS SELECT oid,defaclrole,defaclnamespace,defaclobjtype,defaclacl FROM pg_default_acl;
CREATE TEMP TABLE protected_history_acl_fixture(id int);
GRANT SELECT,UPDATE ON protected_history_acl_fixture TO saas_app;
GRANT ALL PRIVILEGES ON public."ArchiveMediaCapture" TO saas_app, PUBLIC;
GRANT UPDATE ("sourceUrl") ON public."ArchiveMediaCapture" TO saas_app, PUBLIC;
'''+mutation+'''
SELECT json_build_object(
 'readonly',('''+verification.removeprefix('SELECT ')+'''),
 'captureInsert',has_table_privilege('saas_media_archive_capture','public."ArchiveMediaCapture"','INSERT'),
 'captureUpdate',has_table_privilege('saas_media_archive_capture','public."ArchiveMediaCapture"','UPDATE'),
 'guardRead',has_table_privilege('saas_media_archive_guard','public."ArchiveMediaCapture"','SELECT'),
 'unrelatedUpdate',has_table_privilege('saas_app','protected_history_acl_fixture','UPDATE'),
 'defaultsUnchanged',NOT EXISTS(SELECT * FROM pg_default_acl EXCEPT SELECT * FROM saved_default_acl)
   AND NOT EXISTS(SELECT * FROM saved_default_acl EXCEPT SELECT * FROM pg_default_acl));
ROLLBACK;'''
        result=subprocess.run(['psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],input=script,
                              text=True,capture_output=True,env=env)
        self.assertEqual(result.returncode,0,result.stderr)
        proof=json.loads(result.stdout.strip())
        self.assertEqual(proof,{'readonly':True,'captureInsert':True,'captureUpdate':False,
                                'guardRead':True,'unrelatedUpdate':True,'defaultsUnchanged':True})

    @unittest.skipUnless(os.environ.get('SAAS_TEST_DATABASE_URL'), 'Requires isolated local PostgreSQL fixture')
    def test_noinherit_member_role_with_column_write_also_blocks_archive_readonly(self):
        url=urlparse(os.environ['SAAS_TEST_DATABASE_URL'])
        self.assertIn(url.hostname,['localhost','127.0.0.1'],'ACL verification is local only')
        env=dict(os.environ,PGHOST=url.hostname,PGPORT=str(url.port or 5432),PGUSER=url.username,
                 PGPASSWORD=url.password or '',PGDATABASE=url.path.lstrip('/'))
        ns=functions(); queries=[]
        ns['sql']=lambda query,readonly=True:(queries.append((query,readonly)) or (True if readonly else None))
        ns['archive_readonly_grants']()
        mutation=queries[0][0].removeprefix('BEGIN;').removesuffix('COMMIT;')
        verification=queries[1][0]
        script='''BEGIN;
SET LOCAL client_min_messages=warning;
DO $fixture$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='saas_app') THEN CREATE ROLE saas_app NOLOGIN; END IF;
END $fixture$;
ALTER ROLE saas_app NOINHERIT;
CREATE ROLE history_acl_noinherit_writer_fixture NOLOGIN;
GRANT history_acl_noinherit_writer_fixture TO saas_app;
GRANT UPDATE ("sourceUrl") ON public."ArchiveMediaCapture" TO history_acl_noinherit_writer_fixture;
'''+mutation+'''
SELECT json_build_object(
 'effectiveWrite',has_any_column_privilege('saas_app','public."ArchiveMediaCapture"','UPDATE'),
 'memberWrite',has_any_column_privilege('history_acl_noinherit_writer_fixture','public."ArchiveMediaCapture"','UPDATE'),
 'canAssume',pg_has_role('saas_app','history_acl_noinherit_writer_fixture','MEMBER'),
 'strictReadOnly',('''+verification.removeprefix('SELECT ')+'''));
ROLLBACK;'''
        result=subprocess.run(['psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],input=script,
                              text=True,capture_output=True,env=env)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout.strip()),{'effectiveWrite':False,'memberWrite':True,
                                                           'canAssume':True,'strictReadOnly':False})

    def test_inherited_or_column_write_permissions_still_block_runtime(self):
        ns=functions(); effects=[]
        ns.update(sql=lambda query,readonly=True:(effects.append((query,readonly)) or (False if readonly else None)))
        self.assertTrue('archive_readonly_grants' in ns,'Archive grant needs narrow revoke before selective grant')
        with self.assertRaisesRegex(RuntimeError,'Archive read-only'): ns['archive_readonly_grants']()
        self.assertTrue(effects)

if __name__=='__main__': unittest.main()
