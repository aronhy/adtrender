/** Native Wasp OAuth routing rehearsal. No provider traffic or real credentials. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = process.env.SAAS_TEST_DATABASE_URL;
const database = new URL(databaseUrl ?? 'http://invalid');
assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) && /^\/saas_.*test/.test(database.pathname), 'Use an isolated local SaaS test database');
async function freePort() {
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}
async function run(enabled) {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'development', PORT: String(port), DATABASE_URL: databaseUrl,
    WASP_WEB_CLIENT_URL: 'http://localhost:3000', WASP_SERVER_URL: origin,
    JWT_SECRET: 'local-google-routing-fixture-key-only', OUTBOX_ENCRYPTION_KEY: 'c'.repeat(64),
    SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025', SMTP_USERNAME: 'local', SMTP_PASSWORD: 'local',
    EMAIL_FROM: 'research@example.test', REGISTRATION_MODE: 'invite', BILLING_ENABLED: 'false',
    GOOGLE_AUTH_ENABLED: String(enabled), GOOGLE_CLIENT_ID: enabled ? 'fixture.apps.googleusercontent.com' : '',
    GOOGLE_CLIENT_SECRET: enabled ? 'local-fixture-only' : '',
  };
  // Native state failures must occur before any token/userinfo request. An
  // accidental provider fetch is blocked inside the API child itself.
  const guard = 'globalThis.fetch=async()=>{process.stderr.write("PROVIDER_FETCH_FORBIDDEN_IN_ROUTING_TEST\\n");throw new Error("PROVIDER_FETCH_FORBIDDEN_IN_ROUTING_TEST")};';
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(guard)}`, resolve(base, 'app/.wasp/out/server/bundle/server.js')], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-20000); }); child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-20000); });
  try {
    let ready = false;
    for (let i = 0; i < 100 && child.exitCode === null; i++) {
      try { if ((await fetch(origin + '/auth/options')).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, 'Native API did not start with the explicit local fixture configuration');
    const options = await fetch(origin + '/auth/options'); assert.deepEqual(await options.json(), { google: enabled });
    assert.equal(options.headers.get('cache-control'), 'no-store');
    for (const method of ['GET', 'HEAD']) {
      const start = await fetch(origin + '/auth/GOOGLE/LOGIN/', { method, redirect: 'manual' });
      assert.equal(start.status, 302); const location = new URL(start.headers.get('location'));
      if (enabled) {
        assert.equal(location.origin, 'https://accounts.google.com');
        assert.equal(location.searchParams.get('client_id'), env.GOOGLE_CLIENT_ID);
        assert.equal(location.searchParams.get('redirect_uri'), origin + '/auth/google/callback');
        assert.deepEqual(new Set(location.searchParams.get('scope').split(' ')), new Set(['openid', 'email', 'profile']));
        assert(location.searchParams.get('state')); assert(location.searchParams.get('code_challenge'));
        assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
        assert.match(start.headers.get('set-cookie') ?? '', /HttpOnly/i);
      } else {
        assert.equal(location.href, 'http://localhost:3000/login?oauth_error=GOOGLE_UNAVAILABLE');
      }
    }
    const callback = await fetch(origin + '/auth/GOOGLE/CALLBACK/?code=fixture-unusable-code&state=fixture-no-cookie', { redirect: 'manual' });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('location'), `http://localhost:3000/login?oauth_error=${enabled ? 'GOOGLE_SIGN_IN_FAILED' : 'GOOGLE_UNAVAILABLE'}`);
    assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
    const exchange = await fetch(origin + '/auth/EXCHANGE-CODE/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'invalid' }) });
    assert.equal(exchange.status, enabled ? 401 : 403);
    assert.deepEqual(await exchange.json(), { message: enabled ? 'GOOGLE_SIGN_IN_FAILED' : 'GOOGLE_UNAVAILABLE' });
    assert(!logs.includes('PROVIDER_FETCH_FORBIDDEN_IN_ROUTING_TEST'), 'Routing attempted provider access');
    console.log(`PASS native Google routing ${enabled ? 'enabled with fixtures: PKCE, state rejection, safe callback, guarded exchange' : 'disabled with blank keys: email-compatible startup and route guards'}`);
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  }
}
await run(false);
await run(true);
