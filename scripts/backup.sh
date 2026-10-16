#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)
repo_dir=$(cd "$script_dir/.." && pwd)
export PATH="$repo_dir/toolchain/node_modules/.bin:${PG_BIN:+$PG_BIN:}$PATH"
exec node --input-type=module - "$script_dir/object-references.sql" "$@" <<'NODE'
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, chmodSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const fail = message => { throw new Error(message); };
const [objectReferencesPath, ...args] = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: DATABASE_URL=... [PG_BIN=...] backup.sh --output /absolute/path/backup.dump\nPasswords belong in DATABASE_URL or PGPASSWORD environment variables. Existing files are never replaced.');
  process.exit(0);
}
let temporary; let published = false; let finalPath; let session;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = async path => { const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk); return digest.digest('hex'); };
function connection(value) {
  let url; try { url = new URL(value); } catch { fail('DATABASE_URL is required and must be a valid PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash) fail('Invalid PostgreSQL connection URL.');
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!database || database.includes('/')) fail('A database name is required.');
  const allowed = new Set(['sslmode', 'connect_timeout', 'application_name']);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) fail('Unsupported database URL option.');
  const host = url.hostname.replace(/^\[|\]$/g, ''); const port = url.port || '5432';
  return { identity: { host, port, database }, env: { ...process.env, PGHOST: host, PGPORT: port, PGDATABASE: database,
    PGUSER: decodeURIComponent(url.username) || process.env.PGUSER || '', PGPASSWORD: decodeURIComponent(url.password) || process.env.PGPASSWORD || '',
    PGCONNECT_TIMEOUT: url.searchParams.get('connect_timeout') || '10', PGSSLMODE: url.searchParams.get('sslmode') || process.env.PGSSLMODE || 'prefer', PGAPPNAME: 'saas-backup' } };
}
function command(bin, arguments_, env) {
  const result = spawnSync(bin, arguments_, { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`${bin} failed. Provider output was withheld; check local database access and PostgreSQL tool versions.`);
  return result.stdout;
}
function openSnapshot(env) {
  const child = spawn('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; let pending; let terminalError;
  const reject = () => { terminalError = new Error('Could not retain a consistent database snapshot.'); if (pending) { pending.reject(terminalError); pending = undefined; } };
  child.on('error', reject); child.on('exit', code => { if (code !== 0 || pending) reject(); });
  child.stderr.on('data', () => {});
  child.stdout.on('data', chunk => { buffer += chunk.toString(); if (pending) { const index = buffer.indexOf(`${pending.marker}\n`); if (index >= 0) { const value = buffer.slice(0, index); buffer = buffer.slice(index + pending.marker.length + 1); const active = pending; pending = undefined; active.resolve(value.trim()); } } });
  return { ask(sql) { if (terminalError) return Promise.reject(terminalError); return new Promise((resolve, reject) => { if (pending) return reject(new Error('Concurrent snapshot command rejected.')); const marker = `saas_${randomUUID().replaceAll('-', '')}`; pending = { marker, resolve, reject }; child.stdin.write(`${sql}\n\\echo ${marker}\n`); }); }, close() { child.stdin.end(); }, abort() { child.kill(); } };
}
const countSql = `SELECT format('SELECT json_build_object(''table'', %L, ''rows'', count(*)::text) FROM %I.%I;', schemaname || '.' || tablename, schemaname, tablename)
FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND schemaname NOT LIKE 'pg_toast%' ORDER BY schemaname, tablename
\\gexec`;
const normalizeSchema = sql => sql.split('\n').filter(line => !line.startsWith('--') && !/^\\(?:un)?restrict\b/.test(line)).join('\n').trim();
try {
  if (args.length !== 2 || args[0] !== '--output' || !args[1]) fail('Supply exactly --output PATH. See --help.');
  process.umask(0o077); finalPath = resolve(args[1]); const manifestPath = `${finalPath}.manifest.json`;
  if (existsSync(finalPath) || existsSync(manifestPath)) fail('Output already exists; choose a new backup path.');
  const source = connection(process.env.DATABASE_URL);
  const objectReferencesSql = readFileSync(objectReferencesPath, 'utf8');
  mkdirSync(dirname(finalPath), { recursive: true, mode: 0o700 }); temporary = `${finalPath}.partial-${randomUUID()}`;
  session = openSnapshot(source.env);
  const snapshot = await session.ask('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();');
  if (!/^[0-9A-F]+-[0-9A-F]+-\d+$/i.test(snapshot)) fail('Invalid exported snapshot.');
  const tableCounts = (await session.ask(countSql)).split('\n').filter(Boolean).map(line => JSON.parse(line));
  // Use the retained transaction itself, not a fresh connection after the dump.
  // Missing SaaS tables/columns must fail this backup, not publish an empty list.
  const objectReferences = JSON.parse(await session.ask(objectReferencesSql));
  const schema = command('pg_dump', ['--schema-only', '--no-owner', '--no-privileges', `--snapshot=${snapshot}`], source.env);
  command('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--snapshot=${snapshot}`, '--file', temporary], source.env);
  await session.ask('COMMIT;'); session.close(); session = undefined;
  chmodSync(temporary, 0o600);
  command('pg_restore', ['--list', temporary], source.env);
  const manifest = { formatVersion: 1, createdAt: new Date().toISOString(), format: 'PostgreSQL custom', source: source.identity,
    sha256: await hashFile(temporary), sizeBytes: statSync(temporary).size, schemaSha256: hash(normalizeSchema(schema)), tableCounts,
    objectReferencesVersion: 1, objectReferences };
  linkSync(temporary, finalPath); published = true; unlinkSync(temporary); temporary = undefined;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: 'BACKUP_VERIFIED', backup: finalPath, manifest: manifestPath, sha256: manifest.sha256, tables: tableCounts.length }));
} catch (error) {
  session?.abort(); if (temporary && existsSync(temporary)) unlinkSync(temporary);
  if (published && finalPath && existsSync(finalPath)) unlinkSync(finalPath);
  console.error(error instanceof Error ? error.message : 'Backup failed.'); process.exitCode = 1;
}
NODE
