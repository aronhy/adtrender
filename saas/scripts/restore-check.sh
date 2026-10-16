#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)
saas_dir=$(cd "$script_dir/.." && pwd)
export PATH="$saas_dir/toolchain/node_modules/.bin:${PG_BIN:+$PG_BIN:}$PATH"
exec node --input-type=module - "$script_dir/object-references.sql" "$@" <<'NODE'
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const [objectReferencesPath, ...args] = process.argv.slice(2); const fail = message => { throw new Error(message); };
let temporaryReport;
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: [PGPASSWORD=...] [PG_BIN=...] restore-check.sh --backup PATH --target-url postgresql://USER@127.0.0.1:PORT/saas_restore_NAME [--report PATH]\nOnly a new local test/restore database may be created. Repeating an already verified restore only compares its contents; no existing database is overwritten.'); process.exit(0);
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = async path => { const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest('hex'); };
const quote = value => `'${value.replaceAll("'", "''")}'`;
const identifier = value => `"${value.replaceAll('"', '""')}"`;
const local = host => ['127.0.0.1', 'localhost', '::1'].includes(host.toLowerCase());
const normalizedHost = host => local(host) ? 'loopback' : host.toLowerCase();
const normalizeSchema = sql => sql.split('\n').filter(line => !line.startsWith('--') && !/^\\(?:un)?restrict\b/.test(line)).join('\n').trim();
function command(bin, arguments_, env) {
  const result = spawnSync(bin, arguments_, { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`${bin} failed. Output withheld; the isolated restore database is retained for inspection and is never automatically dropped.`);
  return result.stdout.trim();
}
const countSql = `SELECT format('SELECT json_build_object(''table'', %L, ''rows'', count(*)::text) FROM %I.%I;', schemaname || '.' || tablename, schemaname, tablename)
FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname NOT LIKE 'pg_toast%' ORDER BY schemaname, tablename
\\gexec`;
try {
  process.umask(0o077); const options = new Map();
  for (let i = 0; i < args.length; i += 2) { if (!['--backup', '--target-url', '--report'].includes(args[i]) || !args[i + 1] || options.has(args[i])) fail('Invalid or duplicate arguments. See --help.'); options.set(args[i], args[i + 1]); }
  if (!options.get('--backup') || !options.get('--target-url')) fail('Explicit --backup and --target-url are required.');
  let target; try { target = new URL(options.get('--target-url')); } catch { fail('Invalid target URL.'); }
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.password || target.search || target.hash) fail('Target must be a plain PostgreSQL URL without password or URL options. Use PGPASSWORD for a password.');
  const host = target.hostname.replace(/^\[|\]$/g, ''); const port = target.port || '5432'; const database = decodeURIComponent(target.pathname.slice(1));
  if (!local(host) || !/(^|[_-])(test|restore)([_-]|$)/i.test(database) || !/^[a-z_][a-z0-9_-]{0,62}$/i.test(database)) fail('Restore target must be local and its database name must contain a test or restore segment.');
  const backup = resolve(options.get('--backup')); const manifest = JSON.parse(readFileSync(`${backup}.manifest.json`, 'utf8'));
  if (manifest.formatVersion !== 1 || !Array.isArray(manifest.tableCounts) || typeof manifest.schemaSha256 !== 'string' || !manifest.source) fail('Unsupported or invalid backup manifest.');
  const hasObjectReferences = Object.hasOwn(manifest, 'objectReferencesVersion') || Object.hasOwn(manifest, 'objectReferences');
  if (hasObjectReferences && (manifest.objectReferencesVersion !== 1 || !Array.isArray(manifest.objectReferences))) fail('Unsupported or incomplete object references manifest.');
  const objectReferencesSql = hasObjectReferences ? readFileSync(objectReferencesPath, 'utf8') : undefined;
  if (await hashFile(backup) !== manifest.sha256) fail('Backup SHA-256 does not match its manifest. Restore was not started.');
  if (normalizedHost(host) === normalizedHost(manifest.source.host) && port === String(manifest.source.port) && database === manifest.source.database) fail('Restore target must differ from the source database.');
  const identity = { host, port, database }; const targetKey = hash(JSON.stringify({ ...identity, host: normalizedHost(host) }));
  const reportPath = resolve(options.get('--report') || `${backup}.restore-${targetKey.slice(0, 12)}.json`);
  const env = { ...process.env, PGHOST: host, PGPORT: port, PGDATABASE: database, PGUSER: decodeURIComponent(target.username) || process.env.PGUSER || '', PGPASSWORD: process.env.PGPASSWORD || '', PGCONNECT_TIMEOUT: '10', PGAPPNAME: 'saas-restore-check' };
  const sql = (query, connectionEnv = env) => command('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', query], connectionEnv);
  const adminEnv = { ...env, PGDATABASE: 'postgres' };
  const alreadyExists = sql(`SELECT 1 FROM pg_database WHERE datname = ${quote(database)};`, adminEnv) === '1';
  if (alreadyExists) {
    if (!existsSync(reportPath)) fail('Target database already exists without this restore report. Choose a new isolated target; no data was changed.');
    const previous = JSON.parse(readFileSync(reportPath, 'utf8'));
    if (previous.status !== 'RESTORE_VERIFIED' || previous.backupSha256 !== manifest.sha256 || previous.targetKey !== targetKey) fail('Existing database is not the recorded restore of this backup. No data was changed.');
  } else {
    if (existsSync(reportPath)) fail('Report path already exists; use a fresh report path for a new database.');
    sql(`CREATE DATABASE ${identifier(database)} TEMPLATE template0;`, adminEnv);
    command('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', '--dbname', database, backup], env);
  }
  const countResult = spawnSync('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { input: `${countSql}\n`, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (countResult.error || countResult.status !== 0) fail('Could not verify restored row counts.');
  const tableCounts = countResult.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (JSON.stringify(tableCounts) !== JSON.stringify(manifest.tableCounts)) fail('Restored table counts do not match the backup snapshot.');
  const schemaSha256 = hash(normalizeSchema(command('pg_dump', ['--schema-only', '--no-owner', '--no-privileges'], env)));
  if (schemaSha256 !== manifest.schemaSha256) fail('Restored schema does not match the backup snapshot.');
  if (sql("SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND NOT convalidated;") !== '0') fail('Restored database contains unvalidated foreign keys.');
  let objectProof = {};
  if (hasObjectReferences) {
    const objectReferences = JSON.parse(sql(objectReferencesSql));
    if (!isDeepStrictEqual(objectReferences, manifest.objectReferences)) fail('Restored object references do not match the backup snapshot.');
    objectProof = { objectReferencesVerified: true, objectReferencesVersion: 1, objectReferencesSha256: hash(JSON.stringify(objectReferences)) };
  }
  const report = { status: 'RESTORE_VERIFIED', verifiedAt: new Date().toISOString(), backupSha256: manifest.sha256, target: identity, targetKey, schemaSha256, tableCounts, foreignKeysValidated: true, ...objectProof };
  if (alreadyExists) {
    // The earlier report establishes target ownership, not current proof. Refresh
    // only after all reads pass so legacy rechecks cannot retain stale object proof.
    temporaryReport = `${reportPath}.partial-${randomUUID()}`;
    writeFileSync(temporaryReport, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporaryReport, reportPath); temporaryReport = undefined;
  } else writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: alreadyExists ? 'REPLAY_VERIFIED_NO_WRITE' : 'RESTORE_VERIFIED', report: reportPath, tables: tableCounts.length, backupSha256: manifest.sha256 }));
} catch (error) { if (temporaryReport && existsSync(temporaryReport)) unlinkSync(temporaryReport); console.error(error instanceof Error ? error.message : 'Restore check failed.'); process.exitCode = 1; }
NODE
