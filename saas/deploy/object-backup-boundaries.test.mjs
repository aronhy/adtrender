import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { backupObjects, restoreObjects } from '../scripts/object-backup.mjs';

const cliPath = fileURLToPath(new URL('../scripts/object-backup.mjs', import.meta.url));
const exec = promisify(execFile);
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceIdentity = { bucket: 'boundary-source', endpoint: 'http://127.0.0.1:3900' };
const targetIdentity = { bucket: 'boundary-restore', endpoint: 'http://127.0.0.1:3900' };
function memoryStore(initial = []) {
  const objects = new Map(initial), writes = []; let reads = 0;
  return { objects, writes, reads: () => reads,
    async get(key) { reads++; const item = objects.get(key); if (!item) throw new Error('SECRET_PROVIDER_RESPONSE'); return { body: item.bytes, contentType: item.mimeType }; },
    async list() { return [...objects.keys()]; },
    async put(key, stream, options) {
      assert.equal(options.ifNoneMatch, '*'); if (objects.has(key)) throw new Error('SECRET_PRECONDITION');
      const parts = []; for await (const part of stream) parts.push(Buffer.from(part));
      writes.push(key); objects.set(key, { bytes: Buffer.concat(parts), mimeType: options.contentType });
    },
  };
}
async function fixture(t, empty = false) {
  const root = await mkdtemp(join(tmpdir(), 'saas-object-boundary-')); t.after(() => rm(root, { recursive: true, force: true }));
  const databaseBackup = join(root, 'database.dump'), archiveDirectory = join(root, 'archive');
  const bytes = Buffer.from('independent synthetic database dump'); await writeFile(databaseBackup, bytes, { mode: 0o600 });
  const definitions = empty ? [] : [
    ['MediaObject', `public-media/${randomUUID()}`, Buffer.from('image fixture'), 'image/png'],
    ['PrivateFile', `private/org/workspace/${randomUUID()}`, Buffer.from('private file fixture'), 'video/mp4'],
    ['RunItem', `private-source-evidence/run/${randomUUID()}.json`, Buffer.from('{"synthetic":true}'), 'application/json'],
  ];
  const objectReferences = definitions.map(([kind, key, data, mimeType]) => ({ kind, id: randomUUID(), reference: kind === 'RunItem' ? `s3:${key}` : key, sha256: sha(data), sizeBytes: String(data.length), mimeType }));
  if (!empty) objectReferences.push({ ...objectReferences[2], kind: 'CollectionRun', id: randomUUID(), sha256: null, sizeBytes: null });
  const manifest = { formatVersion: 1, sha256: sha(bytes), sizeBytes: bytes.length, objectReferencesVersion: 1, objectReferences };
  const saveDatabaseManifest = () => writeFile(`${databaseBackup}.manifest.json`, JSON.stringify(manifest), { mode: 0o600 }); await saveDatabaseManifest();
  const sourceStore = memoryStore(definitions.map(([, key, data, mimeType]) => [key, { bytes: data, mimeType }]));
  const targetStore = memoryStore(); let verified = 0;
  const backup = overrides => backupObjects({ databaseBackup, outputDirectory: archiveDirectory, sourceIdentity, sourceStore, ...overrides });
  const restore = overrides => restoreObjects({ databaseBackup, archiveDirectory, targetIdentity, targetStore,
    verifyDatabase: async () => { verified++; return { status: 'RESTORE_VERIFIED', backupSha256: manifest.sha256, objectReferencesVerified: true, objectReferencesVersion: 1 }; }, ...overrides });
  const archive = async () => JSON.parse(await readFile(join(archiveDirectory, 'manifest.json'), 'utf8'));
  const saveArchive = value => writeFile(join(archiveDirectory, 'manifest.json'), JSON.stringify(value), { mode: 0o600 });
  return { root, databaseBackup, archiveDirectory, manifest, saveDatabaseManifest, sourceStore, targetStore, backup, restore, archive, saveArchive, verified: () => verified };
}

test('empty reference snapshots still require a fresh database proof and an empty restore target', async t => {
  const f = await fixture(t, true); assert.deepEqual(await f.backup(), { status: 'OBJECT_BACKUP_VERIFIED', objectCount: 0 });
  assert.equal(f.sourceStore.reads(), 0);
  assert.deepEqual(await f.restore(), { status: 'JOINT_RESTORE_VERIFIED', objectCount: 0 }); assert.equal(f.verified(), 1);
  assert.equal((await f.restore()).objectCount, 0); assert.equal(f.verified(), 2);
  f.targetStore.objects.set('unexpected', { bytes: Buffer.from('private'), mimeType: 'text/plain' });
  await assert.rejects(f.restore()); assert.equal(f.verified(), 2); assert.equal(f.targetStore.writes.length, 0);
});

