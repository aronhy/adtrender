import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { backupObjects, restoreObjects } from '../scripts/object-backup.mjs';
import { probeKey, s3Fixture } from './backup/s3-fixture.mjs';

const exec = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const cli = fileURLToPath(new URL('../scripts/object-backup.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'restore-protocol-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databaseBackup = join(root, 'database.dump'), archiveDirectory = join(root, 'archive');
  const dump = Buffer.from('synthetic dump: database verification must never pass'), bytes = Buffer.from('synthetic private bytes');
  const key = `private/org/workspace/${randomUUID()}`;
  await writeFile(databaseBackup, dump, { mode: 0o600 });
  await writeFile(`${databaseBackup}.manifest.json`, JSON.stringify({ formatVersion: 1, sha256: sha(dump), sizeBytes: dump.length,
    objectReferencesVersion: 1, objectReferences: [{ kind: 'PrivateFile', id: 'file', reference: key, sha256: sha(bytes), sizeBytes: String(bytes.length), mimeType: 'video/mp4' }] }), { mode: 0o600 });
  await backupObjects({ databaseBackup, outputDirectory: archiveDirectory,
    sourceIdentity: { endpoint: 'aws:us-east-1', bucket: 'protocol-source-test' },
    sourceStore: { async get() { return { body: bytes, contentType: 'video/mp4' }; } } });
  return { root, databaseBackup, archiveDirectory, key };
}
async function restore(f, store) {
  const env = { PATH: process.env.PATH, HOME: f.root, AWS_EC2_METADATA_DISABLED: 'true',
    RESTORE_S3_REGION: 'us-east-1', RESTORE_S3_BUCKET: store.bucket, RESTORE_S3_ENDPOINT: store.endpoint, RESTORE_S3_FORCE_PATH_STYLE: 'true',
    RESTORE_AWS_ACCESS_KEY_ID: 'fixture-only', RESTORE_AWS_SECRET_ACCESS_KEY: 'PRIVATE_TEST_CREDENTIAL' };
  try {
    await exec(process.execPath, [cli, 'restore', '--backup', f.databaseBackup, '--archive', f.archiveDirectory,
      '--target-url', 'postgresql://fixture@127.0.0.1:1/protocol_restore_test'], { env, timeout: 10000 });
    assert.fail('Restore must refuse an unverified database or provider');
  } catch (error) {
    assert.equal(error.code, 1, 'CLI must exit normally, without a signal or timeout');
    const failure = JSON.parse(error.stderr);
    assert.equal(failure.status, 'FAILED');
    assert(!error.stderr.includes('PRIVATE_')); return failure.errorCode;
  }
}

const scenarios = [
  ['supported', 'OBJECT_RESTORE_FAILED'], // Probe passes; the intentionally invalid dump is rejected next.
  ['ignored', 'OBJECT_STORE_CONDITIONAL_PUT_UNSUPPORTED'],
  ['false-412', 'OBJECT_STORE_CONDITIONAL_PUT_UNSUPPORTED'],
  ['denied', 'OBJECT_STORE_CONDITIONAL_PUT_UNVERIFIED'],
  ['server-error', 'OBJECT_STORE_CONDITIONAL_PUT_UNVERIFIED'],
  ['first-disconnect', 'OBJECT_STORE_CONDITIONAL_PUT_UNVERIFIED'],
  ['second-disconnect', 'OBJECT_STORE_CONDITIONAL_PUT_UNVERIFIED'],
  ['cleanup-denied', 'OBJECT_STORE_PROBE_CLEANUP_FAILED'],
  ['delete-ignored', 'OBJECT_STORE_PROBE_CLEANUP_FAILED'],
  ['foreign-bytes', 'OBJECT_STORE_PROBE_CLEANUP_FAILED'],
];
for (const [mode, expected] of scenarios) test(`real SDK conditional-write gate: ${mode}`, async t => {
  const f = await fixture(t), store = await s3Fixture(t, { mode });
  assert.equal(await restore(f, store), expected);
  assert.deepEqual(store.violations, []);
  assert(store.traffic.some(row => row.method === 'PUT' && probeKey(row.key)));
  assert(!store.traffic.some(row => ['PUT', 'DELETE'].includes(row.method) && !probeKey(row.key)));
  assert(!(await readdir(f.archiveDirectory)).some(name => /^(?:restore-|database-restore-)/.test(name)));
  if (['cleanup-denied', 'delete-ignored', 'foreign-bytes'].includes(mode)) assert.equal(store.objects.size, 1);
  else assert.equal(store.objects.size, 0);
  if (mode === 'foreign-bytes') {
    assert(!store.traffic.some(row => row.method === 'DELETE'));
    assert.equal([...store.objects.values()][0].bytes.toString(), 'belongs to another writer');
  }
});

test('a missing delete capability refuses before probing or database verification', async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(restoreObjects({ ...f, targetIdentity: { endpoint: 'aws:us-east-1', bucket: 'protocol-restore-test' },
    targetStore: { async list() { return []; }, async get() { calls++; }, async put() { calls++; } },
    async verifyDatabase() { calls++; } }), /OBJECT_STORE_CONDITIONAL_PUT_UNVERIFIED/);
  assert.equal(calls, 0);
});

test('invalid archived bytes and nonempty targets refuse before any probe', async t => {
  for (const corrupt of [true, false]) {
    const f = await fixture(t), store = await s3Fixture(t);
    if (corrupt) {
      const archive = JSON.parse(await readFile(join(f.archiveDirectory, 'manifest.json')));
      await writeFile(join(f.archiveDirectory, 'objects', archive.objects[0].sha256), 'changed');
    } else store.objects.set(f.key, { bytes: Buffer.from('preserve existing object'), contentType: 'video/mp4' });
    assert.equal(await restore(f, store), corrupt ? 'OBJECT_CONTENT_MISMATCH' : 'OBJECT_RESTORE_TARGET_NOT_EMPTY');
    assert(store.traffic.every(row => row.method === 'GET')); assert.deepEqual(store.violations, []);
  }
});
