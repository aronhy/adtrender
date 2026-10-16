import copy
import json
import tempfile
import unittest
from pathlib import Path

from fleet_config import load, schedules, rewrite_database_url


class FleetConfigTests(unittest.TestCase):
    def setUp(self):
        self.value = json.loads(Path(__file__).with_name('targets.json').read_text())

    def write(self, value):
        handle = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
        json.dump(value, handle); handle.close()
        self.addCleanup(Path(handle.name).unlink)
        return Path(handle.name)

    def test_youtube_uses_google_worker_and_all_requested_platforms_are_assigned(self):
        config = load(self.write(self.value))
        target = config['targets'][0]
        self.assertEqual(target['platforms'], ['pinterest', 'google', 'tiktok', 'snapchat'])
        self.assertEqual(target['aliases']['youtube'], 'google')
        self.assertEqual(len(schedules(target)), 4)

    def test_timer_slots_are_disjoint_and_repeat_each_twenty_minutes(self):
        target = load(self.write(self.value))['targets'][0]
        slots = schedules(target)
        self.assertEqual(slots['pinterest'], [0, 20, 40])
        self.assertEqual(slots['google'], [5, 25, 45])
        self.assertEqual(slots['tiktok'], [10, 30, 50])
        self.assertEqual(slots['snapchat'], [15, 35, 55])

    def test_rejects_runtime_overcommit_and_credentials_in_versioned_config(self):
        for key, value in [('memoryMiB', 2048), ('minimumAvailableMiB', 512), ('cpus', '3'), ('password', 'private-password')]:
            with self.subTest(key=key):
                changed = copy.deepcopy(self.value); changed['targets'][0][key] = value
                with self.assertRaises(ValueError): load(self.write(changed))

    def test_database_rewrite_preserves_restricted_role_password_database_and_options(self):
        rewritten = rewrite_database_url('postgresql://google_collector_runtime:private-token@database:5432/ad_research_test?schema=public', 'google', 'adtrender-collector-db-us01')
        self.assertEqual(rewritten, 'postgresql://google_collector_runtime:private-token@adtrender-collector-db-us01:5432/ad_research_test?schema=public')
        with self.assertRaises(ValueError): rewrite_database_url('postgresql://saas_migrator:secret@database:5432/ad_research_test', 'google', 'adtrender-collector-db-us01')

    def test_duplicate_nodes_platforms_and_shell_injection_are_rejected(self):
        for mutation in [lambda c: c['targets'].append(copy.deepcopy(c['targets'][0])), lambda c: c['targets'][0]['platforms'].append('youtube'), lambda c: c['targets'][0].update(host='host; touch /tmp/unexpected')]:
            changed = copy.deepcopy(self.value); mutation(changed)
            with self.assertRaises(ValueError): load(self.write(changed))


if __name__ == '__main__': unittest.main()
