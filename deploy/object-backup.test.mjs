import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupObjects, restoreObjects } from '../scripts/object-backup.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const sourceIdentity = { bucket: 'saas-test-source', endpoint: 'http://127.0.0.1:3900' };
const targetIdentity = { bucket: 'saas-restore-fixture', endpoint: 'http://127.0.0.1:3900' };
function store(initial = new Map()) {
  const objects = new Map(initial), writes = [];
  return { objects, writes,
    async get(key) { const item = objects.get(key); if (!item) throw Object.assign(new Error('PRIVATE_PROVIDER_BODY_NOT_FOUND'), { $metadata: { httpStatusCode: 404 } }); return { body: Buffer.from(item.bytes), contentType: item.contentType }; },
    async put(key, input, options) {
      assert.equal(options.ifNoneMatch, '*');
      if (objects.has(key)) throw Object.assign(new Error('PRIVATE_PROVIDER_PRECONDITION'), { $metadata: { httpStatusCode: 412 } });
      const chunks = []; for await (const chunk of Buffer.isBuffer(input) || input instanceof Uint8Array ? [input] : input) chunks.push(Buffer.from(chunk));
      if (!key.startsWith('.adtrender-restore-probe/')) writes.push(key); objects.set(key, { bytes: Buffer.concat(chunks), contentType: options.contentType });
    },
    async delete(key) { assert(key.startsWith('.adtrender-restore-probe/')); objects.delete(key); },
    async list(limit) { return [...objects.keys()].slice(0, limit + 1); },
  };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'saas-joint-backup-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databaseBackup = join(root, 'database.dump'), outputDirectory = join(root, 'objects');
  const dump = Buffer.from('isolated PostgreSQL archive fixture'); await writeFile(databaseBackup, dump);
  const definitions = [
    ['MediaObject', `public-media/${randomUUID()}`, Buffer.from('synthetic image bytes'), 'image/png'],
    ['PrivateFile', `private/org-fixture/ws-fixture/${randomUUID()}`, Buffer.from('private synthetic video'), 'video/mp4'],
    ['RunItem', `private-source-evidence/run-fixture/${randomUUID()}.json`, Buffer.from('{"fixture":true}'), 'application/json'],
  ];
  const objectReferences = definitions.map(([kind, key, bytes, mimeType]) => ({ kind, id: randomUUID(), reference: kind === 'RunItem' ? 's3:' + key : key, sha256: sha(bytes), sizeBytes: kind === 'RunItem' ? null : String(bytes.length), mimeType }));
  objectReferences.push({ ...objectReferences[2], kind: 'CollectionRun', id: randomUUID(), sha256: null });
  const manifest = { formatVersion: 1, source: { host: '127.0.0.1', port: '55438', database: 'saas_test_fixture' }, sha256: sha(dump), sizeBytes: dump.length, objectReferencesVersion: 1, objectReferences };
  const saveManifest = () => writeFile(databaseBackup + '.manifest.json', JSON.stringify(manifest)); await saveManifest();
  const sourceStore = store(new Map(definitions.map(([, key, bytes, contentType]) => [key, { bytes, contentType }])));
  const targetStore = store(); let proofs = 0;
  const backup = overrides => backupObjects({ databaseBackup, outputDirectory, sourceStore, sourceIdentity, ...overrides });
  const restore = overrides => restoreObjects({ databaseBackup, archiveDirectory: outputDirectory, targetStore, targetIdentity, verifyDatabase: async () => { proofs++; return { status: 'RESTORE_VERIFIED', backupSha256: manifest.sha256, objectReferencesVerified: true, objectReferencesVersion: 1 }; }, ...overrides });
  return { root, databaseBackup, outputDirectory, manifest, saveManifest, sourceStore, targetStore, backup, restore, proofs: () => proofs };
}

