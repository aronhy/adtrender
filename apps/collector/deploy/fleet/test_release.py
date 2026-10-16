import unittest
from release import deploy, validate_runtime, required_secrets, check_credentials


class Remote:
    def __init__(self, owned=False, fail=None): self.owned=owned; self.fail=fail; self.events=[]
    def rpc(self, host, action, **payload):
        self.events.append(action)
        if action==self.fail: raise RuntimeError('fixture failure')
        if action=='target_status': return {'owned':self.owned,'revision':None}
        if action=='source_inspect': return {'image':'sha256:'+'a'*64,'versions':{'node':'24.14.1','playwright':'1.62.1','prisma':'5.19.1'},'configs':{},'databaseIP':'172.18.0.2'}
        if action=='source_snapshot': return {'path':'/var/lib/snapshot.tar.gz','bytes':10,'sha256':'b'*64}
        return {'status':'OK'}
    def image(self, *args): self.events.append('image'); return 'sha256:'+'b'*64
    def snapshot(self, *args): self.events.append('snapshot')


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.target={'id':'us01','platforms':['google'],'passwordSecret':'COLLECTOR_US01_SSH_PASSWORD'}
        self.config={'source':{'passwordSecret':'COLLECTOR_SOURCE_SSH_PASSWORD'}}
        self.artifact={'runtimeRef':'adtrender-collector-runtime:'+'a'*40,'runtimeIdentity':{},'manifest':{'revision':'a'*40,'runtime':{'nodeMinimum':'24.14.1','playwright':'1.62.1','prisma':'5.19.1'}},'files':{},'runtimeImage':'sha256:'+'a'*64,'runtimeVersions':{'node':'24.14.1','playwright':'1.62.1','prisma':'5.19.1'}}
    def test_first_handoff_stops_source_before_snapshot_and_starts_target_before_commit(self):
        remote=Remote(); deploy(remote,self.config,self.target,self.artifact)
        e=remote.events
        self.assertLess(e.index('source_pause'),e.index('source_snapshot'))
        self.assertLess(e.index('target_import'),e.index('target_activate'))
        self.assertLess(e.index('target_activate'),e.index('source_commit'))
    def test_expired_node_never_pauses_source_or_opens_ssh(self):
        remote=Remote()
        with self.assertRaisesRegex(ValueError,'FLEET_NODE_INACTIVE'):
            deploy(remote,self.config,{**self.target,'expiresAt':'2000-01-01T00:00:00Z'},self.artifact)
        self.assertEqual(remote.events,[])
    def test_standby_installs_without_source_access_state_import_or_timers(self):
        remote=Remote()
        result=deploy(remote,self.config,{**self.target,'platforms':[]},self.artifact)
        self.assertEqual(result['status'],'STANDBY_READY')
        self.assertEqual(remote.events,['target_status','image','target_standby'])
    def test_destination_image_id_is_used_without_mutating_shared_artifact(self):
        for platforms,action in [([], 'target_standby'),(['google'],'target_prepare')]:
            remote=Remote();original=remote.rpc;captured={}
            def rpc(host,method,**payload):
                if method==action:captured.update(payload)
                return original(host,method,**payload)
            remote.rpc=rpc
            deploy(remote,self.config,{**self.target,'platforms':platforms},self.artifact)
            image=captured['artifact']['runtimeImage'] if not platforms else captured['inspected']['image']
            self.assertEqual(image,'sha256:'+'b'*64)
            self.assertEqual(self.artifact['runtimeImage'],'sha256:'+'a'*64)
    def test_standby_cannot_overwrite_an_owned_queue(self):
        remote=Remote(owned=True)
        with self.assertRaisesRegex(ValueError,'FLEET_OWNED_QUEUE_REQUIRES_HANDOVER'):
            deploy(remote,self.config,{**self.target,'platforms':[]},self.artifact)
        self.assertEqual(remote.events,['target_status'])
    def test_updates_never_overwrite_target_progress_from_source(self):
        remote=Remote(owned=True); deploy(remote,self.config,self.target,self.artifact)
        for action in ['source_pause','source_snapshot','snapshot','target_import']: self.assertNotIn(action,remote.events)
    def test_failed_activation_stops_target_before_source_resume(self):
        remote=Remote(fail='target_activate')
        with self.assertRaises(RuntimeError): deploy(remote,self.config,self.target,self.artifact)
        self.assertLess(remote.events.index('target_rollback'),remote.events.index('source_resume'))
    def test_unconfirmed_target_stop_never_resumes_source(self):
        remote=Remote(fail='target_activate'); original=remote.rpc
        def rpc(host,action,**payload):
            if action=='target_rollback': raise RuntimeError('cannot confirm stop')
            return original(host,action,**payload)
        remote.rpc=rpc
        with self.assertRaises(RuntimeError): deploy(remote,self.config,self.target,self.artifact)
        self.assertNotIn('source_resume',remote.events)
    def test_runtime_mismatch_and_missing_external_secrets_fail_before_deployment(self):
        with self.assertRaises(ValueError): validate_runtime({'node':'24.14.1','playwright':'old','prisma':'5.19.1'},self.artifact['manifest']['runtime'])
        with self.assertRaises(ValueError): required_secrets(self.config,[self.target],{})
    def test_preflight_checks_credentials_without_blocking_another_ready_node(self):
        other={**self.target,'id':'sg01','passwordSecret':'COLLECTOR_SG01_SSH_PASSWORD'}
        env={'COLLECTOR_SOURCE_SSH_PASSWORD':'fixture','COLLECTOR_SG01_SSH_PASSWORD':'fixture'}
        self.assertEqual(check_credentials(self.config,[self.target,other],env),['sg01'])
        with self.assertRaises(ValueError):check_credentials(self.config,[self.target],{})
        self.assertEqual(check_credentials(self.config,[],{}),[])
    def test_owner_commit_failure_retains_ready_target_for_idempotent_retry(self):
        remote=Remote(fail='source_commit')
        with self.assertRaisesRegex(RuntimeError,'FLEET_OWNER_COMMIT_PENDING_TARGET_RETAINED'): deploy(remote,self.config,self.target,self.artifact)
        self.assertNotIn('target_rollback',remote.events);self.assertNotIn('source_resume',remote.events)
    def test_new_revision_recovers_interrupted_first_handoff_before_capturing_owners(self):
        remote=Remote();original=remote.rpc;first=True
        def rpc(host,action,**payload):
            nonlocal first
            if action=='target_status' and first:
                first=False;remote.events.append(action);return {'owned':False,'revision':None,'pending':[{'revision':'b'*40,'status':'PREPARING','previous':None}]}
            return original(host,action,**payload)
        remote.rpc=rpc;deploy(remote,self.config,self.target,self.artifact)
        self.assertLess(remote.events.index('target_rollback'),remote.events.index('source_resume'))
        self.assertLess(remote.events.index('source_resume'),remote.events.index('source_pause'))


if __name__=='__main__': unittest.main()