test('rejects omitted object entries, omitted shared references and duplicate archive keys before database work', async t => {
  for (const mutate of [a => a.objects.pop(), a => { a.objects.find(row => row.references.length === 2).references.pop(); }, a => { a.objects[1] = a.objects[0]; }]) {
    const f = await fixture(t); await f.backup(); const archive = await f.archive(); mutate(archive); await f.saveArchive(archive);
    await assert.rejects(f.restore()); assert.equal(f.verified(), 0); assert.equal(f.targetStore.writes.length, 0);
  }
});

test('rejects a database manifest changed after the object archive was published', async t => {
  const f = await fixture(t); await f.backup(); f.manifest.objectReferences.pop(); await f.saveDatabaseManifest();
  await assert.rejects(f.restore()); assert.equal(f.verified(), 0); assert.equal(f.targetStore.writes.length, 0);
});

test('rejects a symlink dump, database manifest and backup output directory before provider reads', async t => {
  for (const kind of ['dump', 'manifest', 'output']) {
    const f = await fixture(t);
    const path = kind === 'dump' ? f.databaseBackup : kind === 'manifest' ? `${f.databaseBackup}.manifest.json` : f.archiveDirectory;
    const actual = join(f.root, `original-${kind}`);
    if (kind === 'output') await symlink(f.root, path);
    else { await rename(path, actual); await symlink(actual, path); }
    await assert.rejects(f.backup()); assert.equal(f.sourceStore.reads(), 0);
  }
});

test('rejects symlink archive roots, object directories, manifests and content files before restore proof', async t => {
  for (const kind of ['root', 'directory', 'manifest', 'object']) {
    const f = await fixture(t); await f.backup(); const archive = await f.archive();
    const path = kind === 'root' ? f.archiveDirectory : kind === 'directory' ? join(f.archiveDirectory, 'objects') : kind === 'manifest' ? join(f.archiveDirectory, 'manifest.json') : join(f.archiveDirectory, 'objects', archive.objects[0].sha256);
    const actual = join(f.root, `original-${kind}`); await rename(path, actual); await symlink(actual, path);
    await assert.rejects(f.restore()); assert.equal(f.verified(), 0); assert.equal(f.targetStore.writes.length, 0);
  }
});

test('a conditional PUT race is accepted only when GET returns exactly the archived bytes', async t => {
  for (const corrupt of [false, true]) {
    const f = await fixture(t); await f.backup();
    f.targetStore.put = async (key, stream, options) => {
      assert.equal(options.ifNoneMatch, '*'); const parts = []; for await (const part of stream) parts.push(Buffer.from(part));
      f.targetStore.objects.set(key, { bytes: corrupt ? Buffer.from('wrong bytes') : Buffer.concat(parts), mimeType: options.contentType });
      throw new Error('SECRET_PRECONDITION_FAILED');
    };
    if (corrupt) await assert.rejects(f.restore(), error => !error.message.includes('SECRET'));
    else assert.equal((await f.restore()).status, 'JOINT_RESTORE_VERIFIED');
  }
});

test('a completed receipt cannot hide a missing target object or authorize repairing it silently', async t => {
  const f = await fixture(t); await f.backup(); await f.restore(); const firstWrites = f.targetStore.writes.length;
  f.targetStore.objects.delete([...f.targetStore.objects.keys()][0]);
  await assert.rejects(f.restore(), /OBJECT_RESTORE_COMPLETED_TARGET_CHANGED/);
  assert.equal(f.targetStore.writes.length, firstWrites); assert.equal(f.verified(), 1);
});

test('extra target keys introduced while restoring prevent completion', async t => {
  const f = await fixture(t); await f.backup(); const put = f.targetStore.put;
  f.targetStore.put = async (...args) => { await put(...args); f.targetStore.objects.set('unrelated', { bytes: Buffer.from('private'), mimeType: 'text/plain' }); };
  await assert.rejects(f.restore(), /OBJECT_RESTORE_TARGET_NOT_ISOLATED/);
  const receiptPath = (await readdir(f.archiveDirectory)).find(name => /^restore-.*\.json$/.test(name));
  assert.equal(JSON.parse(await readFile(join(f.archiveDirectory, receiptPath), 'utf8')).status, 'IN_PROGRESS');
});

