import hashlib
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from host_ops import verify_release, extract_snapshot, activate_files, rollback_files


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup); self.root = Path(self.temp.name).resolve()

    def bundle(self):
        path = self.root/'bundle'; path.mkdir(); body = b'console.log("test");'
        (path/'google.mjs').write_bytes(body)
        manifest = {'schema': 1, 'revision': 'a'*40, 'cleanTree': True, 'files': [{'path': 'google.mjs', 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()}]}
        (path/'manifest.json').write_text(json.dumps(manifest)); return path

    def test_hash_and_exact_inventory_are_enforced_before_activation(self):
        path = self.bundle(); self.assertEqual(verify_release(path)['revision'], 'a'*40)
        (path/'google.mjs').write_text('tampered')
        with self.assertRaises(ValueError): verify_release(path)

    def test_unexpected_files_symlinks_and_dirty_provenance_are_rejected(self):
        for mode in ['extra', 'symlink', 'dirty']:
            with self.subTest(mode=mode):
                path = self.root/mode; path.mkdir(); (path/'manifest.json').write_text(json.dumps({'schema': 1, 'revision': 'a'*40, 'cleanTree': mode!='dirty', 'files': []}))
                if mode=='extra': (path/'private.env').write_text('private-token')
                if mode=='symlink': (path/'outside').symlink_to(self.root)
                with self.assertRaises(ValueError): verify_release(path)

    def test_snapshot_rejects_parent_paths_and_links_before_writing(self):
        for name, link in [('../outside', False), ('google/profile/link', True)]:
            archive = self.root/'snapshot.tar'; out = self.root/'state'
            with tarfile.open(archive, 'w') as tar:
                member = tarfile.TarInfo(name); member.type = tarfile.SYMTYPE if link else tarfile.REGTYPE; member.linkname='/etc/shadow'; member.size=0; tar.addfile(member)
            with self.assertRaises(ValueError): extract_snapshot(archive, out)
            self.assertFalse((self.root/'outside').exists())

    def test_update_and_rollback_keep_target_checkpoints_and_cooldowns(self):
        old = self.root/'old'; new = self.root/'new'; old.mkdir(); new.mkdir()
        state = self.root/'state'; state.mkdir(); (state/'state.json').write_text('{"seen":["ad-1"],"pauseUntil":123456789}')
        (self.root/'current').symlink_to(old)
        receipt = activate_files(self.root, new); self.assertEqual((self.root/'current').resolve(), new)
        rollback_files(self.root, receipt)
        self.assertEqual((self.root/'current').resolve(), old)
        self.assertEqual((state/'state.json').read_text(), '{"seen":["ad-1"],"pauseUntil":123456789}')


if __name__ == '__main__': unittest.main()
