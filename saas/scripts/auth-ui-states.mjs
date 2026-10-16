/**
 * Account UI verification against a running local app. No accounts are created,
 * no email is sent, and no authentication mutation reaches the local server.
 * Run from anywhere: node saas/scripts/auth-ui-states.mjs
 * Override the loopback frontend with SAAS_AUTH_UI_URL. API states are simulated.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'saas/app/package.json'));
const { chromium } = require('playwright');
const artifacts = join(root, 'output/auth-ui');
const target = new URL(process.env.SAAS_AUTH_UI_URL ?? 'http://127.0.0.1:3100');
const loopback = hostname => ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
assert(['http:', 'https:'].includes(target.protocol) && loopback(target.hostname), 'Frontend must use loopback');
assert(!target.username && !target.password && !target.search && !target.hash, 'Frontend URL must not contain credentials or parameters');
const origin = target.origin;
const syntheticToken = 'a'.repeat(64);
const syntheticEmail = 'auth-ui@example.test';
const checks = [];
const counters = { simulatedAuthRequests: 0, blockedExternalRequests: 0, blockedUnexpectedMutations: 0, pageErrors: 0 };
const screenshots = [];
const routes = ['/login', '/signup', '/request-password-reset', '/password-reset', '/email-verification', '/login/google/callback'];
const locales = ['zh-CN', 'zh-TW', 'en', 'es'];
const viewports = [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 740 }];
let browser;

async function check(name, action, metadata = {}) {
  try {
    const evidence = await action();
    checks.push({ name, status: 'passed', ...metadata, ...(evidence ?? {}) });
  } catch (error) {
    // Playwright exceptions may contain the current URL. Never persist raw errors.
    checks.push({ name, status: 'failed', ...metadata, errorType: error?.name ?? 'Error', ...(error?.name === 'AssertionError' && !String(error.message).includes(syntheticToken) ? { assertion: String(error.message).slice(0, 180) } : {}) });
    console.error(`AUTH_UI_CHECK_FAILED ${name}`);
  }
}

function json(route, status, body) {
  return route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' }, body: JSON.stringify(body) });
}

async function newPage({ viewport = viewports[0], google = 'available', mutation } = {}) {
  const context = await browser.newContext({ viewport, locale: 'en', serviceWorkers: 'block' });
  const state = { google, googleRequests: 0, mutations: [], exchangeAddressClean: null };
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', () => { counters.pageErrors++; });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!loopback(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
      counters.blockedExternalRequests++;
      return route.abort('blockedbyclient');
    }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: {
      'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization',
    } });
    if (url.pathname === '/auth/options') {
      state.googleRequests++;
      counters.simulatedAuthRequests++;
      if (state.google === 'network') return route.abort('failed');
      return json(route, 200, { google: state.google === 'available' });
    }
    if (url.pathname === '/auth/me') return json(route, 401, { message: 'Unauthorized' });
    if (!['GET', 'HEAD'].includes(request.method())) {
      if (url.pathname.startsWith('/auth/')) {
        counters.simulatedAuthRequests++;
        state.mutations.push({ path: url.pathname, method: request.method() });
        if (url.pathname === '/auth/exchange-code') {
          const current = new URL(page.url());
          state.exchangeAddressClean = !current.hash && !current.searchParams.has('token') && !current.searchParams.has('oauth_error');
        }
        if (mutation) return mutation(route, { page, state, path: url.pathname });
      }
      counters.blockedUnexpectedMutations++;
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });
  return { context, page, state };
}

async function scenario(name, options, action) {
  await check(name, async () => {
    const fixture = await newPage(options);
    try { return await action(fixture); }
    finally { await fixture.context.close(); }
  }, { simulated: true });
}

async function navigate(page, path, lang = 'en', { token = false, fragment = '', extra = {} } = {}) {
  const url = new URL(path, origin);
  url.searchParams.set('lang', lang);
  if (token) url.searchParams.set('token', syntheticToken);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  url.hash = fragment;
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  await page.locator('.auth-heading h1').waitFor();
  await page.waitForFunction(locale => document.documentElement.lang === locale, lang);
  if (token) await page.waitForFunction(() => !new URL(location.href).searchParams.has('token'));
  if (path === '/login' || path === '/signup') {
    await page.waitForFunction(() => {
      const button = document.querySelector('.auth-google-button');
      return button && !button.querySelector('.auth-spinner');
    });
  }
  if (path === '/login/google/callback') await page.locator('.auth-alert').waitFor();
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
}

async function geometry(page) {
  const result = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('.auth-shell input')].filter(element => element.getBoundingClientRect().width > 0);
    const buttons = [...document.querySelectorAll('.auth-shell button')].filter(element => element.getBoundingClientRect().width > 0);
    const visible = [...document.querySelectorAll('.auth-shell *')].filter(element => element.getBoundingClientRect().width > 0 && getComputedStyle(element).position !== 'absolute');
    const horizontal = visible.filter(element => element.getBoundingClientRect().left < -1 || element.getBoundingClientRect().right > innerWidth + 1);
    return {
      width: innerWidth, documentWidth: document.documentElement.scrollWidth,
      overflowElements: horizontal.length,
      smallInputs: inputs.filter(element => Number.parseFloat(getComputedStyle(element).fontSize) < 16).length,
      smallButtons: buttons.filter(element => element.getBoundingClientRect().height < 43.5).length,
      brandPanelVisible: getComputedStyle(document.querySelector('.auth-brand-panel')).display !== 'none',
    };
  });
  assert(result.documentWidth <= result.width + 1, 'Document has horizontal overflow');
  assert.equal(result.overflowElements, 0, 'Visible content extends outside the viewport');
  assert.equal(result.smallInputs, 0, 'Input font is smaller than 16px');
  assert.equal(result.smallButtons, 0, 'Button height is smaller than 44px');
  assert.equal(result.brandPanelVisible, result.width > 760, 'Brand panel does not match the responsive layout');
  return result;
}

async function screenshot(page, name) {
  const current = new URL(page.url());
  assert(!current.hash && !current.searchParams.has('token'), 'Capture URL must not contain a token or fragment');
  // Only empty inputs are captured, except masked synthetic UI state evidence.
  const filled = page.locator('input').filter({ visible: true });
  const hasValues = await filled.evaluateAll(inputs => inputs.some(input => input.value));
  await page.screenshot({ path: join(artifacts, name), fullPage: true, ...(hasValues ? { mask: [filled], maskColor: '#e6e0db' } : {}) });
  screenshots.push(name);
}

async function expectAlert(page, text) {
  await page.locator('.auth-alert').filter({ hasText: text }).waitFor();
  assert((await page.locator('.auth-alert').innerText()).includes(text), 'Friendly error message is missing');
}

await mkdir(artifacts, { recursive: true, mode: 0o700 });
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true, args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  for (const viewport of viewports) {
    const fixture = await newPage({ viewport });
    try {
      for (const lang of locales) {
        for (const path of routes) {
          const slug = path === '/login/google/callback' ? 'google-callback' : path.slice(1);
          await check(`layout:${slug}:${lang}:${viewport.width}`, async () => {
            await navigate(fixture.page, path, lang, { token: path === '/password-reset' || path === '/email-verification' });
            const result = await geometry(fixture.page);
            assert.match(await fixture.page.title(), / · AdThrender$/, 'Localized page title is missing');
            if ((path === '/login' && lang === 'zh-CN' && viewport.width !== 320)
              || (path === '/signup' && lang === 'es' && viewport.width !== 1440)
              || (path === '/request-password-reset' && lang === 'zh-CN' && viewport.width === 1440)) {
              await screenshot(fixture.page, `${slug}-${lang}-${viewport.width}.png`);
            }
            return { geometry: result };
          }, { path, locale: lang, viewport, simulated: true });
        }
      }
    } finally { await fixture.context.close(); }
    console.log(`AUTH_UI_LAYOUT_COMPLETE width=${viewport.width}`);
  }

  await scenario('google-options-available', {}, async ({ page, state }) => {
    await navigate(page, '/login');
    assert(await page.locator('.auth-google-button').isEnabled(), 'Available Google button must be enabled');
    assert.equal(await page.locator('.auth-google-state').count(), 0);
    assert(state.googleRequests >= 1);
  });
  await scenario('login-resend-return-restores-signin-form', { mutation: (route, { path }) => {
    assert.equal(path, '/auth/email/resend-verification');
    return json(route, 200, { success: true });
  } }, async ({ page, state }) => {
    await navigate(page, '/login');
    await page.locator('input[name="email"]').fill(syntheticEmail);
    await page.getByRole('button', { name: 'Resend verification email', exact: true }).click();
    await page.getByRole('heading', { name: 'Check your inbox', exact: true }).waitFor();
    assert.equal(state.mutations.length, 1);
    await page.getByRole('link', { name: 'Back to sign in', exact: true }).click();
    await page.locator('input[name="email"]').waitFor();
    assert(await page.locator('input[name="password"]').isVisible(), 'Back to sign in must restore the login form');
    assert.equal(await page.locator('.auth-result').count(), 0, 'Back to sign in must clear the sent-email result');
  });
  await scenario('google-options-unconfigured', { google: 'unconfigured' }, async ({ page }) => {
    await navigate(page, '/login');
    assert(await page.locator('.auth-google-button').isDisabled());
    assert((await page.locator('.auth-google-state').innerText()).includes('isn’t enabled'));
    assert(await page.locator('input[name="email"]').isEnabled());
    await screenshot(page, 'login-google-unconfigured-1440.png');
  });
  await scenario('google-network-retry-recovers', { google: 'network' }, async ({ page, state }) => {
    await navigate(page, '/login');
    assert((await page.locator('.auth-google-state').innerText()).includes('Couldn’t check'));
    assert(await page.locator('.auth-google-button').isDisabled());
    state.google = 'available';
    await page.getByRole('button', { name: 'Try Google again', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.auth-google-button').disabled);
    assert(state.googleRequests >= 2, 'Retry must check Google availability again');
  });

  for (const status of ['network', 'rate-limit']) {
    await scenario(`password-reset-request-${status}`, { mutation: (route, { path }) => {
      assert.equal(path, '/auth/email/request-password-reset');
      return status === 'network' ? route.abort('failed') : json(route, 429, { message: 'RATE_LIMIT' });
    } }, async ({ page, state }) => {
      await navigate(page, '/request-password-reset');
      await page.locator('input[name="email"]').fill(syntheticEmail);
      await page.locator('button[type="submit"]').click();
      await expectAlert(page, status === 'network' ? 'Couldn’t connect.' : 'Too many attempts.');
      assert.equal(state.mutations.length, 1, 'Request should not be submitted more than once');
      if (status === 'rate-limit') assert(await page.locator('button[type="submit"]').isDisabled(), 'Rate limit should enforce a cooldown');
      return { interceptedMutationCount: state.mutations.length };
    });
  }

  await scenario('missing-reset-link-recovery', { viewport: viewports[1] }, async ({ page, state }) => {
    await navigate(page, '/password-reset');
    await page.getByRole('heading', { name: 'This link can’t be used' }).waitFor();
    assert.match(await page.getByRole('link', { name: 'Request a new link' }).getAttribute('href'), /^\/request-password-reset\?/);
    assert.equal(state.mutations.length, 0);
    await screenshot(page, 'invalid-reset-link-en-390.png');
  });
  await scenario('missing-verification-link-recovery', {}, async ({ page, state }) => {
    await navigate(page, '/email-verification');
    await page.getByRole('heading', { name: 'This link can’t be used' }).waitFor();
    assert(await page.locator('input[name="email"]').isVisible());
    assert(await page.getByRole('button', { name: 'Resend verification email' }).isEnabled());
    assert.equal(state.mutations.length, 0);
  });
  for (const path of ['/password-reset', '/email-verification']) {
    await scenario(`expired-link:${path.slice(1)}`, { mutation: route => json(route, 400, { message: 'AUTH_LINK_INVALID' }) }, async ({ page, state }) => {
      await navigate(page, path, 'en', { token: true });
      if (path === '/password-reset') {
        await page.locator('input[name="password"]').fill('SyntheticOnly123');
        await page.locator('input[name="confirmPassword"]').fill('SyntheticOnly123');
      }
      await page.locator('button[type="submit"]').click();
      await page.getByRole('heading', { name: 'This link can’t be used' }).waitFor();
      assert.equal(state.mutations.length, 1);
      assert(!new URL(page.url()).searchParams.has('token'));
      assert(await page.getByRole('link', { name: 'Back to sign in' }).isVisible());
      return { interceptedMutationCount: state.mutations.length };
    });
  }

  await scenario('password-visibility-and-client-validation', {}, async ({ page, state }) => {
    await navigate(page, '/signup');
    await page.locator('input[name="email"]').fill(syntheticEmail);
    const password = page.locator('input[name="password"]');
    const confirmation = page.locator('input[name="confirmPassword"]');
    await password.fill('SyntheticOnly123');
    assert.equal(await password.getAttribute('type'), 'password');
    await page.getByRole('button', { name: 'Show password', exact: true }).first().click();
    assert.equal(await password.getAttribute('type'), 'text');
    await page.getByRole('button', { name: 'Hide password', exact: true }).click();
    assert.equal(await password.getAttribute('type'), 'password');
    await confirmation.fill('DifferentOnly456');
    await page.locator('button[type="submit"]').click();
    await expectAlert(page, 'The passwords don’t match.');
    assert.equal(state.mutations.length, 0, 'Mismatch must not send a request');
    await password.fill('SyntheticWithoutNumber');
    await confirmation.fill('SyntheticWithoutNumber');
    await page.locator('button[type="submit"]').click();
    await expectAlert(page, 'Include at least one number');
    assert.equal(state.mutations.length, 0, 'Password without a number must not send a request');
  });

  await scenario('locale-switch-retains-reset-form-removes-token', {}, async ({ page, state }) => {
    await navigate(page, '/password-reset', 'en', { token: true });
    await page.locator('input[name="password"]').fill('SyntheticOnly123');
    await page.locator('input[name="confirmPassword"]').fill('SyntheticOnly123');
    await page.locator('.auth-language select').selectOption('es');
    await page.waitForFunction(() => document.documentElement.lang === 'es');
    assert(!new URL(page.url()).searchParams.has('token'), 'Locale switch must not restore the captured token');
    assert.equal(await page.locator('input[name="password"]').inputValue(), 'SyntheticOnly123', 'Locale switch must retain the form value');
    assert.equal(await page.locator('input[name="confirmPassword"]').inputValue(), 'SyntheticOnly123', 'Locale switch must retain the confirmation');
    assert.equal(state.mutations.length, 0, 'Changing language must not submit the reset token');
    assert.equal(await page.locator('.auth-result').count(), 0, 'Valid captured reset token must remain usable');
  });

  await scenario('mobile-brand-preserves-query-language-with-empty-storage', { viewport: viewports[1] }, async ({ page, state }) => {
    await navigate(page, '/login', 'es');
    assert.equal(await page.evaluate(() => localStorage.getItem('ad-research.locale')), null, 'Language must come from the URL in this scenario');
    await page.locator('.auth-mobile-brand').click();
    await page.locator('.lp-hero h1').waitFor();
    await page.waitForFunction(() => document.documentElement.lang === 'es');
    assert.equal(new URL(page.url()).pathname, '/');
    assert.equal(new URL(page.url()).searchParams.get('lang'), 'es', 'Mobile brand must preserve the selected language');
    assert.equal(await page.locator('.lp-language select').inputValue(), 'es');
    assert.equal(state.mutations.length, 0, 'Brand navigation must not submit authentication requests');
  });

  await scenario('google-callback-fragment-removed-before-exchange', { mutation: (route, { path }) => {
    assert.equal(path, '/auth/exchange-code');
    return json(route, 400, { message: 'AUTH_LINK_INVALID' });
  } }, async ({ page, state }) => {
    await navigate(page, '/login/google/callback', 'en', { fragment: syntheticToken });
    assert.equal(state.exchangeAddressClean, true, 'Callback address must be cleaned before exchanging the code');
    assert.equal(state.mutations.length, 1, 'One-use callback code must only be exchanged once');
    assert.equal(new URL(page.url()).hash, '');
    await expectAlert(page, 'incomplete, expired, or already used');
    assert(await page.getByRole('link', { name: 'Back to sign in' }).isVisible());
    await screenshot(page, 'google-callback-invalid-en-1440.png');
  });
  await scenario('google-callback-provider-error-cleans-address', {}, async ({ page, state }) => {
    await navigate(page, '/login/google/callback', 'en', { fragment: syntheticToken, extra: { oauth_error: 'EMAIL_ACCOUNT_EXISTS' } });
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(new URL(page.url()).searchParams.get('oauth_error'), null);
    await expectAlert(page, 'already has a password account');
    assert.equal(state.mutations.length, 0, 'Provider error must not attempt code exchange');
  });
  await check('no-runtime-errors', () => { assert.equal(counters.pageErrors, 0, 'Browser runtime errors occurred'); });
  await check('all-mutations-intercepted-as-expected', () => { assert.equal(counters.blockedUnexpectedMutations, 0, 'An unexpected mutation was blocked'); });
} catch (error) {
  checks.push({ name: 'runner', status: 'failed', errorType: error?.name ?? 'Error' });
} finally {
  await browser?.close();
}

const failed = checks.filter(check => check.status === 'failed');
const report = {
  status: failed.length ? 'AUTH_UI_STATES_FAILED' : 'AUTH_UI_STATES_VERIFIED',
  frontend: origin, generatedAt: new Date().toISOString(),
  scope: 'UI layout and simulated API states only; no real email, OAuth, account creation, or server lifecycle acceptance.',
  simulated: true, syntheticOnly: true, realMutationsSent: false, externalRequestsAllowed: false,
  matrix: { routes: routes.length, languages: locales.length, viewports: viewports.map(viewport => viewport.width), expectedCases: 72 },
  summary: { passed: checks.length - failed.length, failed: failed.length }, counters, screenshots, checks,
};
await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ status: report.status, ...report.summary, screenshots: screenshots.length, report: join(artifacts, 'report.json'), failedChecks: failed.map(check => check.name) }));
if (failed.length) process.exitCode = 1;
