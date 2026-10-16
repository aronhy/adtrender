// Runs only against the disposable Compose project created by Verify.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { createRequire } from 'node:module';

assert.equal(process.env.SELFHOST_SMOKE, '1', 'Explicit smoke-test opt-in required');
assert.equal(process.env.COMPOSE_PROJECT_NAME, 'adtrender-ci', 'Disposable Compose project required');
const root = new URL('../../', import.meta.url);
const require = createRequire(new URL('package.json', root));
const { chromium } = require('playwright');
const ca = await readFile(process.env.SELFHOST_CA_FILE);
const customer = 'https://localhost', admin = 'https://admin.localhost', api = 'https://api.localhost';
const password = `Smoke-${randomUUID()}!`;
const owner = 'owner@example.test', member = 'member@example.test';
const checks = [];
let browser, stage = 'startup';
const checked = name => { checks.push(name); console.log(`SELFHOST_PASS ${name}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function apiRequest(path, body, session, origin = customer) {
  assert(path.startsWith('/auth/') || path.startsWith('/operations/') || path === '/health');
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, api), {
      ca, method: body === undefined ? 'GET' : 'POST', timeout: 15000,
      // Resolve only this isolated stack; TLS still checks api.localhost and its CA.
      lookup: (_host, options, callback) => options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4),
      headers: { origin, 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session}` } : {}) },
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, data: JSON.parse(text), cors: response.headers['access-control-allow-origin'] }); }
        catch { reject(new Error('API_JSON_REQUIRED')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('API_TIMEOUT')));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function operation(name, payload, session, expected = 200, origin = customer) {
  const result = await apiRequest(`/operations/${name}`, { json: payload }, session, origin);
  assert.equal(result.status, expected);
  assert.equal(result.cors, origin);
  return result.data.json;
}

