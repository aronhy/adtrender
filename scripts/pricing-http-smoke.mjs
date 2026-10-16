/** Bounded native Wasp query rehearsal. Synthetic catalog/config only.
 * SAAS_TEST_DATABASE_URL must identify a local SaaS test DB with CREATEDB rights.
 * A fresh random database and API ports are created; no existing data is changed.
 * Run after the normal Wasp build, never against a real provider or public API.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile), base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(base, 'apps/web/package.json'));
const { PrismaClient } = require('@prisma/client');
const suffix = randomUUID().replaceAll('-', ''), databaseName = `saas_pricing_http_test_${suffix}`;
const marker = 'PRICING_SMOKE_PROVIDER_REQUEST_BLOCKED';
const queryPath = '/operations/get-public-pricing';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let stage = 'CONFIGURATION', temporary, created = false, db, source, pgEnvironment, child;
const checks = [];
const diagnostic = {};

async function command(file, args, env) {
  return exec(file, args, { env, timeout: 45000, maxBuffer: 1024 * 1024 });
}
async function freePort() {
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}
async function stopApi() {
  if (!child || child.exitCode !== null || child.signalCode !== null) { child = undefined; return; }
  const current = child, exited = once(current, 'exit'); current.kill('SIGTERM');
  const force = setTimeout(() => current.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(force); child = undefined; }
}
async function runApi(enabled, verify) {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary, NODE_ENV: 'development', PORT: String(port),
    DATABASE_URL: source.href, WASP_WEB_CLIENT_URL: origin, WASP_SERVER_URL: origin,
    JWT_SECRET: 'pricing-http-synthetic-jwt-only', OUTBOX_ENCRYPTION_KEY: 'd'.repeat(64),
    SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_USERNAME: 'fixture', SMTP_PASSWORD: 'fixture',
    EMAIL_FROM: 'pricing@example.test', REGISTRATION_MODE: 'invite', GOOGLE_AUTH_ENABLED: 'false', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
    BILLING_ENABLED: enabled ? 'true' : 'false', LIVE_BILLING_ENABLED: enabled ? 'true' : 'false',
    ...(enabled ? { PUBLIC_PRICING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_live_synthetic_pricing_fixture_not_a_credential',
      STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_pricing_fixture_not_a_credential', STRIPE_REFUND_POLICY: 'RETAIN_PAID_PERIOD' } : {}),
  };
  // No outgoing HTTP, HTTPS, fetch or TLS is needed to read this database-only
  // query. Bind the unmodified native API listener to loopback in this process.
  const guard = `import http from 'node:http';import https from 'node:https';import tls from 'node:tls';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';
const deny=()=>{process.stderr.write('${marker}\\n');throw Error('${marker}')};
http.request=http.get=https.request=https.get=tls.connect=deny;globalThis.fetch=deny;
const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){if(typeof args[0]==='number'){if(typeof args[1]==='string')args[1]='127.0.0.1';else args.splice(1,0,'127.0.0.1')}else if(args[0]&&typeof args[0]==='object'&&'port'in args[0])args[0]={...args[0],host:'127.0.0.1'};return listen.apply(this,args)};syncBuiltinESMExports();`;
  child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(guard)}`, join(base, 'apps/web/.wasp/out/server/bundle/server.js')], { cwd: temporary, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let attemptedProviderRequest = false;
  const inspect = chunk => { if (chunk.toString().includes(marker)) attemptedProviderRequest = true; };
  child.stdout.on('data', inspect); child.stderr.on('data', inspect);
  child.on('exit', (code, signal) => { diagnostic.apiExitCode = code; diagnostic.apiExitSignal = signal; });
  // Discard native logs. A fixed boolean reports blocked attempts, never raw data.
  const request = async () => {
    const response = await fetch(origin + queryPath, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ json: {} }), signal: AbortSignal.timeout(5000) });
    diagnostic.queryStatus = response.status; assert.equal(response.status, 200);
    const envelope = await response.json();
    diagnostic.queryEnvelopePresent = Boolean(envelope && typeof envelope === 'object' && envelope.json && typeof envelope.json === 'object');
    assert(diagnostic.queryEnvelopePresent);
    return envelope.json;
  };
  try {
    let ready = false;
    for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i++) {
      try { const probe = await fetch(origin + '/auth/options', { signal: AbortSignal.timeout(500), redirect: 'error' }); diagnostic.readinessStatus = probe.status; if (probe.ok) { ready = true; break; } } catch {}
      await delay(100);
    }
    diagnostic.apiReady = ready; assert(ready);
    await verify(request);
    diagnostic.providerRequestAttempted = attemptedProviderRequest; assert.equal(attemptedProviderRequest, false);
  } finally { await stopApi(); }
}

let failed = false, cleanupFailed = false;
try {
  const input = new URL(process.env.SAAS_TEST_DATABASE_URL ?? 'http://invalid');
  assert(['postgres:', 'postgresql:'].includes(input.protocol));
  assert(['localhost', '127.0.0.1', '[::1]'].includes(input.hostname));
  assert(/^\/saas_[a-z0-9_]*test[a-z0-9_]*$/.test(input.pathname) && !input.search && !input.hash && input.username);
  const pgBin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@15/bin';
  pgEnvironment = { PATH: `${pgBin}:${process.env.PATH}`, PGHOST: input.hostname.replace(/^\[|\]$/g, ''), PGPORT: input.port || '5432', PGUSER: decodeURIComponent(input.username), PGPASSWORD: decodeURIComponent(input.password), PGDATABASE: 'postgres', PGCONNECT_TIMEOUT: '5', PGPASSFILE: '/dev/null' };
  temporary = await mkdtemp('/private/tmp/ds-meta-pricing-http-'); await chmod(temporary, 0o700);
  source = new URL(input); source.pathname = '/' + databaseName;
  stage = 'CREATE_ISOLATED_DATABASE';
  await command(join(pgBin, 'createdb'), ['--template=template0', databaseName], pgEnvironment); created = true;
  await command(join(pgBin, 'psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', `ALTER DATABASE "${databaseName}" SET timezone TO 'UTC';`], pgEnvironment);
  stage = 'MIGRATE_ISOLATED_DATABASE';
  await command(process.execPath, [join(base, 'apps/web/node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema=' + join(base, 'apps/web/.wasp/out/db/schema.prisma')], { ...pgEnvironment, HOME: temporary, DATABASE_URL: source.href });
  db = new PrismaClient({ datasources: { db: { url: source.href } } });
  stage = 'SEED_SYNTHETIC_CATALOG';
  const liveId = randomUUID();
  const plan = { key: `pricing-http-${suffix}`, version: 1, name: 'Synthetic public pricing rehearsal', status: 'ACTIVE', currency: 'usd', priceMinor: 1299, billingInterval: 'MONTH', trialDays: 0, workspaceLimit: 2, memberLimit: 3, savedAdLimit: 40, monthlyAnalysisLimit: 12, providerPriceId: 'price_private_fixture_' + suffix, verifiedProviderMode: 'LIVE', publicConfirmedAt: new Date() };
  await db.planVersion.createMany({ data: [
    { ...plan, id: liveId },
    { ...plan, id: randomUUID(), key: plan.key + '-unconfirmed', name: 'must-hide-unconfirmed', publicConfirmedAt: null },
    { ...plan, id: randomUUID(), key: plan.key + '-legacy', name: 'must-hide-legacy', publicConfirmedAt: null, verifiedProviderMode: null },
    { ...plan, id: randomUUID(), key: plan.key + '-test', name: 'must-hide-test', publicConfirmedAt: null, verifiedProviderMode: 'TEST' },
    { ...plan, id: randomUUID(), key: plan.key + '-draft', name: 'must-hide-draft', status: 'DRAFT' },
    { ...plan, id: randomUUID(), key: plan.key + '-retired', name: 'must-hide-retired', status: 'RETIRED' },
  ] });
  stage = 'DEFAULT_UNPUBLISHED';
  await runApi(false, async request => {
    const result = await request(); assert.equal(result.status, 'UNPUBLISHED'); assert.deepEqual(result.plans, []);
    assert.deepEqual(Object.keys(result).sort(), ['message', 'plans', 'status']); checks.push('anonymous_default_unpublished');
  });
  stage = 'EXPLICIT_LIVE_CATALOG';
  await runApi(true, async request => {
    const result = await request(); assert.equal(result.status, 'PUBLISHED');
    assert.deepEqual(Object.keys(result).sort(), ['message', 'plans', 'status']);
    assert.deepEqual(result.plans, [{ id: liveId, name: plan.name, priceMinor: 1299, currency: 'usd', interval: 'MONTH', workspaceLimit: 2, memberLimit: 3, savedAdLimit: 40, monthlyAnalysisLimit: 12 }]);
    assert(!JSON.stringify(result).includes('must-hide-')); assert(!JSON.stringify(result).includes('price_private_fixture_'));
    checks.push('anonymous_explicit_live_only', 'public_dto_whitelist', 'unconfirmed_legacy_test_draft_retired_hidden');
    stage = 'WITHDRAW_PUBLIC_CONFIRMATION';
    await db.planVersion.update({ where: { id: liveId }, data: { publicConfirmedAt: null } });
    const withdrawn = await request(); assert.equal(withdrawn.status, 'UNPUBLISHED'); assert.deepEqual(withdrawn.plans, []);
    checks.push('withdrawal_visible_on_same_native_route', 'no_provider_requests');
  });
} catch { failed = true; }
finally {
  try { await stopApi(); await db?.$disconnect(); } catch { cleanupFailed = true; }
  if (created) try { await command(join(process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@15/bin', 'dropdb'), ['--force', databaseName], pgEnvironment); } catch { cleanupFailed = true; }
  if (temporary) try { await rm(temporary, { recursive: true, force: true }); } catch { cleanupFailed = true; }
}
console.log(JSON.stringify({ status: failed || cleanupFailed ? 'PRICING_HTTP_SMOKE_FAILED' : 'PRICING_HTTP_SMOKE_VERIFIED', ...(failed ? { failedStage: stage, diagnostic } : {}), nativeRoute: queryPath, anonymous: true, syntheticOnly: true, checks, cleanupVerified: !cleanupFailed }));
if (failed || cleanupFailed) process.exitCode = 1;
