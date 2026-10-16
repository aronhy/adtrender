/** Local Ad Spy acceptance. All API responses and creatives are synthetic.
 * No request is allowed to reach a backend or an external host.
 * SAAS_WORKSPACE_UI_URL=http://127.0.0.1:3200 SAAS_WORKSPACE_API_URL=http://127.0.0.1:3201
 * node saas/scripts/spy-ui-smoke.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ids, workspaceFixture, syntheticCreative } from './workspace-ui-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'saas/app/package.json'));
const { chromium } = require('playwright');
function localOrigin(value) {
  const url = new URL(value);
  assert(['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Use a loopback origin without credentials or parameters');
  return url.origin;
}
const origin = localOrigin(process.env.SAAS_WORKSPACE_UI_URL ?? 'http://127.0.0.1:3200');
const apiOrigin = localOrigin(process.env.SAAS_WORKSPACE_API_URL ?? 'http://127.0.0.1:3201');
const artifacts = resolve(process.env.SAAS_SPY_ARTIFACT_DIR ?? join(root, 'output/spy-ui'));
const viewports = [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 740 }];
const locales = ['zh-CN', 'zh-TW', 'en', 'es'];
const translations = {
  'zh-CN': { heading: '广告Spy', search: '搜索广告', category: ['分类待接入', '全部分类', '电商', 'Shopify', '其他', '未识别'], note: /尚无可核验数据/ },
  'zh-TW': { heading: '廣告Spy', search: '搜尋廣告', category: ['分類待接入', '全部分類', '電商', 'Shopify', '其他', '未識別'], note: /尚無可核驗資料/ },
  en: { heading: 'Ad Spy', search: 'Search ads', category: ['Categories pending integration', 'All categories', 'E-commerce', 'Shopify', 'Other', 'Unidentified'], note: /not available yet/ },
  es: { heading: 'Ad Spy', search: 'Buscar anuncios', category: ['Categorías pendientes de integración', 'Todas las categorías', 'Comercio electrónico', 'Shopify', 'Otros', 'Sin identificar'], note: /no hay datos verificables/ },
};
const checks = [], screenshots = [];
const counters = { simulatedReads: 0, simulatedWrites: 0, serverMutations: 0, blockedExternalRequests: 0, blockedWebSockets: 0, unexpectedRequests: 0, pageErrors: 0 };
const headers = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' };
const json = (route, body) => route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(body) });
let browser, fatalError;

async function fixture(viewport = viewports[0]) {
  const context = await browser.newContext({ viewport, locale: 'en', serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(12_000);
  const model = workspaceFixture(origin), log = { queries: [], commands: [] };
  page.on('pageerror', () => counters.pageErrors++);
  await context.routeWebSocket('**/*', socket => { counters.blockedWebSockets++; socket.close(); });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.href === `${origin.replace(/^http:/, 'https:')}/__workspace-fixture__/ad.svg`) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: syntheticCreative });
    if (![origin, apiOrigin].includes(url.origin)) { counters.blockedExternalRequests++; return route.abort('blockedbyclient'); }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/__workspace-fixture__/ad.svg') return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: syntheticCreative });
    if (url.pathname === '/auth/me') return json(route, { json: { ...model.state.user, identities: { email: { id: model.state.user.email, isEmailVerified: true }, google: null } } });
    if (url.pathname === '/auth/options') return json(route, { google: false });
    if (url.pathname.startsWith('/operations/')) {
      let args = {}; try { args = request.postDataJSON()?.json ?? {}; } catch {}
      if (url.pathname === '/operations/app-command') { counters.simulatedWrites++; log.commands.push(args); return json(route, { json: model.command(args) }); }
      counters.simulatedReads++; log.queries.push({ path: url.pathname, args });
      if (url.pathname === '/operations/get-app-state') {
        if (args.workspaceId) model.state.selectedWorkspace = model.state.workspaces.find(item => item.id === args.workspaceId) ?? model.state.selectedWorkspace;
        return json(route, { json: model.state });
      }
      if (url.pathname === '/operations/search-public-ads') return json(route, { json: model.search(args) });
      if (url.pathname === '/operations/get-public-ad') return json(route, { json: model.detail });
      if (url.pathname === '/operations/get-research-page') return json(route, { json: model.research(args) });
      counters.unexpectedRequests++; return route.abort('blockedbyclient');
    }
    if (url.origin === apiOrigin || /^\/(?:api|auth)(?:\/|$)/.test(url.pathname) || !['GET', 'HEAD'].includes(request.method())) { counters.unexpectedRequests++; return route.abort('blockedbyclient'); }
    // Only same-origin frontend document/module/font GETs can reach the preview.
    return route.continue();
  });
  return { context, page, model, log };
}
async function check(name, action, metadata = {}) {
  try { checks.push({ name, status: 'passed', simulated: true, ...metadata, ...await action() }); }
  catch (error) {
    checks.push({ name, status: 'failed', simulated: true, ...metadata, errorType: error?.name ?? 'Error', ...(error?.name === 'AssertionError' ? { assertion: String(error.message).slice(0, 220) } : {}) });
    console.error(`SPY_UI_CHECK_FAILED ${name}`);
  }
}
async function scenario(name, action, viewport = viewports[0]) {
  await check(name, async () => { const current = await fixture(viewport); try { return await action(current); } finally { await current.context.close(); } }, { viewport });
}
async function settle(page) { await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }); }
async function navigate(page, path = '/app/ads', locale = 'en', extra = {}) {
  const url = new URL(path, origin); url.searchParams.set('workspace', ids.workspace); url.searchParams.set('lang', locale);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(locale => document.querySelector('.workspace-shell')?.getAttribute('data-locale') === locale, locale);
  await page.locator('#main-content h1').waitFor(); await settle(page);
}
async function geometry(page) {
  const data = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, sidebar: document.querySelector('.sidebar')?.getBoundingClientRect().width, heading: document.querySelector('#main-content h1')?.textContent?.trim() }));
  assert(data.document <= data.viewport + 1, 'Page must not overflow horizontally'); return data;
}
async function capture(page, name) {
  assert(![...new URL(page.url()).searchParams.keys()].some(key => /token|invite|password/i.test(key)), 'Screenshot URL must not include secrets');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })); await settle(page);
  await page.screenshot({ path: join(artifacts, name), fullPage: true, mask: [page.locator('input[type=password]')], maskColor: '#e6e0db' }); screenshots.push(name);
}
async function openFilters(page) {
  const toggle = page.locator('.ws-mobile-filter-toggle');
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
}
async function openDates(page) { await openFilters(page); const details = page.locator('.ws-date-filter'); if (!await details.evaluate(node => node.open)) await details.locator('summary').click(); }
async function searchAction(page, action, predicate) {
  const response = page.waitForResponse(response => {
    if (new URL(response.url()).pathname !== '/operations/search-public-ads') return false;
    try { return predicate(response.request().postDataJSON()?.json ?? {}); } catch { return false; }
  });
  await action(); const result = await response; assert.equal(result.status(), 200, 'Synthetic search must succeed'); await page.locator('.ad-card').first().waitFor(); await settle(page);
  return result.request().postDataJSON().json;
}
async function sidebarWidth(page, width) { await page.waitForFunction(width => Math.abs(document.querySelector('.sidebar').getBoundingClientRect().width - width) < 1, width); }

