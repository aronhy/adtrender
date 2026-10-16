import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile), root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'apps/web/package.json'));
const { PrismaClient } = require('@prisma/client'), { tsImport } = require('tsx/esm/api');
const digest = value => createHash('sha256').update(value).digest('hex');
const baseUrl = process.env.SAAS_BACKUP_TEST_DATABASE_URL;

for (const hasObservation of [true, false]) test(`a public legacy import ${hasObservation ? 'with' : 'without'} observations preserves verified evidence through joint restore`, { skip: !baseUrl, timeout: 120000 }, async t => {
  const module = path => tsImport(join(root, 'scripts/saas-migration', path), import.meta.url);
  const { prepareSourceEvidenceManifest, archiveSourceEvidence } = await module('source-evidence.ts');
  const { createInventoryManifest } = await module('inventory.ts');
  const { buildPublicImportPlan, importPublicPlan } = await module('import-public.ts');
  const { prepareLocalMediaManifest, uploadLocalMedia, createLocalS3Provider } = await module('local-media.ts');
  const base = new URL(baseUrl);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) && /test/.test(base.pathname) && !base.search);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 20);
  const sourceName = 'saas_legacy_source_test_' + suffix, targetName = 'saas_legacy_restore_test_' + suffix;
  const sourceClientUrl = new URL(base); sourceClientUrl.pathname = '/' + sourceName;
  const sourceUrl = new URL(sourceClientUrl); sourceUrl.password = '';
  const targetClientUrl = new URL(base); targetClientUrl.pathname = '/' + targetName;
  const targetUrl = new URL(targetClientUrl); targetUrl.password = '';
  const pgBin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@15/bin';
  const pgEnv = { PATH: `${pgBin}:${process.env.PATH}`, PGHOST: base.hostname, PGPORT: base.port || '5432', PGUSER: decodeURIComponent(base.username), PGPASSWORD: decodeURIComponent(base.password), PGDATABASE: 'postgres', PGCONNECT_TIMEOUT: '5' };
  const command = async (file, args, env) => {
    try { return (await exec(file, args, { env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim(); }
    catch { throw new Error('LEGACY_JOINT_REHEARSAL_FAILED_' + file.split('/').at(-1)); }
  };
  const sql = (text, database = 'postgres') => command(join(pgBin, 'psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', text], { ...pgEnv, PGDATABASE: database });
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'saas-legacy-joint-test-')));
  let sourceDb, restoredDb, provider, server;
  t.after(async () => {
    provider?.close(); await sourceDb?.$disconnect(); await restoredDb?.$disconnect();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const name of [targetName, sourceName]) await sql(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`);
    await rm(temporary, { recursive: true, force: true });
  });
  await sql(`CREATE DATABASE "${sourceName}" TEMPLATE template0;`);
  await command(process.execPath, [join(root, 'apps/web/node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema=' + join(root, 'apps/web/.wasp/out/db/schema.prisma')], { ...pgEnv, DATABASE_URL: sourceClientUrl.href });
  sourceDb = new PrismaClient({ datasources: { db: { url: sourceClientUrl.href } } });

  const sourceBucket = 'saas-migration-test-' + suffix, targetBucket = 'saas-restore-' + suffix;
  const sourceObjects = new Map(), restoredObjects = new Map(); let sourcePuts = 0, targetPuts = 0;
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
      res.writeHead(200, { 'content-type': value.mimeType, 'content-length': value.bytes.length }); res.end(value.bytes); return;
    }
    if (req.method === 'PUT') {
      if (req.headers['if-none-match'] !== '*') return error(400, 'MissingPrecondition');
      if (values.has(key)) return error(412, 'PreconditionFailed');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      values.set(key, { bytes: Buffer.concat(chunks), mimeType: req.headers['content-type'] });
      if (bucket === sourceBucket) sourcePuts++; else targetPuts++;
      res.writeHead(200, { ETag: '"fixture"' }); res.end(); return;
    }
    error(405, 'MethodNotAllowed');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`, destination = { endpoint, bucket: sourceBucket };
  provider = createLocalS3Provider(destination, { accessKeyId: 'fixture-source', secretAccessKey: 'fixture-source-secret' });

  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCykAAAAASUVORK5CYII=', 'base64');
  const allowedRoot = join(temporary, 'media'); await mkdir(allowedRoot); await writeFile(join(allowedRoot, 'fixture.png'), image);
  const when = '2026-10-05T00:00:00.000Z';
  const row = id => ({ libraryId: id, sourceUrl: `https://www.facebook.com/ads/library/?id=${id}`, advertiser: 'Synthetic migration advertiser', copy: '合成公开广告，不是真实来源数据', ...(hasObservation ? { collectedAt: when } : {}), mediaType: 'image', mediaUrl: '/local-media/fixture.png', platforms: ['facebook'], status: 'active' });
  const input = Buffer.from(JSON.stringify([row('100000000000001'), row('100000000000002'), row('100000000000001')]));
  const inventory = createInventoryManifest(input, { generatedAt: when, ownership: 'public', localMediaFiles: ['fixture.png'] });
  const publicPlan = buildPublicImportPlan(input, inventory, { confirmManifestHash: inventory.manifestHash, localMediaFiles: ['fixture.png'], mediaEvidence: { 'fixture.png': { sha256: digest(image), sizeBytes: image.length } } });
  assert.deepEqual([publicPlan.summary.inputCount, publicPlan.summary.ads, publicPlan.summary.variants, publicPlan.summary.quarantinedRows], [3, 2, 2, 0]);
  assert.equal((await importPublicPlan(sourceDb, publicPlan, sourceUrl.href)).status, 'IMPORTED');
  const mediaOptions = { allowedRoot, confirmInventoryHash: inventory.manifestHash, targetUrl: sourceUrl.href, destination, generatedAt: when };
  const mediaManifest = await prepareLocalMediaManifest(input, inventory, mediaOptions);
  assert.equal((await uploadLocalMedia(sourceDb, input, inventory, mediaManifest, { ...mediaOptions, confirmManifestHash: mediaManifest.manifestHash, provider })).status, 'VERIFIED');
  assert.equal(sourcePuts, 2);

  const env = { ...pgEnv, PG_BIN: pgBin, DATABASE_URL: sourceClientUrl.href, AWS_EC2_METADATA_DISABLED: 'true', S3_BUCKET: sourceBucket, S3_REGION: 'us-east-1', S3_ENDPOINT: endpoint, S3_FORCE_PATH_STYLE: 'true', AWS_ACCESS_KEY_ID: 'fixture-source', AWS_SECRET_ACCESS_KEY: 'fixture-source-secret', RESTORE_S3_BUCKET: targetBucket, RESTORE_S3_REGION: 'us-east-1', RESTORE_S3_ENDPOINT: endpoint, RESTORE_S3_FORCE_PATH_STYLE: 'true', RESTORE_AWS_ACCESS_KEY_ID: 'fixture-target', RESTORE_AWS_SECRET_ACCESS_KEY: 'fixture-target-secret', RESTORE_PGPASSWORD: pgEnv.PGPASSWORD };
  const backup = join(temporary, 'database.dump'), beforeBackup = join(temporary, 'before-evidence.dump'), archive = join(temporary, 'objects');
  const cli = (mode, dump, args) => command(process.execPath, [join(root, 'scripts/object-backup.mjs'), mode, '--backup', dump, ...args], env);
  await command(join(root, 'scripts/backup.sh'), ['--output', beforeBackup], env);
  await assert.rejects(cli('backup', beforeBackup, ['--output', join(temporary, 'incomplete')]));
  assert.equal(sourcePuts, 2, 'a digest-only evidence reference cannot be called a complete backup');
  const beforeItems = await sourceDb.runItem.findMany({ orderBy: { itemKey: 'asc' } });
  const evidenceOptions = { confirmInventoryHash: inventory.manifestHash, publicPlan, targetUrl: sourceUrl.href, destination, generatedAt: when };
  const evidenceManifest = await prepareSourceEvidenceManifest(sourceDb, input, inventory, evidenceOptions);
  const archived = await archiveSourceEvidence(sourceDb, input, inventory, evidenceManifest, { ...evidenceOptions, confirmManifestHash: evidenceManifest.manifestHash, provider });
  assert.equal(archived.status, 'ARCHIVED'); assert.equal(sourcePuts, 5);
  const run = await sourceDb.collectionRun.findUnique({ where: { idempotencyKey: `legacy-public:${inventory.sha256}` } });
  const afterItems = await sourceDb.runItem.findMany({ orderBy: { itemKey: 'asc' } });
  assert.deepEqual(afterItems.map(item => [item.itemKey, item.evidenceSha256]), beforeItems.map(item => [item.itemKey, item.evidenceSha256]), 'variant evidence hashes must not be rewritten to the raw input hash');
  assert(run.evidenceReference.startsWith('s3:private-source-evidence/' + run.id + '/'));
  assert.deepEqual(sourceObjects.get(run.evidenceReference.slice(3)).bytes, input, 'original approved JSON bytes are preserved');
  for (const item of afterItems) assert.equal(digest(sourceObjects.get(item.evidenceReference.slice(3)).bytes), item.evidenceSha256);
  assert.equal((await archiveSourceEvidence(sourceDb, input, inventory, evidenceManifest, { ...evidenceOptions, confirmManifestHash: evidenceManifest.manifestHash, provider })).status, 'REPLAY_VERIFIED_NO_WRITE');
  assert.equal((await importPublicPlan(sourceDb, publicPlan, sourceUrl.href)).status, 'REPLAY_VERIFIED_NO_WRITE');
  assert.equal(sourcePuts, 5);
  assert.deepEqual(await sourceDb.collectionRun.findUnique({ where: { id: run.id } }), run);

  await command(join(root, 'scripts/backup.sh'), ['--output', backup], env);
  const databaseManifest = JSON.parse(await readFile(backup + '.manifest.json'));
  assert.equal(databaseManifest.objectReferences.length, hasObservation ? 8 : 6);
  assert.equal(await sourceDb.adObservation.count(), hasObservation ? 2 : 0);
  const rawObject = sourceObjects.get(run.evidenceReference.slice(3));
  const originalBytes = rawObject.bytes;
  rawObject.bytes = Buffer.from(originalBytes); rawObject.bytes[0] ^= 1;
  await assert.rejects(cli('backup', backup, ['--output', join(temporary, 'tampered-source')]), 'raw source corruption must fail even when there are no observations');
  rawObject.bytes = originalBytes;
  const runReference = databaseManifest.objectReferences.find(ref => ref.kind === 'CollectionRun');
  assert.equal(runReference.sha256, inventory.sha256);
  assert.equal(runReference.sizeBytes, String(input.length));
  assert.equal(JSON.parse(await cli('backup', backup, ['--output', archive])).objectCount, 5);
  assert.equal(JSON.parse(await cli('restore', backup, ['--archive', archive, '--target-url', targetUrl.href])).status, 'JOINT_RESTORE_VERIFIED');
  restoredDb = new PrismaClient({ datasources: { db: { url: targetClientUrl.href } } });
  assert.deepEqual(await restoredDb.collectionRun.findUnique({ where: { id: run.id } }), run);
  assert.deepEqual(await restoredDb.runItem.findMany({ orderBy: { itemKey: 'asc' } }), afterItems);
  assert.deepEqual(await restoredDb.mediaObject.findMany({ orderBy: { id: 'asc' } }), await sourceDb.mediaObject.findMany({ orderBy: { id: 'asc' } }));
  assert.deepEqual(await restoredDb.adObservation.findMany({ orderBy: { id: 'asc' } }), await sourceDb.adObservation.findMany({ orderBy: { id: 'asc' } }));
  assert.deepEqual(restoredObjects, sourceObjects); assert.equal(targetPuts, 5); assert.equal(sourcePuts, 5);
  assert.equal(JSON.parse(await cli('restore', backup, ['--archive', archive, '--target-url', targetUrl.href])).status, 'JOINT_RESTORE_VERIFIED');
  assert.equal(targetPuts, 5, 'repeating a verified restore does not PUT');
});
