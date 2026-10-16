/** Customer quota / own-support UI rehearsal, synthetic local PostgreSQL only.
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
const serverRequire = createRequire(join(base, 'app/.wasp/out/server/package.json'));
const { hashPassword } = await import(serverRequire.resolve('@wasp.sh/lib-auth/node'));
const suffix = randomUUID().replaceAll('-', ''), databaseName = `saas_customer_support_ui_test_${suffix}`;
const queryPaths = ['/operations/get-app-state', '/operations/get-admin-page'], marker = 'CUSTOMER_SUPPORT_UI_PROVIDER_REQUEST_BLOCKED';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const artifacts = resolve('saas/.artifacts', `customer-support-ui-${suffix}`);
const children = [], checks = [], nativeResponses = [], pendingResponses = [];
let temporary, pgEnv, db, browser, created = false, failed = false, cleanupFailed = false, stage = 'CONFIGURATION';
let providerRequestAttempted = false, blockedBrowserRequests = 0, apiOrigin, uiOrigin;
let mutationRequests = 0;
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
  temporary = await mkdtemp('/private/tmp/ds-meta-customer-support-ui-'); await chmod(temporary, 0o700);
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const source = new URL(input); source.pathname = '/' + databaseName;
  stage = 'CREATE_ISOLATED_DATABASE';
  await command(join(pgBin, 'createdb'), ['--template=template0', databaseName], pgEnv); created = true;
  await command(join(pgBin, 'psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', `ALTER DATABASE "${databaseName}" SET timezone TO 'UTC';`], pgEnv);
  stage = 'MIGRATE_ISOLATED_DATABASE';
  await command(process.execPath, [join(base, 'app/node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema=' + join(base, 'app/.wasp/out/db/schema.prisma')], { ...pgEnv, HOME: temporary, DATABASE_URL: source.href });
  db = new PrismaClient({ datasources: { db: { url: source.href } } });
  stage = 'SEED_SYNTHETIC_IDENTITIES_AND_RECORDS';
  const day = 86_400_000, [{ now }] = await db.$queryRaw`SELECT clock_timestamp() AS now`;
  const at = offset => new Date(now.valueOf() + offset * day);
  const fixturePassword = `Synthetic-fixture-only-${suffix}!`, hashedPassword = await hashPassword(fixturePassword);
  const admin = { id: randomUUID(), email: `admin-${suffix}@example.test`, displayName: '合成平台验收员', isAdmin: true };
  const owner = { id: randomUUID(), email: `owner-${suffix}@example.test`, displayName: '合成客户验收员', isAdmin: false };
  const other = { id: randomUUID(), email: `other-${suffix}@example.test`, displayName: '其他合成成员', isAdmin: false };
  const organizationId = randomUUID(), secondOrganizationId = randomUUID(), workspaceId = randomUUID();
  const openId = randomUUID(), resolvedId = randomUUID(), hiddenId = randomUUID(), currentAnalysisId = randomUUID();
  const organizationName = '合成客户 · 当前已付额度', secondOrganizationName = '合成客户 · 续费待处理';
  const workspaceName = '合成反馈工作区', openSubject = '本人反馈 · 待处理样本', resolvedSubject = '本人反馈 · 已处理样本';
  const providerMarker = 'private-provider-fixture-' + suffix;
  const quotas = [
    { key: 'WORKSPACES', label: '工作区', limit: 10, used: 2, reserved: 0 },
    { key: 'MEMBERS', label: '成员席位', limit: 11, used: 3, reserved: 1 },
    { key: 'SAVED_ADS', label: '收藏', limit: 12, used: 4, reserved: 2 },
    { key: 'ANALYSES', label: '分析次数', limit: 13, used: 5, reserved: 3 },
  ];
  await db.$transaction(async tx => {
    for (const user of [admin, owner, other]) {
      await tx.user.create({ data: { ...user, onboardingCompletedAt: now, auth: { create: { identities: { create: { providerName: 'email', providerUserId: user.email, providerData: JSON.stringify({ hashedPassword, isEmailVerified: true, emailVerificationSentAt: null, passwordResetSentAt: null }) } } } } } });
    }
    for (const [id, name] of [[organizationId, organizationName], [secondOrganizationId, secondOrganizationName]]) {
      await tx.organization.create({ data: { id, slug: id, name, status: 'ACTIVE' } });
      await tx.organizationMember.create({ data: { organizationId: id, userId: owner.id, role: 'OWNER' } });
    }
    await tx.organizationMember.createMany({ data: [{ organizationId, userId: admin.id, role: 'ADMIN' }, { organizationId, userId: other.id, role: 'MEMBER' }] });
    await tx.workspace.create({ data: { id: workspaceId, organizationId, slug: workspaceId, name: workspaceName } });
    const plan = await tx.planVersion.create({ data: { key: `customer-ui-${suffix}`, version: 1, name: '合成订阅套餐', status: 'DRAFT', providerPriceId: providerMarker } });
    await tx.subscription.createMany({ data: [
      { organizationId, planVersionId: plan.id, provider: 'STRIPE', providerCustomerId: providerMarker, providerSubscriptionId: providerMarker + '-active', status: 'ACTIVE', currentPeriodStart: at(-2), currentPeriodEnd: at(28), cancelAtPeriodEnd: true },
      { organizationId: secondOrganizationId, planVersionId: plan.id, provider: 'STRIPE', providerCustomerId: providerMarker, providerSubscriptionId: providerMarker + '-past-due', status: 'PAST_DUE', currentPeriodStart: at(-32), currentPeriodEnd: at(-2) },
    ] });
    for (const { label, ...quota } of quotas) await tx.entitlement.createMany({ data: [
      { ...quota, id: quota.key === 'ANALYSES' ? currentAnalysisId : randomUUID(), organizationId, source: 'STRIPE', periodStart: at(-2), periodEnd: at(28), validFrom: at(-2), validUntil: at(28) },
      { key: quota.key, organizationId, limit: 777777, source: 'MANUAL', periodStart: at(-1), validFrom: at(-1), validUntil: at(-0.1) },
      { key: quota.key, organizationId, limit: 888888, source: 'MANUAL', periodStart: at(2), validFrom: at(2), validUntil: at(32) },
      { key: quota.key, organizationId: secondOrganizationId, limit: 777777, source: 'PLAN', periodStart: at(-32), validFrom: at(-32), validUntil: at(-2) },
    ] });
    await tx.feedback.createMany({ data: [
      { id: openId, organizationId, workspaceId, userId: owner.id, category: 'BUG', subject: openSubject, body: '合成问题：仅验证本人可查看处理状态，不提交实际服务请求。', status: 'OPEN', createdAt: at(-1) },
      { id: resolvedId, organizationId, workspaceId: null, userId: owner.id, category: 'DELETION_REQUEST', subject: resolvedSubject, body: '合成组织申请：已处理仅为支持记录状态，没有删除任何资料。', status: 'RESOLVED', createdAt: at(-2), resolvedAt: at(-0.1) },
      { id: hiddenId, organizationId, workspaceId, userId: other.id, category: 'GENERAL', subject: '其他成员反馈不得出现在本人列表', body: 'hidden-other-member-fixture', status: 'OPEN', createdAt: now },
    ] });
  });
  const apiPort = await freePort(), uiPort = await freePort(); apiOrigin = `http://127.0.0.1:${apiPort}`; uiOrigin = `http://127.0.0.1:${uiPort}`;
  const common = { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary, NODE_ENV: 'development', WASP_WEB_CLIENT_URL: uiOrigin, WASP_SERVER_URL: apiOrigin, REACT_APP_API_URL: apiOrigin };
  const env = { ...common, PORT: String(apiPort), DATABASE_URL: source.href, JWT_SECRET: 'customer-support-ui-synthetic-jwt-only', OUTBOX_ENCRYPTION_KEY: 'f'.repeat(64), SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_USERNAME: 'fixture', SMTP_PASSWORD: 'fixture', EMAIL_FROM: 'support@example.test', REGISTRATION_MODE: 'invite', GOOGLE_AUTH_ENABLED: 'false', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', BILLING_ENABLED: 'false', LIVE_BILLING_ENABLED: 'false', PUBLIC_PRICING_ENABLED: 'false' };
  const guard = `import http from 'node:http';import https from 'node:https';import tls from 'node:tls';import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';const deny=()=>{process.stderr.write('${marker}\\n');throw Error('${marker}')};http.request=http.get=https.request=https.get=tls.connect=deny;globalThis.fetch=deny;const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){if(typeof args[0]==='number'){if(typeof args[1]==='string')args[1]='127.0.0.1';else args.splice(1,0,'127.0.0.1')}else if(args[0]&&typeof args[0]==='object'&&'port'in args[0])args[0]={...args[0],host:'127.0.0.1'};return listen.apply(this,args)};syncBuiltinESMExports();`;
  stage = 'START_NATIVE_API';
  const api = launch(['--import', `data:text/javascript,${encodeURIComponent(guard)}`, join(base, 'app/.wasp/out/server/bundle/server.js')], temporary, env);
  await ready(apiOrigin, '/auth/options', api);
  stage = 'START_REAL_VITE';
  const vite = launch([join(base, 'app/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], join(base, 'app'), common);
  await ready(uiOrigin, '/pricing', vite);
  stage = 'START_FRESH_CHROME';
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, env: { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary }, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  async function snapshot(page, name, details) {
    const geometry = await page.evaluate(() => ({ viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth }));
    assert(geometry.pageWidth <= geometry.viewportWidth);
    const filename = `${name}.png`;
    const fullPage = details.area.startsWith('ADMIN_');
    await page.screenshot({ path: join(artifacts, filename), fullPage });
    await chmod(join(artifacts, filename), 0o600);
    checks.push({ ...details, capture: fullPage ? 'full-page' : 'viewport', pageHorizontalOverflow: false, screenshot: filename, screenshotSha256: createHash('sha256').update(await readFile(join(artifacts, filename))).digest('hex') });
  }
  async function newAuthenticatedPage(user, viewport) {
    const context = await browser.newContext({ viewport, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if ([apiOrigin, uiOrigin].includes(url.origin)) {
        if (url.pathname === '/operations/app-command') { mutationRequests++; return route.abort('blockedbyclient'); }
        return route.continue();
      }
      blockedBrowserRequests++; return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin !== apiOrigin || !queryPaths.includes(url.pathname)) return;
      const currentStage = stage;
      pendingResponses.push((async () => {
        let body; try { body = await response.json(); } catch {}
        const data = body?.json;
        const row = { stage: currentStage, role: user.isAdmin ? 'PLATFORM_ADMIN' : 'CUSTOMER_OWNER', viewport: viewport.width, route: url.pathname, httpStatus: response.status() };
        if (response.ok()) {
          assert(data);
          if (url.pathname === '/operations/get-admin-page' && data.kind === 'customers') {
            const current = data.customers.find(customer => customer.id === organizationId);
            const pastDue = data.customers.find(customer => customer.id === secondOrganizationId);
            assert.equal(current?.status, 'ACTIVE'); assert.equal(current?.subscription.status, 'ACTIVE');
            assert.equal(pastDue?.status, 'ACTIVE'); assert.equal(pastDue?.subscription.status, 'PAST_DUE');
            for (const expected of quotas) {
              const quota = current.entitlements.find(item => item.key === expected.key).current;
              for (const key of ['used', 'reserved', 'limit']) assert.equal(quota[key], expected[key]);
              assert.equal(quota.source, 'STRIPE');
              assert.equal(pastDue.entitlements.find(item => item.key === expected.key).current, null);
            }
            assert(!JSON.stringify(data).includes(providerMarker));
            row.customerEffectiveQuotasVerified = true;
          }
          if (url.pathname === '/operations/get-app-state' && !user.isAdmin) {
            assert.equal(data.user.isAdmin, false);
            assert.deepEqual(data.organizationSupportRequests.map(request => request.id).sort(), [openId, resolvedId].sort());
            assert(!JSON.stringify(data.organizationSupportRequests).includes('hidden-other-member-fixture'));
            row.ownRequestStatuses = data.organizationSupportRequests.map(request => ({ id: request.id === openId ? 'initially-open' : 'already-resolved', status: request.status, createdAtPresent: Boolean(request.createdAt), resolvedAtPresent: Boolean(request.resolvedAt) }));
            for (const expected of quotas) {
              const entitlement = data.billing.entitlements.find(item => item.key === expected.key);
              if (currentStage.startsWith('OWNER_QUOTA_EXPIRED_') && expected.key === 'ANALYSES') {
                assert.equal(entitlement.status, 'UNAVAILABLE'); assert.equal(entitlement.limit, null);
              } else { assert.equal(entitlement.status, 'ACTIVE'); assert.equal(entitlement.limit, expected.limit); assert.equal(entitlement.used, expected.used + expected.reserved); }
            }
            row.ownerEffectiveQuotasVerified = true;
            if (currentStage.startsWith('OWNER_QUOTA_EXPIRED_')) row.expiredAnalysisUnavailable = true;
          }
        }
        nativeResponses.push(row);
      })().catch(() => { diagnostic.nativeResponseValidationFailed = true; }));
    });
    await page.goto(uiOrigin + '/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.getByLabel('邮箱', { exact: true }).fill(user.email);
    await page.getByLabel('密码', { exact: true }).fill(fixturePassword);
    const loginResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/email/login' && response.request().method() === 'POST');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    assert.equal((await loginResponse).status(), 200);
    await page.waitForURL(url => url.pathname.startsWith('/app'), { timeout: 15000 });
    await page.waitForFunction(() => Boolean(document.querySelector('#workspace-select')?.value), { timeout: 15000 });
    return { context, page };
  }
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    stage = `ADMIN_LOGIN_${viewport.width}`;
    const adminPage = await newAuthenticatedPage(admin, viewport);
    stage = `ADMIN_CUSTOMER_VIEW_${viewport.width}`;
    await adminPage.page.goto(`${uiOrigin}/app/admin?workspace=${workspaceId}`, { waitUntil: 'domcontentloaded' });
    await adminPage.page.getByRole('tab', { name: '客户与权益', exact: true }).click();
    const currentRow = adminPage.page.getByRole('row').filter({ hasText: organizationName });
    const pastDueRow = adminPage.page.getByRole('row').filter({ hasText: secondOrganizationName });
    await currentRow.waitFor({ state: 'visible', timeout: 15000 });
    const currentText = await currentRow.innerText(), pastDueText = await pastDueRow.innerText();
    assert(currentText.includes('合成订阅套餐') && currentText.includes('已安排周期末取消'));
    assert.equal(await currentRow.locator('td').nth(1).innerText(), '正常');
    assert((await currentRow.locator('td').nth(2).innerText()).includes('正常'));
    assert.equal(await pastDueRow.locator('td').nth(1).innerText(), '正常');
    assert((await pastDueRow.locator('td').nth(2).innerText()).includes('续费待处理'));
    for (const quota of quotas) {
      assert(currentText.includes(quota.label));
      assert(currentText.includes(`已用 ${quota.used} · 预留 ${quota.reserved} · 上限 ${quota.limit}`));
    }
    assert.equal(currentText.match(/已付订阅/g)?.length, 4);
    assert.equal(pastDueText.match(/无有效额度/g)?.length, 4);
    assert(!currentText.includes('777777') && !currentText.includes('888888') && !currentText.includes(providerMarker));
    const table = adminPage.page.locator('.table-wrap').filter({ has: currentRow });
    const tableGeometry = await table.evaluate(element => ({ width: element.clientWidth, contentWidth: element.scrollWidth }));
    await snapshot(adminPage.page, `customers-${viewport.width}x${viewport.height}-left`, { area: 'ADMIN_CUSTOMERS', viewport, activeSubscriptionSeparateFromOrganization: true, effectiveQuotas: quotas, sourceLabel: '已付订阅', futureAndExpiredIgnored: true, missingCurrentExplicit: true, tableGeometry });
    if (tableGeometry.contentWidth > tableGeometry.width) {
      await table.evaluate(element => { element.scrollLeft = element.scrollWidth; });
      assert((await table.evaluate(element => element.scrollLeft)) > 0);
      await snapshot(adminPage.page, `customers-${viewport.width}x${viewport.height}-quotas`, { area: 'ADMIN_CUSTOMER_QUOTAS_SCROLLED', viewport, tableHorizontalScrollVerified: true });
    }
    await adminPage.context.close();
    stage = `CUSTOMER_LOGIN_${viewport.width}`;
    await db.feedback.update({ where: { id: openId }, data: { status: 'OPEN', resolvedAt: null } });
    const customer = await newAuthenticatedPage(owner, viewport);
    stage = `OWN_SUPPORT_BEFORE_${viewport.width}`;
    await customer.page.goto(`${uiOrigin}/app/settings?workspace=${workspaceId}#feedback`, { waitUntil: 'domcontentloaded' });
    const ownOpen = customer.page.locator('#feedback article').filter({ hasText: openSubject });
    const ownResolved = customer.page.locator('#feedback article').filter({ hasText: resolvedSubject });
    await ownOpen.waitFor({ state: 'visible', timeout: 15000 });
    const feedbackText = await customer.page.locator('#feedback').innerText();
    assert(feedbackText.includes('“已处理”是支持记录状态，不代表已执行数据删除'));
    assert(!feedbackText.includes('其他成员反馈不得出现在本人列表') && !feedbackText.includes('hidden-other-member-fixture'));
    assert((await ownOpen.innerText()).includes('待处理'));
    assert((await ownOpen.innerText()).includes('提交于') && !(await ownOpen.innerText()).includes('处理于'));
    assert((await ownOpen.innerText()).includes(organizationName + ' / ' + workspaceName));
    assert((await ownResolved.innerText()).includes('已处理') && (await ownResolved.innerText()).includes('处理于'));
    assert((await ownOpen.innerText()).includes(openId) && (await ownResolved.innerText()).includes(resolvedId));
    const billingText = await customer.page.locator('#billing .quota-list').innerText();
    assert(!billingText.includes('777777') && !billingText.includes('888888'));
    for (const expected of quotas) assert(billingText.includes(`${expected.used + expected.reserved} / ${expected.limit}`));
    await customer.page.locator('#billing .quota-list').scrollIntoViewIfNeeded();
    await snapshot(customer.page, `owner-quotas-${viewport.width}x${viewport.height}-current`, { area: 'OWNER_CURRENT_QUOTAS', viewport, futureAndExpiredIgnored: true, fourCurrentLimitsVerified: true });
    await ownOpen.scrollIntoViewIfNeeded();
    await snapshot(customer.page, `own-support-${viewport.width}x${viewport.height}-before`, { area: 'OWN_SUPPORT', viewport, ownOnly: true, statuses: ['OPEN', 'RESOLVED'], submissionAndResolutionTimes: true, requestIdsVisible: true, organizationWorkspaceVisible: true, noDeletionClaim: true });
    stage = `OWN_SUPPORT_REFRESH_${viewport.width}`;
    const refreshedAt = new Date(now.valueOf() + 1000);
    await db.feedback.update({ where: { id: openId }, data: { status: 'RESOLVED', resolvedAt: refreshedAt } });
    const refreshed = customer.page.waitForResponse(response => new URL(response.url()).pathname === '/operations/get-app-state' && response.status() === 200);
    await customer.page.getByRole('button', { name: '刷新处理状态', exact: true }).click(); await refreshed;
    await ownOpen.getByText('已处理', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    assert((await ownOpen.innerText()).includes('处理于'));
    assert.equal(await ownOpen.locator('.status').innerText(), '已处理');
    await ownOpen.scrollIntoViewIfNeeded();
    await snapshot(customer.page, `own-support-${viewport.width}x${viewport.height}-refreshed`, { area: 'OWN_SUPPORT_REFRESH', viewport, nativeRefreshVerified: true, status: 'RESOLVED', resolutionTimeVisible: true });
    stage = `OWNER_QUOTA_EXPIRED_${viewport.width}`;
    await db.entitlement.update({ where: { id: currentAnalysisId }, data: { validUntil: at(-0.1) } });
    const expiredResponse = customer.page.waitForResponse(response => new URL(response.url()).pathname === '/operations/get-app-state' && response.status() === 200);
    await customer.page.getByRole('button', { name: '刷新处理状态', exact: true }).click(); await expiredResponse;
    await customer.page.locator('#billing .quota-list').getByText('当前无有效额度', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await customer.page.locator('#billing .quota-list').getByText('当前无有效额度', { exact: true }).count(), 1);
    assert(!(await customer.page.locator('#billing .quota-list').innerText()).includes('777777') && !(await customer.page.locator('#billing .quota-list').innerText()).includes('888888'));
    await customer.page.locator('#billing .quota-list').scrollIntoViewIfNeeded();
    await snapshot(customer.page, `owner-quotas-${viewport.width}x${viewport.height}-expired`, { area: 'OWNER_EXPIRED_ANALYSIS', viewport, nativeRefreshVerified: true, status: 'UNAVAILABLE', noFutureOrExpiredFallback: true });
    await db.entitlement.update({ where: { id: currentAnalysisId }, data: { validUntil: at(28) } });
    await customer.context.close();
  }
  await Promise.all(pendingResponses);
  stage = 'VERIFY_NATIVE_RESPONSES_AND_BOUNDARIES';
  assert.equal(diagnostic.nativeResponseValidationFailed, undefined);
  for (const width of [1280, 390]) {
    assert(nativeResponses.some(row => row.viewport === width && row.customerEffectiveQuotasVerified));
    assert(nativeResponses.some(row => row.viewport === width && row.ownRequestStatuses?.some(request => request.status === 'OPEN')));
    assert(nativeResponses.some(row => row.viewport === width && row.stage === `OWN_SUPPORT_REFRESH_${width}` && row.ownRequestStatuses?.every(request => request.status === 'RESOLVED')));
    assert(nativeResponses.some(row => row.viewport === width && row.expiredAnalysisUnavailable));
  }
  assert.equal(mutationRequests, 0);
  assert.equal(await db.emailDelivery.count(), 0);
  assert.equal(await db.workspace.count({ where: { archivedAt: { not: null } } }), 0);
  assert.equal(await db.session.count(), 4);
  assert.equal(providerRequestAttempted, false);
} catch (error) { failed = true; diagnostic.errorType = error?.name ?? 'Error'; }
finally {
  try { await browser?.close(); } catch { cleanupFailed = true; }
  for (const child of children.reverse()) try { await stop(child); } catch { cleanupFailed = true; }
  try { await db?.$disconnect(); } catch { cleanupFailed = true; }
  if (created) try { await command(join(process.env.PG_BIN ?? '/opt/homebrew/opt/postgresql@15/bin', 'dropdb'), ['--force', databaseName], pgEnv); } catch { cleanupFailed = true; }
  if (temporary) try { await rm(temporary, { recursive: true, force: true }); } catch { cleanupFailed = true; }
}
const report = { status: failed || cleanupFailed ? 'CUSTOMER_SUPPORT_UI_SMOKE_FAILED' : 'CUSTOMER_SUPPORT_UI_SMOKE_VERIFIED', ...(failed ? { failedStage: stage, diagnostic } : {}), nativeRoutes: queryPaths, syntheticOnly: true, authentication: 'Native Wasp email login with synthetic verified identities', browser: 'Google Chrome headless; fresh isolated profiles; sandbox enabled', queryMocked: false, externalServicesUsed: false, blockedBrowserRequests, providerRequestAttempted, mutationRequests, checks, nativeResponses, cleanupVerified: !cleanupFailed, artifacts };
await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(report));
if (failed || cleanupFailed) process.exitCode = 1;
