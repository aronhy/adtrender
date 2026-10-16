import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
const migrations = fileURLToPath(new URL('../apps/web/migrations/', import.meta.url));
const databaseUrl = process.env.SAAS_BACKUP_TEST_DATABASE_URL;
const hash = value => createHash('sha256').update(value).digest('hex');
const quote = value => `'${value.replaceAll("'", "''")}'`;

describe('PostgreSQL snapshot object references', { skip: !databaseUrl }, () => {
  let root, source, env, connection; const created = new Set();
  const dbName = () => `saas_backup_test_${randomUUID().replaceAll('-', '')}`;
  const exec = (bin, args, overrides = {}) => spawnSync(bin, args, { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...overrides });
  function sql(query, database = source) {
    const result = exec('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query], { env: { ...env, PGDATABASE: database } });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  }
  function createDatabase() {
    const name = dbName(); sql(`CREATE DATABASE "${name}" TEMPLATE template0;`, 'postgres'); created.add(name); return name;
  }
  const targetUrl = name => { const target = new URL(connection); target.pathname = `/${name}`; target.password = ''; return target.href; };
  function backup(name = randomUUID(), extraEnv = {}) {
    const path = join(root, `${name}.dump`);
    const result = exec('bash', [join(scripts, 'backup.sh'), '--output', path], { env: { ...env, DATABASE_URL: targetUrl(source), ...extraEnv } });
    return { path, result, manifestPath: `${path}.manifest.json` };
  }
  function restore(fixture, name = dbName()) {
    // Track only our freshly generated target names, never a user-supplied database.
    created.add(name);
    const report = join(root, `${name}.report.json`);
    const result = exec('bash', [join(scripts, 'restore-check.sh'), '--backup', fixture.path, '--target-url', targetUrl(name), '--report', report]);
    return { result, name, report };
  }
  const expected = [
    { kind: 'AdObservation', id: 'observation', reference: 's3:private-source-evidence/run/observation.json', sha256: 'b'.repeat(64), sizeBytes: null, mimeType: 'application/json' },
    { kind: 'CollectionRun', id: 'run', reference: 's3:private-source-evidence/run/batch.json', sha256: null, sizeBytes: null, mimeType: 'application/json' },
    { kind: 'MediaObject', id: 'media-null', reference: null, sha256: null, sizeBytes: null, mimeType: null },
    { kind: 'MediaObject', id: 'media-ready', reference: 'public-media/original', sha256: 'a'.repeat(64), sizeBytes: '9007199254740993', mimeType: 'image/png' },
    { kind: 'PrivateFile', id: 'private-ready', reference: 'private/org/workspace/file', sha256: 'c'.repeat(64), sizeBytes: '12', mimeType: 'video/mp4' },
    { kind: 'RunItem', id: 'item', reference: 'local-private:private-source-evidence/run/item.json', sha256: 'd'.repeat(64), sizeBytes: null, mimeType: 'application/json' },
  ];
  const addInventory = manifest => ({ ...manifest, objectReferencesVersion: 1, objectReferences: expected });
  before(() => {
    connection = new URL(databaseUrl);
    assert(['postgres:', 'postgresql:'].includes(connection.protocol));
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(connection.hostname));
    assert(/(^|[_-])(test|restore)([_-]|$)/i.test(connection.pathname.slice(1)));
    assert.equal(connection.search, ''); assert.equal(connection.hash, '');
    root = mkdtempSync(join(tmpdir(), 'saas-pg-backup-test-'));
    // Inherit no provider credentials or external service configuration.
    env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'PG_BIN'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(env, { PGHOST: connection.hostname.replace(/^\[|\]$/g, ''), PGPORT: connection.port || '5432', PGUSER: decodeURIComponent(connection.username), PGPASSWORD: decodeURIComponent(connection.password), PGCONNECT_TIMEOUT: '10', npm_config_audit: 'false' });
    source = createDatabase();
    for (const name of readdirSync(migrations).sort()) {
      const path = join(migrations, name, 'migration.sql');
      if (existsSync(path)) sql(readFileSync(path, 'utf8'));
    }
    sql(`BEGIN;
      INSERT INTO "User" (id, "updatedAt") VALUES ('owner', now());
      INSERT INTO "Organization" (id, "updatedAt", name, slug) VALUES ('org', now(), 'Backup fixture', 'backup-fixture');
      INSERT INTO "OrganizationMember" (id, "updatedAt", "organizationId", "userId", role) VALUES ('member', now(), 'org', 'owner', 'OWNER');
      INSERT INTO "Workspace" (id, "updatedAt", "organizationId", name, slug) VALUES ('workspace', now(), 'org', 'Fixture', 'fixture');
      INSERT INTO "DataSource" (id, "updatedAt", key, name, "adapterVersion") VALUES ('source', now(), 'backup-test', 'Fixture', 'test');
      INSERT INTO "CollectionTask" (id, "updatedAt", "dataSourceId", name, query) VALUES ('task', now(), 'source', 'Fixture', '{}');
      INSERT INTO "CollectionRun" (id, "updatedAt", "taskId", "dataSourceId", "idempotencyKey", "querySnapshot", "adapterVersion", "evidenceReference") VALUES ('run', now(), 'task', 'source', 'backup-test', '{}', 'test', 's3:private-source-evidence/run/batch.json');
      INSERT INTO "CollectionRun" (id, "updatedAt", "taskId", "dataSourceId", "idempotencyKey", "querySnapshot", "adapterVersion") VALUES ('run-empty', now(), 'task', 'source', 'backup-empty', '{}', 'test');
      INSERT INTO "Ad" (id, "updatedAt", "dataSourceId", "sourceAdId", "sourceUrl") VALUES ('ad', now(), 'source', 'backup-ad', 'https://example.test/ad');
      INSERT INTO "AdObservation" (id, "adId", "dataSourceId", "collectionRunId", "observedAt", snapshot, "evidenceReference", "evidenceSha256", "parserVersion") VALUES ('observation', 'ad', 'source', 'run', now(), '{}', 's3:private-source-evidence/run/observation.json', '${'b'.repeat(64)}', 'test');
      INSERT INTO "RunItem" (id, "runId", "dataSourceId", "itemKey", "evidenceReference", "evidenceSha256", "parserVersion") VALUES ('item', 'run', 'source', 'fixture', 'local-private:private-source-evidence/run/item.json', '${'d'.repeat(64)}', 'test');
      INSERT INTO "MediaObject" (id, "updatedAt", "adId", "sourceUrl", status, "storageKey", sha256, "sizeBytes", "mimeType") VALUES
        ('media-ready', now(), 'ad', 'https://example.test/ready.png', 'READY', 'public-media/original', '${'a'.repeat(64)}', 9007199254740993, 'image/png'),
        ('media-null', now(), 'ad', 'https://example.test/null.png', 'READY', NULL, NULL, NULL, NULL),
        ('media-failed', now(), 'ad', 'https://example.test/failed.png', 'FAILED', 'public-media/failed', NULL, NULL, NULL),
        ('media-expired', now(), 'ad', 'https://example.test/expired.png', 'EXPIRED', 'public-media/expired', NULL, NULL, NULL);
      INSERT INTO "PrivateFile" (id, "updatedAt", "organizationId", "workspaceId", "storageKey", filename, "mimeType", "sizeBytes", sha256, status) VALUES
        ('private-ready', now(), 'org', 'workspace', 'private/org/workspace/file', 'fixture.mp4', 'video/mp4', 12, '${'c'.repeat(64)}', 'READY'),
        ('private-expired', now(), 'org', 'workspace', 'private/org/workspace/expired', 'fixture.mp4', 'video/mp4', 12, '${'c'.repeat(64)}', 'EXPIRED');
      COMMIT;`);
  });
  after(() => {
    for (const name of created) sql(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`, 'postgres');
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('exports ordered five-kind references without hiding READY null keys or losing bigint precision', () => {
    const f = backup(); assert.equal(f.result.status, 0, f.result.stderr);
    const manifest = JSON.parse(readFileSync(f.manifestPath));
    assert.equal(manifest.objectReferencesVersion, 1); assert.deepEqual(manifest.objectReferences, expected);
    const target = restore(f); assert.equal(target.result.status, 0, target.result.stderr);
    const report = JSON.parse(readFileSync(target.report));
    assert.equal(report.backupSha256, manifest.sha256); assert.equal(report.objectReferencesVerified, true);
    assert.equal(report.objectReferencesVersion, 1); assert.equal(report.objectReferencesSha256, hash(JSON.stringify(expected)));
    assert.equal(restore(f, target.name).result.status, 0);
  });

  test('archived legacy source metadata is bound to its run and malformed receipts cannot downgrade to null hashes', () => {
    const sourceObject = { kind: 'SOURCE', key: 'private-source-evidence/run/batch.json', sha256: 'e'.repeat(64), sizeBytes: 123, mimeType: 'application/json' };
    const receipt = { schemaVersion: 1, classification: 'public', runId: 'run', inputSha256: sourceObject.sha256, publicPlanHash: 'plan', inventoryManifestHash: 'inventory', manifestHash: 'f'.repeat(64), objects: [sourceObject] };
    const setReceipt = value => sql(`UPDATE "CollectionRun" SET "adapterVersion"='legacy-public-v1', "idempotencyKey"='legacy-public:${sourceObject.sha256}', coverage=${quote(JSON.stringify({ planHash: 'plan', inventoryManifestHash: 'inventory', ...(value === undefined ? {} : { sourceEvidenceArchive: value }) }))}::jsonb WHERE id='run';`);
    const exportedRun = () => JSON.parse(sql(readFileSync(join(scripts, 'object-references.sql'), 'utf8'))).find(ref => ref.kind === 'CollectionRun');
    try {
      setReceipt(receipt);
      assert.deepEqual(exportedRun(), { ...expected[1], sha256: sourceObject.sha256, sizeBytes: '123' });
      for (const malformed of [undefined, { ...receipt, objects: [] }, { ...receipt, objects: {} }, { ...receipt, runId: 'other' }, { ...receipt, inputSha256: 'a'.repeat(64) }, { ...receipt, publicPlanHash: 'other' }, ...[{ key: 'other' }, { sha256: null }, { sizeBytes: null }, { sizeBytes: '123' }, { mimeType: 'text/plain' }].map(change => ({ ...receipt, objects: [{ ...sourceObject, ...change }] }))]) {
        setReceipt(malformed);
        assert.equal(exportedRun().sha256, 'INVALID_LEGACY_SOURCE_RECEIPT');
        assert.equal(exportedRun().sizeBytes, 'INVALID_LEGACY_SOURCE_RECEIPT');
      }
      setReceipt({ ...receipt, objects: [sourceObject, sourceObject] });
      const duplicate = backup(); assert.notEqual(duplicate.result.status, 0); assert(!existsSync(duplicate.path)); assert(!existsSync(duplicate.manifestPath));
    } finally { sql(`UPDATE "CollectionRun" SET "adapterVersion"='test', "idempotencyKey"='backup-test', coverage='{}'::jsonb WHERE id='run';`); }
  });

  test('rejects a changed reference in a manifest even when archive, schema and row counts match', () => {
    const f = backup(); assert.equal(f.result.status, 0, f.result.stderr);
    const manifest = addInventory(JSON.parse(readFileSync(f.manifestPath)));
    manifest.objectReferences = expected.map(row => row.id === 'media-ready' ? { ...row, reference: 'public-media/wrong' } : row);
    writeFileSync(f.manifestPath, JSON.stringify(manifest));
    const target = restore(f); assert.equal(target.result.status, 1); assert.match(target.result.stderr, /object references/i); assert(!existsSync(target.report));
  });

  test('revalidates references on repeat without overwriting a changed target row', () => {
    const f = backup(); assert.equal(f.result.status, 0, f.result.stderr);
    writeFileSync(f.manifestPath, JSON.stringify(addInventory(JSON.parse(readFileSync(f.manifestPath)))));
    const target = restore(f); assert.equal(target.result.status, 0, target.result.stderr);
    sql(`UPDATE "MediaObject" SET "storageKey"='public-media/changed-after-restore' WHERE id='media-ready';`, target.name);
    const replay = restore(f, target.name); assert.equal(replay.result.status, 1); assert.match(replay.result.stderr, /object references/i);
    assert.equal(sql(`SELECT "storageKey" FROM "MediaObject" WHERE id='media-ready';`, target.name), 'public-media/changed-after-restore');
  });

  test('legacy manifests restore only PostgreSQL and never issue object verification proof', () => {
    const f = backup(); assert.equal(f.result.status, 0, f.result.stderr);
    const manifest = JSON.parse(readFileSync(f.manifestPath)); delete manifest.objectReferencesVersion; delete manifest.objectReferences;
    writeFileSync(f.manifestPath, JSON.stringify(manifest));
    const target = restore(f); assert.equal(target.result.status, 0, target.result.stderr);
    const report = JSON.parse(readFileSync(target.report)); assert.notEqual(report.objectReferencesVerified, true); assert.equal(report.objectReferencesVersion, undefined);
  });

  test('repeat proof reflects the current manifest instead of retaining an earlier object verification claim', () => {
    const f = backup(); assert.equal(f.result.status, 0, f.result.stderr);
    const complete = JSON.parse(readFileSync(f.manifestPath));
    const target = restore(f); assert.equal(target.result.status, 0, target.result.stderr);
    const legacy = { ...complete }; delete legacy.objectReferencesVersion; delete legacy.objectReferences;
    writeFileSync(f.manifestPath, JSON.stringify(legacy));
    assert.equal(restore(f, target.name).result.status, 0);
    assert.notEqual(JSON.parse(readFileSync(target.report)).objectReferencesVerified, true);
    writeFileSync(f.manifestPath, JSON.stringify(complete));
    assert.equal(restore(f, target.name).result.status, 0);
    assert.equal(JSON.parse(readFileSync(target.report)).objectReferencesVerified, true);
  });

  test('rejects incomplete or unsupported object inventory versions before restoring', () => {
    for (const fields of [{ objectReferences: expected }, { objectReferencesVersion: 1 }, { objectReferencesVersion: 2, objectReferences: expected }]) {
      const f = backup(); assert.equal(f.result.status, 0, f.result.stderr);
      const manifest = JSON.parse(readFileSync(f.manifestPath)); delete manifest.objectReferencesVersion; delete manifest.objectReferences;
      writeFileSync(f.manifestPath, JSON.stringify({ ...manifest, ...fields }));
      const target = restore(f); assert.equal(target.result.status, 1); assert(!existsSync(target.report));
      assert.equal(sql(`SELECT count(*) FROM pg_database WHERE datname=${quote(target.name)};`, 'postgres'), '0');
    }
  });

  test('does not label a non-SaaS database as a complete object-aware backup', () => {
    const other = createDatabase(); sql('CREATE TABLE unrelated (id text);', other);
    const path = join(root, 'non-saas.dump'); const result = exec('bash', [join(scripts, 'backup.sh'), '--output', path], { env: { ...env, DATABASE_URL: targetUrl(other) } });
    assert.equal(result.status, 1); assert(!existsSync(path)); assert(!existsSync(`${path}.manifest.json`));
  });

  test('dump and inventory retain the same snapshot while a separate writer changes the live row', () => {
    const actualDump = exec('which', ['pg_dump']).stdout.trim(); const actualPsql = exec('which', ['psql']).stdout.trim();
    const wrappers = join(root, 'wrappers'); mkdirSync(wrappers);
    writeFileSync(join(wrappers, 'pg_dump'), `#!/usr/bin/env bash\nset -euo pipefail\nif [ ! -f "$SAAS_TEST_CHANGED" ]; then\n  "$SAAS_TEST_PSQL" -X -q -v ON_ERROR_STOP=1 -c 'UPDATE "MediaObject" SET "storageKey"='"'"'public-media/post-snapshot'"'"' WHERE id='"'"'media-ready'"'"';'\n  touch "$SAAS_TEST_CHANGED"\nfi\nexec "$SAAS_TEST_REAL_DUMP" "$@"\n`, { mode: 0o700 });
    try {
      const f = backup('snapshot', { PG_BIN: wrappers, SAAS_TEST_PSQL: actualPsql, SAAS_TEST_REAL_DUMP: actualDump, SAAS_TEST_CHANGED: join(root, 'changed') });
      assert.equal(f.result.status, 0, f.result.stderr); assert.equal(sql(`SELECT "storageKey" FROM "MediaObject" WHERE id='media-ready';`), 'public-media/post-snapshot');
      const manifest = JSON.parse(readFileSync(f.manifestPath)); assert.deepEqual(manifest.objectReferences, expected);
      const target = restore(f); assert.equal(target.result.status, 0, target.result.stderr);
      assert.equal(sql(`SELECT "storageKey" FROM "MediaObject" WHERE id='media-ready';`, target.name), 'public-media/original');
    } finally { sql(`UPDATE "MediaObject" SET "storageKey"='public-media/original' WHERE id='media-ready';`); }
  });
});
