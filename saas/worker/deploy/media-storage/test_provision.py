"""Exercise provisioning failure recovery without touching Docker or host /etc."""
import contextlib
import importlib.util
import io
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('media_storage_provision', pathlib.Path(__file__).with_name('provision.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Host:
    def __init__(self):
        self.role = False
        self.image = 'sha256:' + 'a' * 64
        self.fail_grants = False
        self.commands = []

    def run(self, command, input=None, text=True):
        if input is None:
            return self.image
        self.commands.append(input)
        if input.startswith('SELECT count(*)'):
            return '1' if self.role else '0'
        if 'CREATE ROLE' in input:
            self.role = True
        if self.fail_grants and 'GRANT CONNECT' in input:
            raise RuntimeError('SYNTHETIC_GRANT_FAILED')
        if 'DROP ROLE' in input:
            self.role = False
        return ''


class ProvisioningTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.directory.name)
        self.configuration = self.root / 'private.env'
        self.application = self.root / 'app.env'
        self.runtime = self.root / 'runtime.env'
        self.application.write_text('S3_BUCKET=synthetic\nS3_REGION=us-east-1\nAWS_ACCESS_KEY_ID=fixture-key\nAWS_SECRET_ACCESS_KEY=fixture-secret\n')
        self.host = Host()

    def tearDown(self):
        self.directory.cleanup()

    def provision(self):
        with contextlib.redirect_stdout(io.StringIO()):
            module.provision(self.configuration, self.application, self.runtime, self.host.run)

    def test_missing_storage_configuration_never_creates_a_role_or_private_file(self):
        self.application.write_text('S3_BUCKET=synthetic\n')
        with self.assertRaisesRegex(RuntimeError, 'STORAGE_CONFIGURATION_MISSING'):
            self.provision()
        self.assertFalse(self.host.role)
        self.assertFalse(self.configuration.exists())
        self.assertFalse(self.runtime.exists())

    def test_unpinned_image_never_creates_a_role(self):
        self.host.image = 'latest'
        with self.assertRaisesRegex(RuntimeError, 'IMMUTABLE_IMAGE_REQUIRED'):
            self.provision()
        self.assertFalse(self.host.role)
        self.assertFalse(self.configuration.exists())

    def test_image_drift_is_rejected_before_creating_a_role_or_changing_configuration(self):
        original = 'MEDIA_IMAGE=sha256:' + 'b' * 64 + '\n'
        self.runtime.write_text(original)
        with self.assertRaisesRegex(RuntimeError, 'PINNED_IMAGE_DRIFT_REQUIRES_REVIEW'):
            self.provision()
        self.assertFalse(self.host.role)
        self.assertFalse(self.configuration.exists())
        self.assertEqual(self.runtime.read_text(), original)

    def test_failed_grant_removes_only_this_attempts_role_and_private_file(self):
        self.host.fail_grants = True
        with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_GRANT_FAILED'):
            self.provision()
        self.assertFalse(self.host.role)
        self.assertFalse(self.configuration.exists())
        self.assertFalse(self.runtime.exists())

    def test_failed_grant_preserves_existing_configuration_and_role(self):
        self.provision()
        original = self.configuration.read_bytes()
        self.host.fail_grants = True
        with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_GRANT_FAILED'):
            self.provision()
        self.assertTrue(self.host.role)
        self.assertEqual(self.configuration.read_bytes(), original)

    def test_success_is_private_and_idempotent_without_rotating_credentials(self):
        self.provision()
        original = self.configuration.read_bytes()
        self.provision()
        self.assertTrue(self.host.role)
        self.assertEqual(self.configuration.read_bytes(), original)
        self.assertEqual(self.configuration.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.runtime.stat().st_mode & 0o777, 0o600)
        self.assertEqual(sum('CREATE ROLE' in sql for sql in self.host.commands), 1)


if __name__ == '__main__':
    unittest.main()
