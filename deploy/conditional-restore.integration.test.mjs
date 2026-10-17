import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { databaseFixture, databaseUrl, objectCli } from './backup/database-fixture.mjs';
import { probeKey, s3Fixture } from './backup/s3-fixture.mjs';

test('a compatible HTTP provider restores real PostgreSQL and all five reference kinds, then replays without mutations', { skip: !databaseUrl, timeout: 120000 }, async t => {
  const f = await databaseFixture(t);
  const source = await s3Fixture(t, { bucket: 'conditional-source-test', objects: f.objects });
  const target = await s3Fixture(t);
  assert.equal((await objectCli(f, source, target, 'backup')).objectCount, 3);
  assert.deepEqual(await objectCli(f, source, target, 'restore'), { status: 'JOINT_RESTORE_VERIFIED', objectCount: 3 });
  assert.deepEqual(target.objects, f.objects);
  assert.equal(await f.sql('SELECT count(*) FROM "PrivateFile" WHERE id=\'file\' AND status=\'READY\';', f.targetName), '1');
  const reportFile = (await readdir(f.archiveDirectory)).find(name => name.startsWith('database-restore-'));
  assert.equal(JSON.parse(await readFile(join(f.archiveDirectory, reportFile))).objectReferencesVerified, true);
  const before = target.traffic.length;
  assert.equal((await objectCli(f, source, target, 'restore')).status, 'JOINT_RESTORE_VERIFIED');
  assert(target.traffic.slice(before).every(row => row.method === 'GET'));
  assert.equal(target.traffic.filter(row => row.method === 'PUT' && !probeKey(row.key)).length, 3);
  assert.equal(target.traffic.filter(row => row.method === 'DELETE').length, 1);
  assert(source.traffic.every(row => row.method === 'GET'));
  assert.deepEqual([...source.violations, ...target.violations], []);
});

const config = process.env.SAAS_GARAGE_TEST_CONFIG;
test('Garage 2.4.1 is refused before database creation or business-object writes', { skip: !config, timeout: 120000 }, async t => {
  assert(databaseUrl, 'Garage verification requires an explicit isolated database URL');
  const { source, target, reader } = JSON.parse(config), f = await databaseFixture(t);
  const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
  const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const client = value => new S3Client({ endpoint: value.endpoint, region: value.region ?? 'us-east-1', credentials: value.credentials,
    forcePathStyle: true, maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED' });
  const writer = client(source), destination = client(target);
  const readOnly = { ...source, credentials: reader }, backupReader = client(readOnly);
  t.after(() => { writer.destroy(); destination.destroy(); backupReader.destroy(); });
  const send = (client, command) => client.send(command, { abortSignal: AbortSignal.timeout(10000) });
  for (const [Key, value] of f.objects) await send(writer, new PutObjectCommand({ Bucket: source.bucket, Key, Body: value.bytes, ContentType: value.contentType }));
  const [firstKey] = f.objects.keys();
  await assert.rejects(send(backupReader, new PutObjectCommand({ Bucket: source.bucket, Key: firstKey, Body: 'forbidden' })), error => error.$metadata?.httpStatusCode === 403);
  assert.equal((await objectCli(f, readOnly, target, 'backup')).objectCount, 3);
  // A fresh valid archive reaches the provider gate, not a validation shortcut.
  await objectCli(f, readOnly, target, 'restore', 'OBJECT_STORE_CONDITIONAL_PUT_UNSUPPORTED');
  assert.equal(await f.sql(`SELECT count(*) FROM pg_database WHERE datname='${f.targetName}';`, 'postgres'), '0');
  assert.equal((await send(destination, new ListObjectsV2Command({ Bucket: target.bucket }))).Contents?.length ?? 0, 0);
  assert(!(await readdir(f.archiveDirectory)).some(name => /^(?:restore-|database-restore-)/.test(name)));
  // Repeat attempts must remain safe and leave no disposable probe behind.
  await objectCli(f, readOnly, target, 'restore', 'OBJECT_STORE_CONDITIONAL_PUT_UNSUPPORTED');
  assert.equal(await f.sql(`SELECT count(*) FROM pg_database WHERE datname='${f.targetName}';`, 'postgres'), '0');
  assert.equal((await send(destination, new ListObjectsV2Command({ Bucket: target.bucket }))).Contents?.length ?? 0, 0);
  for (const [Key, value] of f.objects) {
    const actual = await send(backupReader, new GetObjectCommand({ Bucket: source.bucket, Key }));
    assert.deepEqual(Buffer.from(await actual.Body.transformToByteArray()), value.bytes);
  }
});
