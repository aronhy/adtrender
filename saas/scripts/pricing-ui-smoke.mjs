/** Real generated Wasp UI + native query, synthetic local PostgreSQL only.
 * Run from the repository root after the standard build. No provider calls.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, chmod, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const base = resolve('saas'), exec = promisify(execFile), require = createRequire(join(base, 'app/package.json'));
const { PrismaClient } = require('@prisma/client'), { chromium } = require('playwright');
const suffix = randomUUID().replaceAll('-', ''), databaseName = `saas_pricing_ui_test_${suffix}`;
const queryPath = '/operations/get-public-pricing', marker = 'PRICING_UI_PROVIDER_REQUEST_BLOCKED';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const artifacts = resolve('saas/.artifacts', `pricing-ui-${suffix}`);
const children = [], checks = [], nativeResponses = [], pendingResponses = [];
let temporary, pgEnv, db, browser, created = false, failed = false, cleanupFailed = false, stage = 'CONFIGURATION';
let providerRequestAttempted = false, blockedBrowserRequests = 0, apiOrigin, uiOrigin;
const diagnostic = {};
const command = (file, args, env) => exec(file, args, { env, timeout: 45000, maxBuffer: 1024 * 1024 });
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await exit; } finally { clearTimeout(timer); }
}
function launch(args, cwd, env) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { if (chunk.toString().includes(marker)) providerRequestAttempted = true; });
  return child;
}
async function ready(origin, path, child) {
  for (let i = 0; i < 150 && child.exitCode === null && child.signalCode === null; i++) {
    try { if ((await fetch(origin + path, { signal: AbortSignal.timeout(500), redirect: 'error' })).ok) return; } catch {}
    await delay(100);
  }
  diagnostic.childExitCode = child.exitCode; throw Error('LOCAL_SERVER_NOT_READY');
}

try {
  const input = new URL(process.env.SAAS_TEST_DATABASE_URL ?? 'http://invalid');
  assert(['postgres:', 'postgresql:'].includes(input.protocol));
  assert(['localhost', '127.0.0.1', '[::1]'].includes(input.hostname));
  assert(/^\/saas_[a-z0-9_]*test[a-z0-9_]*$/.test(input.pathname) && !input.search && !input.hash && input.username);
  const pgBin = process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@15/bin';
  pgEnv = { PATH: `${pgBin}:${process.env.PATH}`, PGHOST: input.hostname.replace(/^\[|\]$/g, ''), PGPORT: input.port || '5432', PGUSER: decodeURIComponent(input.username), PGPASSWORD: decodeURIComponent(input.password), PGDATABASE: 'postgres', PGCONNECT_TIMEOUT: '5', PGPASSFILE: '/dev/null' };
  temporary = await mkdtemp('/private/tmp/ds-meta-pricing-ui-'); await chmod(temporary, 0o700);
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const source = new URL(input); source.pathname = '/' + databaseName;
  stage = 'CREATE_ISOLATED_DATABASE';
  await command(join(pgBin, 'createdb'), ['--template=template0', databaseName], pgEnv); created = true;
  await command(join(pgBin, 'psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', `ALTER DATABASE "${databaseName}" SET timezone TO 'UTC';`], pgEnv);
  stage = 'MIGRATE_ISOLATED_DATABASE';
  await command(process.execPath, [join(base, 'app/node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema=' + join(base, 'app/.wasp/out/db/schema.prisma')], { ...pgEnv, HOME: temporary, DATABASE_URL: source.href });
  db = new PrismaClient({ datasources: { db: { url: source.href } } });
  const liveId = randomUUID(), confirmedAt = new Date();
  const plan = { id: liveId, key: `pricing-ui-${suffix}`, version: 1, name: '合成验收套餐', status: 'ACTIVE', currency: 'usd', priceMinor: 1299, billingInterval: 'MONTH', trialDays: 0, workspaceLimit: 2, memberLimit: 3, savedAdLimit: 40, monthlyAnalysisLimit: 12, providerPriceId: 'price_private_fixture_' + suffix, verifiedProviderMode: 'LIVE', publicConfirmedAt: confirmedAt };
  await db.planVersion.createMany({ data: [plan, { ...plan, id: randomUUID(), key: plan.key + '-hidden', name: 'must-hide-test-plan', verifiedProviderMode: 'TEST', publicConfirmedAt: null }] });
  const apiPort = await freePort(), uiPort = await freePort(); apiOrigin = `http://127.0.0.1:${apiPort}`; uiOrigin = `http://127.0.0.1:${uiPort}`;
  const common = { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary, NODE_ENV: 'development', WASP_WEB_CLIENT_URL: uiOrigin, WASP_SERVER_URL: apiOrigin, REACT_APP_API_URL: apiOrigin };
  const env = { ...common, PORT: String(apiPort), DATABASE_URL: source.href, JWT_SECRET: 'pricing-ui-synthetic-jwt-only', OUTBOX_ENCRYPTION_KEY: 'e'.repeat(64), SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_USERNAME: 'fixture', SMTP_PASSWORD: 'fixture', EMAIL_FROM: 'pricing@example.test', REGISTRATION_MODE: 'invite', GOOGLE_AUTH_ENABLED: 'false', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', BILLING_ENABLED: 'true', LIVE_BILLING_ENABLED: 'true', PUBLIC_PRICING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_live_synthetic_pricing_fixture_not_a_credential', STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_pricing_fixture_not_a_credential', STRIPE_REFUND_POLICY: 'RETAIN_PAID_PERIOD' };
  const guard = `import http from 'node:http';import https from 'node:https';import tls from 'node:tls';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';const deny=()=>{process.stderr.write('${marker}\\n');throw Error('${marker}')};http.request=http.get=https.request=https.get=tls.connect=deny;globalThis.fetch=deny;const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){if(typeof args[0]==='number'){if(typeof args[1]==='string')args[1]='127.0.0.1';else args.splice(1,0,'127.0.0.1')}else if(args[0]&&typeof args[0]==='object'&&'port'in args[0])args[0]={...args[0],host:'127.0.0.1'};return listen.apply(this,args)};syncBuiltinESMExports();`;
  stage = 'START_NATIVE_API';
  const api = launch(['--import', `data:text/javascript,${encodeURIComponent(guard)}`, join(base, 'app/.wasp/out/server/bundle/server.js')], temporary, env);
  await ready(apiOrigin, '/auth/options', api);
  stage = 'START_REAL_VITE';
  const vite = launch([join(base, 'app/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], join(base, 'app'), common);
  await ready(uiOrigin, '/pricing', vite);
  stage = 'START_FRESH_CHROME';
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, env: { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary }, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, locale: 'zh-CN', serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if ([apiOrigin, uiOrigin].includes(url.origin)) return route.continue();
      blockedBrowserRequests++; return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    let state = 'PUBLISHED';
    page.on('response', response => {
      if (new URL(response.url()).origin !== apiOrigin || new URL(response.url()).pathname !== queryPath) return;
      const observedState = state;
      pendingResponses.push((async () => {
        let body; try { body = await response.json(); } catch {}
        const data = body?.json;
        nativeResponses.push({ state: observedState, viewport: viewport.width, httpStatus: response.status(), ...(data?.status ? { status: data.status, planCount: data.plans?.length } : {}) });
        if (response.ok()) { assert(data && ['PUBLISHED', 'UNPUBLISHED'].includes(data.status)); assert(!JSON.stringify(data).includes('price_private_fixture_')); assert(!JSON.stringify(data).includes('must-hide-test-plan')); }
      })());
    });
    for (state of ['PUBLISHED', 'UNPUBLISHED', 'ERROR']) {
      stage = `${state}_${viewport.width}`;
      await db.planVersion.update({ where: { id: liveId }, data: { currency: state === 'ERROR' ? 'USD' : 'usd', publicConfirmedAt: state === 'UNPUBLISHED' ? null : confirmedAt } });
      await page.goto(uiOrigin + '/pricing', { waitUntil: 'domcontentloaded', timeout: 20000 });
      const expected = state === 'PUBLISHED' ? plan.name : state === 'UNPUBLISHED' ? '正式价格及套餐待公布' : '暂时无法读取套餐';
      await page.getByRole('heading', { name: expected, exact: true }).waitFor({ state: 'visible', timeout: 20000 });
      const text = await page.locator('main').innerText();
      assert(!text.includes('must-hide-test-plan') && !text.includes('price_private_fixture_'));
      if (state === 'PUBLISHED') {
        for (const value of ['12.99', '2 个工作区', '3 个成员席位', '40 条收藏', '12 次分析 / 月']) assert(text.includes(value));
        assert.equal(await page.getByRole('link', { name: '选择此套餐', exact: true }).getAttribute('href'), `/app/settings?plan=${liveId}#billing`);
        assert.equal(await page.locator('.pricing-option').count(), 1);
      } else assert.equal(await page.locator('.pricing-option').count(), 0);
      const geometry = await page.evaluate(() => ({ viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth }));
      assert(geometry.pageWidth <= geometry.viewportWidth);
      const screenshot = `${state.toLowerCase()}-${viewport.width}x${viewport.height}.png`;
      await page.screenshot({ path: join(artifacts, screenshot), fullPage: true });
      await chmod(join(artifacts, screenshot), 0o600);
      checks.push({ state, viewport, horizontalOverflow: false, screenshot, screenshotSha256: createHash('sha256').update(await readFile(join(artifacts, screenshot))).digest('hex') });
    }
    stage = `RETRY_RECOVERY_${viewport.width}`;
    state = 'RECOVERED';
    await db.planVersion.update({ where: { id: liveId }, data: { currency: 'usd' } });
    await page.getByRole('button', { name: '重新读取', exact: true }).click();
    await page.getByRole('heading', { name: plan.name, exact: true }).waitFor({ state: 'visible', timeout: 15000 });
    checks.push({ state: 'RECOVERED', viewport, retryButtonVerified: true });
    await context.close();
  }
  await Promise.all(pendingResponses);
  stage = 'VERIFY_NATIVE_RESPONSES';
  for (const width of [1280, 390]) {
    for (const state of ['PUBLISHED', 'UNPUBLISHED', 'RECOVERED']) assert(nativeResponses.some(row => row.viewport === width && row.state === state && row.httpStatus === 200 && row.status === (state === 'UNPUBLISHED' ? 'UNPUBLISHED' : 'PUBLISHED')));
    assert(nativeResponses.some(row => row.viewport === width && row.state === 'ERROR' && row.httpStatus === 503));
  }
  assert.equal(providerRequestAttempted, false);
} catch (error) { failed = true; diagnostic.errorType = error?.name ?? 'Error'; }
finally {
  try { await browser?.close(); } catch { cleanupFailed = true; }
  for (const child of children.reverse()) try { await stop(child); } catch { cleanupFailed = true; }
  try { await db?.$disconnect(); } catch { cleanupFailed = true; }
  if (created) try { await command(join(process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@15/bin', 'dropdb'), ['--force', databaseName], pgEnv); } catch { cleanupFailed = true; }
  if (temporary) try { await rm(temporary, { recursive: true, force: true }); } catch { cleanupFailed = true; }
}
const report = { status: failed || cleanupFailed ? 'PRICING_UI_SMOKE_FAILED' : 'PRICING_UI_SMOKE_VERIFIED', ...(failed ? { failedStage: stage, diagnostic } : {}), nativeRoute: queryPath, syntheticOnly: true, anonymous: true, browser: 'Google Chrome headless; fresh isolated profile; sandbox enabled', queryMocked: false, errorFixture: 'synthetic published catalog has invalid currency casing; native API returns 503', externalServicesUsed: false, blockedBrowserRequests, providerRequestAttempted, checks, nativeResponses, cleanupVerified: !cleanupFailed, artifacts };
await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report));
if (failed || cleanupFailed) process.exitCode = 1;
