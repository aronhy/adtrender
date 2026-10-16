import fcntl
import json
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path
from subprocess import TimeoutExpired
from fleet_config import load
from runner import run_slot, docker_command


class FakeProcess:
    def __init__(self, backend): self.backend = backend
    def wait(self, timeout):
        if self.backend.running: raise TimeoutExpired('docker', timeout)
        return 0


class FakeDocker:
    def __init__(self): self.running = False; self.started = 0
    def live(self, node): return []
    def start(self, args): self.running = True; self.started += 1; return FakeProcess(self)
    def stop(self, name, seconds): self.running = False
    def wait_removed(self, name, seconds): return not self.running


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.target = load(Path(__file__).with_name('targets.json'))['targets'][0]
        # Existing window/cleanup fixtures exercise an explicitly authorized
        # legacy queue. Production defaults remain CONFIG_QUEUE and fail closed.
        self.target['controlMode']='LEGACY_QUEUE'
        self.backend = FakeDocker()
        self.lock = self.root/'shared.lock'
        self.state = self.root/'state.json'; self.state.write_text('{"seen":["existing-ad"],"pauseUntil":9999999999999}')
        (self.root/'config').mkdir()
        (self.root/'config'/'runtime.json').write_text(json.dumps({'image': 'sha256:'+'a'*64}))
        (self.root/'current').mkdir()
        (self.root/'current'/'manifest.json').write_text(json.dumps({'revision':'a'*40,'capabilityDigest':'c'*64}))
        control=self.root/'config'/'node-control.env'
        control.write_text('COLLECTOR_CONTROL_URL=https://control.example.test\nCOLLECTOR_INCARNATION_ID=12345678-1234-1234-1234-123456789012\nCOLLECTOR_NODE_TOKEN='+'fixture-token-'+'x'*32+'\n')
        control.chmod(0o600)
        now=datetime.now(timezone.utc)
        (self.root/'config'/'authorization.json').write_text(json.dumps({'schema':1,'node':self.target['id'],'revision':'a'*40,'scope':'platform_queue','platforms':self.target['platforms'],'issuedAt':now.isoformat(),'validUntil':(now+timedelta(seconds=2400)).isoformat()}))

    def test_no_assignment_never_starts_browser_or_mutates_checkpoint(self):
        (self.root/'config'/'authorization.json').unlink()
        before=self.state.read_bytes()
        self.assertEqual(self.invoke()['status'],'IDLE_NO_ASSIGNMENT')
        self.assertEqual(self.backend.started,0)
        self.assertEqual(self.state.read_bytes(),before)

    def invoke(self, platform='pinterest', memory=1000):
        return run_slot(self.target, platform, self.root, self.lock, self.backend, available_mib=memory, free_disk_mib=4096)

    def test_all_platforms_share_one_lock_and_do_not_start_overlapping_browsers(self):
        with self.lock.open('a') as held:
            fcntl.flock(held, fcntl.LOCK_EX|fcntl.LOCK_NB)
            for platform in ['pinterest', 'google', 'tiktok', 'snapchat']:
                self.assertEqual(self.invoke(platform)['status'], 'SKIPPED_BUSY')
        self.assertEqual(self.backend.started, 0)

    def test_low_headroom_skips_collection_without_modifying_checkpoint(self):
        before = self.state.read_bytes()
        self.assertEqual(self.invoke(memory=800)['status'], 'SKIPPED_RESOURCES')
        self.assertEqual(self.backend.started, 0)
        self.assertEqual(self.state.read_bytes(), before)

    def test_window_shutdown_removes_container_and_keeps_checkpoint(self):
        before = self.state.read_bytes()
        result = self.invoke()
        self.assertEqual(result['status'], 'FINISHED')
        self.assertFalse(self.backend.running)
        self.assertEqual(self.state.read_bytes(), before)

    def test_container_command_has_resource_limits_and_no_published_ports_or_inline_password(self):
        args = docker_command(self.target, 'google', self.root, 'sha256:'+'a'*64)
        self.assertIn('768m', args); self.assertIn('0.75', args)
        self.assertIn('--read-only', args); self.assertNotIn('-p', args)
        self.assertIn('--env-file', args); self.assertNotIn('private-password', ' '.join(args))
        self.assertTrue(args[-1].endswith('/google.mjs'))
    def test_signal_interrupt_cleans_container_before_releasing_shared_lock(self):
        original=self.backend.start
        def start(args):
            process=original(args);wait=process.wait;first=True
            def interrupted(timeout):
                nonlocal first
                if first:first=False;raise KeyboardInterrupt()
                return wait(timeout)
            process.wait=interrupted;return process
        self.backend.start=start
        with self.assertRaises(KeyboardInterrupt):self.invoke()
        self.assertFalse(self.backend.running)
        with self.lock.open('a') as held:fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)

    def test_managed_mode_does_not_boot_with_legacy_owner_file_only(self):
        self.target['controlMode']='CONFIG_QUEUE'
        (self.root/'config'/'node-control.env').unlink()
        self.assertEqual(self.invoke()['status'],'IDLE_NO_CONTROL')
        self.assertEqual(self.backend.started,0)

    def test_managed_command_uses_node_private_credentials_and_shared_receipt_volume(self):
        self.target['controlMode']='CONFIG_QUEUE'
        args=docker_command(self.target,'google',self.root,'sha256:'+'a'*64)
        self.assertIn('COLLECTOR_CONTROL_MODE=CONFIG_QUEUE',args)
        self.assertIn('COLLECTOR_NODE_ID='+self.target['id'],args)
        self.assertIn('COLLECTOR_RECEIPT_DIR=/dispatch',args)
        self.assertIn(str(self.root/'dispatch')+':/dispatch:rw',args)
        self.assertIn(str(self.root/'config'/'node-control.env'),args)

    def test_recovery_slot_needs_no_sampling_authorization_and_passes_recover_only(self):
        (self.root/'config'/'authorization.json').unlink()
        captured=[]
        original=self.backend.start
        self.backend.start=lambda args:(captured.append(args) or original(args))
        result=run_slot(self.target,'google',self.root,self.lock,self.backend,available_mib=1000,free_disk_mib=4096,recover_only=True)
        self.assertEqual(result['status'],'FINISHED')
        self.assertEqual(captured[0][-1],'--recover-only')


if __name__ == '__main__': unittest.main()
