/** Real browser -> Wasp -> isolated PostgreSQL -> outbox worker -> local SMTP.
 * The SMTP sink only accepts example.test; it never sends to external recipients.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';

const source = fileURLToPath(new URL('../', import.meta.url));
const runtime = resolve(process.env.SAAS_AUTH_RUNTIME ?? source);
const frontend = new URL(process.env.SAAS_AUTH_UI_URL ?? 'http://127.0.0.1:3100');
const backend = new URL(process.env.SAAS_AUTH_API_URL ?? 'http://127.0.0.1:3101');
const database = new URL(process.env.SAAS_TEST_DATABASE_URL ?? 'http://invalid');
for (const url of [frontend, backend, database]) assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'Only loopback services are permitted');
assert(/^\/saas_.*test/.test(database.pathname), 'Use an isolated test database');
const require = createRequire(resolve(runtime, 'app/package.json'));
const { chromium } = require('playwright');
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient({ datasources: { db: { url: database.href } } });
const output = resolve(source, '../output/auth-ui');
await mkdir(output, { recursive: true });
const messages = [], sockets = new Set();
const smtp = net.createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  socket.write('220 localhost SMTP test sink\r\n');
  let buffer = '', data = false, body = '', recipient = '', authentication = 0;
  socket.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\r\n')) {
      const index = buffer.indexOf('\r\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
      if (data) {
        if (line === '.') { messages.push({ recipient, body }); data = false; body = ''; socket.write('250 accepted locally\r\n'); }
        else body += line + '\r\n';
        continue;
      }
      if (authentication) { authentication--; socket.write(authentication ? '334 UGFzc3dvcmQ6\r\n' : '235 authenticated locally\r\n'); }
      else if (/^EHLO|^HELO/i.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (/^AUTH LOGIN/i.test(line)) { authentication = 2; socket.write('334 VXNlcm5hbWU6\r\n'); }
      else if (/^AUTH/i.test(line)) socket.write('235 authenticated locally\r\n');
      else if (/^RCPT TO:/i.test(line)) { recipient = line.match(/<([^>]+)>/)?.[1] ?? ''; socket.write(recipient.endsWith('@example.test') ? '250 accepted\r\n' : '550 test recipients only\r\n'); }
      else if (line === 'DATA') { data = true; socket.write('354 end with dot\r\n'); }
      else if (line === 'QUIT') socket.end('221 bye\r\n');
      else socket.write('250 ok\r\n');
    }
  });
});
await new Promise((resolve, reject) => { smtp.once('error', reject); smtp.listen(1025, '127.0.0.1', resolve); });
const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const failures = [];
page.on('pageerror', error => failures.push(error.name));
const checks = [];
const checked = label => { checks.push(label); console.log(`PASS ${label}`); };
const email = `ui-auth-${Date.now()}@example.test`, password = 'Local-Auth-Test-42', replacement = 'Replacement-Auth-Test-72';
async function goto(path) { await page.goto(new URL(path, frontend).href); await page.locator('.auth-shell').waitFor(); }
async function button(label) { await page.getByRole('button', { name: label, exact: true }).click(); }
async function text(value) { await page.getByText(value, { exact: true }).waitFor(); }
async function post(path, body, session) {
  const response = await fetch(new URL(path, backend), { method: 'POST', headers: { 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session}` } : {}) }, body: JSON.stringify(body) });
  const data = await response.json(); return { status: response.status, data };
}
async function flush() {
  await promisify(execFile)(resolve(runtime, 'scripts/worker.sh'), ['--once', '--mail-only'], {
    cwd: resolve(runtime, 'app'), env: { ...process.env, DATABASE_URL: database.href, SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025', SMTP_SECURE: 'false', SMTP_USERNAME: 'local', SMTP_PASSWORD: 'local', EMAIL_FROM: 'auth@example.test', BILLING_ENABLED: 'false', GOOGLE_AUTH_ENABLED: 'false', OPENAI_API_KEY: '' }, timeout: 30000,
  });
}
function tokenFor(path) {
  const message = [...messages].reverse().find(item => item.recipient === email && item.body.includes(path));
  assert(message, 'Expected local SMTP message');
  const decoded = message.body.replace(/=\r\n/g, '').replace(/=([A-F\d]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const token = decoded.match(/[?&]token=([a-f\d]{64})/i)?.[1];
  assert(token, 'Expected one-use token in received local email'); return token;
}
try {
  await goto('/signup?lang=en');
  await page.locator('[name=email]').fill(email);
  await page.locator('[name=password]').fill(password);
  await page.locator('[name=confirmPassword]').fill(password);
  await button('Create account');
  await text('Check your inbox');
  assert(await page.getByRole('button', { name: /Try again in \d+s/ }).isDisabled(), 'Immediate resend must be disabled');
  await page.screenshot({ path: resolve(output, 'mail-sent-desktop.png'), fullPage: true });
  await flush();
  const verification = tokenFor('email-verification');
  const unverified = await post('/auth/email/login', { email, password });
  assert.equal(unverified.status, 401);
  checked('Browser signup; real outbox worker delivered to local SMTP; unverified login rejected');

  await goto(`/email-verification?lang=en&token=${verification}`);
  await page.getByRole('button', { name: 'Verify my email', exact: true }).waitFor();
  assert(!new URL(page.url()).searchParams.has('token'), 'Token removed before action');
  await page.locator('.auth-language select').selectOption('es');
  assert(!new URL(page.url()).searchParams.has('token'), 'Language switch must not restore token');
  await page.locator('.auth-form button[type=submit]').click();
  await page.getByRole('link', { name: 'Iniciar sesión', exact: true }).waitFor();
  checked('Verification from received email; changing language preserves in-memory token and cleans URL');

  await goto('/login?lang=en');
  await page.locator('[name=email]').fill(email); await page.locator('[name=password]').fill(password);
  await button('Sign in');
  await page.waitForURL(url => url.pathname === '/app');
  checked('Verified password login reaches the authenticated workspace');
  const oldSession = (await post('/auth/email/login', { email, password })).data.sessionId;
  assert(typeof oldSession === 'string', 'Native Wasp session exists');
  await context.clearCookies();
  await page.evaluate(() => localStorage.clear());

  await goto('/request-password-reset?lang=en');
  await page.locator('[name=email]').fill(email); await button('Send reset link');
  await text('Check your inbox'); await flush();
  const reset = tokenFor('password-reset');
  await goto(`/password-reset?lang=en&token=${reset}`);
  await page.locator('[name=password]').fill(replacement); await page.locator('[name=confirmPassword]').fill(replacement);
  await button('Save new password'); await text('Password updated');
  await page.screenshot({ path: resolve(output, 'password-updated-desktop.png'), fullPage: true });
  assert.equal((await post('/auth/email/login', { email, password })).status, 401);
  assert.equal((await post('/operations/get-app-state', { json: {} }, oldSession)).status, 401);
  checked('Reset email received locally; new password saved; old password and prior session rejected');

  await goto('/login?lang=en');
  await page.locator('[name=email]').fill(email); await page.locator('[name=password]').fill(replacement);
  await button('Sign in'); await page.waitForURL(url => url.pathname === '/app');
  checked('New password signs in through the real browser');

  await goto(`/password-reset?lang=en&token=${reset}`);
  await page.locator('[name=password]').fill(password); await page.locator('[name=confirmPassword]').fill(password);
  await button('Save new password'); await text('This link can’t be used');
  assert(await page.getByRole('link', { name: 'Request a new link', exact: true }).isVisible());
  await goto(`/email-verification?lang=en&token=${verification}`);
  await button('Verify my email'); await text('This link can’t be used');
  assert(await page.locator('[name=email]').isVisible());
  checked('Used reset/verification links are rejected with working recovery controls');

  await goto('/login?lang=en');
  await page.locator('[name=email]').fill(`absent-${Date.now()}@example.test`);
  await page.locator('[name=password]').fill(password); await button('Sign in');
  await page.getByRole('alert').waitFor();
  assert((await page.getByRole('alert').innerText()).includes('Check your email and password'));
  await goto('/request-password-reset?lang=en');
  await page.locator('[name=email]').fill(`absent-${Date.now()}@example.test`); await button('Send reset link');
  await text('Check your inbox');
  checked('Wrong credentials show actionable feedback; absent email receives the same neutral request result');

  const pending = await db.emailDelivery.count({ where: { recipientEmail: email, encryptedPayload: { not: null } } });
  assert.equal(pending, 0); assert.equal(failures.length, 0);
  checked('Sent email payloads cleared; no browser runtime errors');
  const report = { status: 'PASSED', checks, localSmtpMessages: messages.length, externalEmailSent: false, browserErrors: failures.length };
  await writeFile(resolve(output, 'email-flow-report.json'), JSON.stringify(report, null, 2));
} finally {
  await browser.close(); await db.$disconnect();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => smtp.close(resolve));
}
