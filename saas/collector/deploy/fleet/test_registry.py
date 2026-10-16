import copy
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from fleet_config import load
from registry import load_registry, resolve, validate_registry, update_file, deployable
from authorization import seconds_left
from release import Connection, required_secrets
from reconcile import authorize, reconcile_node
import host_ops
from runner import run_slot

HERE = Path(__file__).resolve().parent
NOW = datetime(2026, 10, 9, tzinfo=timezone.utc).timestamp()


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.registry = load_registry(environ={}); self.base = load(HERE/'targets.json')
        # Lifecycle fixtures must not depend on which production nodes are enabled today.
        for node in self.registry['nodes'][1:]: node.update(verified=False, enabled=False, publicHostKey=None)

    def ready(self, index=1):
        node = self.registry['nodes'][index]
        node.update(verified=True, enabled=True, publicHostKey=self.base['targets'][0]['publicHostKey'])
        return node

    def test_four_provided_servers_registered_with_japan_nonroot_and_unknown_expiry(self):
        self.assertEqual([n['id'] for n in self.registry['nodes']], ['us01', 'sg01', 'jp01', 'hk01'])
        self.assertEqual(self.registry['nodes'][2]['user'], 'ubuntu')
        self.assertTrue(all(n['expiresAt'] is None for n in self.registry['nodes']))
        config, states = resolve(self.base, self.registry, NOW)
        self.assertEqual(len(config['targets']), 1)
        self.assertEqual([s['status'] for s in states], ['READY', 'DISABLED', 'DISABLED', 'DISABLED'])

    def test_enabled_unverified_node_still_cannot_deploy(self):
        self.registry['nodes'][1]['enabled'] = True
        self.registry['assignments']['google'] = 'sg01'
        config, states = resolve(self.base, self.registry, NOW)
        self.assertEqual(states[1]['status'], 'PENDING_VERIFICATION')
        self.assertEqual([t['id'] for t in config['targets']], ['us01'])
        self.assertNotIn('google', config['targets'][0]['platforms'])

    def test_enabled_verified_unassigned_node_stays_idle(self):
        self.ready()
        config, states = resolve(self.base, self.registry, NOW)
        self.assertEqual(states[1]['status'], 'IDLE_NO_ASSIGNMENT')
        self.assertEqual(len(config['targets']), 2)
        self.assertEqual(config['targets'][1]['platforms'], [])

    def test_assigning_platform_compiles_unique_owners_and_youtube_alias(self):
        self.ready(2); self.registry['assignments']['google'] = 'jp01'
        config, _ = resolve(self.base, self.registry, NOW)
        self.assertEqual(config['targets'][0]['cycleMinutes'], 60)
        japan = config['targets'][1]
        self.assertEqual(japan['platforms'], ['google']); self.assertEqual(japan['aliases'], {'youtube':'google'})
        self.assertEqual(japan['privilege'], 'sudo')
        self.assertEqual(japan['passwordSecret'], 'COLLECTOR_JP01_SSH_PASSWORD')

    def test_new_nodes_require_central_configuration_mode(self):
        self.ready(2);self.registry['assignments']['google']='jp01'
        config,_=resolve(self.base,self.registry,NOW)
        self.assertEqual(config['targets'][1].get('controlMode'),'CONFIG_QUEUE')
        self.assertEqual(config['targets'][0].get('controlMode'),'CONFIG_QUEUE')

    def test_existing_us_explicit_legacy_is_preserved(self):
        self.base['targets'][0]['controlMode']='LEGACY_QUEUE'
        config,_=resolve(self.base,self.registry,NOW)
        self.assertEqual(config['targets'][0]['controlMode'],'LEGACY_QUEUE')

    def test_default_us_without_node_control_cannot_launch_using_an_old_fleet_permit(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'current').mkdir();(root/'config').mkdir()
            (root/'current'/'manifest.json').write_text(json.dumps({'revision':'a'*40}))
            (root/'config'/'runtime.json').write_text(json.dumps({'image':'sha256:'+'b'*64}))
            now=datetime.now(timezone.utc);until=now.timestamp()+2400
            (root/'config'/'authorization.json').write_text(json.dumps({'schema':1,'node':'us01','revision':'a'*40,'scope':'platform_queue','platforms':self.base['targets'][0]['platforms'],'issuedAt':now.isoformat(),'validUntil':datetime.fromtimestamp(until,timezone.utc).isoformat()}))
            class Backend:
                def live(self,node): return []
                def start(self,args): raise AssertionError('SOURCE_LAUNCH_BEFORE_NODE_CONTROL')
            result=run_slot(self.base['targets'][0],'google',root,root/'shared.lock',Backend(),available_mib=4096,free_disk_mib=4096)
            self.assertEqual(result['status'],'IDLE_NO_CONTROL')

    def test_expiry_and_disable_prevent_deployment(self):
        self.registry['nodes'][0]['expiresAt'] = '2026-10-09T08:00:00+08:00'
        config, states = resolve(self.base, self.registry, NOW)
        self.assertEqual(states[0]['status'], 'EXPIRED'); self.assertFalse(deployable(config['targets'][0], NOW))
        self.registry['nodes'][0].update(expiresAt=None, enabled=False)
        config, _ = resolve(self.base, self.registry, NOW)
        self.assertFalse(deployable(config['targets'][0], NOW))

    def test_empty_assignments_allow_code_install_but_no_queues(self):
        self.registry['assignments'] = {}
        config, _ = resolve(self.base, self.registry, NOW)
        self.assertTrue(all(t['platforms']==[] for t in config['targets']))
        self.assertEqual(required_secrets(config, [], {}), {})

    def test_invalid_registry_cannot_leak_passwords_or_inject_commands(self):
        mutations = [lambda r:r['nodes'][0].update(password='never-version'),
                     lambda r:r['nodes'][0].update(host='host; touch /tmp/bad'),
                     lambda r:r['nodes'][0].update(expiresAt='2026-10-10'),
                     lambda r:r['nodes'][0].update(enabled='yes'),
                     lambda r:r['nodes'][1].update(verified=True),
                     lambda r:r['nodes'].append(copy.deepcopy(r['nodes'][0])),
                     lambda r:r['assignments'].update(google='missing')]
        for mutate in mutations:
            value=copy.deepcopy(self.registry);mutate(value)
            with self.assertRaises(ValueError): validate_registry(value)

    def test_dynamic_environment_registry_does_not_modify_versioned_file(self):
        self.registry['nodes'][0]['enabled']=False
        value=load_registry(environ={'COLLECTOR_FLEET_REGISTRY':json.dumps(self.registry)})
        self.assertFalse(value['nodes'][0]['enabled'])
        self.assertTrue(load_registry(environ={})['nodes'][0]['enabled'])
        with self.assertRaises(ValueError): load_registry(environ={'COLLECTOR_FLEET_REGISTRY':'malformed'})

    def test_cli_update_is_atomic_and_invalid_update_retains_previous_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'registry.json';path.write_text(json.dumps(self.registry));before=path.read_bytes()
            with self.assertRaises(ValueError): update_file(path,lambda value:value['nodes'][0].update(password='bad'))
            self.assertEqual(path.read_bytes(),before)
            update_file(path,lambda value:value['nodes'][0].update(enabled=False))
            self.assertFalse(load_registry(path,{})['nodes'][0]['enabled'])

    def test_new_node_secret_bundle_and_sudo_keep_credentials_out_of_argv_and_child_environment(self):
        self.ready(2);self.registry['assignments']['google']='jp01'
        config,_=resolve(self.base,self.registry,NOW);target=config['targets'][1]
        credentials={config['source']['passwordSecret']:'fixture-source',target['passwordSecret']:'fixture-japan'}
        self.assertEqual(required_secrets(config,[target],{'COLLECTOR_FLEET_SSH_PASSWORDS':json.dumps(credentials)}),credentials)
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ',{'COLLECTOR_FLEET_SSH_PASSWORDS':json.dumps(credentials)}):
            connection=Connection(target,'fixture-japan',directory)
            self.assertIn('sudo -n -- python3',connection.command(['python3','-B'])[-1])
            self.assertNotIn('fixture-japan',' '.join(connection.command(['true'])))
            self.assertNotIn('COLLECTOR_FLEET_SSH_PASSWORDS',connection.env)
            self.assertEqual(connection.password.stat().st_mode&0o777,0o600)


class AuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        (self.root/'config').mkdir();(self.root/'current').mkdir()
        (self.root/'current'/'manifest.json').write_text(json.dumps({'revision':'a'*40}))
        self.target={**load(HERE/'targets.json')['targets'][0],'enabled':True,'expiresAt':None}
        self.permit={'schema':1,'node':'us01','revision':'a'*40,'scope':'platform_queue','platforms':['google'],
                     'issuedAt':'2026-10-09T00:00:00+00:00','validUntil':'2026-10-09T00:40:00+00:00'}

    def left(self, now=NOW):
        (self.root/'config'/'authorization.json').write_text(json.dumps(self.permit))
        return seconds_left(self.root,self.target,'google',now)

    def test_permit_expires_locally_during_coordinator_or_network_outage(self):
        self.assertEqual(self.left(),2400-330-15)
        self.assertEqual(self.left(NOW+2400),0)
        self.target['expiresAt']='2026-10-09T00:10:00+00:00'
        self.assertEqual(self.left(),600-330-15)

    def test_wrong_node_platform_revision_future_or_oversized_permit_is_denied(self):
        for change in [{'node':'jp01'},{'platforms':['tiktok']},{'revision':'b'*40},{'issuedAt':'2026-10-10T00:00:00+00:00'}, {'validUntil':'2026-10-10T00:40:00+00:00'}]:
            original=copy.deepcopy(self.permit);self.permit.update(change)
            self.assertEqual(self.left(),0);self.permit=original
        self.target['enabled']=False;self.assertEqual(self.left(),0)

    def test_missing_or_corrupt_authorization_fails_closed(self):
        self.assertEqual(seconds_left(self.root,self.target,'google',NOW),0)
        (self.root/'config'/'authorization.json').write_text('broken')
        self.assertEqual(seconds_left(self.root,self.target,'google',NOW),0)

    def test_durable_owner_blocks_transfer_even_after_old_node_expires(self):
        with patch.object(host_ops,'ASSIGNMENT_ROOT',self.root):
            host_ops.source_reserve(self.target);host_ops.source_reserve(self.target)
            with self.assertRaisesRegex(ValueError,'FLEET_CHECKPOINT_TRANSFER_REQUIRED'):
                host_ops.source_reserve({**self.target,'id':'jp01'})
            self.assertEqual(json.loads((self.root/'assignments.json').read_text())['google'],'us01')

    def test_expiring_or_disabled_node_gets_revocation_not_new_permission(self):
        events=[]
        class Remote:
            def rpc(self,host,action,**payload): events.append((host,action,payload));return {'status':'OK'}
        self.target['enabled']=False
        authorize(Remote(),{},self.target,'a'*40,'digest',NOW)
        self.assertEqual([e[1] for e in events],['target_revoke'])
        events.clear();self.target['enabled']=True
        authorize(Remote(),{},self.target,'a'*40,'digest',NOW)
        self.assertEqual([e[1] for e in events],['source_reserve','target_authorize'])
        self.assertEqual(events[-1][2]['permit']['scope'],'platform_queue')

    def test_uninstalled_node_never_gets_execution_permission(self):
        events=[]
        class Remote:
            def rpc(self,host,action,**payload): events.append(action);return {'owned':False,'revision':None}
        self.assertEqual(reconcile_node(Remote(),{},self.target,'digest')['status'],'NOT_DEPLOYED')
        self.assertEqual(events,['target_status'])

    def test_remote_authorize_writes_permit_only_for_current_ready_deployment(self):
        self.target['privilege']='root'
        self.config={**load(HERE/'targets.json'), 'targets':[self.target]}
        (self.root/'config'/'fleet.json').write_text(json.dumps(self.config))
        (self.root/'current'/'authorization.py').write_text('# fixture')
        self.permit['platforms']=self.target['platforms']
        issued=datetime.now(timezone.utc).timestamp()
        self.permit['issuedAt']=datetime.fromtimestamp(issued,timezone.utc).isoformat()
        self.permit['validUntil']=datetime.fromtimestamp(issued+2400,timezone.utc).isoformat()
        with patch.object(host_ops,'node_root',return_value=self.root), patch.object(host_ops,'target_status',return_value={'owned':True,'revision':'a'*40,'complete':True}), patch.object(host_ops,'run') as run:
            result=host_ops.target_authorize(self.config,self.target,'a'*40,self.permit)
            self.assertEqual(result['status'],'AUTHORIZED')
            self.assertEqual(json.loads((self.root/'config'/'authorization.json').read_text())['node'],'us01')
            self.assertEqual((self.root/'config'/'authorization.json').stat().st_mode&0o777,0o600)
            self.assertTrue(run.called)
            before=(self.root/'config'/'authorization.json').read_bytes()
            self.permit['revision']='b'*40
            with self.assertRaises(ValueError):host_ops.target_authorize(self.config,self.target,'a'*40,self.permit)
            self.assertEqual((self.root/'config'/'authorization.json').read_bytes(),before)

    def test_remote_revocation_removes_permission_and_stops_original_platforms(self):
        config={**load(HERE/'targets.json'),'targets':[self.target]}
        (self.root/'config'/'fleet.json').write_text(json.dumps(config));self.left()
        with patch.object(host_ops,'node_root',return_value=self.root), patch.object(host_ops,'stop_target') as stop:
            host_ops.target_revoke({**self.target,'platforms':['google']})
            self.assertFalse((self.root/'config'/'authorization.json').exists())
            self.assertEqual(stop.call_args.args[0]['platforms'],self.target['platforms'])


if __name__=='__main__':unittest.main()
