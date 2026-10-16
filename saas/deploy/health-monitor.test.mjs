import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runMonitor } from './health-monitor.mjs';

const healthy = { status: 'ok', api: 'ok', database: 'ok', worker: 'ok', source: 'ok', email: 'ok' };
async function fixture(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'health-monitor-'));
  await chmod(directory, 0o700);
  const state = { health: { ...healthy }, healthStatus: 200, healthMode: 'json', webhookStatus: 204, webhookDelay: 0, webhookGate: null, webhookEntered: null, healthCalls: 0, posts: [] };
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/health')) {
      state.healthCalls++;
      if (state.healthMode === 'network') { req.socket.destroy(); return; }
      if (state.healthMode === 'timeout') { setTimeout(() => res.end('{}'), 300).unref(); return; }
      res.writeHead(state.healthStatus, { 'content-type': state.healthMode === 'html' ? 'text/html' : 'application/json' });
      res.end(state.healthMode === 'html' ? '<html>PRIVATE_HEALTH_BODY</html>' : state.healthMode === 'oversized' ? 'x'.repeat(70_000) : JSON.stringify(state.health)); return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    state.posts.push({ path: req.url, body: JSON.parse(body), authorization: req.headers.authorization, idempotencyKey: req.headers['idempotency-key'] });
    state.webhookEntered?.();
    if (state.webhookGate) await state.webhookGate;
    if (state.webhookDelay) await new Promise(resolve => setTimeout(resolve, state.webhookDelay));
    res.writeHead(state.webhookStatus, { 'content-type': 'text/plain', ...(state.webhookStatus === 302 ? { location: '/redirect-target' } : {}) });
    res.end(state.webhookStatus === 204 ? undefined : 'PRIVATE_PROVIDER_BODY');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { MONITOR_ENABLED: 'true', MONITOR_SERVICE_ID: 'ad-research-test', MONITOR_HEALTH_URL: `${base}/health`, MONITOR_WEBHOOK_URL: 'https://alerts.invalid/hook', MONITOR_WEBHOOK_TOKEN: 'LOCAL_FIXTURE_SECRET_TOKEN', MONITOR_STATE_DIR: directory, MONITOR_TIMEOUT_MS: '1000' };
  // Keep the real HTTP requests and responses; only route the configured HTTPS receiver to a local fixture.
  const fetchImpl = (url, options) => {
    const target = new URL(url);
    if (target.origin === 'https://alerts.invalid') return fetch(`${base}${target.pathname}`, options);
    assert.equal(target.origin, base, 'tests must never contact an external service');
    return fetch(url, options);
  };
  const run = overrides => runMonitor({ env: { ...env, ...overrides }, fetchImpl });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { state, env, run, fetchImpl, directory, stateFile: join(directory, 'state.json') };
}

