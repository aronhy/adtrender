/** Offline browser regression against a local Wasp frontend. All API/media traffic
 * is intercepted; this never reads a real session or connects to a database.
 * SAAS_WORKSPACE_UI_URL=http://127.0.0.1:3290 node scripts/ads-media-continuity-smoke.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ids, workspaceFixture, syntheticCreative } from './workspace-ui-fixture.mjs';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { chromium } = require('playwright');
const origin = new URL(process.env.SAAS_WORKSPACE_UI_URL ?? 'http://127.0.0.1:3290');
assert(['localhost', '127.0.0.1'].includes(origin.hostname) && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash, 'Local frontend origin required');
const apiOrigin = new URL(process.env.SAAS_WORKSPACE_API_URL ?? 'http://127.0.0.1:3291').origin;
assert(['localhost', '127.0.0.1'].includes(new URL(apiOrigin).hostname), 'Local API origin required');
const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  let now = Date.now();
  await page.clock.install({ time: now });
  const fixture = workspaceFixture(origin.origin);
  const counts = { searches: 0, renewals: 0, mediaReads: 0, mutations: 0 };
  const errors = [];
  page.on('pageerror', error => errors.push(error.name));
  const media = adId => ({
    id: `media-${adId}`, type: 'IMAGE', status: 'READY',
    displayUrl: `https://media.example.test/${adId}.svg?signature=${now}&expires=${now + 300_000}`,
    displayUrlExpiresAt: new Date(now + 300_000).toISOString(),
  });
  const ads = [ids.ad, ids.otherAd].map(id => ({ ...fixture.ad, id, media: [media(id)] }));
  const headers = { 'access-control-allow-origin': origin.origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' };
  const json = (route, value) => route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify({ json: value }) });
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin === 'https://media.example.test') {
      counts.mediaReads++;
      return route.fulfill(Number(url.searchParams.get('expires')) <= now
        ? { status: 403, body: 'Synthetic expired signature' }
        : { status: 200, contentType: 'image/svg+xml', body: syntheticCreative });
    }
    if (![origin.origin, apiOrigin].includes(url.origin)) return route.abort('blockedbyclient');
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/auth/me') return json(route, { ...fixture.state.user, identities: { email: { id: fixture.state.user.email, isEmailVerified: true }, google: null } });
    if (url.pathname === '/operations/get-app-state') return json(route, fixture.state);
    if (url.pathname === '/operations/search-public-ads') {
      counts.searches++;
      return json(route, { ...fixture.search(), ads: ads.map(ad => ({ ...ad, media: [media(ad.id)] })) });
    }
    if (url.pathname === '/operations/get-public-ad') {
      const args = request.postDataJSON().json;
      assert.equal(args.workspaceId, ids.workspace);
      assert.equal(args.adId, ids.ad);
      counts.renewals++;
      return json(route, { ...fixture.detail, media: [media(args.adId)] });
    }
    if (url.pathname === '/operations/app-command') { counts.mutations++; return route.abort('blockedbyclient'); }
    if (url.pathname.startsWith('/operations/') || url.origin === apiOrigin || request.method() !== 'GET') return route.abort('blockedbyclient');
    return route.continue();
  });
  await page.goto(`${origin.origin}/app/ads?workspace=${ids.workspace}&lang=en`);
  await page.waitForFunction(() => document.querySelectorAll('.ad-card img').length === 2 && [...document.querySelectorAll('.ad-card img')].every(image => image.complete && image.naturalWidth > 0 && image.closest('.media-loaded')));
  await page.evaluate(() => { window.__continuityPreviews = [...document.querySelectorAll('.ad-card img')]; });
  assert.equal(counts.searches, 1);

  now += 301_000;
  await page.clock.runFor(301_000);
  await page.locator('.workspace-language select').selectOption('es');
  await page.waitForFunction(() => document.querySelector('.workspace-shell')?.getAttribute('data-locale') === 'es');
  assert(await page.evaluate(() => window.__continuityPreviews.every((image, index) => image === document.querySelectorAll('.ad-card img')[index] && image.closest('.media-loaded'))));
  assert.equal(counts.searches, 1);
  assert.equal(counts.renewals, 0);

  await page.locator('.ad-card img').first().evaluate(image => image.dispatchEvent(new Event('error')));
  await page.locator('.ad-card .media-unavailable').first().waitFor();
  now += 301_000;
  await page.clock.runFor(301_000);
  assert.equal(counts.renewals, 0);
  assert.equal(counts.searches, 1);
  assert(await page.evaluate(() => window.__continuityPreviews[1] === document.querySelector('.ad-card img')));
  // Only this explicit click requests current media URLs.
  await page.locator('.results-heading button').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.ad-card img').length === 2 && [...document.querySelectorAll('.ad-card img')].every(image => image.complete && image.naturalWidth > 0 && image.closest('.media-loaded')));
  assert.equal(counts.searches, 2);
  assert.equal(counts.renewals, 0);
  assert(await page.evaluate(() => window.__continuityPreviews[1] === document.querySelectorAll('.ad-card img')[1]));
  assert.equal(counts.mediaReads, 3);
  assert.equal(counts.mutations, 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', synthetic: true, simulatedStaySeconds: 602, ...counts, checks: ['loaded previews survive expiry and language rerender', 'no automatic signature renewal after failure', 'manual refresh restores failed preview', 'other preview stays mounted'] }));
} finally { await browser.close(); }
