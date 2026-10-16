/** Real local API acceptance with new synthetic users in a dedicated workspace test DB.
 * Requires SAAS_TEST_DATABASE_URL=postgresql://.../saas_workspace_ui_test.
 * No mail, AI, payment, collection worker, production data or remote endpoint is used.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = resolve(process.env.SAAS_WORKSPACE_RUNTIME ?? join(root, 'saas'));
const require = createRequire(join(runtime, 'app/package.json'));
const { PrismaClient } = require('@prisma/client'), { chromium } = require('playwright');
const serverRequire = createRequire(join(runtime, 'app/.wasp/out/server/package.json'));
const { hashPassword } = await import(serverRequire.resolve('@wasp.sh/lib-auth/node'));
const loopback = hostname => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
function localOrigin(value) { const url = new URL(value); assert(['http:', 'https:'].includes(url.protocol) && loopback(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Only a loopback origin is allowed'); return url.origin; }
const api = localOrigin(process.env.SAAS_WORKSPACE_API_URL ?? 'http://127.0.0.1:3201');
const ui = localOrigin(process.env.SAAS_WORKSPACE_UI_URL ?? 'http://127.0.0.1:3200');
const database = new URL(process.env.SAAS_TEST_DATABASE_URL ?? 'http://invalid');
assert(['postgres:', 'postgresql:'].includes(database.protocol) && loopback(database.hostname) && /^\/saas_workspace_(?:ui|api)_test(?:_[a-z0-9]+)?$/.test(database.pathname) && !database.search && !database.hash, 'A dedicated local workspace test database is required');
const db = new PrismaClient({ datasources: { db: { url: database.href } } });
const artifacts = resolve(process.env.SAAS_WORKSPACE_API_ARTIFACT_DIR ?? join(root, 'output/workspace-api'));
const spyFilters = process.env.SAAS_WORKSPACE_SPY_FILTERS === 'true';
const suffix = randomUUID(), password = `Local-workspace-${suffix}!`, marker = `workspace-smoke-${suffix}`;
const checks = [], nativeResponses = [];
let browser, stage = 'configuration', failed;
const checked = name => { checks.push({ name, status: 'passed' }); console.log(`WORKSPACE_API_PASS ${name}`); };
async function post(path, payload, session, operation = true) {
  assert(path.startsWith('/operations/') || path === '/auth/email/login' || path === '/auth/logout');
  const response = await fetch(api + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session}` } : {}) }, body: JSON.stringify(operation ? { json: payload } : payload) });
  let raw; try { raw = await response.json(); } catch { raw = null; }
  nativeResponses.push({ route: path, status: response.status, ...(path === '/operations/app-command' ? { command: payload.type } : {}) });
  return { status: response.status, data: operation ? raw?.json ?? raw : raw };
}
async function operation(name, args, session, expected = 200) { const response = await post(`/operations/${name}`, args, session); assert.equal(response.status, expected, `${name} status`); return response.data; }
const command = (args, session, expected) => operation('app-command', args, session, expected);
async function login(user) {
  const result = await post('/auth/email/login', { email: user.email, password }, undefined, false); assert.equal(result.status, 200); assert.equal(typeof result.data.sessionId, 'string');
  // Proves that the target API uses the fixture database before any app mutation.
  const response = await fetch(api + '/auth/me', { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${result.data.sessionId}` } });
  assert.equal(response.status, 200); assert.equal((await response.json()).json.id, user.id, 'API and fixture database must match'); return result.data.sessionId;
}
async function syntheticUser(label) { return db.user.create({ data: { email: `${label}-${suffix}@example.test`, displayName: `Synthetic ${label}`, auth: { create: { identities: { create: { providerName: 'email', providerUserId: `${label}-${suffix}@example.test`, providerData: JSON.stringify({ hashedPassword: await hashPassword(password), isEmailVerified: true, emailVerificationSentAt: null, passwordResetSentAt: null }) } } } } } }); }

await mkdir(artifacts, { recursive: true, mode: 0o700 });
try {
  stage = 'seed-identities'; const mailBefore = await db.emailDelivery.count();
  const [owner, viewer, outsider] = await Promise.all(['owner', 'viewer', 'outsider'].map(syntheticUser));
  const ownerSession = await login(owner), viewerSession = await login(viewer), outsiderSession = await login(outsider);
  const initial = await operation('get-app-state', {}, ownerSession); assert.equal(initial.selectedWorkspace, null); assert.equal(initial.organizations.length, 0); checked('new-user-has-no-workspace');
  stage = 'create-organization-and-workspaces';
  const created = await command({ type: 'CREATE_ORGANIZATION', name: `Synthetic acceptance ${suffix}`, workspaceName: 'Primary synthetic workspace' }, ownerSession);
  const workspaceId = created.workspaceId; assert(workspaceId);
  const state = await operation('get-app-state', { workspaceId }, ownerSession), organizationId = state.selectedWorkspace.organizationId;
  assert.equal(state.role, 'OWNER'); assert.equal(state.selectedWorkspace.name, 'Primary synthetic workspace'); assert.equal(state.organizations.length, 1);
  // Only adjusts this newly created test organization's fixture allowance.
  await db.entitlement.updateMany({ where: { organizationId, key: 'WORKSPACES' }, data: { limit: 3 } });
  const second = await command({ type: 'CREATE_WORKSPACE', organizationId, name: 'Secondary synthetic workspace' }, ownerSession);
  assert(second.workspaceId && second.workspaceId !== workspaceId); checked('real-commands-create-team-and-two-workspaces');
  const source = await db.dataSource.create({ data: { key: marker, name: 'Synthetic API fixture', adapterVersion: 'fixture', status: 'PAUSED' } });
  const ads = []; for (let index = 0; index < 3; index++) ads.push(await db.ad.create({ data: { dataSourceId: source.id, sourceAdId: `${marker}-${index}`, sourceUrl: 'https://example.test/synthetic-ad', body: `${marker} synthetic public research copy ${index}`, fieldProvenance: { advertiserName: { value: 'Synthetic API Studio' } }, sourceStatus: 'ACTIVE', firstObservedAt: new Date(), lastObservedAt: new Date(), ...(spyFilters ? { publisherPlatforms: index === 0 ? ['Facebook', 'FACEBOOK', 'Instagram', 'Audience Network'] : index === 1 ? ['FACEBOOK', 'AUDIENCE_NETWORK'] : [], sourceStartedAt: index === 0 ? new Date('2026-09-20T00:00:00.000Z') : index === 1 ? new Date('2026-09-20T23:59:59.999Z') : null, sourceEndedAt: index === 1 ? new Date('2026-09-22T00:00:00.000Z') : null } : {}) } }));
  stage = 'search-and-detail'; const first = await operation('search-public-ads', { workspaceId, query: marker, limit: 2 }, ownerSession);
  assert.equal(first.summary.total, 3); assert.equal(first.ads.length, 2); assert(first.nextCursor);
  const next = await operation('search-public-ads', { workspaceId, query: marker, limit: 2, cursor: first.nextCursor }, ownerSession);
  assert.equal(next.ads.length, 1); assert.equal(new Set([...first.ads, ...next.ads].map(ad => ad.id)).size, 3);
  const detail = await operation('get-public-ad', { workspaceId, adId: ads[0].id }, ownerSession); assert.equal(detail.ad.copy, ads[0].body); checked('search-pagination-and-detail-use-real-postgresql-data');
  if (spyFilters) {
    stage = 'spy-platform-source-dates-and-pagination';
    const base = { workspaceId, query: marker, platform: 'facebook', startedFrom: '2026-09-20', startedTo: '2026-09-20' };
    const filtered = await operation('search-public-ads', { ...base, limit: 1 }, ownerSession); assert.equal(filtered.summary.total, 2); assert.equal(filtered.ads.length, 1); assert(filtered.nextCursor);
    const filteredNext = await operation('search-public-ads', { ...base, limit: 1, cursor: filtered.nextCursor }, ownerSession); assert.equal(filteredNext.nextCursor, null); assert.deepEqual(filteredNext.summary, filtered.summary);
    const found = [...filtered.ads, ...filteredNext.ads]; assert.deepEqual(found.map(ad => ad.id).sort(), [ads[0].id, ads[1].id].sort());
    assert.equal(found.find(ad => ad.id === ads[0].id).sourceStartedAt, '2026-09-20T00:00:00.000Z'); assert.equal(found.find(ad => ad.id === ads[1].id).sourceStartedAt, '2026-09-20T23:59:59.999Z'); assert.equal(found.find(ad => ad.id === ads[1].id).sourceEndedAt, '2026-09-22T00:00:00.000Z');
    assert.equal((await operation('search-public-ads', { ...base, platform: 'audience_network' }, ownerSession)).summary.total, 2);
    assert.deepEqual((await operation('search-public-ads', { ...base, platform: 'instagram' }, ownerSession)).ads.map(ad => ad.id), [ads[0].id]);
    assert.equal((await operation('search-public-ads', { ...base, platform: 'pinterest' }, ownerSession)).summary.total, 0);
    assert.equal((await operation('search-public-ads', { ...base, startedFrom: '2026-10-03', startedTo: '2026-10-03' }, ownerSession)).summary.total, 0);
    const unknown = await operation('get-public-ad', { workspaceId, adId: ads[2].id }, ownerSession); assert.deepEqual(unknown.ad.publisherPlatforms, []); assert.equal(unknown.ad.sourceStartedAt, null); assert.equal(unknown.ad.sourceEndedAt, null);
    checked('spy-real-platform-filter-deduplicates-and-source-date-dto-includes-whole-utc-day');
    stage = 'spy-input-and-cursor-denials';
    for (const changed of [{ platform: 'instagram' }, { startedFrom: '2026-09-19' }, { startedTo: '2026-09-21' }]) await operation('search-public-ads', { ...base, ...changed, cursor: filtered.nextCursor }, ownerSession, 400);
    for (const invalid of [{ platform: "facebook' OR 1=1 --" }, { platform: 'FACEBOOK' }, { startedFrom: '2026-02-30' }, { startedFrom: '2026-09-21' }]) await operation('search-public-ads', { ...base, ...invalid }, ownerSession, 400);
    checked('spy-real-api-rejects-invalid-filter-values-and-reused-cursors');
  }
  stage = 'save-folder-note-persistence'; await command({ type: 'CREATE_FOLDER', workspaceId, name: 'Synthetic evidence' }, ownerSession);
  const withFolder = await operation('get-app-state', { workspaceId }, ownerSession), folderId = withFolder.research.folders.find(folder => folder.name === 'Synthetic evidence')?.id; assert(folderId);
  await command({ type: 'SAVE_AD', workspaceId, adId: ads[0].id, folderId }, ownerSession);
  await command({ type: 'SAVE_AD', workspaceId, adId: ads[0].id, folderId }, ownerSession);
  const research = await operation('get-research-page', { workspaceId, kind: 'saved', limit: 20 }, ownerSession); assert.equal(research.total, 1); const savedAdId = research.savedAds[0].id;
  await command({ type: 'SAVE_NOTE', workspaceId, savedAdId, body: 'Synthetic note persisted through the real API.' }, ownerSession);
  const refreshed = await operation('get-research-page', { workspaceId, kind: 'saved', folderId, limit: 20 }, ownerSession);
  assert.equal(refreshed.total, 1); assert.equal(refreshed.savedAds[0].notes[0].body, 'Synthetic note persisted through the real API.');
  assert.equal((await db.entitlement.findFirstOrThrow({ where: { organizationId, key: 'SAVED_ADS' } })).used, 1); checked('folder-save-note-refresh-persist-without-duplicate-quota');
  stage = 'viewer-and-cross-workspace-denials'; await db.organizationMember.create({ data: { organizationId, userId: viewer.id, role: 'MEMBER' } }); await db.workspaceMember.create({ data: { organizationId, workspaceId, userId: viewer.id, role: 'VIEWER' } });
  assert.equal((await operation('get-app-state', { workspaceId }, viewerSession)).role, 'VIEWER'); assert.equal((await operation('search-public-ads', { workspaceId, query: marker }, viewerSession)).summary.total, 3);
  for (const args of [{ type: 'SAVE_AD', workspaceId, adId: ads[1].id }, { type: 'CREATE_FOLDER', workspaceId, name: 'Denied fixture' }, { type: 'SAVE_NOTE', workspaceId, savedAdId, body: 'Denied fixture' }, { type: 'ANALYZE_AD', workspaceId, adId: ads[0].id, idempotencyKey: randomUUID() }]) await command(args, viewerSession, 403);
  await operation('get-app-state', { workspaceId: second.workspaceId }, viewerSession, 403); await operation('search-public-ads', { workspaceId, query: marker }, outsiderSession, 403);
  if (spyFilters) {
    const filters = { workspaceId, query: marker, platform: 'facebook', startedFrom: '2026-09-20', startedTo: '2026-09-20' };
    assert.equal((await operation('search-public-ads', filters, viewerSession)).summary.total, 2);
    await operation('search-public-ads', filters, outsiderSession, 403);
    await operation('search-public-ads', { ...filters, workspaceId: second.workspaceId }, viewerSession, 403);
    checked('spy-real-filtered-search-allows-viewer-and-denies-foreign-workspaces');
  }
  await command({ type: 'SAVE_NOTE', workspaceId: second.workspaceId, savedAdId, body: 'Cross-space denied' }, ownerSession, 404);
  await command({ type: 'SAVE_AD', workspaceId: second.workspaceId, adId: ads[1].id, folderId }, ownerSession, 404);
  assert.equal(await db.savedAd.count({ where: { organizationId } }), 1); assert.equal(await db.note.count({ where: { organizationId } }), 1); checked('viewer-write-and-cross-workspace-requests-rejected-without-data-change');
  stage = 'quota-and-profile'; await db.entitlement.updateMany({ where: { organizationId, key: 'SAVED_ADS' }, data: { limit: 1 } }); await command({ type: 'SAVE_AD', workspaceId, adId: ads[1].id }, ownerSession, 402);
  await command({ type: 'UPDATE_PROFILE', displayName: 'Synthetic updated reviewer', emailNotifications: false }, ownerSession);
  const profile = await operation('get-app-state', { workspaceId }, ownerSession); assert.equal(profile.user.displayName, 'Synthetic updated reviewer'); assert.equal(profile.user.emailNotifications, false); checked('quota-denial-and-personal-settings-persist');
  stage = 'browser-refresh-persistence'; browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' }); let unexpectedWrites = 0, externalRequests = 0, pageErrors = 0;
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (![ui, api].includes(url.origin)) { externalRequests++; return route.abort('blockedbyclient'); }
    if (request.method() === 'OPTIONS') return route.continue();
    if (!['GET', 'HEAD'].includes(request.method()) && !(url.pathname === '/auth/email/login' || url.pathname.startsWith('/operations/get-') || url.pathname === '/operations/search-public-ads')) { unexpectedWrites++; return route.abort('blockedbyclient'); }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', () => pageErrors++);
  await page.goto(ui + '/login?lang=en'); await page.locator('input[name=email]').fill(owner.email); await page.locator('input[name=password]').fill(password); await page.locator('.auth-form button[type=submit]').click(); await page.waitForURL(url => url.pathname === '/app');
  if (spyFilters) {
    await page.goto(`${ui}/app?${new URLSearchParams({ workspace: workspaceId, lang: 'en', q: marker, platform: 'facebook', startedFrom: '2026-09-20', startedTo: '2026-09-20' })}`);
    await page.locator('.ad-card').first().waitFor(); assert.equal(await page.locator('.ad-card').count(), 2); await page.reload(); await page.locator('.ad-card').first().waitFor(); assert.equal(await page.locator('.ad-card').count(), 2);
    assert.equal(await page.locator('select[name=platform]').inputValue(), 'facebook');
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: join(artifacts, 'real-api-spy-filters.png'), fullPage: true }); checked('spy-browser-refresh-preserves-real-platform-and-source-date-filter-results');
  }
  await page.goto(`${ui}/app/research?workspace=${workspaceId}&lang=en`); await page.getByText('Synthetic API Studio', { exact: true }).first().waitFor(); await page.reload(); await page.getByText('Synthetic API Studio', { exact: true }).first().waitFor();
  const note = page.locator('textarea[name=body]'); assert.equal(await note.inputValue(), 'Synthetic note persisted through the real API.');
  await page.screenshot({ path: join(artifacts, 'real-api-research-refresh.png'), fullPage: true }); assert.equal(unexpectedWrites, 0); assert.equal(pageErrors, 0); await context.close(); checked('real-browser-login-and-reload-show-persisted-collection-and-note');
  stage = 'logout-and-mail-boundary'; const logout = await post('/auth/logout', {}, ownerSession, false); assert.equal(logout.status, 200); await operation('get-app-state', { workspaceId }, ownerSession, 401);
  assert.equal(await db.emailDelivery.count(), mailBefore); checked('logout-invalidates-session-and-no-mail-was-queued');
  if (process.env.SAAS_WORKSPACE_PREVIEW_ACCOUNT_FILE) {
    const accountFile = resolve(process.env.SAAS_WORKSPACE_PREVIEW_ACCOUNT_FILE);
    assert(accountFile.startsWith('/private/tmp/'), 'Preview credentials may only be saved in the local temporary directory');
    await writeFile(accountFile, JSON.stringify({ synthetic: true, ui, email: owner.email, password, workspaceId, organizationId }, null, 2), { mode: 0o600 }); await chmod(accountFile, 0o600);
  }
} catch (error) { failed = { stage, errorType: error?.name ?? 'Error', ...(error?.name === 'AssertionError' ? { assertion: String(error.message).slice(0, 220) } : {}) }; console.error(`WORKSPACE_API_FAILED ${stage}`); process.exitCode = 1; }
finally {
  await browser?.close(); await db.$disconnect();
  await writeFile(join(artifacts, spyFilters ? 'spy-api-smoke-report.json' : 'workspace-api-report.json'), JSON.stringify({ status: failed ? 'FAILED' : 'PASSED', mode: 'real local API and isolated synthetic PostgreSQL fixtures', checks, nativeResponses, failure: failed ?? null, boundaries: { databaseIsLocalDedicatedWorkspaceTest: true, realEmailSent: false, providerCallsRequired: false, existingRecordsChanged: false } }, null, 2));
  console.log(`WORKSPACE_API_RESULT checks=${checks.length} status=${failed ? 'FAILED' : 'PASSED'}`);
}