test('acknowledged status changes notify once, recovery notifies, and later incidents get a new event id', async t => {
  const f = await fixture(t);
  assert.equal((await f.run()).status, 'SENT');
  assert.equal((await f.run()).status, 'UNCHANGED');
  f.state.health.worker = 'unavailable'; assert.equal((await f.run()).event, 'alert');
  assert.equal((await f.run()).status, 'UNCHANGED');
  f.state.health.source = 'paused'; assert.equal((await f.run()).event, 'change');
  f.state.health = { ...healthy }; assert.equal((await f.run()).event, 'recovery');
  f.state.health.worker = 'unavailable'; await f.run();
  assert.deepEqual(f.state.posts.map(p => p.body.event), ['initial', 'alert', 'change', 'recovery', 'alert']);
  assert.notEqual(f.state.posts[1].idempotencyKey, f.state.posts[4].idempotencyKey);
  assert.equal((await stat(f.stateFile)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(f.directory), ['state.json']);
});

test('failed notification leaves acknowledgement untouched and retries with the same idempotency key', async t => {
  const f = await fixture(t); assert.equal((await f.run()).status, 'SENT'); const previous = await readFile(f.stateFile, 'utf8');
  f.state.health.email = 'attention'; f.state.webhookStatus = 500;
  const failed = await f.run(); assert.equal(failed.errorCode, 'WEBHOOK_HTTP_ERROR');
  assert.equal(await readFile(f.stateFile, 'utf8'), previous);
  f.state.webhookStatus = 204; assert.equal((await f.run()).status, 'SENT');
  assert.equal(f.state.posts[1].idempotencyKey, f.state.posts[2].idempotencyKey);
  assert.equal((await f.run()).status, 'UNCHANGED');
});

test('changing receiver credentials, receiver URL, health URL or service identity never inherits a silent acknowledgement', async t => {
  const f = await fixture(t); await f.run();
  for (const override of [{ MONITOR_WEBHOOK_TOKEN: 'REPLACED_RECEIVER_CREDENTIAL' }, { MONITOR_WEBHOOK_URL: 'https://alerts.invalid/new-hook' }, { MONITOR_HEALTH_URL: `${f.env.MONITOR_HEALTH_URL}-new` }, { MONITOR_SERVICE_ID: 'another-service' }]) {
    assert.equal((await f.run(override)).event, 'initial');
  }
  assert.equal(f.state.posts.length, 5);
});

test('dry run reads health but sends nothing and writes no acknowledged state', async t => {
  const f = await fixture(t);
  const result = await runMonitor({ env: f.env, argv: ['--dry-run'], fetchImpl: f.fetchImpl });
  assert.equal(result.status, 'DRY_RUN'); assert.equal(result.wouldNotify, true);
  assert.equal(f.state.healthCalls, 1); assert.equal(f.state.posts.length, 0); assert.deepEqual(await readdir(f.directory), []);
  await f.run(); const before = await readFile(f.stateFile, 'utf8');
  f.state.health.worker = 'unavailable';
  await runMonitor({ env: f.env, argv: ['--dry-run'], fetchImpl: f.fetchImpl });
  assert.equal(await readFile(f.stateFile, 'utf8'), before); assert.equal(f.state.posts.length, 1);
});

test('a live exclusive lock suppresses a second instance and existing locks are never guessed stale', async t => {
  const f = await fixture(t); let release;
  f.state.webhookGate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { f.state.webhookEntered = resolve; });
  const first = f.run(); await Promise.race([entered, first.then(result => assert.equal(result.status, 'SENT'))]);
  try {
    assert.equal((await stat(join(f.directory, 'monitor.lock'))).mode & 0o777, 0o600);
    assert.equal((await f.run()).status, 'SKIPPED_LOCKED');
    assert.equal(f.state.posts.length, 1);
  } finally { release(); await first; }
  await writeFile(join(f.directory, 'monitor.lock'), 'operator-must-check', { mode: 0o600 });
  assert.equal((await f.run()).status, 'SKIPPED_LOCKED');
  assert.equal(await readFile(join(f.directory, 'monitor.lock'), 'utf8'), 'operator-must-check');
});

test('health network, timeout, non-JSON, invalid schema, HTTP and oversized responses stay distinct', async t => {
  const f = await fixture(t);
  for (const item of [
    { mode: 'network', wanted: 'network_error' }, { mode: 'timeout', wanted: 'timeout' },
    { mode: 'html', wanted: 'non_json' }, { mode: 'json', health: { privateEmail: 'PRIVATE@example.test' }, wanted: 'invalid_payload' },
    { mode: 'json', code: 503, wanted: 'http_error' }, { mode: 'oversized', wanted: 'response_too_large' },
  ]) {
    f.state.healthMode = item.mode; f.state.healthStatus = item.code || 200; f.state.health = item.health || { ...healthy, database: 'unavailable' };
    const result = await f.run({ MONITOR_TIMEOUT_MS: '100' });
    assert.equal(result.status, 'SENT'); assert.equal(result.snapshot.probe, item.wanted);
  }
});

test('webhook timeout and redirect neither acknowledge nor forward credentials', async t => {
  const f = await fixture(t); f.state.webhookDelay = 300;
  assert.equal((await f.run({ MONITOR_TIMEOUT_MS: '100' })).errorCode, 'WEBHOOK_TIMEOUT');
  assert.deepEqual(await readdir(f.directory), []);
  f.state.webhookDelay = 0; f.state.webhookStatus = 302;
  assert.equal((await f.run()).errorCode, 'WEBHOOK_NETWORK_ERROR');
  assert.deepEqual(await readdir(f.directory), []);
  assert.equal(f.state.posts.some(p => p.path === '/redirect-target'), false);
  f.state.webhookStatus = 204; assert.equal((await f.run()).status, 'SENT');
});