async function verificationLink(email) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const response = await fetch('http://127.0.0.1:8025/api/v1/messages', { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const { messages } = await response.json();
    const match = messages.find(message => message.To.some(to => to.Address === email));
    if (match) {
      const response = await fetch(`http://127.0.0.1:8025/api/v1/message/${encodeURIComponent(match.ID)}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      const message = await response.json();
      const links = `${message.Text}\n${message.HTML}`.match(/https:\/\/localhost\/email-verification\?[^\s<>"']+/g) ?? [];
      for (const value of links) {
        const link = new URL(value.replaceAll('&amp;', '&'));
        if (link.origin === customer && link.pathname === '/email-verification' && /^[a-f\d]{64}$/.test(link.searchParams.get('token') ?? '')) return link;
      }
      throw new Error('VERIFICATION_LINK_REQUIRED');
    }
    await sleep(1000);
  }
  throw new Error('MAIL_DELIVERY_TIMEOUT');
}

async function signIn(page, origin, email) {
  await page.goto(`${origin}/login?lang=en`);
  await page.locator('[name=email]').fill(email);
  await page.locator('[name=password]').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(url => url.origin === origin && url.pathname === (origin === admin ? '/app/admin' : '/app'));
}

try {
  const deadline = Date.now() + 60000;
  let healthy = false;
  while (Date.now() < deadline) {
    const result = await apiRequest('/health');
    if (result.status === 200 && ['api', 'database', 'worker', 'email'].every(key => result.data[key] === 'ok')) { healthy = true; break; }
    await sleep(1000);
  }
  assert(healthy, 'API, database, full worker and email must be ready');
  // A fresh instance has no verified collection source, so overall health may be degraded.
  checked('fresh-database-migrations-api-and-worker-ready');
  browser = await chromium.launch({ channel: 'chromium', headless: true, chromiumSandbox: true, args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1'] });
  // Caddy's private CA is checked separately by apiRequest and the HTTPS routing step.
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const browserErrors = [];
  context.on('page', page => page.on('pageerror', error => browserErrors.push(error.name)));
  page.on('pageerror', error => browserErrors.push(error.name));
  const sessions = new Map();
  for (const email of [owner, member]) {
    stage = email === owner ? 'owner-registration' : 'member-registration';
    await context.clearCookies();
    await page.goto(`${customer}/signup?lang=en`);
    await page.locator('[name=email]').fill(email);
    await page.locator('[name=password]').fill(password);
    await page.locator('[name=confirmPassword]').fill(password);
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.getByText('Check your inbox', { exact: true }).waitFor();
    assert.equal((await apiRequest('/auth/email/login', { email, password })).status, 401);
    stage = 'worker-smtp-verification';
    const link = await verificationLink(email);
    link.searchParams.set('lang', 'en');
    await page.goto(link.href);
    await page.getByRole('button', { name: 'Verify my email', exact: true }).waitFor();
    assert(!new URL(page.url()).searchParams.has('token'));
    await page.getByRole('button', { name: 'Verify my email', exact: true }).click();
    await page.getByRole('link', { name: 'Sign in', exact: true }).waitFor();
    await signIn(page, customer, email);
    const result = await apiRequest('/auth/email/login', { email, password });
    assert.equal(result.status, 200);
    assert.equal(typeof result.data.sessionId, 'string');
    sessions.set(email, result.data.sessionId);
    const state = await operation('get-app-state', {}, result.data.sessionId);
    assert.equal(state.user.isAdmin, false, 'Allowlisted accounts must not be elevated automatically');
    await operation('app-command', { type: 'CREATE_ORGANIZATION', name: `Smoke ${email}`, workspaceName: `Smoke ${email}` }, result.data.sessionId);
    await page.evaluate(() => localStorage.clear());
  }
  checked('browser-registration-real-worker-mailpit-verification-and-login');

  stage = 'ordinary-user-admin-denial';
  const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const dashboard = { module: 'dashboard', payload: { view: 'overview', from: day, to: day } };
  const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const adminPage = await adminContext.newPage();
  adminPage.on('pageerror', error => browserErrors.push(error.name));
  await signIn(adminPage, admin, member);
  await adminPage.getByText('Your account has no active platform administration permission. Contact a platform administrator.', { exact: true }).waitFor();
  await operation('get-platform-admin-data', dashboard, sessions.get(member), 403, admin);
  checked('ordinary-user-denied-by-administrator-ui-and-api');

  stage = 'explicit-admin-grant';
  const granted = JSON.parse(execFileSync('docker', ['compose', 'exec', '-T', 'api', 'node', '--import', 'tsx', 'src/team/admin-cli.ts', 'grant-admin', '--email', owner], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(granted.result.isAdmin, true);
  await adminPage.evaluate(() => localStorage.clear());
  await adminContext.clearCookies();
  await signIn(adminPage, admin, owner);
  await adminPage.locator('.platform-admin .pa-tabs').waitFor();
  await operation('get-platform-admin-data', dashboard, sessions.get(owner), 200, admin);
  await operation('get-platform-admin-data', dashboard, sessions.get(member), 403, admin);
  checked('explicit-cli-grant-and-administrator-browser-login');

  stage = 'customer-to-admin-navigation';
  await page.goto(`${customer}/app/admin?lang=en&token=discarded`);
  await page.waitForURL(url => url.origin === admin);
  assert(!new URL(page.url()).searchParams.has('token'));
  checked('customer-management-link-stays-on-self-hosted-instance');

  stage = 'garage-storage';
  const storage = await readFile(new URL('./storage-smoke.mjs', import.meta.url), 'utf8');
  const output = execFileSync('docker', ['compose', 'exec', '-T', '-e', 'SELFHOST_SMOKE=1', 'api', 'node', '--import', 'tsx', '--input-type=module'], { input: storage, encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] });
  process.stdout.write(output);
  assert.equal(browserErrors.length, 0, 'Browser runtime errors must be absent');
  checked('no-browser-runtime-errors');
  console.log(JSON.stringify({ status: 'PASSED', checks, externalEmailSent: false, externalProvidersUsed: false }));
} catch (error) {
  // Never print tokens, signed URLs, request bodies, CLI stderr or provider errors.
  const storageFailure = String(error.stderr ?? '').match(/^SELFHOST_STORAGE_FAILED stage=[a-z-]+ kind=[A-Za-z]+$/m);
  if (storageFailure) console.error(storageFailure[0]);
  console.error(`SELFHOST_SMOKE_FAILED stage=${stage} kind=${error.name}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
