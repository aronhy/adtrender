import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { seedJointBackupFixture } from './helpers/joint-backup-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(join(root, 'apps/web/package.json'));
const { PrismaClient } = require('@prisma/client');
const { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// This suite is intentionally fail-closed. The runner creates two disposable Garage instances.
test('PostgreSQL and real Garage joint restore', { timeout: 180000 }, async t => {
  assert(process.env.SAAS_GARAGE_TEST_CONFIG, 'Use deploy/backup/run-garage-rehearsal.mjs');
  const { source, reader, target } = JSON.parse(process.env.SAAS_GARAGE_TEST_CONFIG);
  const base = new URL(process.env.SAAS_BACKUP_TEST_DATABASE_URL);
  assert(['postgres:', 'postgresql:'].includes(base.protocol));
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
  assert(/(?:^|[_-])(?:test|restore)(?:[_-]|$)/i.test(base.pathname.slice(1)) && !base.search && !base.hash);
  for (const store of [source, target]) {
    const url = new URL(store.endpoint);
    assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:');
    assert(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/');
  }
  assert.equal(source.bucket, 'adtrender-test-source'); assert.equal(target.bucket, 'adtrender-restore-test');
  assert.notEqual(source.endpoint, target.endpoint);
  const suffix = randomUUID().replaceAll('-', '');
  const sourceName = `saas_garage_source_test_${suffix}`, targetName = `saas_garage_restore_test_${suffix}`;
  const sourceUrl = new URL(base); sourceUrl.pathname = `/${sourceName}`;
  const targetClientUrl = new URL(base); targetClientUrl.pathname = `/${targetName}`;
  const targetUrl = new URL(targetClientUrl); targetUrl.password = '';
  const pgEnv = { PATH: process.env.PG_BIN ? `${process.env.PG_BIN}:${process.env.PATH}` : process.env.PATH,
    PGHOST: base.hostname.replace(/^\[|\]$/g, ''), PGPORT: base.port || '5432', PGUSER: decodeURIComponent(base.username),
    PGPASSWORD: decodeURIComponent(base.password), PGDATABASE: 'postgres', PGCONNECT_TIMEOUT: '5' };
  if (process.env.PG_BIN) pgEnv.PG_BIN = process.env.PG_BIN;
  async function command(file, args, env = pgEnv) {
    try { return (await exec(file, args, { env, timeout: 60000, maxBuffer: 4 * 1024 ** 2 })).stdout.trim(); }
    catch { throw new Error(`GARAGE_FIXTURE_COMMAND_FAILED_${file.split('/').at(-1)}`); }
  }
  const sql = (text, database = 'postgres') => command('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', text], { ...pgEnv, PGDATABASE: database });
  const temporary = await mkdtemp(join(tmpdir(), 'adtrender-garage-restore-'));
  const dump = join(temporary, 'database.dump'), archive = join(temporary, 'objects');
  const sourceDb = new PrismaClient({ datasources: { db: { url: sourceUrl.href } } });
  const restoredDb = new PrismaClient({ datasources: { db: { url: targetClientUrl.href } } });
  const clients = [], proxies = [];
  t.after(async () => {
    for (const client of clients) client.destroy();
    for (const server of proxies) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await Promise.all([sourceDb.$disconnect(), restoredDb.$disconnect()]);
    // Names are freshly generated above, never taken from the supplied URL.
    for (const name of [targetName, sourceName]) await sql(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`);
    await rm(temporary, { recursive: true, force: true });
  });
  // A transparent observer forwards every signed request to real Garage, without mocking responses.
  // Preserve Host for signature verification. Record methods only, never credentials or object URLs.
  async function observe(endpoint) {
    const upstream = new URL(endpoint), methods = [];
    const server = createServer((req, res) => {
      methods.push(req.method);
      const forwarded = request({ hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers: req.headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      forwarded.setTimeout(15000, () => forwarded.destroy());
      forwarded.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on('aborted', () => forwarded.destroy()); req.pipe(forwarded);
    });
    proxies.push(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { endpoint: `http://127.0.0.1:${server.address().port}`, methods, puts: () => methods.filter(method => method === 'PUT').length };
  }
  function client(store, credentials = store.credentials) {
    const result = new S3Client({ endpoint: store.endpoint, region: 'garage', credentials, forcePathStyle: true,
      ignoreConfiguredEndpointUrls: true, maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED',
      requestHandler: { connectionTimeout: 5000, requestTimeout: 15000, throwOnRequestTimeout: true } });
    clients.push(result); return result;
  }
  const sourceWriter = client(source), sourceReader = client(source, reader), targetWriter = client(target);
  const send = (client, cmd) => client.send(cmd, { abortSignal: AbortSignal.timeout(15000) });
  const put = (client, bucket, key, bytes, contentType, extra = {}) => send(client, new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType, ...extra }));
  const get = async (client, bucket, key) => {
    const response = await send(client, new GetObjectCommand({ Bucket: bucket, Key: key }));
    return { bytes: Buffer.from(await response.Body.transformToByteArray()), contentType: response.ContentType };
  };
  const sourceTraffic = await observe(source.endpoint), targetTraffic = await observe(target.endpoint);
  const env = { ...pgEnv, DATABASE_URL: sourceUrl.href, AWS_EC2_METADATA_DISABLED: 'true',
    S3_BUCKET: source.bucket, S3_REGION: 'garage', S3_ENDPOINT: sourceTraffic.endpoint, S3_FORCE_PATH_STYLE: 'true',
    AWS_ACCESS_KEY_ID: reader.accessKeyId, AWS_SECRET_ACCESS_KEY: reader.secretAccessKey,
    RESTORE_S3_BUCKET: target.bucket, RESTORE_S3_REGION: 'garage', RESTORE_S3_ENDPOINT: targetTraffic.endpoint, RESTORE_S3_FORCE_PATH_STYLE: 'true',
    RESTORE_AWS_ACCESS_KEY_ID: target.credentials.accessKeyId, RESTORE_AWS_SECRET_ACCESS_KEY: target.credentials.secretAccessKey,
    RESTORE_PGPASSWORD: pgEnv.PGPASSWORD };
  async function cli(mode, directory = archive, expectedError) {
    const args = [join(root, 'scripts/object-backup.mjs'), mode, '--backup', dump,
      ...(mode === 'backup' ? ['--output', directory] : ['--archive', directory, '--target-url', targetUrl.href])];
    let result;
    try { result = JSON.parse((await exec(process.execPath, args, { env, timeout: 60000, maxBuffer: 1024 ** 2 })).stdout); }
    catch (error) {
      assert.equal(error.code, 1, 'CLI must fail normally, without a timeout or signal');
      const failure = JSON.parse(error.stderr);
      assert.equal(failure.status, 'FAILED');
      assert(expectedError, 'CLI failed unexpectedly');
      assert.equal(failure.errorCode, expectedError); return;
    }
    assert(!expectedError, 'CLI unexpectedly accepted invalid input'); return result;
  }
  const targetAbsent = async () => assert.equal(await sql(`SELECT count(*) FROM pg_database WHERE datname='${targetName}';`), '0');
  await sql(`CREATE DATABASE "${sourceName}" TEMPLATE template0;`);
  await command(process.execPath, [join(root, 'apps/web/node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema=' + join(root, 'apps/web/.wasp/out/db/schema.prisma')], { ...pgEnv, DATABASE_URL: sourceUrl.href });
  const { note, privateFile, sourceObjects } = await seedJointBackupFixture(sourceDb);
  for (const [key, value] of sourceObjects) await put(sourceWriter, source.bucket, key, value.bytes, value.contentType);
  const [firstKey, firstValue] = [...sourceObjects][0];

  await t.test('backup credentials can read but cannot write source objects', async () => {
    await assert.rejects(() => put(sourceReader, source.bucket, firstKey, Buffer.from('forbidden'), firstValue.contentType), error => error.$metadata?.httpStatusCode === 403);
    assert.deepEqual(await get(sourceWriter, source.bucket, firstKey), firstValue);
  });
  await command(join(root, 'scripts/backup.sh'), ['--output', dump], env);
  const manifest = JSON.parse(await readFile(`${dump}.manifest.json`));
  assert.equal(manifest.objectReferences.length, 5);
  assert.deepEqual([...new Set(manifest.objectReferences.map(row => row.kind))].sort(), ['AdObservation', 'CollectionRun', 'MediaObject', 'PrivateFile', 'RunItem']);
  await t.test('corrupt source bytes cannot publish a successful object archive', async () => {
    await put(sourceWriter, source.bucket, firstKey, Buffer.from('corrupt source'), firstValue.contentType);
    const incomplete = join(temporary, 'incomplete');
    await cli('backup', incomplete, 'OBJECT_CONTENT_MISMATCH');
    await assert.rejects(readFile(join(incomplete, 'manifest.json')), { code: 'ENOENT' });
    await put(sourceWriter, source.bucket, firstKey, firstValue.bytes, firstValue.contentType);
  });
  assert.deepEqual(await cli('backup'), { status: 'OBJECT_BACKUP_VERIFIED', objectCount: 3 });
  await t.test('corrupt local archive fails before creating a database or writing Garage', async () => {
    const path = join(archive, 'objects', hash(firstValue.bytes));
    await writeFile(path, 'corrupt archive');
    await cli('restore', archive, 'OBJECT_CONTENT_MISMATCH');
    await targetAbsent(); assert.equal(targetTraffic.puts(), 0);
    await writeFile(path, firstValue.bytes);
  });
  await t.test('a nonempty restore bucket is rejected without overwriting or creating a database', async () => {
    await put(targetWriter, target.bucket, firstKey, firstValue.bytes, firstValue.contentType);
    await cli('restore', archive, 'OBJECT_RESTORE_TARGET_NOT_EMPTY');
    await targetAbsent(); assert.equal(targetTraffic.puts(), 0);
    assert.deepEqual(await get(targetWriter, target.bucket, firstKey), firstValue);
    await send(targetWriter, new DeleteObjectCommand({ Bucket: target.bucket, Key: firstKey }));
  });
  await t.test('the actual CLI restores private research and all five reference kinds to independent targets', async () => {
    assert.deepEqual(await cli('restore'), { status: 'JOINT_RESTORE_VERIFIED', objectCount: 3 });
    assert.equal(targetTraffic.puts(), 3);
    assert.deepEqual(await restoredDb.note.findUnique({ where: { id: note.id } }), note);
    assert.deepEqual(await restoredDb.privateFile.findUnique({ where: { id: privateFile.id } }), privateFile);
    for (const [key, value] of sourceObjects) assert.deepEqual(await get(targetWriter, target.bucket, key), value);
    const reportFile = (await readdir(archive)).find(name => name.startsWith('database-restore-'));
    const report = JSON.parse(await readFile(join(archive, reportFile)));
    assert.equal(report.objectReferencesVerified, true); assert.equal(report.backupSha256, manifest.sha256);
    assert.equal(report.objectReferencesSha256, hash(JSON.stringify(manifest.objectReferences)));
  });
  await t.test('repeating a verified restore performs no PUT or DELETE', async () => {
    assert.equal((await cli('restore')).status, 'JOINT_RESTORE_VERIFIED');
    assert.equal(targetTraffic.puts(), 3); assert(!targetTraffic.methods.includes('DELETE'));
  });
  await t.test('Garage enforces conditional PUT and preserves the existing bytes', async () => {
    // Use a separate diagnostic key so a provider defect cannot contaminate later restore checks.
    const key = `restore-capability-probe/${randomUUID()}`, original = Buffer.from('original probe');
    targetWriter.middlewareStack.add(next => async args => {
      if (args.input.IfNoneMatch === '*') assert.equal(args.request.headers['if-none-match'], '*');
      return next(args);
    }, { step: 'finalizeRequest', name: 'assertConditionalHeader' });
    await put(targetWriter, target.bucket, key, original, 'application/octet-stream');
    try {
      await assert.rejects(() => put(targetWriter, target.bucket, key, Buffer.from('must not overwrite'), 'application/octet-stream', { IfNoneMatch: '*' }), error => error.$metadata?.httpStatusCode === 412);
      assert.deepEqual((await get(targetWriter, target.bucket, key)).bytes, original);
    } finally {
      await send(targetWriter, new DeleteObjectCommand({ Bucket: target.bucket, Key: key }));
    }
  });
  await t.test('unchanged row counts cannot hide restored database metadata drift', async () => {
    await restoredDb.privateFile.update({ where: { id: privateFile.id }, data: { sha256: 'f'.repeat(64) } });
    await cli('restore', archive, 'OBJECT_RESTORE_FAILED'); assert.equal(targetTraffic.puts(), 3);
    await restoredDb.privateFile.update({ where: { id: privateFile.id }, data: { sha256: privateFile.sha256 } });
  });
  await t.test('a completed receipt cannot hide changed or missing target objects', async () => {
    const corrupt = Buffer.from('changed target');
    await put(targetWriter, target.bucket, firstKey, corrupt, firstValue.contentType);
    await cli('restore', archive, 'OBJECT_CONTENT_MISMATCH'); assert.equal(targetTraffic.puts(), 3);
    assert.deepEqual((await get(targetWriter, target.bucket, firstKey)).bytes, corrupt);
    await send(targetWriter, new DeleteObjectCommand({ Bucket: target.bucket, Key: firstKey }));
    await cli('restore', archive, 'OBJECT_RESTORE_COMPLETED_TARGET_CHANGED'); assert.equal(targetTraffic.puts(), 3);
  });
  assert(sourceTraffic.methods.length > 0 && sourceTraffic.methods.every(method => method === 'GET'));
  assert(!targetTraffic.methods.includes('DELETE'));
  for (const [key, value] of sourceObjects) assert.deepEqual(await get(sourceWriter, source.bucket, key), value);
  assert.deepEqual(await sourceDb.note.findUnique({ where: { id: note.id } }), note);
  const remaining = await send(targetWriter, new ListObjectsV2Command({ Bucket: target.bucket }));
  assert.equal(remaining.Contents.length, 2);
});
