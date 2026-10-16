import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Environment = Record<string, string | undefined>;
export type NativeIngestSetupOptions = { input: string; stdio: ['pipe', 'pipe', 'pipe']; env: Record<string, string> };
export type NativeIngestSetupIO = { read: (path: string) => string; execute: (binary: string, args: string[], options: NativeIngestSetupOptions) => unknown };
export const nativeIngestSqlPaths = ['meta', 'google', 'snapchat', 'tiktok', 'pinterest'].map(source =>
  fileURLToPath(new URL(`../apps/collector/deploy/${source}/ingest.sql`, import.meta.url)));

function ownedDatabase(env: Environment): URL | null {
  const value = env.SAAS_TEST_DATABASE_URL;
  if (!value) return null;
  try {
    if (value !== env.SAAS_OWNED_TEST_DATABASE_URL) throw new Error();
    const url = new URL(value);
    const name = decodeURIComponent(url.pathname.slice(1));
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !/^[A-Za-z0-9_]+$/.test(name) || !name.includes('_test_') || url.hash ||
      [...url.searchParams.keys()].some(key => !['schema', 'connection_limit', 'pool_timeout', 'sslmode', 'sslaccept', 'connect_timeout'].includes(key))) throw new Error();
    if (decodeURIComponent(url.password).includes('\0')) throw new Error();
    // Prisma's connection options do not belong in libpq, and may not override
    // the guarded host, database or explicitly supplied identity.
    url.search = '';
    return url;
  } catch {
    throw new Error('OWNED_LOCAL_SAAS_TEST_DATABASE_REQUIRED');
  }
}

/** Safe argv representation. A supplied test password is passed only in the
 * child environment by the installer, never in a command or diagnostic. */
export function ownedNativeIngestDatabase(env: Environment): string | null {
  const url = ownedDatabase(env);
  if (!url) return null;
  url.password = '';
  return url.toString();
}

const defaultIO: NativeIngestSetupIO = {
  read: path => readFileSync(path, 'utf8'),
  execute: (binary, args, options) => execFileSync(binary, args, options),
};

/** SaaS migrations dispatch to these native functions, but do not install them.
 * Initialize the explicitly owned test database before any suite is scheduled. */
export function installNativeTestIngest(env: Environment, io: NativeIngestSetupIO = defaultIO): { skipped: boolean } {
  const database = ownedDatabase(env);
  if (!database) return { skipped: true };
  const password = decodeURIComponent(database.password);
  database.password = '';
  const childEnv: Record<string, string> = {
    PATH: env.PATH || '/usr/bin:/bin', PGPASSFILE: '/dev/null', PGCONNECT_TIMEOUT: '10', PGAPPNAME: 'adthrender-native-test-ingest',
    ...(password ? { PGPASSWORD: password } : {}),
  };
  try {
    // Match the existing native service fixture: keep SQL unchanged except
    // grants to deployment roles that are intentionally absent in local tests.
    const input = nativeIngestSqlPaths.map(path => io.read(path).replace(/^GRANT\b[^\r\n]*(?:\r?\n|$)/gmi, '')).join('\n');
    io.execute(env.PG_BIN ? join(env.PG_BIN, 'psql') : 'psql', [database.toString(), '-X', '-v', 'ON_ERROR_STOP=1'], { input, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
    return { skipped: false };
  } catch {
    // Child-process errors include argv and stderr; neither is a safe report.
    throw new Error('NATIVE_TEST_INGEST_SETUP_FAILED');
  }
}

export default function nativeTestIngestGlobalSetup() {
  if (!installNativeTestIngest(process.env).skipped) console.info('Native ingest initialized for the explicitly owned local SaaS test database.');
}
