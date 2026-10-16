import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const states = {
  api: ['ok', 'unavailable', 'unknown'], database: ['ok', 'unavailable', 'unknown'],
  worker: ['ok', 'unavailable', 'unknown'], source: ['ok', 'paused', 'unconfigured', 'error', 'stale', 'unknown'],
  email: ['ok', 'attention', 'unknown'],
};
const probes = ['ok', 'timeout', 'network_error', 'http_error', 'non_json', 'invalid_payload', 'response_too_large'];
const sha = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
class MonitorError extends Error {
  constructor(code, field) { super(code); this.code = code; this.field = field; }
}
const fail = (code, field) => { throw new MonitorError(code, field); };

function url(value, field, webhook = false) {
  let parsed; try { parsed = new URL(value); } catch { fail('CONFIGURATION_INVALID', field); }
  const loopback = ['127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== 'https:' && (webhook || parsed.protocol !== 'http:' || !loopback))) fail('CONFIGURATION_INVALID', field);
  return parsed.href;
}
function configuration(env, argv) {
  if (argv.length > 1 || (argv.length && argv[0] !== '--dry-run')) fail('INVALID_ARGUMENTS');
  if (!env.MONITOR_ENABLED || env.MONITOR_ENABLED === 'false') return { status: 'NOT_ENABLED', reason: 'DISABLED', exitCode: 0 };
  if (env.MONITOR_ENABLED !== 'true') fail('CONFIGURATION_INVALID', 'MONITOR_ENABLED');
  const required = ['MONITOR_SERVICE_ID', 'MONITOR_HEALTH_URL', 'MONITOR_WEBHOOK_URL', 'MONITOR_WEBHOOK_TOKEN', 'MONITOR_STATE_DIR'];
  const missing = required.filter(name => !env[name]?.trim());
  if (missing.length) return { status: 'NOT_ENABLED', reason: 'CONFIGURATION_REQUIRED', missing, exitCode: 2 };
  if (!/^[a-z0-9][a-z0-9._-]{0,47}$/.test(env.MONITOR_SERVICE_ID)) fail('CONFIGURATION_INVALID', 'MONITOR_SERVICE_ID');
  if (!/^[\x21-\x7e]{1,512}$/.test(env.MONITOR_WEBHOOK_TOKEN)) fail('CONFIGURATION_INVALID', 'MONITOR_WEBHOOK_TOKEN');
  if (!isAbsolute(env.MONITOR_STATE_DIR)) fail('CONFIGURATION_INVALID', 'MONITOR_STATE_DIR');
  const timeoutMs = Number(env.MONITOR_TIMEOUT_MS || 5000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) fail('CONFIGURATION_INVALID', 'MONITOR_TIMEOUT_MS');
  const config = {
    service: env.MONITOR_SERVICE_ID, health: url(env.MONITOR_HEALTH_URL, 'MONITOR_HEALTH_URL'),
    webhook: url(env.MONITOR_WEBHOOK_URL, 'MONITOR_WEBHOOK_URL', true), token: env.MONITOR_WEBHOOK_TOKEN,
    directory: resolve(env.MONITOR_STATE_DIR), timeoutMs, dryRun: argv.includes('--dry-run'),
  };
  // Receiver credentials can select a different destination even when its URL stays the same.
  config.binding = sha(JSON.stringify([config.service, config.health, config.webhook, sha(config.token)]));
  return config;
}
function snapshot(probe, httpStatus = null, components = Object.fromEntries(Object.keys(states).map(key => [key, 'unknown']))) {
  return { probe, httpStatus, components, status: probe === 'ok' && Object.values(components).every(value => value === 'ok') ? 'ok' : 'degraded' };
}
async function discard(response) { try { await response.body?.cancel(); } catch { /* Never log provider bodies. */ } }
async function boundedText(response) {
  const reader = response.body?.getReader(); if (!reader) return '';
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength; if (size > 65_536) fail('RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(item.value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { try { await reader.cancel(); } catch {} }
}
async function readHealth(config, fetchImpl) {
  const signal = AbortSignal.timeout(config.timeoutMs); let httpStatus = null;
  try {
    const response = await fetchImpl(config.health, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { accept: 'application/json' }, signal });
    httpStatus = response.status;
    if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) { await discard(response); return snapshot('non_json', httpStatus); }
    let data; const text = await boundedText(response);
    try { data = JSON.parse(text); } catch { return snapshot('non_json', httpStatus); }
    let invalid = !data || typeof data !== 'object' || Array.isArray(data);
    const components = Object.fromEntries(Object.entries(states).map(([key, allowed]) => {
      const value = data?.[key]; if (typeof value === 'string' && allowed.includes(value)) return [key, value];
      invalid = true; return [key, 'unknown'];
    }));
    return snapshot(invalid ? 'invalid_payload' : response.ok ? 'ok' : 'http_error', httpStatus, components);
  } catch (error) {
    return snapshot(error instanceof MonitorError && error.code === 'RESPONSE_TOO_LARGE' ? 'response_too_large' : signal.aborted ? 'timeout' : 'network_error', httpStatus);
  }
}