await mkdir(artifacts, { recursive: true, mode: 0o700 });
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  for (const viewport of viewports) {
    const current = await fixture(viewport);
    try { for (const locale of locales) await check(`ad-spy-layout:${locale}:${viewport.width}`, async () => {
      const { page } = current, expected = translations[locale];
      await navigate(page, '/app/ads', locale); await page.locator('.ad-card').first().waitFor();
      assert.equal(await page.locator('#main-content h1').innerText(), expected.heading);
      assert.equal(await page.locator('.search-primary button').innerText(), expected.search);
      assert.equal(await page.locator('.workspace-language select').inputValue(), locale);
      assert.equal(await page.locator('.workspace-shell').getAttribute('lang'), locale);
      const toggle = page.locator('.ws-mobile-filter-toggle');
      if (viewport.width < 961) {
        assert(await toggle.isVisible(), 'Mobile has a filter toggle'); assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
        assert(!await page.locator('select[name=platform]').isVisible(), 'Mobile filters start closed');
        const target = await toggle.getAttribute('aria-controls'); assert(target && await page.evaluate(id => Boolean(document.getElementById(id)), target), 'Filter toggle controls a real panel');
        if (locale === 'es') await capture(page, `ad-spy-es-${viewport.width}.png`);
        await toggle.click(); assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      } else assert(!await toggle.isVisible(), 'Desktop keeps filter controls visible');
      assert(await page.locator('select[name=platform]').isVisible());
      const category = page.locator('.ws-common-filters select:disabled');
      assert.equal(await category.count(), 1, 'Categories use one pending selector');
      assert.deepEqual(await category.locator('option').allTextContents(), expected.category);
      assert.match(await page.locator('.ws-classification-note').innerText(), expected.note);
      assert.equal(await category.getAttribute('name'), null, 'Pending categories cannot enter a form submission');
      assert(await category.getAttribute('aria-describedby'), 'Pending selector describes its unavailable data');
      const data = await geometry(page);
      if (locale === 'es' && viewport.width < 961) { await openDates(page); await geometry(page); await capture(page, `ad-spy-es-${viewport.width}-filters.png`); }
      if (locale === 'zh-CN' && viewport.width === 1440) await capture(page, 'ad-spy-zh-CN-1440-expanded.png');
      return { geometry: data };
    }, { locale, viewport }); } finally { await current.context.close(); }
    console.log(`SPY_UI_LAYOUT_COMPLETE width=${viewport.width}`);
  }
  await scenario('desktop-sidebar-collapse-memory-and-workspace-switch', async ({ page, log }) => {
    await navigate(page, '/app/ads', 'zh-CN'); await sidebarWidth(page, 248);
    const toggle = page.locator('.sidebar-collapse'); await toggle.click(); await sidebarWidth(page, 76); assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    await capture(page, 'ad-spy-zh-CN-1440-collapsed.png');
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('.ad-card').first().waitFor(); await sidebarWidth(page, 76);
    assert.equal(await page.evaluate(() => localStorage.getItem('adthrender.workspace.sidebarCollapsed')), 'true');
    const workspace = page.locator('.workspace-topline-switch'); assert(await workspace.isVisible(), 'Collapsed sidebar keeps workspace switching available');
    await workspace.selectOption(ids.otherWorkspace); await page.waitForURL(url => url.pathname === '/app/ads' && url.searchParams.get('workspace') === ids.otherWorkspace);
    await page.waitForFunction(id => document.querySelector('.workspace-topline-switch')?.value === id, ids.otherWorkspace);
    assert(log.queries.some(query => query.path.endsWith('get-app-state') && query.args.workspaceId === ids.otherWorkspace));
    assert.equal(new URL(page.url()).searchParams.get('lang'), 'zh-CN'); await sidebarWidth(page, 76);
    await toggle.click(); await sidebarWidth(page, 248); assert.equal(await toggle.getAttribute('aria-expanded'), 'true'); await geometry(page);
  });
  await scenario('mobile-drawer-escape-and-filter-submission', async ({ page }) => {
    await navigate(page, '/app/ads', 'es'); const toggle = page.locator('.workspace-menu-toggle');
    for (let index = 0; index < 10; index++) { await page.keyboard.press('Tab'); assert(!await page.evaluate(() => Boolean(document.activeElement?.closest('.sidebar'))), 'Closed drawer cannot receive keyboard focus'); }
    await toggle.click(); assert.equal(await toggle.getAttribute('aria-expanded'), 'true'); assert.equal(await page.locator('.sidebar').getAttribute('role'), 'dialog');
    assert.equal(await page.locator('#main-content').evaluate(node => node.inert), true); await page.keyboard.press('Escape');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false'); assert(await toggle.evaluate(node => node === document.activeElement)); assert.equal(await page.locator('#main-content').evaluate(node => node.inert), false);
    await openFilters(page); await page.locator('select[name=platform]').selectOption('instagram');
    await searchAction(page, () => page.locator('.ws-mobile-apply').click(), args => args.platform === 'instagram');
    assert.equal(await page.locator('.ws-mobile-filter-toggle').getAttribute('aria-expanded'), 'false'); assert.equal(new URL(page.url()).searchParams.get('platform'), 'instagram'); await geometry(page);
  }, viewports[1]);
  await scenario('workspace-entry-redirect-and-overview-route', async ({ page }) => {
    await navigate(page, '/app', 'es', { q: 'synthetic', platform: 'facebook' }); await page.waitForURL(url => url.pathname === '/app/ads');
    assert.equal(new URL(page.url()).searchParams.get('workspace'), ids.workspace); assert.equal(new URL(page.url()).searchParams.get('lang'), 'es'); assert.equal(new URL(page.url()).searchParams.get('q'), 'synthetic');
    await page.locator('.sidebar a[href*="/app/overview"]').click(); await page.waitForURL(url => url.pathname === '/app/overview'); await page.locator('#main-content h1').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('workspace'), ids.workspace); assert.equal(await page.locator('.ws-ads-page').count(), 0, 'Overview remains a separate destination'); await geometry(page);
  });
  await scenario('combined-filters-clear-cursor-and-detail-return', async ({ page, log }) => {
    await navigate(page, '/app/ads', 'en', { cursor: 'synthetic-search-page-2' }); await page.locator('.ad-card').first().waitFor();
    await page.locator('input[name=q]').fill('synthetic'); await page.locator('select[name=platform]').selectOption('facebook'); await page.locator('select[name=media]').selectOption('IMAGE'); await page.locator('select[name=country]').selectOption('US');
    await openDates(page); await page.locator('input[name=startedFrom]').fill('2026-10-01'); await page.locator('input[name=startedTo]').fill('2026-10-07');
    const args = await searchAction(page, () => page.locator('.ws-date-panel button[type=submit]').click(), args => args.query === 'synthetic' && args.startedFrom === '2026-10-01');
    for (const [key, value] of Object.entries({ workspaceId: ids.workspace, platform: 'facebook', mediaType: 'IMAGE', country: 'US', startedFrom: '2026-10-01', startedTo: '2026-10-07' })) assert.equal(args[key], value, `Search operation receives ${key}`);
    assert(!args.cursor && !args.observedFrom && !args.observedTo, 'New source-start filters clear the cursor without changing observation filters');
    assert(!new URL(page.url()).searchParams.has('cursor')); assert(!Object.keys(args).some(key => /category|business|technology/i.test(key)), 'Pending category is never submitted');
    await searchAction(page, () => page.locator('.pagination button').last().click(), args => Boolean(args.cursor));
    const before = new URL(page.url()); await page.locator('.ad-card-media').first().click(); await page.locator('.back-link').waitFor();
    const returnTo = new URLSearchParams(new URL(page.url()).searchParams.get('returnTo'));
    for (const key of ['platform', 'media', 'country', 'startedFrom', 'startedTo', 'cursor']) assert.equal(returnTo.get(key), before.searchParams.get(key), `Detail retains ${key}`);
    await page.locator('.back-link').click(); await page.waitForURL(url => url.pathname === '/app/ads');
    for (const [key, value] of before.searchParams) assert.equal(new URL(page.url()).searchParams.get(key), value, `Returning restores ${key}`);
    assert(log.commands.every(command => command.type === 'PRODUCT_EVENT'), 'Browsing performs no business mutations');
  });
  await scenario('source-date-seven-days-manual-and-invalid-range', async ({ page, log }) => {
    await navigate(page); await openDates(page);
    await page.locator('.ws-date-panel select').selectOption('7');
    const values = { from: await page.locator('input[name=startedFrom]').inputValue(), to: await page.locator('input[name=startedTo]').inputValue() };
    const today = await page.evaluate(() => new Date().toISOString().slice(0, 10)); assert.equal(values.to, today); assert.equal((Date.parse(values.to) - Date.parse(values.from)) / 86_400_000, 6, 'Seven-day preset includes today');
    await searchAction(page, () => page.locator('.ws-date-panel button[type=submit]').click(), args => args.startedFrom === values.from && args.startedTo === values.to);
    await openDates(page); await page.locator('.ws-date-panel select').selectOption('custom'); await page.locator('input[name=startedFrom]').fill('2026-09-01'); await page.locator('input[name=startedTo]').fill('2026-09-15');
    await searchAction(page, () => page.locator('.ws-date-panel button[type=submit]').click(), args => args.startedFrom === '2026-09-01' && args.startedTo === '2026-09-15');
    await openDates(page); await page.locator('input[name=startedFrom]').fill('2026-09-20'); const before = page.url(), queryCount = log.queries.length;
    await page.locator('.ws-date-panel button[type=submit]').click(); await settle(page);
    assert.equal(page.url(), before, 'Invalid date range cannot navigate'); assert.equal(log.queries.length, queryCount, 'Invalid date range sends no API request');
    assert.equal(await page.locator('input[name=startedFrom]').evaluate(node => node.validity.rangeOverflow), true); assert.equal(await page.locator('.ws-date-filter').evaluate(node => node.open), true, 'Invalid range remains editable');
    await page.locator('.ws-date-panel select').selectOption('all');
    // The initial unfiltered query can be cached, so URL and form state are the acceptance evidence here.
    await page.locator('.ws-date-panel button[type=submit]').click(); await page.waitForURL(url => !url.searchParams.has('startedFrom') && !url.searchParams.has('startedTo'));
    assert.equal(await page.locator('input[name=startedFrom]').inputValue(), ''); assert.equal(await page.locator('input[name=startedTo]').inputValue(), '');
  });
  await scenario('clear-filters-and-distinct-global-query', async ({ page }) => {
    await navigate(page, '/app/ads', 'es', { q: 'synthetic', platform: 'facebook', media: 'VIDEO', country: 'US', startedFrom: '2026-09-01', startedTo: '2026-09-02', cursor: 'synthetic-search-page-2' });
    const country = page.locator('select[name=country]'); assert.notEqual(await country.locator('option[value=""]').innerText(), await country.locator('option[value=ALL]').innerText(), 'Global source queries are not unrestricted countries');
    await country.selectOption('ALL'); await searchAction(page, () => page.locator('.search-primary button').click(), args => args.country === 'ALL' && !args.cursor);
    await searchAction(page, () => page.locator('.ws-applied-filters button').click(), args => !args.query && !args.country && !args.platform && !args.mediaType && !args.startedFrom && !args.startedTo && !args.cursor);
    assert.deepEqual([...new URL(page.url()).searchParams].sort(), [['lang', 'es'], ['workspace', ids.workspace]].sort());
    assert.equal(await page.locator('input[name=q]').inputValue(), ''); assert.equal(await page.locator('select[name=platform]').inputValue(), ''); assert.equal(await country.inputValue(), '');
  });
  await check('no-runtime-errors-or-unexpected-api-requests', async () => { assert.equal(counters.pageErrors, 0); assert.equal(counters.unexpectedRequests, 0); assert.equal(counters.serverMutations, 0); });
} catch (error) { fatalError = { errorType: error?.name ?? 'Error' }; process.exitCode = 1; console.error('SPY_UI_FATAL'); }
finally {
  await browser?.close(); const failed = checks.filter(check => check.status === 'failed');
  await writeFile(join(artifacts, 'spy-ui-report.json'), JSON.stringify({ status: failed.length || fatalError ? 'FAILED' : 'PASSED', mode: 'fully intercepted synthetic UI; no backend or external calls', checks, counters, screenshots, failure: fatalError ?? null }, null, 2));
  console.log(`SPY_UI_RESULT checks=${checks.length} passed=${checks.length - failed.length} failed=${failed.length}`); if (failed.length) process.exitCode = 1;
}