test('binds public/private/evidence bytes to a database snapshot, restores, and replays without writes', async t => {
  const f = await fixture(t); const result = await f.backup();
  assert.equal(result.status, 'OBJECT_BACKUP_VERIFIED'); assert.equal(result.objectCount, 3);
  assert.equal((await stat(f.outputDirectory)).mode & 0o777, 0o700);
  const archive = JSON.parse(await readFile(join(f.outputDirectory, 'manifest.json')));
  assert.equal(archive.databaseBackupSha256, f.manifest.sha256);
  for (const object of archive.objects) {
    const file = join(f.outputDirectory, 'objects', object.sha256);
    assert.equal(sha(await readFile(file)), object.sha256); assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  assert.equal(f.sourceStore.writes.length, 0);
  assert.equal((await f.restore()).status, 'JOINT_RESTORE_VERIFIED');
  assert.equal(f.targetStore.writes.length, 3); assert.equal(f.proofs(), 1);
  for (const [key, value] of f.sourceStore.objects) assert.deepEqual(f.targetStore.objects.get(key), value);
  assert.equal((await f.restore()).status, 'JOINT_RESTORE_VERIFIED');
  assert.equal(f.targetStore.writes.length, 3); assert.equal(f.proofs(), 2);
});

test('a changed database dump or legacy manifest cannot be called a joint backup', async t => {
  const f = await fixture(t); await writeFile(f.databaseBackup, 'tampered');
  await assert.rejects(f.backup());
  const g = await fixture(t); delete g.manifest.objectReferencesVersion; delete g.manifest.objectReferences; await g.saveManifest();
  await assert.rejects(g.backup());
});
test('does not publish success for missing, corrupt, wrong MIME or oversized source objects', async t => {
  for (const kind of ['missing', 'hash', 'mime', 'size']) {
    const f = await fixture(t), key = [...f.sourceStore.objects.keys()][0];
    if (kind === 'missing') f.sourceStore.objects.delete(key);
    if (kind === 'hash') f.sourceStore.objects.get(key).bytes = Buffer.from('corrupt');
    if (kind === 'mime') f.sourceStore.objects.get(key).contentType = 'text/html';
    await assert.rejects(f.backup(kind === 'size' ? { limits: { maxObjectBytes: 4 } } : undefined), error => !error.message.includes('PRIVATE_PROVIDER'));
    await assert.rejects(readFile(join(f.outputDirectory, 'manifest.json')));
  }
});
test('rejects traversal, unsupported evidence storage and conflicting duplicate references', async t => {
  for (const reference of ['../private/key', 'local-private:private-source-evidence/run/file.json', 'https://example.test/private']) {
    const f = await fixture(t); f.manifest.objectReferences[0].reference = reference; await f.saveManifest(); await assert.rejects(f.backup());
  }
  const f = await fixture(t); f.manifest.objectReferences.push({ ...f.manifest.objectReferences[0], id: randomUUID(), sha256: 'f'.repeat(64) }); await f.saveManifest(); await assert.rejects(f.backup());
});
test('refuses an existing backup destination and enforces total bytes and object count', async t => {
  const f = await fixture(t); await f.backup(); await assert.rejects(f.backup());
  const g = await fixture(t); await assert.rejects(g.backup({ limits: { maxTotalBytes: 4 } }));
  const h = await fixture(t); await assert.rejects(h.backup({ limits: { maxObjects: 1 } }));
});
test('verifies local archived bytes before writing or proving a database restore', async t => {
  const f = await fixture(t); await f.backup(); const archive = JSON.parse(await readFile(join(f.outputDirectory, 'manifest.json')));
  await writeFile(join(f.outputDirectory, 'objects', archive.objects[0].sha256), 'changed');
  await assert.rejects(f.restore()); assert.equal(f.targetStore.writes.length, 0); assert.equal(f.proofs(), 0);
});
test('refuses source bucket, non-restore bucket, nonempty unowned target and unverified database references', async t => {
  const f = await fixture(t); await f.backup();
  await assert.rejects(f.restore({ targetIdentity: sourceIdentity }));
  await assert.rejects(f.restore({ targetIdentity: { ...targetIdentity, bucket: 'production-customer-files' } }));
  f.targetStore.objects.set('unrelated', { bytes: Buffer.from('do not touch'), contentType: 'text/plain' });
  await assert.rejects(f.restore()); assert.equal(f.targetStore.writes.length, 0); assert(f.targetStore.objects.has('unrelated'));
  const g = await fixture(t); await g.backup(); await assert.rejects(g.restore({ verifyDatabase: async () => ({ status: 'RESTORE_VERIFIED', backupSha256: g.manifest.sha256 }) })); assert.equal(g.targetStore.writes.length, 0);
});
test('a failed restore remains resumable but never overwrites conflicting target bytes', async t => {
  const f = await fixture(t); await f.backup(); const put = f.targetStore.put; let calls = 0;
  f.targetStore.put = async (...args) => { if (!args[0].startsWith('.adtrender-restore-probe/') && ++calls === 2) throw new Error('PRIVATE_PROVIDER_TOKEN'); return put(...args); };
  await assert.rejects(f.restore(), error => !error.message.includes('PRIVATE_PROVIDER'));
  assert.equal(f.targetStore.writes.length, 1); f.targetStore.put = put;
  assert.equal((await f.restore()).status, 'JOINT_RESTORE_VERIFIED'); assert.equal(f.targetStore.writes.length, 3);
  const key = [...f.targetStore.objects.keys()][0]; f.targetStore.objects.get(key).bytes = Buffer.from('different');
  await assert.rejects(f.restore()); assert.equal(f.targetStore.writes.length, 3);
});
