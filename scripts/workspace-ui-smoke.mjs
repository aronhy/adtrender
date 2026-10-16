/** Local browser acceptance. Every API response is synthetic; no mutation reaches a server.
 * SAAS_WORKSPACE_UI_URL=http://127.0.0.1:3200 SAAS_WORKSPACE_API_URL=http://127.0.0.1:3201
 * node scripts/workspace-ui-smoke.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ids, workspaceFixture, syntheticCreative } from './workspace-ui-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'apps/web/package.json'));
const { chromium } = require('playwright');
const loopback = hostname => ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
function localOrigin(value) { const url = new URL(value); assert(['http:', 'https:'].includes(url.protocol) && loopback(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Use a loopback origin without credentials or parameters'); return url.origin; }
const origin = localOrigin(process.env.SAAS_WORKSPACE_UI_URL ?? 'http://127.0.0.1:3200');
const apiOrigin = localOrigin(process.env.SAAS_WORKSPACE_API_URL ?? 'http://127.0.0.1:3201');
const artifacts = resolve(process.env.SAAS_WORKSPACE_ARTIFACT_DIR ?? join(root, 'output/workspace-ui'));
const viewports = [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 740 }];
const locales = ['zh-CN', 'zh-TW', 'en', 'es'];
const routes = ['/app', '/app/ads', `/app/ads/${ids.ad}`, '/app/research', '/app/settings'];
const checks = [], screenshots = [], headings = new Map();
const counters = { simulatedReads: 0, simulatedWrites: 0, serverMutations: 0, blockedExternalRequests: 0, unexpectedRequests: 0, pageErrors: 0 };
let browser, fatalError;

async function check(name, action, metadata = {}) {
  try { const evidence = await action(); checks.push({ name, status: 'passed', ...metadata, ...evidence }); }
  catch (error) { checks.push({ name, status: 'failed', ...metadata, errorType: error?.name ?? 'Error', ...(error?.name === 'AssertionError' ? { assertion: String(error.message).slice(0, 220) } : {}) }); console.error(`WORKSPACE_UI_CHECK_FAILED ${name}`); }
}
const headers = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' };
const json = (route, status, body) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
async function fixture(options = {}) {
  const context = await browser.newContext({ viewport: options.viewport ?? viewports[0], locale: 'en', serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  const model = workspaceFixture(origin, options), log = { commands: [], queries: [], auth: true };
  page.on('pageerror', () => counters.pageErrors++);
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    // The HTTPS loopback creative is fully intercepted, with no TLS or network connection.
    if (url.href === `${origin.replace(/^http:/, 'https:')}/__workspace-fixture__/ad.svg`) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: syntheticCreative });
    if (![origin, apiOrigin].includes(url.origin)) { counters.blockedExternalRequests++; return route.abort('blockedbyclient'); }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/__workspace-fixture__/ad.svg') return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: syntheticCreative });
    if (url.pathname === '/auth/me') return json(route, 200, { json: log.auth ? { ...model.state.user, identities: { email: { id: model.state.user.email, isEmailVerified: true }, google: null } } : null });
    if (url.pathname === '/auth/options') return json(route, 200, { google: false });
    if (url.pathname === '/auth/logout') { log.auth = false; counters.simulatedWrites++; return json(route, 200, { success: true }); }
    if (url.pathname.startsWith('/operations/')) {
      let args = {}; try { args = request.postDataJSON()?.json ?? {}; } catch {}
      if (url.pathname === '/operations/app-command') {
        counters.simulatedWrites++; log.commands.push(args);
        if (args.type !== 'PRODUCT_EVENT' && options.commandError) return json(route, options.commandError === 'QUOTA_EXCEEDED' ? 402 : 403, { message: options.commandError });
        return json(route, 200, { json: model.command(args) });
      }
      counters.simulatedReads++; log.queries.push({ path: url.pathname, args });
      if (url.pathname === '/operations/get-app-state') {
        if (options.forbidden) return json(route, 403, { message: 'WORKSPACE_FORBIDDEN' });
        if (args.workspaceId) model.state.selectedWorkspace = model.state.workspaces.find(item => item.id === args.workspaceId) ?? model.state.selectedWorkspace;
        return json(route, 200, { json: model.state });
      }
      if (url.pathname === '/operations/search-public-ads') {
        if (options.searchError) return json(route, 503, { message: 'SERVICE_UNAVAILABLE' });
        return json(route, 200, { json: model.search(args) });
      }
      if (url.pathname === '/operations/get-public-ad') return json(route, 200, { json: model.detail });
      if (url.pathname === '/operations/get-research-page') return json(route, 200, { json: model.research(args) });
      counters.unexpectedRequests++; return route.abort('blockedbyclient');
    }
    if (url.origin === apiOrigin || !['GET', 'HEAD'].includes(request.method())) { counters.unexpectedRequests++; return route.abort('blockedbyclient'); }
    return route.continue();
  });
  return { context, page, model, log };
}
async function navigate(page, path, locale = 'en', extra = {}) {
  const url = new URL(path, origin); url.searchParams.set('workspace', ids.workspace); url.searchParams.set('lang', locale);
  for (const [key, value] of Object.entries(extra)) value === null ? url.searchParams.delete(key) : url.searchParams.set(key, value);
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.locator('.workspace-shell').waitFor();
  await page.waitForFunction(locale => document.querySelector('.workspace-shell')?.getAttribute('data-locale') === locale, locale);
  await page.locator('#main-content h1').waitFor();
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
}
async function geometry(page) {
  const data = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, main: document.querySelector('#main-content')?.getBoundingClientRect().width, h1: document.querySelector('#main-content h1')?.textContent?.trim(), locale: document.querySelector('.workspace-shell')?.getAttribute('lang') }));
  assert(data.document <= data.viewport + 1, 'Page must not overflow horizontally'); assert(data.h1, 'Page needs a visible heading'); return data;
}
async function capture(page, name) {
  assert(!new URL(page.url()).searchParams.has('invite'), 'Do not capture an invitation token in the URL');
  await page.evaluate(async () => { window.scrollTo({ top: 0, behavior: 'instant' }); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  await page.screenshot({ path: join(artifacts, name), fullPage: true, mask: [page.locator('input[type=password]')], maskColor: '#e6e0db' }); screenshots.push(name);
}
async function viewportCaptures(page, prefix) {
  for (const position of ['top', 'middle', 'bottom']) {
    await page.evaluate(position => { const end = document.documentElement.scrollHeight - innerHeight; window.scrollTo({ top: position === 'top' ? 0 : position === 'middle' ? end / 2 : end, behavior: 'instant' }); }, position);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const name = `${prefix}-${position}.png`; await page.screenshot({ path: join(artifacts, name), fullPage: false, mask: [page.locator('input[type=password]')], maskColor: '#e6e0db' }); screenshots.push(name);
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
}
async function scenario(name, options, action) {
  await check(name, async () => { const current = await fixture(options); try { return await action(current); } finally { await current.context.close(); } }, { simulated: true });
}

await mkdir(artifacts, { recursive: true, mode: 0o700 });
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  for (const viewport of viewports) {
    const current = await fixture({ viewport });
    try {
      for (const locale of locales) for (const path of routes) await check(`layout:${path}:${locale}:${viewport.width}`, async () => {
        await navigate(current.page, path, locale);
        if (path.startsWith('/app/ads')) {
          const creative = current.page.locator('img[src*="/__workspace-fixture__/"]').first(); await creative.scrollIntoViewIfNeeded();
          await current.page.waitForFunction(() => [...document.images].some(image => image.src.includes('/__workspace-fixture__/') && image.complete && image.naturalWidth > 0));
          await current.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        }
        const data = await geometry(current.page);
        const key = path; if (!headings.has(key)) headings.set(key, new Map()); headings.get(key).set(locale, data.h1);
        assert.equal(data.locale, locale, 'Workspace language attribute must follow chosen locale');
        assert.equal(await current.page.locator('.workspace-language select').inputValue(), locale);
        if (locale === 'en' || (locale === 'zh-CN' && path === '/app') || (locale === 'es' && path === '/app/settings' && viewport.width === 320)) await capture(current.page, `${path === '/app' ? 'overview' : path.includes(ids.ad) ? 'detail' : path.split('/').at(-1)}-${locale}-${viewport.width}.png`);
        if (locale === 'es' && path === '/app/settings' && viewport.width === 320) await viewportCaptures(current.page, 'settings-es-320');
        return { geometry: data };
      }, { path, locale, viewport, simulated: true });
    } finally { await current.context.close(); }
    console.log(`WORKSPACE_UI_LAYOUT_COMPLETE width=${viewport.width}`);
  }
  await check('four-languages-render-translated-headings', async () => { for (const [path, values] of headings) if (!path.includes(ids.ad)) assert(new Set(values.values()).size >= 3, `Headings must change language for ${path}`); });
  for (const viewport of viewports) {
    const current = await fixture({ viewport, noWorkspace: true });
    try { for (const locale of locales) await check(`onboarding-layout:${locale}:${viewport.width}`, async () => {
      await navigate(current.page, '/app', locale, { workspace: null }); assert(await current.page.locator('input[name=workspaceName]').isVisible()); await current.page.locator('.workspace-invitation summary').click(); assert(await current.page.locator('input[name=token]').isVisible());
      const data = await geometry(current.page); if (locale === 'en') await capture(current.page, `onboarding-${locale}-${viewport.width}.png`); return { geometry: data };
    }, { locale, viewport, simulated: true }); } finally { await current.context.close(); }
  }
  await scenario('onboarding-create-organization', { noWorkspace: true }, async ({ page, log }) => {
    await navigate(page, '/app', 'en', { workspace: null }); await page.locator('input[name=name]').fill('Synthetic team'); await page.locator('input[name=workspaceName]').fill('Synthetic workspace');
    await page.locator('form').filter({ has: page.locator('input[name=workspaceName]') }).locator('button[type=submit]').click();
    await page.waitForURL(url => url.searchParams.get('workspace') === ids.workspace); assert(log.commands.some(command => command.type === 'CREATE_ORGANIZATION')); await capture(page, 'onboarding-created.png');
  });
  await scenario('onboarding-invitation-token-is-masked-and-scrubbed', { noWorkspace: true }, async ({ page, log }) => {
    await navigate(page, '/app', 'en', { workspace: null, invite: 'a'.repeat(64) }); await page.waitForFunction(() => !new URL(location.href).searchParams.has('invite'));
    assert.equal(await page.locator('input[name=token]').getAttribute('type'), 'password'); await capture(page, 'onboarding-invitation.png');
    await page.locator('form').filter({ has: page.locator('input[name=token]') }).locator('button').last().click(); await page.waitForFunction(() => new URL(location.href).searchParams.has('workspace')); assert(log.commands.some(command => command.type === 'ACCEPT_INVITATION'));
  });
  for (const width of [390, 320]) await scenario(`mobile-menu-and-language:${width}`, { viewport: { width, height: 844 } }, async ({ page }) => {
    await navigate(page, '/app'); const toggle = page.locator('.workspace-menu-toggle'); await toggle.click(); assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape'); assert.equal(await toggle.getAttribute('aria-expanded'), 'false'); await toggle.click();
    await page.locator('.sidebar a[href*="/app/ads"]').click(); await page.waitForURL(url => url.pathname === '/app/ads'); assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    const language = page.locator('.workspace-language select').filter({ visible: true }).first(); await language.selectOption('es');
    await page.waitForFunction(() => document.querySelector('.workspace-shell')?.getAttribute('data-locale') === 'es'); assert.equal(new URL(page.url()).searchParams.get('workspace'), ids.workspace); assert.equal(new URL(page.url()).searchParams.get('lang'), 'es'); await geometry(page);
  });
  await scenario('tablet-collapsed-menu-keyboard-boundary:820', { viewport: { width: 820, height: 1000 } }, async ({ page }) => {
    await navigate(page, '/app'); const toggle = page.locator('.workspace-menu-toggle'); assert(await toggle.isVisible());
    for (let index = 0; index < 14; index++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('.sidebar'))), false, 'Closed sidebar must not receive keyboard focus'); }
    await toggle.click(); assert.equal(await toggle.getAttribute('aria-expanded'), 'true'); assert.equal(await page.locator('#main-content').evaluate(node => node.inert), true, 'Main content must be inert while the menu is open');
    await page.keyboard.press('Escape'); assert.equal(await toggle.getAttribute('aria-expanded'), 'false'); assert.equal(await toggle.evaluate(node => node === document.activeElement), true, 'Escape returns focus to the toggle'); assert.equal(await page.locator('#main-content').evaluate(node => node.inert), false); await geometry(page); await capture(page, 'tablet-menu-820.png');
  });
  await scenario('brand-home-preserves-selected-workspace', {}, async ({ page }) => {
    await navigate(page, '/app/research', 'es', { workspace: ids.otherWorkspace }); await page.locator('.workspace-sidebar-brand a').click(); await page.waitForURL(url => url.pathname === '/app');
    assert.equal(new URL(page.url()).searchParams.get('workspace'), ids.otherWorkspace); assert.equal(new URL(page.url()).searchParams.get('lang'), 'es');
  });
  await scenario('mobile-current-home-brand-closes-menu', { viewport: viewports[1] }, async ({ page }) => {
    await navigate(page, '/app', 'en', { workspace: ids.otherWorkspace }); const toggle = page.locator('.workspace-menu-toggle'); await toggle.click(); assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await page.locator('.workspace-sidebar-brand a').click(); assert.equal(await toggle.getAttribute('aria-expanded'), 'false'); assert.equal(new URL(page.url()).searchParams.get('workspace'), ids.otherWorkspace);
  });
  await scenario('search-filters-pagination-and-return-to', {}, async ({ page, log }) => {
    await navigate(page, '/app/ads'); await page.locator('input[name=q]').fill('everyday'); await page.locator('input[name=country]').fill('US'); await page.locator('select[name=media]').selectOption('IMAGE');
    await page.locator('.search-form button[type=submit]').click(); await page.waitForURL(url => url.searchParams.get('q') === 'everyday');
    const nextSearch = page.waitForResponse(response => { if (!response.url().includes('/operations/search-public-ads')) return false; try { return Boolean(response.request().postDataJSON()?.json?.cursor); } catch { return false; } });
    await page.locator('.pagination button').last().click(); await page.waitForURL(url => Boolean(url.searchParams.get('cursor'))); await nextSearch;
    assert(log.queries.some(query => query.path.endsWith('search-public-ads') && query.args.query === 'everyday' && query.args.country === 'US' && query.args.mediaType === 'IMAGE' && query.args.cursor));
    await page.locator('.ad-card a[href*="/app/ads/"]').first().click(); await page.locator('.back-link').waitFor();
    const detail = new URL(page.url()); assert(new URLSearchParams(detail.searchParams.get('returnTo')).has('cursor'), 'Return link preserves the page cursor');
    await page.locator('.back-link').click(); await page.waitForURL(url => url.pathname === '/app/ads'); assert.equal(new URL(page.url()).searchParams.get('q'), 'everyday'); assert.equal(new URL(page.url()).searchParams.get('lang'), 'en');
  });
  await scenario('research-folder-and-pagination', {}, async ({ page, log }) => {
    await navigate(page, '/app/research'); await page.locator('.research-tools select').first().selectOption(ids.folder);
    await page.locator('.pagination button').last().click();
    await page.waitForFunction(() => document.querySelector('.pagination')?.textContent?.includes('2'));
    assert(log.queries.some(query => query.path.endsWith('get-research-page') && query.args.folderId === ids.folder && query.args.cursor));
  });
  await scenario('viewer-cannot-write', { role: 'VIEWER' }, async ({ page, log }) => {
    await navigate(page, `/app/ads/${ids.ad}`); assert(await page.locator('select[name=folderId]').isDisabled()); assert(await page.locator('.analysis-invite button').isDisabled());
    await navigate(page, '/app/research'); assert(await page.locator('.research-tools button[aria-expanded]').isDisabled()); assert.equal(await page.locator('.ws-create-folder').count(), 0); assert(!log.commands.some(command => command.type !== 'PRODUCT_EVENT'));
    await navigate(page, '/app/settings'); assert(await page.locator('input[name=name]').isDisabled()); assert(await page.locator('input[name=email]').isDisabled()); assert(await page.locator('input[name=displayName]').isEnabled());
  });
  await scenario('settings-profile-invitation-and-feedback-commands', {}, async ({ page, log }) => {
    await navigate(page, '/app/settings');
    const profile = page.locator('form').filter({ has: page.locator('input[name=displayName]') });
    await page.locator('input[name=displayName]').fill('Updated synthetic reviewer'); await profile.locator('button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('.account-line strong')?.textContent === 'Updated synthetic reviewer');
    const invitation = page.locator('form').filter({ has: page.locator('input[name=email]') }); await invitation.locator('input[name=email]').fill('invited-fixture@example.test'); await invitation.locator('button[type=submit]').click();
    const feedback = page.locator('form').filter({ has: page.locator('textarea[name=message]') }); await feedback.locator('textarea').fill('Synthetic feedback without personal information.'); await feedback.locator('button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('textarea[name=message]')?.value === '');
    for (const type of ['UPDATE_PROFILE', 'INVITE_MEMBER', 'SUBMIT_FEEDBACK']) assert(log.commands.some(command => command.type === type), `Settings must submit ${type}`);
    assert.equal(log.commands.find(command => command.type === 'INVITE_MEMBER').workspaceId, ids.workspace);
    assert.equal(await page.locator('input[type=email][readonly]').inputValue(), 'workspace-fixture@example.test');
    await page.locator('.settings-index a[href="#billing"]').click(); await page.locator('.workspace-language select').selectOption('es'); await page.waitForFunction(() => document.querySelector('.workspace-shell')?.getAttribute('data-locale') === 'es'); assert.equal(new URL(page.url()).hash, '#billing', 'Changing language preserves the settings section');
  });
  await scenario('quota-error-is-retryable', { commandError: 'QUOTA_EXCEEDED', empty: true }, async ({ page, log }) => {
    await navigate(page, `/app/ads/${ids.ad}`); await page.locator('form').filter({ has: page.locator('select[name=folderId]') }).locator('button[type=submit]').click();
    await page.locator('.inline-error').waitFor(); assert(!await page.locator('select[name=folderId]').isDisabled()); assert(log.commands.some(command => command.type === 'SAVE_AD'));
    const errorBefore = await page.locator('.inline-error').innerText(); await page.locator('.workspace-language select').selectOption('es'); await page.waitForFunction(before => { const current = document.querySelector('.inline-error')?.textContent?.trim(); return current && current !== before; }, errorBefore); await capture(page, 'quota-error.png');
  });
  await scenario('forbidden-workspace-state', { forbidden: true }, async ({ page }) => {
    const url = new URL('/app?lang=en', origin); url.searchParams.set('workspace', ids.workspace); await page.goto(url.href); await page.locator('.empty-state').waitFor(); assert.equal(await page.locator('.ad-card').count(), 0);
    assert.match(await page.locator('.empty-state').innerText(), /You do not have permission/); await page.locator('.workspace-language select').selectOption('es'); await page.getByText('No tienes permiso o tu acceso ha cambiado. Actualiza e inténtalo de nuevo.', { exact: true }).waitFor(); await capture(page, 'forbidden-workspace.png');
  });
  await scenario('search-loading-failure', { searchError: true }, async ({ page }) => { await navigate(page, '/app/ads'); await page.locator('.empty-state').waitFor(); assert(await page.locator('.empty-state button').isEnabled()); await capture(page, 'search-failure.png'); });
  await scenario('search-empty-results', { empty: true }, async ({ page }) => { await navigate(page, '/app/ads'); await page.locator('.empty-state').waitFor(); assert.equal(await page.locator('.ad-card').count(), 0); await capture(page, 'empty-search.png'); });
  await scenario('long-content-mobile', { long: true, viewport: viewports[1] }, async ({ page }) => { for (const path of routes) { await navigate(page, path, 'es'); await geometry(page); } await capture(page, 'long-settings-390.png'); });
  await scenario('logout-clears-session-and-returns-to-login', {}, async ({ page, log }) => {
    await navigate(page, '/app'); await page.locator('.sidebar-bottom button').last().click(); await page.waitForURL(url => url.pathname === '/login'); assert.equal(log.auth, false); await page.locator('.auth-shell').waitFor();
  });
  await check('no-browser-runtime-errors-or-unexpected-api-requests', async () => { assert.equal(counters.pageErrors, 0); assert.equal(counters.unexpectedRequests, 0); assert.equal(counters.serverMutations, 0); });
} catch (error) {
  fatalError = { errorType: error?.name ?? 'Error' }; process.exitCode = 1;
  console.error('WORKSPACE_UI_FATAL');
} finally {
  await browser?.close();
  const failed = checks.filter(check => check.status === 'failed');
  await writeFile(join(artifacts, 'workspace-ui-report.json'), JSON.stringify({ status: failed.length || fatalError ? 'FAILED' : 'PASSED', mode: 'fully intercepted synthetic UI', startedFrom: 'loopback frontend', checks, counters, screenshots, failure: fatalError ?? null }, null, 2));
  console.log(`WORKSPACE_UI_RESULT checks=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`);
  if (failed.length) process.exitCode = 1;
}
