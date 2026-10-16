import json
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch
import host_ops
from fleet_config import load,schedules,validate
from reconcile import reconcile_node


class StandbyTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.config=load(Path(__file__).with_name('targets.json'))
        self.target={**self.config['targets'][0],'platforms':[],'aliases':{}}
        self.config['targets']=[self.target];self.revision='a'*40;self.image='sha256:'+'b'*64
        self.node=self.root/self.target['id'];self.candidate=self.node/'releases'/self.revision;self.candidate.mkdir(parents=True)
        (self.candidate/'manifest.json').write_text(json.dumps({'revision':self.revision}))

    def test_empty_assignments_are_valid_and_produce_no_worker_units(self):
        validate(self.config)
        self.assertEqual(schedules(self.target),{})
        self.assertEqual(host_ops.worker_units(self.target),{})

    def test_standby_has_same_code_and_runtime_without_database_password_or_owner(self):
        calls=[]
        def run(args,**kwargs):
            calls.append(args);return CompletedProcess(args,0,self.image+'\n','')
        with patch.object(host_ops,'ROOT',self.root),patch.object(host_ops,'stage_artifact',return_value=self.candidate),patch.object(host_ops,'probe_browser') as probe,patch.object(host_ops,'run',run):
            host_ops.target_standby(self.config,self.target,self.revision,{'runtimeImage':self.image})
            probe.assert_called_once_with(self.target,self.candidate,self.image)
            status=host_ops.target_status(self.target)
        self.assertFalse(status['owned']);self.assertTrue(status['standby']);self.assertTrue(status['complete'])
        self.assertEqual((self.node/'current').resolve(),self.candidate)
        self.assertEqual(set(p.name for p in (self.node/'config').iterdir()),{'fleet.json','runtime.json'})
        self.assertFalse(any('systemctl' in call for call in calls))

    def test_failed_browser_check_keeps_previous_current_and_config(self):
        old=self.node/'releases'/('c'*40);old.mkdir();(self.node/'current').symlink_to(old)
        (old/'manifest.json').write_text(json.dumps({'revision':'c'*40}))
        with patch.object(host_ops,'ROOT',self.root),patch.object(host_ops,'stage_artifact',return_value=self.candidate),patch.object(host_ops,'probe_browser',side_effect=RuntimeError('fixture')),patch.object(host_ops,'run',return_value=CompletedProcess([],0,self.image+'\n','')):
            with self.assertRaises(RuntimeError):host_ops.target_standby(self.config,self.target,self.revision,{'runtimeImage':self.image})
        self.assertEqual((self.node/'current').resolve(),old)
        self.assertFalse((self.node/'config').exists())

    def test_unassigned_deployed_node_is_revoked_instead_of_receiving_permit(self):
        calls=[]
        class Remote:
            def rpc(self,host,action,**payload):
                calls.append(action)
                return {'owned':False,'standby':True,'revision':'a'*40,'complete':True}
        result=reconcile_node(Remote(),self.config,self.target,'digest')
        self.assertEqual(result['status'],'IDLE_NO_ASSIGNMENT')
        self.assertEqual(calls,['target_status','target_revoke'])

    def test_empty_stop_never_invokes_systemctl_without_unit_names(self):
        with patch.object(host_ops,'run',return_value=CompletedProcess([],0,'','')) as run:
            host_ops.stop_target(self.target)
        self.assertTrue(all(c.args[0][0]!='systemctl' for c in run.call_args_list))


if __name__=='__main__':unittest.main()
