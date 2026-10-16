import contextlib
import importlib.util
import io
import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import host_ops
import release
from fleet_config import load


class OperationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve()
        self.config=load(Path(__file__).with_name('targets.json'));self.target=self.config['targets'][0];self.revision='a'*40
    def command(self,args,**kwargs): return subprocess.CompletedProcess(args,0,'','')
    def test_snapshot_failure_leaves_no_reusable_partial_archive(self):
        record=self.root/'snapshot';record.mkdir();(record/'handover.json').write_text('{"committed":false}')
        evidence=self.root/'google-collector'/'evidence';evidence.mkdir(parents=True);(evidence/'state.json').write_text('{"schema":1,"pauseUntil":12345}')
        (evidence/'unsafe').symlink_to('/etc/shadow');target={**self.target,'platforms':['google']}
        with patch.object(host_ops,'snapshot_root',return_value=record),patch.object(host_ops,'SOURCE_STATE',self.root),patch.object(host_ops,'run',self.command):
            with self.assertRaises(ValueError):host_ops.source_snapshot(self.config,target,self.revision)
            self.assertFalse((record/'snapshot.tar.gz').exists());self.assertFalse((record/'snapshot.tar.pending').exists())
            (evidence/'unsafe').unlink();snapshot=host_ops.source_snapshot(self.config,target,self.revision)
        self.assertEqual(snapshot['sha256'],host_ops.digest(record/'snapshot.tar.gz'))
        with tarfile.open(record/'snapshot.tar.gz') as archive:self.assertEqual(archive.extractfile('google/state.json').read(),(evidence/'state.json').read_bytes())
    def test_repeated_pause_still_confirms_source_is_stopped(self):
        record=self.root/'snapshot';record.mkdir();(record/'handover.json').write_text(json.dumps({'committed':False,'services':{'google':True},'revision':self.revision}))
        events=[]
        def command(args,**kwargs):events.append(args);return self.command(args,**kwargs)
        with patch.object(host_ops,'snapshot_root',return_value=record),patch.object(host_ops,'run',command):host_ops.source_pause(self.config,{**self.target,'platforms':['google']},self.revision)
        self.assertIn(['systemctl','stop','google-collector.service'],events)
    def test_snapshot_hash_failure_does_not_touch_existing_target_progress(self):
        root=self.root/'us01';(root/'incoming').mkdir(parents=True);(root/'state'/'google').mkdir(parents=True)
        checkpoint=root/'state'/'google'/'state.json';checkpoint.write_text('{"seen":["keep"],"pauseUntil":999}')
        (root/'incoming'/(self.revision+'.tar.gz')).write_bytes(b'broken')
        with patch.object(host_ops,'ROOT',self.root),patch.object(host_ops,'run',self.command):
            with self.assertRaisesRegex(ValueError,'FLEET_SNAPSHOT_HASH_INVALID'):host_ops.target_import(self.target,self.revision,{'bytes':6,'sha256':'b'*64})
        self.assertEqual(json.loads(checkpoint.read_text())['seen'],['keep'])
    def test_target_rollback_restores_code_and_private_config_but_keeps_progress(self):
        root=self.root/'us01';old=root/'releases'/('b'*40);new=root/'releases'/self.revision;old.mkdir(parents=True);new.mkdir()
        (old/'manifest.json').write_text(json.dumps({'revision':'b'*40}));(root/'current').symlink_to(new)
        (root/'owner.json').write_text(json.dumps({'handoverRevision':'c'*40,'revision':self.revision}))
        (root/'state'/'google').mkdir(parents=True);checkpoint=root/'state'/'google'/'state.json';checkpoint.write_text('{"seen":["new-progress"],"pauseUntil":999}')
        tx=root/'transactions'/self.revision;(tx/'config').mkdir(parents=True);(tx/'config'/'google.env').write_text('PRIVATE=old');(root/'config').mkdir();(root/'config'/'google.env').write_text('PRIVATE=new')
        (tx/'receipt.json').write_text(json.dumps({'status':'ACTIVATED','candidate':str(new),'previous':str(old),'relayActive':False,'timers':[],'units':{}}))
        with patch.object(host_ops,'ROOT',self.root),patch.object(host_ops,'SYSTEMD',self.root/'units'),patch.object(host_ops,'run',self.command):host_ops.target_rollback(self.config,self.target,self.revision)
        self.assertEqual((root/'current').resolve(),old);self.assertEqual((root/'config'/'google.env').read_text(),'PRIVATE=old');self.assertEqual(json.loads(checkpoint.read_text())['seen'],['new-progress'])
    def test_default_cli_has_no_network_or_secret_dependency(self):
        with patch('sys.argv',['release.py']),patch.object(subprocess,'run',side_effect=AssertionError('network attempted')),patch.object(subprocess,'Popen',side_effect=AssertionError('network attempted')),contextlib.redirect_stdout(io.StringIO()) as output:release.main()
        self.assertEqual(json.loads(output.getvalue())['status'],'PLAN_ONLY')
    def test_stale_rollback_receipt_never_overwrites_another_release(self):
        root=self.root/'us01';third=root/'releases'/('c'*40);third.mkdir(parents=True);(root/'current').symlink_to(third)
        (root/'config').mkdir();private=root/'config'/'google.env';private.write_text('PRIVATE=current')
        tx=root/'transactions'/self.revision;tx.mkdir(parents=True)
        (tx/'receipt.json').write_text(json.dumps({'previous':str(root/'releases'/('b'*40)),'candidate':str(root/'releases'/self.revision)}))
        with patch.object(host_ops,'ROOT',self.root),patch.object(host_ops,'run',side_effect=AssertionError('must not mutate remote services')):
            with self.assertRaisesRegex(ValueError,'FLEET_ROLLBACK_DRIFT'):host_ops.target_rollback(self.config,self.target,self.revision)
        self.assertEqual(private.read_text(),'PRIVATE=current')
    def test_ssh_transport_uses_private_files_and_pinned_host_keys(self):
        connection=release.Connection(self.target,'fixture-private-password',self.root)
        self.assertNotIn('fixture-private-password',' '.join(connection.command(['true'])))
        self.assertEqual(connection.password.stat().st_mode&0o777,0o600)
        self.assertIn(self.target['publicHostKey'],(connection.directory/'known_hosts').read_text())
    def test_activation_does_not_start_collection_before_central_authorization(self):
        root=self.root/'us01';candidate=root/'releases'/self.revision;candidate.mkdir(parents=True)
        tx=root/'transactions'/self.revision;tx.mkdir(parents=True)
        (tx/'receipt.json').write_text(json.dumps({'candidate':str(candidate),'previous':None,'status':'PREPARING'}))
        for platform in self.target['platforms']:
            state=root/'state'/platform;state.mkdir(parents=True);(state/'state.json').write_text('{"schema":1}')
        calls=[]
        def command(args,**kwargs):
            calls.append(args);return subprocess.CompletedProcess(args,0,'active\n' if 'is-active' in args else '', '')
        with patch.object(host_ops,'ROOT',self.root),patch.object(host_ops,'run',command):
            result=host_ops.target_activate(self.config,self.target,self.revision,self.revision)
        self.assertEqual(result['status'],'READY_AWAITING_ASSIGNMENT')
        for call in calls:
            if 'enable' in call:
                self.assertFalse(any(f'adtrender-us01-{p}.timer' in call for p in self.target['platforms']))
    def test_candidate_feed_rejects_truncation_and_future_metadata(self):
        spec=importlib.util.spec_from_file_location('candidate_refresh',Path(__file__).with_name('candidate-refresh.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        feed={'schema':1,'generatedAt':'2026-10-09T00:00:00Z','truncated':False,'candidates':[]}
        self.assertEqual(module.validate_feed(json.dumps(feed).encode())['candidates'],[])
        without_flag={k:v for k,v in feed.items() if k!='truncated'}
        self.assertEqual(module.validate_feed(json.dumps(without_flag).encode())['candidates'],[])
        for invalid in [{**feed,'truncated':True},{**feed,'truncated':None},{**feed,'truncated':'false'},{**feed,'generatedAt':'2999-01-01T00:00:00Z'},{**feed,'schema':2}]:
            with self.assertRaises(ValueError):module.validate_feed(json.dumps(invalid).encode())


if __name__=='__main__':unittest.main()