async function requireSafeDirectory(directory) {
  let info; try { info = await lstat(directory); } catch { fail('STATE_DIRECTORY_REQUIRED'); }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 || await realpath(directory) !== directory) fail('STATE_DIRECTORY_UNSAFE');
}
async function acquire(directory) {
  const path = join(directory, 'monitor.lock'); let handle;
  try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === 'EEXIST') return null; fail('LOCK_ACQUIRE_FAILED'); }
  const info = await handle.stat();
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await handle.sync(); }
  catch { await handle.close(); await unlink(path); fail('LOCK_ACQUIRE_FAILED'); }
  return async () => {
    await handle.close();
    let current; try { current = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; fail('LOCK_RELEASE_FAILED'); }
    if (current.ino === info.ino && current.dev === info.dev) await unlink(path);
  };
}
function validSnapshot(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 4 &&
    probes.includes(value.probe) && (value.httpStatus === null || Number.isInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599) &&
    value.components && Object.keys(value.components).length === 5 && Object.entries(states).every(([key, allowed]) => allowed.includes(value.components[key])) &&
    value.status === snapshot(value.probe, value.httpStatus, value.components).status;
}
async function readState(directory) {
  let handle;
  try { handle = await open(join(directory, 'state.json'), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error.code === 'ENOENT') return null; fail('STATE_FILE_UNSAFE'); }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.size > 8192) fail('STATE_FILE_UNSAFE');
    let value; try { value = JSON.parse(await handle.readFile('utf8')); } catch { fail('STATE_FILE_INVALID'); }
    if (!value || value.version !== 1 || !hex(value.binding) || !hex(value.fingerprint) || !hex(value.ackId) || !validSnapshot(value.snapshot) || value.fingerprint !== sha(JSON.stringify(value.snapshot)) || typeof value.acknowledgedAt !== 'string' || !Number.isFinite(Date.parse(value.acknowledgedAt))) fail('STATE_FILE_INVALID');
    return value;
  } finally { await handle.close(); }
}
async function acknowledge(directory, state) {
  const temporary = join(directory, `state-${randomUUID()}.tmp`); let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(state)}\n`); await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, join(directory, 'state.json'));
    const folder = await open(directory, constants.O_RDONLY); try { await folder.sync(); } finally { await folder.close(); }
  } catch { fail('STATE_WRITE_FAILED'); }
  finally { await handle?.close(); try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') fail('STATE_WRITE_FAILED'); } }
}
async function notify(config, payload, fetchImpl) {
  const signal = AbortSignal.timeout(config.timeoutMs);
  try {
    const response = await fetchImpl(config.webhook, {
      method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}`, 'idempotency-key': payload.eventId }, body: JSON.stringify(payload),
    });
    const accepted = response.ok, httpStatus = response.status; await discard(response);
    return accepted ? { accepted: true, httpStatus } : { accepted: false, errorCode: 'WEBHOOK_HTTP_ERROR', httpStatus };
  } catch { return { accepted: false, errorCode: signal.aborted ? 'WEBHOOK_TIMEOUT' : 'WEBHOOK_NETWORK_ERROR' }; }
}
async function execute(config, fetchImpl) {
  await requireSafeDirectory(config.directory);
  const release = config.dryRun ? null : await acquire(config.directory);
  if (!config.dryRun && !release) return { status: 'SKIPPED_LOCKED', exitCode: 0 };
  try {
    const saved = await readState(config.directory);
    const previous = saved?.binding === config.binding ? saved : null;
    const current = await readHealth(config, fetchImpl); const fingerprint = sha(JSON.stringify(current));
    const changed = previous?.fingerprint !== fingerprint;
    const event = !previous ? 'initial' : current.status === 'ok' && previous.snapshot.status !== 'ok' ? 'recovery' : previous.snapshot.status === 'ok' && current.status !== 'ok' ? 'alert' : 'change';
    const result = { snapshot: current, ...(changed ? { event } : {}) };
    if (config.dryRun) return { status: 'DRY_RUN', ...result, wouldNotify: changed, exitCode: 0 };
    if (!changed) return { status: 'UNCHANGED', ...result, exitCode: 0 };
    // Acknowledgement chaining differentiates later recurrences; failed attempts keep the same id.
    const eventId = sha(JSON.stringify([config.binding, previous?.ackId || 'initial', fingerprint]));
    const delivery = await notify(config, { schemaVersion: 1, service: config.service, event, eventId, observedAt: new Date().toISOString(), ...current }, fetchImpl);
    if (!delivery.accepted) return { status: 'FAILED', ...result, ...delivery, exitCode: 1 };
    await acknowledge(config.directory, { version: 1, binding: config.binding, fingerprint, snapshot: current, ackId: eventId, acknowledgedAt: new Date().toISOString() });
    return { status: 'SENT', ...result, webhookStatus: delivery.httpStatus, exitCode: 0 };
  } finally { await release?.(); }
}

/** The CLI uses native fetch. Injection permits local transport fixtures without weakening HTTPS policy. */
export async function runMonitor({ env = process.env, argv = [], fetchImpl = globalThis.fetch } = {}) {
  try {
    const config = configuration(env, argv);
    if (config.status === 'NOT_ENABLED') return config;
    return await execute(config, fetchImpl);
  } catch (error) {
    return { status: 'FAILED', errorCode: error instanceof MonitorError ? error.code : 'MONITOR_LOCAL_FAILURE', ...(error instanceof MonitorError && error.field ? { field: error.field } : {}), exitCode: 1 };
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await runMonitor({ argv: process.argv.slice(2) }); console.log(JSON.stringify(result)); process.exitCode = result.exitCode;
}
