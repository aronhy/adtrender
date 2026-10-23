import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile), root = fileURLToPath(new URL('../../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const databaseUrl = process.env.SAAS_BACKUP_TEST_DATABASE_URL;
if (process.env.CI && !databaseUrl) throw new Error('SAAS_BACKUP_TEST_DATABASE_URL is required in CI');

export async function databaseFixture(t) {
  const base = new URL(databaseUrl);
  assert(['postgres:', 'postgresql:'].includes(base.protocol));
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
  assert(/(?:^|[_-])(?:test|restore)(?:[_-]|$)/i.test(base.pathname.slice(1)) && !base.search && !base.hash);
  const directory = await mkdtemp(join(tmpdir(), 'conditional-restore-test-'));
  const suffix = randomUUID().replaceAll('-', ''), sourceName = `saas_source_test_${suffix}`, targetName = `saas_restore_test_${suffix}`;
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'PG_BIN'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { PGHOST: base.hostname.replace(/^\[|\]$/g, ''), PGPORT: base.port || '5432', PGUSER: decodeURIComponent(base.username),
    PGPASSWORD: decodeURIComponent(base.password), PGCONNECT_TIMEOUT: '5', PGPASSFILE: '/dev/null' });
  const pg = name => env.PG_BIN ? join(env.PG_BIN, name) : name;
  const sql = async (query, database = sourceName) => (await exec(pg('psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', query], {
    env: { ...env, PGDATABASE: database }, timeout: 30000, maxBuffer: 16 * 1024 ** 2,
  })).stdout.trim();
  t.after(async () => {
    try {
      for (const name of [targetName, sourceName]) await sql(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`, 'postgres');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  await sql(`CREATE DATABASE "${sourceName}" TEMPLATE template0;`, 'postgres');
  const migrations = join(root, 'apps/web/migrations');
  for (const name of (await readdir(migrations)).sort()) {
    if (name !== 'migration_lock.toml') await sql(await readFile(join(migrations, name, 'migration.sql'), 'utf8'));
  }
  const keys = [`public-media/${randomUUID()}`, `private/org/workspace/${randomUUID()}`, `private-source-evidence/run/${randomUUID()}.json`];
  const values = [
    { bytes: Buffer.from('synthetic public image'), contentType: 'image/png' },
    { bytes: Buffer.from('synthetic private video'), contentType: 'video/mp4' },
    { bytes: Buffer.from('{"synthetic":true}'), contentType: 'application/json' },
  ];
  await sql(`BEGIN;
    INSERT INTO "User" (id, "updatedAt") VALUES ('owner', now());
    INSERT INTO "Organization" (id, "updatedAt", name, slug) VALUES ('org', now(), 'Restore fixture', 'restore-fixture');
    INSERT INTO "OrganizationMember" (id, "updatedAt", "organizationId", "userId", role) VALUES ('member', now(), 'org', 'owner', 'OWNER');
    INSERT INTO "Workspace" (id, "updatedAt", "organizationId", name, slug) VALUES ('workspace', now(), 'org', 'Fixture', 'fixture');
    INSERT INTO "DataSource" (id, "updatedAt", key, name, "adapterVersion") VALUES ('source', now(), 'restore-test', 'Fixture', 'test');
    INSERT INTO "CollectionTask" (id, "updatedAt", "dataSourceId", name, query) VALUES ('task', now(), 'source', 'Fixture', '{}');
    INSERT INTO "CollectionRun" (id, "updatedAt", "taskId", "dataSourceId", "idempotencyKey", "querySnapshot", "adapterVersion", "evidenceReference") VALUES ('run', now(), 'task', 'source', 'restore-test', '{}', 'test', 's3:${keys[2]}');
    INSERT INTO "Ad" (id, "updatedAt", "dataSourceId", "sourceAdId", "sourceUrl") VALUES ('ad', now(), 'source', 'restore-ad', 'https://example.test/ad');
    INSERT INTO "AdObservation" (id, "adId", "dataSourceId", "collectionRunId", "observedAt", snapshot, "evidenceReference", "evidenceSha256", "parserVersion") VALUES ('observation', 'ad', 'source', 'run', now(), '{}', 's3:${keys[2]}', '${hash(values[2].bytes)}', 'test');
    INSERT INTO "RunItem" (id, "runId", "dataSourceId", "itemKey", "evidenceReference", "evidenceSha256", "parserVersion") VALUES ('item', 'run', 'source', 'fixture', 's3:${keys[2]}', '${hash(values[2].bytes)}', 'test');
    INSERT INTO "MediaObject" (id, "updatedAt", "adId", "sourceUrl", status, "storageKey", sha256, "sizeBytes", "mimeType") VALUES ('media', now(), 'ad', 'https://example.test/image.png', 'READY', '${keys[0]}', '${hash(values[0].bytes)}', ${values[0].bytes.length}, 'image/png');
    INSERT INTO "PrivateFile" (id, "updatedAt", "organizationId", "workspaceId", "storageKey", filename, "mimeType", "sizeBytes", sha256, status) VALUES ('file', now(), 'org', 'workspace', '${keys[1]}', 'fixture.mp4', 'video/mp4', ${values[1].bytes.length}, '${hash(values[1].bytes)}', 'READY');
    COMMIT;`);
  const sourceUrl = new URL(base); sourceUrl.pathname = `/${sourceName}`; sourceUrl.password = '';
  const targetUrl = new URL(base); targetUrl.pathname = `/${targetName}`; targetUrl.password = '';
  const databaseBackup = join(directory, 'database.dump'), archiveDirectory = join(directory, 'archive');
  await exec('bash', [join(root, 'scripts/backup.sh'), '--output', databaseBackup], {
    env: { ...env, DATABASE_URL: sourceUrl.href }, timeout: 60000, maxBuffer: 1024 ** 2,
  });
  const manifest = JSON.parse(await readFile(`${databaseBackup}.manifest.json`));
  assert.equal(manifest.objectReferences.length, 5);
  assert.deepEqual([...new Set(manifest.objectReferences.map(row => row.kind))].sort(), ['AdObservation', 'CollectionRun', 'MediaObject', 'PrivateFile', 'RunItem']);
  return { directory, databaseBackup, archiveDirectory, objects: new Map(keys.map((key, index) => [key, values[index]])), env, sql, targetName, targetUrl: targetUrl.href, manifest };
}

export async function objectCli(f, source, target, mode, expectedError) {
  const credentials = { accessKeyId: 'fixture-only', secretAccessKey: 'fixture-secret' };
  const s = source.credentials ?? credentials, d = target.credentials ?? credentials;
  const env = { ...f.env, AWS_EC2_METADATA_DISABLED: 'true',
    S3_REGION: source.region ?? 'us-east-1', S3_BUCKET: source.bucket, S3_ENDPOINT: source.endpoint, S3_FORCE_PATH_STYLE: 'true', AWS_ACCESS_KEY_ID: s.accessKeyId, AWS_SECRET_ACCESS_KEY: s.secretAccessKey,
    RESTORE_S3_REGION: target.region ?? 'us-east-1', RESTORE_S3_BUCKET: target.bucket, RESTORE_S3_ENDPOINT: target.endpoint, RESTORE_S3_FORCE_PATH_STYLE: 'true',
    RESTORE_AWS_ACCESS_KEY_ID: d.accessKeyId, RESTORE_AWS_SECRET_ACCESS_KEY: d.secretAccessKey, RESTORE_PGPASSWORD: f.env.PGPASSWORD };
  let result;
  try {
    result = JSON.parse((await exec(process.execPath, [join(root, 'scripts/object-backup.mjs'), mode, '--backup', f.databaseBackup,
      ...(mode === 'backup' ? ['--output', f.archiveDirectory] : ['--archive', f.archiveDirectory, '--target-url', f.targetUrl])], {
      env, timeout: 60000, maxBuffer: 1024 ** 2,
    })).stdout);
  } catch (error) {
    assert.equal(error.code, 1, 'CLI must exit normally, without a timeout or signal');
    assert(expectedError, 'CLI failed unexpectedly');
    assert.deepEqual(JSON.parse(error.stderr), { status: 'FAILED', errorCode: expectedError }); return;
  }
  assert(!expectedError, 'CLI unexpectedly accepted an incompatible provider'); return result;
}
