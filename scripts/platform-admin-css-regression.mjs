/** Synthetic browser regression of collateral CSS changes. BEFORE is the same
 * current DOM/build with the ten captured CSS files overlaid, not a historical
 * application build. No real auth, API, collector or provider is contacted. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ids, workspaceFixture, syntheticCreative } from './workspace-ui-fixture.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'apps/web/package.json')); const { chromium } = require('playwright');
const origin = 'http://127.0.0.1:3200', api = 'https://api.example.invalid';
const out = resolve(process.env.SAAS_ADMIN_CSS_ARTIFACT_DIR ?? join(root, 'output/platform-admin-ui/css-regression'));
const baseline = '/private/tmp/adthrender-admin-20261011/css-before';
const cssPaths = ['style.css', 'workspace.css', 'brand/brand.css', 'landing/landing.css', 'ads-library.css', 'ad-detail.css', 'ad-history-charts.css', 'workspace-content.css', 'workspace-settings.css', 'site-analytics/site-analytics.css'].map(path => `apps/web/src/client/${path}`);
// Match stylesheet source order in the current Vite CSS extraction. Appending
// the same files in a different order creates false noncolor cascade changes.
const cssDir = join(root, 'apps/web/.wasp/out/web-app/build/assets');
const compiledCss = (await Promise.all((await readdir(cssDir)).filter(file => file.endsWith('.css')).map(file => readFile(join(cssDir, file), 'utf8')))).join('\n');
const cssMarkers = { 'style.css': 'font-synthesis:none', 'workspace.css': '.workspace-shell,.workspace-session', 'brand/brand.css': '.at-brand{', 'landing/landing.css': '.lp{', 'ads-library.css': '.workspace-shell.workspace-ads-shell', 'ad-detail.css': '.workspace-shell .ws-ad-detail.ws-ad-detail-redesign', 'ad-history-charts.css': '.workspace-shell .ws-history-charts', 'workspace-content.css': '.workspace-shell :is(.ws-ads-page', 'workspace-settings.css': '.workspace-shell .workspace-settings', 'site-analytics/site-analytics.css': '.analytics-consent{' };
cssPaths.sort((one, two) => compiledCss.indexOf(cssMarkers[one.replace('apps/web/src/client/', '')]) - compiledCss.indexOf(cssMarkers[two.replace('apps/web/src/client/', '')]));
const originalCss = (await Promise.all(cssPaths.map(async path => `/* SYNTHETIC CSS BASELINE ${path} */\n` + (await readFile(join(baseline, path), 'utf8')).replace(/@import\s+(?:url\([^)]*\)|[^;]+);/g, '')))).join('\n');
const checks = [], screenshots = [], pageErrors = [], limitations = [
  'Before uses the current application DOM/build with the ten captured CSS files appended as overrides. It approximates prior styles; it is not evidence of an older application build.',
  'CSS import directives are removed. Tailwind output and any styles outside these ten files remain the current build in both modes.',
  'Only synthetic response models are used. Screenshots validate appearance and geometry, not production authentication, data, collectors or providers.',
  'Auth CSS is outside the ten-file color migration. Its own scoped CTA palette is measured for contrast and reported separately from brand-orange CTA compliance.',
];
const counters = { syntheticReads: 0, syntheticWrites: 0, serverMutations: 0, externalRequestsBlocked: 0, unexpectedOperations: 0 };
const routes = [['overview', '/app'], ['ads', '/app/ads'], ['research', '/app/research'], ['settings', '/app/settings'], ['detail', `/app/ads/${ids.ad}`], ['home', '/'], ['login', '/login']];
const headers = { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' };
await mkdir(out, { recursive: true }); const browser = await chromium.launch({ headless: true });
async function fixture(width, isPublic) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(12000); const model = workspaceFixture(origin);
  page.on('pageerror', error => pageErrors.push({ width, error: error.message }));
  const json = (route, status, body) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.href === `${origin.replace(/^http:/, 'https:')}/__workspace-fixture__/ad.svg` || url.pathname === '/__workspace-fixture__/ad.svg') return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: syntheticCreative });
    if (![origin, api].includes(url.origin)) { counters.externalRequestsBlocked++; return route.abort('blockedbyclient'); }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/auth/me') return json(route, 200, { json: isPublic ? null : { ...model.state.user, identities: { email: { id: model.state.user.email, isEmailVerified: true }, google: null } } });
    if (url.pathname === '/auth/options') return json(route, 200, { google: false });
    if (url.pathname === '/health') return json(route, 200, { status: 'SYNTHETIC', database: 'SYNTHETIC' });
    if (url.pathname.startsWith('/operations/')) {
      let args = {}; try { args = request.postDataJSON()?.json ?? {}; } catch {}
      if (url.pathname === '/operations/app-command') { counters.syntheticWrites++; return json(route, 200, { json: model.command(args) }); }
      counters.syntheticReads++;
      if (url.pathname === '/operations/get-app-state') return json(route, 200, { json: model.state });
      if (url.pathname === '/operations/search-public-ads') return json(route, 200, { json: model.search(args) });
      if (url.pathname === '/operations/get-public-ad') return json(route, 200, { json: model.detail });
      if (url.pathname === '/operations/get-research-page') return json(route, 200, { json: model.research(args) });
      counters.unexpectedOperations++; return json(route, 503, { message: 'SYNTHETIC_UNAVAILABLE' });
    }
    if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())) { counters.externalRequestsBlocked++; return route.abort('blockedbyclient'); }
    return route.continue();
  });
  return { context, page };
}
async function settle(page) {
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  await page.mouse.move(0, 0);
}
async function metrics(page) {
  return page.evaluate(() => {
    const round = n => Math.round(n * 10) / 10;
    const selectors = ['h1', 'main', 'h2', 'h3', 'button', 'input', '.ad-grid', '.ad-card', '.lp-actions', '.auth-form', '.workspace-sidebar'];
    const boxes = selectors.flatMap(selector => Array.from(document.querySelectorAll(selector)).filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').slice(0, 30).map((el, index) => { const r = el.getBoundingClientRect(); return { key: `${selector}:${index}`, text: (el.textContent ?? '').trim().slice(0, 160), x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) }; }));
    const rgb = value => { const numbers = value.match(/[\d.]+/g)?.map(Number) ?? []; const srgb = value.startsWith('color(srgb'); return srgb ? numbers.slice(0, 3).map(n => n * 255) : numbers.slice(0, 3); };
    const luminosity = color => rgb(color).map(value => { const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
    const equalColor = (one, two) => rgb(one).every((value, index) => Math.abs(value - rgb(two)[index]) < 1);
    // Compare measured CTA colors with the approved palette itself. A live
    // span swatch can interpolate color transitions and is not a color oracle.
    const orange = 'rgb(239, 119, 43)', ink = 'rgb(26, 22, 19)';
    const ctas = Array.from(document.querySelectorAll('.button.primary,.lp-button:not(.lp-secondary),.auth-button')).filter(el => el.getClientRects().length && !el.disabled).map(el => { const css = getComputedStyle(el); const a = luminosity(css.color), b = luminosity(css.backgroundColor); return { text: el.textContent.trim(), foreground: css.color, background: css.backgroundColor, contrast: round((Math.max(a, b) + .05) / (Math.min(a, b) + .05)), brandOrange: equalColor(css.backgroundColor, orange), inkText: equalColor(css.color, ink), authScoped: !!el.closest('.auth-shell') }; });
    return { references: {orange,ink}, width: innerWidth, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight, heading: document.querySelector('h1')?.textContent.trim() ?? null, boxes, ctas };
  });
}
try {
  for (const width of [1440, 390]) for (const [name, path] of routes) {
    const { context, page } = await fixture(width, ['home', 'login'].includes(name));
    try {
      const url = new URL(path, origin); url.searchParams.set('lang', 'zh-CN'); if (path.startsWith('/app')) url.searchParams.set('workspace', ids.workspace);
      await page.goto(url.href, { waitUntil: 'domcontentloaded' });
      if (path.startsWith('/app')) { await page.locator('.workspace-shell').waitFor(); await page.locator('#main-content h1').waitFor(); }
      else await page.locator('h1').waitFor();
      await settle(page); const after = await metrics(page); const afterFile = `${name}-${width}-after.png`; await page.screenshot({ path: join(out, afterFile), fullPage: true }); screenshots.push(afterFile);
      const style = await page.addStyleTag({ content: originalCss }); await settle(page); const before = await metrics(page); const beforeFile = `${name}-${width}-before.png`; await page.screenshot({ path: join(out, beforeFile), fullPage: true }); screenshots.push(beforeFile); await style.evaluate(el => el.remove());
      const differences = [];
      for (const box of after.boxes) { const prior = before.boxes.find(old => old.key === box.key); if (!prior) { differences.push({ key: box.key, reason: 'missing baseline box' }); continue; } if (prior.text !== box.text) differences.push({ key: box.key, reason: 'content changed' }); for (const field of ['x', 'y', 'width', 'height']) if (Math.abs(prior[field] - box[field]) > 1) differences.push({ key: box.key, field, before: prior[field], after: box[field] }); }
      const failures = []; if (after.documentWidth > width + 1) failures.push('current page has horizontal overflow'); if (before.documentWidth > width + 1) failures.push('approximate prior page has horizontal overflow'); if (after.heading !== before.heading) failures.push('heading changed'); if (differences.length) failures.push('noncolor layout geometry differs'); if (after.ctas.some(cta => cta.contrast < 4.5)) failures.push('primary CTA contrast below 4.5'); if (after.ctas.some(cta => !cta.authScoped && (!cta.brandOrange || !cta.inkText))) failures.push('brand primary CTA is not ink text on brand orange');
      checks.push({ name: `${name}:${width}`, status: failures.length ? 'failed' : 'passed', failures, before, after, geometryDifferences: differences, screenshots: { before: beforeFile, after: afterFile } });
      process.stdout.write(`CSS_REGRESSION ${name}:${width} ${failures.length ? 'FAILED ' + failures.join('; ') : 'passed'}\n`);
    } catch (error) { checks.push({ name: `${name}:${width}`, status: 'failed', error: String(error.message) }); process.stdout.write(`CSS_REGRESSION ${name}:${width} FAILED ${String(error.message).slice(0, 220)}\n`); }
    finally { await context.close(); }
  }
} finally {
  await browser.close(); const report = { synthetic: true, baselineMode: 'same-current-build-plus-original-css-overlay', limitations, baselineFiles: cssPaths, checks, screenshots, counters, pageErrors }; await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
  const passed = checks.filter(c => c.status === 'passed').length; const failed = checks.length - passed; const authStyles = checks.flatMap(c => (c.after?.ctas ?? []).filter(cta => cta.authScoped)).map(cta => ({ foreground: cta.foreground, background: cta.background, contrast: cta.contrast }));
  await writeFile(join(out, 'README.md'), `# SYNTHETIC CSS regression\n\n${passed} passed, ${failed} failed; ${screenshots.length} screenshots.\n\n${limitations.map(text => '- ' + text).join('\n')}\n\nAuth CTA measured palettes: ${JSON.stringify(authStyles)}.\n\nRaw checks and geometry are in report.json.\n`);
  process.stdout.write(`CSS_REGRESSION: ${passed} passed, ${failed} failed; ${screenshots.length} screenshots\n${JSON.stringify(counters)}\n`); if (failed || pageErrors.length || counters.serverMutations) process.exitCode = 1;
}
