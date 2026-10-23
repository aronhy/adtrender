import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile), root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'apps/web/package.json'));
const { PrismaClient } = require('@prisma/client');
const hash = value => createHash('sha256').update(value).digest('hex');
const baseUrl = process.env.SAAS_BACKUP_TEST_DATABASE_URL;

test('the actual CLI restores PostgreSQL, private research and all referenced S3 bytes into isolated targets', { skip: !baseUrl, timeout: 120000 }, async t => {
  const base = new URL(baseUrl);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) && /test/.test(base.pathname) && !base.search);
  const suffix = randomUUID().replaceAll('-', ''), sourceName = 'saas_joint_source_test_' + suffix, targetName = 'saas_joint_restore_test_' + suffix;
  const sourceUrl = new URL(base); sourceUrl.pathname = '/' + sourceName;
  const targetUrl = new URL(base); targetUrl.pathname = '/' + targetName; targetUrl.password = '';
  const pgBin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@15/bin';
  const pgEnv = { PATH: `${pgBin}:${process.env.PATH}`, PGHOST: base.hostname, PGPORT: base.port || '5432', PGUSER: decodeURIComponent(base.username), PGPASSWORD: decodeURIComponent(base.password), PGDATABASE: 'postgres', PGCONNECT_TIMEOUT: '5' };
  const command = async (file, args, env) => {
    try { return (await exec(file, args, { env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim(); }
    catch { throw new Error('JOINT_REHEARSAL_COMMAND_FAILED_' + file.split('/').at(-1)); }
  };
  const sql = (text, database = 'postgres') => command(join(pgBin, 'psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', text], { ...pgEnv, PGDATABASE: database });
  const temporary = await mkdtemp(join(tmpdir(), 'saas-joint-cli-test-')); const backup = join(temporary, 'database.dump'), archive = join(temporary, 'objects');
  let sourceDb, restoredDb, server;
  t.after(async () => {
    await sourceDb?.$disconnect(); await restoredDb?.$disconnect();
    if (server) { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); }
    // Only this test's random, explicitly disposable databases are removed.
    for (const name of [targetName, sourceName]) await sql(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`);
    await rm(temporary, { recursive: true, force: true });
  });
  await sql(`CREATE DATABASE "${sourceName}" TEMPLATE template0;`);
  await command(process.execPath, [join(root, 'apps/web/node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema=' + join(root, 'apps/web/.wasp/out/db/schema.prisma')], { ...pgEnv, DATABASE_URL: sourceUrl.href });
  sourceDb = new PrismaClient({ datasources: { db: { url: sourceUrl.href } } });
  const user = await sourceDb.user.create({ data: { email: `joint-${suffix}@example.test` } });
  const organization = await sourceDb.organization.create({ data: { name: 'Synthetic restore team', slug: suffix, members: { create: { userId: user.id, role: 'OWNER' } }, workspaces: { create: { name: 'Synthetic workspace', slug: 'fixture' } } }, include: { workspaces: true } });
  const workspace = organization.workspaces[0];
  const dataSource = await sourceDb.dataSource.create({ data: { key: suffix, name: 'Synthetic backup evidence', adapterVersion: 'fixture', status: 'DISABLED' } });
  const ad = await sourceDb.ad.create({ data: { dataSourceId: dataSource.id, sourceAdId: suffix, sourceUrl: 'https://example.invalid/synthetic', body: 'Synthetic backup record' } });
  const saved = await sourceDb.savedAd.create({ data: { organizationId: organization.id, workspaceId: workspace.id, adId: ad.id, savedByUserId: user.id } });
  const note = await sourceDb.note.create({ data: { organizationId: organization.id, workspaceId: workspace.id, savedAdId: saved.id, authorUserId: user.id, body: '联合恢复测试私有笔记，不是真实客户数据。' } });
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCykAAAAASUVORK5CYII=', 'base64');
  const video = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
  const evidence = Buffer.from(JSON.stringify({ fixture: true, source: 'synthetic', ad: ad.id }));
  const imageKey = `public-media/${randomUUID()}`, privateKey = `private/${organization.id}/${workspace.id}/${randomUUID()}`, evidenceKey = `private-source-evidence/fixture-run/${randomUUID()}.json`;
  await sourceDb.mediaObject.create({ data: { adId: ad.id, sourceUrl: 'https://example.invalid/synthetic.png', type: 'IMAGE', status: 'READY', storageKey: imageKey, mimeType: 'image/png', sizeBytes: BigInt(image.length), sha256: hash(image) } });
  const privateFile = await sourceDb.privateFile.create({ data: { organizationId: organization.id, workspaceId: workspace.id, storageKey: privateKey, filename: 'synthetic.mp4', status: 'READY', mimeType: 'video/mp4', sizeBytes: BigInt(video.length), sha256: hash(video) } });
  const task = await sourceDb.collectionTask.create({ data: { dataSourceId: dataSource.id, name: 'Synthetic evidence only', query: {}, status: 'PAUSED' } });
  const run = await sourceDb.collectionRun.create({ data: { taskId: task.id, dataSourceId: dataSource.id, idempotencyKey: suffix, querySnapshot: {}, adapterVersion: 'fixture', evidenceReference: 's3:' + evidenceKey } });
  await sourceDb.runItem.create({ data: { runId: run.id, dataSourceId: dataSource.id, itemKey: 'fixture', parserVersion: 'fixture', evidenceReference: 's3:' + evidenceKey, evidenceSha256: hash(evidence) } });
  await sourceDb.adObservation.create({ data: { adId: ad.id, dataSourceId: dataSource.id, collectionRunId: run.id, observedAt: new Date(), snapshot: { fixture: true }, parserVersion: 'fixture', evidenceReference: 's3:' + evidenceKey, evidenceSha256: hash(evidence) } });
  const sourceBucket = 'saas-test-source-' + suffix, targetBucket = 'saas-restore-' + suffix;
  const sourceObjects = new Map([[imageKey, { bytes: image, contentType: 'image/png' }], [privateKey, { bytes: video, contentType: 'video/mp4' }], [evidenceKey, { bytes: evidence, contentType: 'application/json' }]]);
  const restoredObjects = new Map(); let targetPuts = 0, sourcePuts = 0;
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'), [, bucket, ...parts] = url.pathname.split('/'); const key = decodeURIComponent(parts.join('/'));
    const values = bucket === sourceBucket ? sourceObjects : bucket === targetBucket ? restoredObjects : null;
    const error = (status, code) => { res.writeHead(status, { 'content-type': 'application/xml' }); res.end(`<Error><Code>${code}</Code></Error>`); };
    if (!values) return error(404, 'NoSuchBucket');
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const keys = [...values.keys()].sort(); res.setHeader('content-type', 'application/xml');
      res.end(`<ListBucketResult><Name>${bucket}</Name><KeyCount>${keys.length}</KeyCount><IsTruncated>false</IsTruncated>${keys.map(key => `<Contents><Key>${key}</Key></Contents>`).join('')}</ListBucketResult>`); return;
    }
    if (req.method === 'GET') {
      const value = values.get(key); if (!value) return error(404, 'NoSuchKey');
      res.writeHead(200, { 'content-type': value.contentType, 'content-length': value.bytes.length }); res.end(value.bytes); return;
    }
    if (req.method === 'DELETE' && bucket === targetBucket && key.startsWith('.adtrender-restore-probe/')) {
      values.delete(key); res.writeHead(204); res.end(); return;
    }
    if (req.method === 'PUT') {
      if (bucket === sourceBucket) { sourcePuts++; return error(403, 'AccessDenied'); }
      if (req.headers['if-none-match'] !== '*') return error(400, 'MissingPrecondition');
      if (values.has(key)) return error(412, 'PreconditionFailed');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      values.set(key, { bytes: Buffer.concat(chunks), contentType: req.headers['content-type'] });
      if (!key.startsWith('.adtrender-restore-probe/')) targetPuts++;
      res.writeHead(200, { ETag: '"fixture"' }); res.end(); return;
    }
    error(405, 'MethodNotAllowed');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const endpoint = `http://127.0.0.1:${server.address().port}`;
  const env = { ...pgEnv, PG_BIN: pgBin, DATABASE_URL: sourceUrl.href, AWS_EC2_METADATA_DISABLED: 'true', S3_BUCKET: sourceBucket, S3_REGION: 'us-east-1', S3_ENDPOINT: endpoint, S3_FORCE_PATH_STYLE: 'true', AWS_ACCESS_KEY_ID: 'fixture-source', AWS_SECRET_ACCESS_KEY: 'fixture-source-secret', RESTORE_S3_BUCKET: targetBucket, RESTORE_S3_REGION: 'us-east-1', RESTORE_S3_ENDPOINT: endpoint, RESTORE_S3_FORCE_PATH_STYLE: 'true', RESTORE_AWS_ACCESS_KEY_ID: 'fixture-target', RESTORE_AWS_SECRET_ACCESS_KEY: 'fixture-target-secret', RESTORE_PGPASSWORD: pgEnv.PGPASSWORD };
  await command(join(root, 'scripts/backup.sh'), ['--output', backup], env);
  const databaseManifest = JSON.parse(await readFile(backup + '.manifest.json')); assert.equal(databaseManifest.objectReferences.length, 5);
  const cli = (mode, args) => command(process.execPath, [join(root, 'scripts/object-backup.mjs'), mode, '--backup', backup, ...args], env);
  assert.equal(JSON.parse(await cli('backup', ['--output', archive])).status, 'OBJECT_BACKUP_VERIFIED');
  assert.equal(JSON.parse(await cli('restore', ['--archive', archive, '--target-url', targetUrl.href])).status, 'JOINT_RESTORE_VERIFIED');
  const restoredClientUrl = new URL(base); restoredClientUrl.pathname = '/' + targetName;
  restoredDb = new PrismaClient({ datasources: { db: { url: restoredClientUrl.href } } });
  assert.deepEqual(await restoredDb.note.findUnique({ where: { id: note.id } }), note);
  assert.deepEqual(await restoredDb.privateFile.findUnique({ where: { id: privateFile.id } }), privateFile);
  assert.deepEqual(restoredObjects, sourceObjects); assert.equal(targetPuts, 3); assert.equal(sourcePuts, 0);
  assert.equal(JSON.parse(await cli('restore', ['--archive', archive, '--target-url', targetUrl.href])).status, 'JOINT_RESTORE_VERIFIED'); assert.equal(targetPuts, 3);
  // Same table counts are insufficient: metadata drift must fail a repeat proof.
  await restoredDb.privateFile.update({ where: { id: privateFile.id }, data: { sha256: 'f'.repeat(64) } });
  await assert.rejects(cli('restore', ['--archive', archive, '--target-url', targetUrl.href])); assert.equal(targetPuts, 3);
});
