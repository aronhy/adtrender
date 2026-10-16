import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Only explicit loopback test databases are accepted; the test creates its own random databases.
const databaseUrl = process.env.SAAS_BACKUP_TEST_DATABASE_URL;
assert(databaseUrl, 'Set SAAS_BACKUP_TEST_DATABASE_URL to an isolated local test database');
const database = new URL(databaseUrl);
assert(['postgres:', 'postgresql:'].includes(database.protocol));
assert(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
assert(/(?:^|[_-])(?:test|restore)(?:[_-]|$)/i.test(database.pathname.slice(1)));
assert(!database.search && !database.hash);
const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'adtrender-garage-test-'));
const envFile = join(temporary, 'garage.env');
const hex = size => randomBytes(size).toString('hex');
const secrets = { SOURCE_ACCESS_KEY: `GK${hex(12)}`, SOURCE_SECRET_KEY: hex(32), SOURCE_RPC_SECRET: hex(32),
  TARGET_ACCESS_KEY: `GK${hex(12)}`, TARGET_SECRET_KEY: hex(32), TARGET_RPC_SECRET: hex(32) };
const reader = { accessKeyId: `GK${hex(12)}`, secretAccessKey: hex(32) };
if (process.env.GITHUB_ACTIONS === 'true') for (const value of [...Object.values(secrets), ...Object.values(reader)]) console.log(`::add-mask::${value}`);
await writeFile(envFile, Object.entries(secrets).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
const project = `adtrender-backup-test-${randomUUID()}`;
console.log(`GARAGE_REHEARSAL project=${project}`);
const compose = ['compose', '--project-name', project, '--env-file', envFile, '-f', join(root, 'deploy/backup/compose.yaml')];
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'PG_BIN', 'CI'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
const exec = promisify(execFile);
let stage = 'start';
async function docker(args, timeout = 30000) {
  try { return (await exec('docker', [...compose, ...args], { env, timeout, maxBuffer: 4 * 1024 ** 2 })).stdout.trim(); }
  catch { throw new Error(`GARAGE_REHEARSAL_FAILED_${stage}`); }
}
async function endpoint(service) {
  const address = await docker(['port', service, '3900']);
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  return `http://${address}`;
}
try {
  await docker(['up', '-d', '--wait', '--wait-timeout', '120'], 180000);
  stage = 'source-read-only-key';
  // Fixture writes use the bootstrap key; the actual backup CLI gets only this read-only key.
  await docker(['exec', '-T', 'source', '/garage', 'key', 'import', '--yes', reader.accessKeyId, reader.secretAccessKey]);
  await docker(['exec', '-T', 'source', '/garage', 'bucket', 'allow', '--read', '--key', reader.accessKeyId, 'adtrender-test-source']);
  const config = {
    source: { endpoint: await endpoint('source'), bucket: 'adtrender-test-source', credentials: { accessKeyId: secrets.SOURCE_ACCESS_KEY, secretAccessKey: secrets.SOURCE_SECRET_KEY } },
    reader,
    target: { endpoint: await endpoint('target'), bucket: 'adtrender-restore-test', credentials: { accessKeyId: secrets.TARGET_ACCESS_KEY, secretAccessKey: secrets.TARGET_SECRET_KEY } },
  };
  stage = 'joint-restore';
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', join(root, 'deploy/garage-joint-backup.integration.test.mjs')], {
      cwd: root, stdio: 'inherit', env: { ...env, SAAS_BACKUP_TEST_DATABASE_URL: databaseUrl, SAAS_GARAGE_TEST_CONFIG: JSON.stringify(config) },
      timeout: 240000,
    });
    child.on('error', reject); child.on('close', (code, signal) => resolve(signal ? 1 : code));
  });
  assert.equal(code, 0, 'Garage joint restore tests failed');
} catch (error) {
  console.error(`GARAGE_REHEARSAL_FAILED stage=${stage} kind=${error.name}`);
  process.exitCode = 1;
} finally {
  stage = 'cleanup';
  try {
    await docker(['down', '--volumes', '--remove-orphans'], 60000);
    await rm(temporary, { recursive: true, force: true });
  } catch {
    console.error(`GARAGE_REHEARSAL_CLEANUP_FAILED project=${project} envFile=${envFile}`);
    process.exitCode = 1;
  }
}