test('only allowlisted state leaves the health boundary and credentials appear solely in the authorization header', async t => {
  const f = await fixture(t);
  f.state.health = { ...healthy, source: 'PRIVATE_SOURCE_TOKEN', privateEmail: 'PRIVATE@example.test', secret: f.env.MONITOR_WEBHOOK_TOKEN, url: f.env.MONITOR_HEALTH_URL };
  const result = await f.run();
  assert.equal(result.status, 'SENT');
  assert.equal(result.snapshot.components.source, 'unknown');
  assert.equal(result.snapshot.probe, 'invalid_payload');
  const outputs = JSON.stringify({ result, payload: f.state.posts[0].body, state: JSON.parse(await readFile(f.stateFile, 'utf8')) });
  for (const secret of ['PRIVATE_SOURCE_TOKEN', 'PRIVATE@example.test', f.env.MONITOR_WEBHOOK_TOKEN, f.env.MONITOR_HEALTH_URL, f.env.MONITOR_WEBHOOK_URL]) assert.ok(!outputs.includes(secret));
  assert.equal(f.state.posts[0].authorization, `Bearer ${f.env.MONITOR_WEBHOOK_TOKEN}`);
});

test('disabled or incomplete configuration sends nothing; unsafe endpoint configuration is rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.run({ MONITOR_ENABLED: 'false' })).status, 'NOT_ENABLED');
  assert.equal((await f.run({ MONITOR_WEBHOOK_TOKEN: '' })).status, 'NOT_ENABLED');
  for (const override of [{ MONITOR_WEBHOOK_URL: 'http://alerts.invalid/hook' }, { MONITOR_WEBHOOK_URL: 'https://alerts.invalid/hook?token=SECRET' }, { MONITOR_HEALTH_URL: 'http://public.example/health' }, { MONITOR_HEALTH_URL: 'https://user:pass@example.test/health' }]) assert.equal((await f.run(override)).errorCode, 'CONFIGURATION_INVALID');
  assert.equal(f.state.healthCalls, 0); assert.equal(f.state.posts.length, 0);
});

test('unsafe permissions and symlinked acknowledgement files fail closed before any delivery', async t => {
  const f = await fixture(t);
  await chmod(f.directory, 0o755);
  assert.equal((await f.run()).errorCode, 'STATE_DIRECTORY_UNSAFE');
  await chmod(f.directory, 0o700);
  await writeFile(join(f.directory, 'private-file'), 'PRIVATE_CONTENT', { mode: 0o600 });
  await symlink(join(f.directory, 'private-file'), f.stateFile);
  assert.equal((await f.run()).errorCode, 'STATE_FILE_UNSAFE');
  assert.equal(f.state.posts.length, 0); assert.equal(await readFile(join(f.directory, 'private-file'), 'utf8'), 'PRIVATE_CONTENT');
});

test('the actual CLI dry run prints only safe JSON and never emits environment or health-body secrets', async t => {
  const f = await fixture(t);
  f.state.health = { ...healthy, source: 'PRIVATE_SOURCE', privateEmail: 'PRIVATE_EMAIL', authorization: f.env.MONITOR_WEBHOOK_TOKEN };
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./health-monitor.mjs', import.meta.url)), '--dry-run'], { env: { ...process.env, ...f.env } });
  assert.equal(JSON.parse(stdout).status, 'DRY_RUN'); assert.equal(stderr, '');
  for (const secret of ['PRIVATE_SOURCE', 'PRIVATE_EMAIL', f.env.MONITOR_WEBHOOK_TOKEN, f.env.MONITOR_HEALTH_URL, f.env.MONITOR_WEBHOOK_URL]) assert.ok(!`${stdout}${stderr}`.includes(secret));
  assert.equal(f.state.posts.length, 0); assert.deepEqual(await readdir(f.directory), []);
});