test('the restore lock prevents concurrent writes and is released after a failed database proof', async t => {
  const f = await fixture(t); await f.backup(); let unblock, entered;
  const gate = new Promise(resolve => { unblock = resolve; }); const ready = new Promise(resolve => { entered = resolve; });
  const first = f.restore({ verifyDatabase: async () => { entered(); await gate; throw new Error('SECRET_DATABASE_ERROR'); } });
  await ready; await assert.rejects(f.restore(), /OBJECT_RESTORE_LOCKED/); unblock();
  await assert.rejects(first, error => !error.message.includes('SECRET')); assert.equal(f.targetStore.writes.length, 0);
  assert.equal((await f.restore()).status, 'JOINT_RESTORE_VERIFIED');
});

async function guardedCli(f, command, extraEnv = {}) {
  const guard = join(f.root, `transport-${randomUUID()}.mjs`), transportLog = `${guard}.json`;
  // Exercise the real SDK endpoint resolver while forbidding every network call.
  await writeFile(guard, `import http from 'node:http'; import https from 'node:https'; import { writeFileSync } from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; import { Writable } from 'node:stream';\nfor (const [transport, protocol] of [[http,'http:'],[https,'https:']]) transport.request = function (options) { const value = typeof options === 'string' ? new URL(options) : options; writeFileSync(process.env.BOUNDARY_TRANSPORT_LOG, JSON.stringify({ protocol, hostname: value.hostname ?? value.host })); const request = new Writable({ write(_chunk, _encoding, callback) { callback(); }, final(callback) { callback(); queueMicrotask(() => request.destroy(new Error('BOUNDARY_ALL_NETWORK_BLOCKED'))); } }); request.setTimeout = () => request; return request; }; syncBuiltinESMExports();\n`);
  const env = { PATH: process.env.PATH, HOME: f.root, AWS_EC2_METADATA_DISABLED: 'true', BOUNDARY_TRANSPORT_LOG: transportLog, ...extraEnv };
  const args = command === 'backup' ? ['backup', '--backup', f.databaseBackup, '--output', f.archiveDirectory] : ['restore', '--backup', f.databaseBackup, '--archive', f.archiveDirectory, '--target-url', 'postgresql://fixture@127.0.0.1:1/saas_restore_boundary'];
  let result;
  try { result = { ...await exec(process.execPath, ['--import', guard, cliPath, ...args], { env, timeout: 10000 }), code: 0 }; }
  catch (error) { result = { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  let transport; try { transport = JSON.parse(await readFile(transportLog, 'utf8')); } catch {}
  return { ...result, transport };
}

test('CLI refuses ambient profile credentials and never reuses source credentials for restore', async t => {
  const f = await fixture(t); const credentials = join(f.root, 'aws-credentials');
  await writeFile(credentials, '[default]\naws_access_key_id = SHOULD_NOT_BE_USED\naws_secret_access_key = PRIVATE_PROFILE_SECRET\n');
  let result = await guardedCli(f, 'backup', { S3_REGION: 'us-east-1', S3_BUCKET: 'boundary-source', AWS_SHARED_CREDENTIALS_FILE: credentials });
  assert.equal(result.code, 1); assert.equal(result.transport, undefined); assert.match(result.stderr, /OBJECT_STORE_CONFIGURATION_REQUIRED/); assert(!result.stderr.includes('PRIVATE_PROFILE_SECRET'));
  result = await guardedCli(f, 'restore', { RESTORE_S3_REGION: 'us-east-1', RESTORE_S3_BUCKET: 'boundary-restore', AWS_ACCESS_KEY_ID: 'SOURCE_ONLY', AWS_SECRET_ACCESS_KEY: 'PRIVATE_SOURCE_SECRET' });
  assert.equal(result.code, 1); assert.equal(result.transport, undefined); assert.match(result.stderr, /OBJECT_STORE_CONFIGURATION_REQUIRED/); assert(!result.stderr.includes('PRIVATE_SOURCE_SECRET'));
});

test('CLI AWS identity cannot be redirected by ambient AWS endpoint configuration', async t => {
  const f = await fixture(t);
  const result = await guardedCli(f, 'backup', { S3_REGION: 'us-east-1', S3_BUCKET: 'boundary-source', S3_FORCE_PATH_STYLE: 'true', AWS_ACCESS_KEY_ID: 'EXPLICIT_FIXTURE', AWS_SECRET_ACCESS_KEY: 'EXPLICIT_FIXTURE_SECRET', AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:1' });
  assert.equal(result.code, 1); assert(result.transport, 'the real SDK reached the guarded transport');
  assert.match(result.transport.hostname, /(?:^|\.)amazonaws\.com$/);
  assert.equal(result.transport.protocol, 'https:');
});
