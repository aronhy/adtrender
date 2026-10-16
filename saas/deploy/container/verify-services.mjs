import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const timeoutMs = 10_000;
class CheckFailure extends Error {
  constructor(code, details = {}) { super(code); this.code = code; this.details = details; }
}
function required(env, names) {
  const missing = names.filter(name => !env[name]?.trim());
  if (missing.length) throw new CheckFailure('CONFIGURATION_REQUIRED', { missing });
}
function boolean(value, name) {
  if (value !== undefined && value !== '' && !['true', 'false'].includes(value)) throw new CheckFailure('CONFIGURATION_INVALID', { field: name });
  return value === 'true';
}
function failure(error) {
  return error instanceof CheckFailure ? { errorCode: error.code, ...error.details } : { errorCode: 'CONNECTION_OR_PROVIDER_FAILURE' };
}
async function verifySmtp(env, load) {
  required(env, ['SMTP_HOST', 'SMTP_USERNAME', 'SMTP_PASSWORD']);
  const port = Number(env.SMTP_PORT || 587), secure = boolean(env.SMTP_SECURE, 'SMTP_SECURE');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || /[\s/@]/.test(env.SMTP_HOST)) throw new CheckFailure('CONFIGURATION_INVALID', { field: 'SMTP_HOST_OR_PORT' });
  const nodemailer = load('nodemailer');
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST, port, secure, requireTLS: !secure,
    auth: { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: timeoutMs,
    logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
  });
  try {
    if (await transport.verify() !== true) throw new CheckFailure('SMTP_VERIFICATION_FAILED');
    return { status: 'PASSED', result: 'connection_auth_verified', messageSent: false };
  } finally { transport.close(); }
}
async function discard(response) { try { await response.body?.cancel(); } catch { /* Do not expose provider bodies. */ } }
async function readExact(response, expected) {
  const reader = response.body?.getReader();
  if (!reader) throw new CheckFailure('SIGNED_BYTES_MISMATCH');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > expected.length) throw new CheckFailure('SIGNED_BYTES_MISMATCH');
      chunks.push(Buffer.from(chunk.value));
    }
    if (!Buffer.concat(chunks).equals(expected)) throw new CheckFailure('SIGNED_BYTES_MISMATCH');
  } finally { try { await reader.cancel(); } catch { /* No provider output. */ } }
}
async function verifyStorage(env, load, fetchImpl, wait) {
  required(env, ['S3_BUCKET', 'S3_REGION', 'S3_ENDPOINT', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
  let endpoint;
  try { endpoint = new URL(env.S3_ENDPOINT); } catch { throw new CheckFailure('CONFIGURATION_INVALID', { field: 'S3_ENDPOINT' }); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new CheckFailure('CONFIGURATION_INVALID', { field: 'S3_ENDPOINT' });
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.S3_BUCKET)) throw new CheckFailure('CONFIGURATION_INVALID', { field: 'S3_BUCKET' });
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = load('@aws-sdk/client-s3');
  const { getSignedUrl } = load('@aws-sdk/s3-request-presigner');
  const client = new S3Client({
    endpoint: endpoint.origin, region: env.S3_REGION,
    forcePathStyle: boolean(env.S3_FORCE_PATH_STYLE, 'S3_FORCE_PATH_STYLE'),
    // Explicit credentials prevent this check from discovering unrelated instance profiles.
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) },
    maxAttempts: 1, requestHandler: { requestTimeout: timeoutMs, connectionTimeout: 5000, throwOnRequestTimeout: true },
  });
  const objectId = randomUUID(), Key = `verify/${objectId}.png`, Bucket = env.S3_BUCKET;
  let cleanupRequired = false, phase = 'put', result;
  const signed = expiresIn => getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), { expiresIn });
  const get = url => fetchImpl(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', headers: { 'cache-control': 'no-store' }, signal: AbortSignal.timeout(timeoutMs) });
  const expectStatus = async (url, expected, code) => {
    const response = await get(url);
    if (response.status !== expected) { await discard(response); throw new CheckFailure(code, { expectedStatus: expected, httpStatus: response.status }); }
    return response;
  };
  try {
    // Set before the request: a timed-out PUT can still have persisted the object.
    cleanupRequired = true;
    await client.send(new PutObjectCommand({ Bucket, Key, Body: png, ContentType: 'image/png', ContentLength: png.length, CacheControl: 'private, no-store', ChecksumSHA256: createHash('sha256').update(png).digest('base64') }));
    phase = 'anonymous_get';
    const anonymous = new URL(await signed(60)); anonymous.search = '';
    await discard(await expectStatus(anonymous.toString(), 403, 'ANONYMOUS_ACCESS_NOT_DENIED'));
    phase = 'signed_get';
    const shortUrl = await signed(2);
    await readExact(await expectStatus(shortUrl, 200, 'SIGNED_READ_FAILED'), png);
    phase = 'expired_get';
    // Strict expiry check. Clock skew / provider tolerance is a failure, never softened.
    await wait(2500);
    await discard(await expectStatus(shortUrl, 403, 'SIGNED_URL_NOT_EXPIRED'));
    phase = 'delete';
    await client.send(new DeleteObjectCommand({ Bucket, Key }));
    phase = 'deleted_get';
    await discard(await expectStatus(await signed(60), 404, 'DELETED_OBJECT_STILL_ACCESSIBLE_OR_UNVERIFIABLE'));
    cleanupRequired = false;
    result = { status: 'PASSED', anonymousGet: 403, signedGet: 200, bytesMatch: true, sizeBytes: png.length, expiresInSeconds: 2, expiredGet: 403, deletedGet: 404, objectsCreated: 1, objectsDeleted: 1 };
  } catch (error) { result = { status: 'FAILED', phase, ...failure(error) }; }
  finally {
    if (cleanupRequired) {
      try { await client.send(new DeleteObjectCommand({ Bucket, Key })); result.cleanup = 'delete_acknowledged'; }
      catch { result.cleanup = 'FAILED'; result.cleanupObjectId = objectId; result.cleanupRequired = true; }
    }
    client.destroy();
  }
  return result;
}

/** Injection is for local transport rehearsal only; CLI always loads the real SDKs. */
export async function verifyServices({ argv = process.argv.slice(2), env = process.env, load = createRequire(resolve(process.cwd(), 'package.json')), fetchImpl = globalThis.fetch, wait = sleep, emit = value => console.log(JSON.stringify(value)) } = {}) {
  if (argv.length === 1 && argv[0] === '--help') {
    emit({ usage: 'Run from the release app directory: node /opt/ad-research/verify-services.mjs [--smtp | --storage]', smtp: 'Connection/authentication only; no message is sent.', storage: 'One random verify/ object; strict private/read/2-second-expiry/delete checks.' }); return 0;
  }
  if (argv.some(arg => !['--smtp', '--storage'].includes(arg)) || new Set(argv).size !== argv.length) { emit({ status: 'FAILED', errorCode: 'INVALID_ARGUMENTS' }); return 1; }
  const services = argv.length ? argv.map(arg => arg.slice(2)) : ['smtp', 'storage'];
  let failed = false;
  for (const service of services) {
    let result;
    try { result = service === 'smtp' ? await verifySmtp(env, load) : await verifyStorage(env, load, fetchImpl, wait); }
    catch (error) { result = { status: 'FAILED', ...failure(error) }; }
    failed ||= result.status !== 'PASSED'; emit({ service, ...result });
  }
  return failed ? 1 : 0;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await verifyServices();
