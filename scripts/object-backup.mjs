/** Database-bound private object archives. No source listing, deletion or overwrite. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaults = { maxObjectBytes: 100 * 1024 ** 2, maxTotalBytes: 10 * 1024 ** 3, maxObjects: 100000 };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const mediaKey = new RegExp(`^public-media/${uuid}$`);
const privateKey = new RegExp(`^private/[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128}/${uuid}$`);
const evidenceKey = new RegExp(`^private-source-evidence/[A-Za-z0-9_-]{1,128}/${uuid}\\.json$`);
const digestPattern = /^[a-f0-9]{64}$/;
const evidenceKinds = new Set(['CollectionRun', 'RunItem', 'AdObservation']);
const streamLengths = new WeakMap();
class SafeFailure extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new SafeFailure(code); };
const safe = (error, code) => error instanceof SafeFailure ? error : new SafeFailure(code);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function bounds(value = {}) {
  if (!object(value) || Object.keys(value).some(key => !Object.hasOwn(defaults, key))) fail('OBJECT_LIMITS_INVALID');
  const result = { ...defaults, ...value };
  for (const [key, amount] of Object.entries(result)) if (!Number.isSafeInteger(amount) || amount < 1 || amount > defaults[key]) fail('OBJECT_LIMITS_INVALID');
  return result;
}
function identity(value) {
  if (!object(value) || Object.keys(value).some(key => !['bucket', 'endpoint'].includes(key))
    || typeof value.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value.bucket)
    || value.bucket.includes('..') || /^\d+\.\d+\.\d+\.\d+$/.test(value.bucket)
    || typeof value.endpoint !== 'string') fail('OBJECT_STORE_IDENTITY_INVALID');
  let endpoint = value.endpoint;
  if (!/^aws:[a-z0-9-]{3,40}$/.test(endpoint)) {
    let url; try { url = new URL(endpoint); } catch { fail('OBJECT_STORE_IDENTITY_INVALID'); }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) fail('OBJECT_STORE_IDENTITY_INVALID');
    endpoint = url.origin;
  }
  return { bucket: value.bucket, endpoint };
}
function mime(value) {
  if (typeof value !== 'string' || value.length > 255 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;[ a-z0-9="._-]+)?$/i.test(value.trim())) fail('OBJECT_CONTENT_TYPE_INVALID');
  return value.trim().toLowerCase();
}
function size(value) {
  if (typeof value === 'number') { if (!Number.isSafeInteger(value) || value < 0) fail('OBJECT_SIZE_INVALID'); return value; }
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,15})$/.test(value) || !Number.isSafeInteger(Number(value))) fail('OBJECT_SIZE_INVALID');
  return Number(value);
}
async function regular(path, privateMode = false) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (privateMode && (info.mode & 0o077) !== 0)) fail('OBJECT_ARCHIVE_FILE_INVALID');
    return { handle, info };
  } catch (error) { await handle.close(); throw error; }
}
async function jsonFile(path, privateMode = false) {
  const { handle, info } = await regular(path, privateMode);
  try {
    if (info.size > 64 * 1024 ** 2) fail('OBJECT_MANIFEST_TOO_LARGE');
    const bytes = await handle.readFile();
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } finally { await handle.close(); }
}
async function privateDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) fail('OBJECT_ARCHIVE_DIRECTORY_INVALID');
}
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function consume(body, maximum, onChunk = async () => {}) {
  if (!(body instanceof Uint8Array) && (!body || typeof body[Symbol.asyncIterator] !== 'function')) fail('OBJECT_BODY_INVALID');
  const input = body instanceof Uint8Array ? [body] : body;
  const hash = createHash('sha256'); let length = 0;
  for await (const chunk of input) {
    if (!(chunk instanceof Uint8Array)) fail('OBJECT_BODY_INVALID');
    length += chunk.byteLength;
    if (!Number.isSafeInteger(length) || length > maximum) fail('OBJECT_BYTES_LIMIT_EXCEEDED');
    hash.update(chunk); await onChunk(chunk);
  }
  return { sha256: hash.digest('hex'), sizeBytes: length };
}
async function hashFile(path, maximum = Number.MAX_SAFE_INTEGER, privateMode = false) {
  const { handle, info } = await regular(path, privateMode);
  try {
    if (info.size > maximum) fail('OBJECT_BYTES_LIMIT_EXCEEDED');
    return await consume(handle.createReadStream({ autoClose: false }), maximum);
  } finally { await handle.close(); }
}
async function publishJson(path, value, replace = false) {
  const temporary = `${path}.partial-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try {
    if (replace) {
      if (await exists(path)) { const checked = await regular(path, true); await checked.handle.close(); }
      await rename(temporary, path);
    } else { await link(temporary, path); await unlink(temporary); }
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
function references(manifest, limits) {
  if (!object(manifest) || manifest.objectReferencesVersion !== 1 || !Array.isArray(manifest.objectReferences)) fail('OBJECT_REFERENCES_REQUIRED');
  const result = new Map(), refIds = new Map();
  for (const ref of manifest.objectReferences) {
    if (!object(ref) || typeof ref.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(ref.id) || typeof ref.reference !== 'string') fail('OBJECT_REFERENCE_INVALID');
    let key;
    if (ref.kind === 'MediaObject' && mediaKey.test(ref.reference)) key = ref.reference;
    else if (ref.kind === 'PrivateFile' && privateKey.test(ref.reference)) key = ref.reference;
    else if (evidenceKinds.has(ref.kind) && ref.reference.startsWith('s3:') && evidenceKey.test(ref.reference.slice(3))) key = ref.reference.slice(3);
    else fail('OBJECT_REFERENCE_INVALID');
    if (ref.sha256 !== null && (typeof ref.sha256 !== 'string' || !digestPattern.test(ref.sha256))) fail('OBJECT_REFERENCE_INVALID');
    const expectedSize = ref.sizeBytes === null ? null : size(ref.sizeBytes);
    const contentType = ref.mimeType === null ? null : mime(ref.mimeType);
    if (['MediaObject', 'PrivateFile'].includes(ref.kind) && (!ref.sha256 || expectedSize === null)) fail('OBJECT_REFERENCE_METADATA_REQUIRED');
    if (expectedSize !== null && expectedSize > limits.maxObjectBytes) fail('OBJECT_BYTES_LIMIT_EXCEEDED');
    const refId = `${ref.kind}:${ref.id}`;
    if (refIds.has(refId) && refIds.get(refId) !== key) fail('OBJECT_REFERENCE_CONFLICT');
    refIds.set(refId, key);
    let entry = result.get(key);
    if (!entry) { entry = { key, sha256: ref.sha256, sizeBytes: expectedSize, contentType, references: [] }; result.set(key, entry); }
    for (const [field, incoming] of Object.entries({ sha256: ref.sha256, sizeBytes: expectedSize, contentType })) {
      if (entry[field] !== null && incoming !== null && entry[field] !== incoming) fail('OBJECT_REFERENCE_CONFLICT');
      if (entry[field] === null) entry[field] = incoming;
    }
    if (!entry.references.some(item => item.kind === ref.kind && item.id === ref.id)) entry.references.push({ kind: ref.kind, id: ref.id });
    if (result.size > limits.maxObjects) fail('OBJECT_COUNT_LIMIT_EXCEEDED');
  }
  for (const entry of result.values()) entry.references.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  return new Map([...result.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
async function databaseProof(databaseBackup, limits) {
  if (typeof databaseBackup !== 'string' || !databaseBackup) fail('DATABASE_BACKUP_REQUIRED');
  const document = await jsonFile(`${databaseBackup}.manifest.json`);
  const manifest = document.value;
  if (!object(manifest) || manifest.formatVersion !== 1 || !digestPattern.test(manifest.sha256 ?? '')) fail('DATABASE_MANIFEST_INVALID');
  const expectedSize = size(manifest.sizeBytes), dump = await hashFile(databaseBackup);
  if (dump.sha256 !== manifest.sha256 || dump.sizeBytes !== expectedSize) fail('DATABASE_BACKUP_MISMATCH');
  return { sha256: dump.sha256, manifestSha256: sha(document.bytes), references: references(manifest, limits) };
}
function matches(actual, expected) {
  if ((expected.sha256 !== null && actual.sha256 !== expected.sha256)
    || (expected.sizeBytes !== null && actual.sizeBytes !== Number(expected.sizeBytes))
    || (expected.contentType !== null && actual.contentType !== expected.contentType)) fail('OBJECT_CONTENT_MISMATCH');
}
async function readStored(store, key, maximum, onChunk) {
  const response = await store.get(key);
  try { return { ...await consume(response.body, maximum, onChunk), contentType: mime(response.contentType) }; }
  finally { response.body?.destroy?.(); }
}

export async function backupObjects({ databaseBackup, outputDirectory, sourceStore, sourceIdentity, limits: configuredLimits } = {}) {
  try {
    const limits = bounds(configuredLimits), source = identity(sourceIdentity);
    if (!sourceStore || typeof sourceStore.get !== 'function' || typeof outputDirectory !== 'string' || !outputDirectory) fail('OBJECT_BACKUP_CONFIGURATION_INVALID');
    const proof = await databaseProof(databaseBackup, limits), directory = resolve(outputDirectory);
    // mkdir is exclusive. An existing directory, including a symlink, is refused.
    try { await mkdir(directory, { mode: 0o700 }); } catch { fail('OBJECT_BACKUP_OUTPUT_EXISTS_OR_UNAVAILABLE'); }
    await chmod(directory, 0o700); await mkdir(join(directory, 'objects'), { mode: 0o700 });
    const objects = []; let total = 0;
    for (const expected of proof.references.values()) {
      const temporary = join(directory, 'objects', `.partial-${randomUUID()}`);
      const handle = await open(temporary, 'wx', 0o600);
      let actual;
      try {
        actual = await readStored(sourceStore, expected.key, Math.min(limits.maxObjectBytes, limits.maxTotalBytes - total), async bytes => {
          let offset = 0;
          while (offset < bytes.length) { const written = await handle.write(bytes, offset, bytes.length - offset); if (!written.bytesWritten) fail('OBJECT_ARCHIVE_WRITE_FAILED'); offset += written.bytesWritten; }
        });
        matches(actual, expected); await handle.sync();
      } finally { await handle.close(); }
      total += actual.sizeBytes;
      if (total > limits.maxTotalBytes) fail('OBJECT_TOTAL_LIMIT_EXCEEDED');
      const destination = join(directory, 'objects', actual.sha256);
      if (await exists(destination)) matches(await hashFile(destination, limits.maxObjectBytes, true), { ...actual, contentType: null });
      else await link(temporary, destination);
      await unlink(temporary);
      objects.push({ key: expected.key, sha256: actual.sha256, sizeBytes: String(actual.sizeBytes), contentType: actual.contentType, references: expected.references });
    }
    const manifest = { version: 1, status: 'OBJECT_BACKUP_VERIFIED', databaseBackupSha256: proof.sha256, databaseManifestSha256: proof.manifestSha256, sourceIdentity: source, objects };
    await publishJson(join(directory, 'manifest.json'), manifest);
    return { status: 'OBJECT_BACKUP_VERIFIED', objectCount: objects.length };
  } catch (error) { throw safe(error, 'OBJECT_BACKUP_FAILED'); }
}

async function archiveProof(databaseBackup, archiveDirectory) {
  const limits = bounds(), directory = resolve(archiveDirectory);
  await privateDirectory(directory); await privateDirectory(join(directory, 'objects'));
  const proof = await databaseProof(databaseBackup, limits);
  const document = await jsonFile(join(directory, 'manifest.json'), true), manifest = document.value;
  if (!object(manifest) || manifest.version !== 1 || manifest.status !== 'OBJECT_BACKUP_VERIFIED'
    || manifest.databaseBackupSha256 !== proof.sha256 || manifest.databaseManifestSha256 !== proof.manifestSha256
    || !Array.isArray(manifest.objects) || manifest.objects.length !== proof.references.size) fail('OBJECT_ARCHIVE_BINDING_MISMATCH');
  const source = identity(manifest.sourceIdentity), seen = new Set(); let total = 0;
  for (const entry of manifest.objects) {
    if (!object(entry) || typeof entry.key !== 'string' || seen.has(entry.key) || !proof.references.has(entry.key)
      || !digestPattern.test(entry.sha256 ?? '') || !Array.isArray(entry.references)) fail('OBJECT_ARCHIVE_REFERENCE_MISMATCH');
    seen.add(entry.key);
    const expected = proof.references.get(entry.key);
    const refs = entry.references.map(ref => {
      if (!object(ref) || Object.keys(ref).length !== 2 || typeof ref.kind !== 'string' || typeof ref.id !== 'string') fail('OBJECT_ARCHIVE_REFERENCE_MISMATCH');
      return { kind: ref.kind, id: ref.id };
    }).sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
    if (JSON.stringify(refs) !== JSON.stringify(expected.references)) fail('OBJECT_ARCHIVE_REFERENCE_MISMATCH');
    const expectedBytes = size(entry.sizeBytes), contentType = mime(entry.contentType);
    const actual = { ...await hashFile(join(directory, 'objects', entry.sha256), limits.maxObjectBytes, true), contentType };
    matches(actual, { sha256: entry.sha256, sizeBytes: expectedBytes, contentType }); matches(actual, expected);
    total += actual.sizeBytes; if (total > limits.maxTotalBytes) fail('OBJECT_TOTAL_LIMIT_EXCEEDED');
    entry.sizeBytes = String(expectedBytes); entry.contentType = contentType;
  }
  return { directory, proof, source, manifest, archiveSha256: sha(document.bytes), limits };
}
async function targetKeys(store, count, expected) {
  const keys = await store.list(count);
  if (!Array.isArray(keys) || keys.length > count || keys.some(key => typeof key !== 'string' || !expected.has(key)) || new Set(keys).size !== keys.length) fail('OBJECT_RESTORE_TARGET_NOT_ISOLATED');
  return new Set(keys);
}
async function verifyTarget(store, entry, limits) {
  const actual = await readStored(store, entry.key, limits.maxObjectBytes);
  matches(actual, entry);
}
export async function restoreObjects({ databaseBackup, archiveDirectory, targetStore, targetIdentity, verifyDatabase } = {}) {
  let lock, lockPath;
  try {
    if (typeof archiveDirectory !== 'string' || !archiveDirectory || typeof verifyDatabase !== 'function'
      || !targetStore || ['get', 'put', 'list'].some(method => typeof targetStore[method] !== 'function')) fail('OBJECT_RESTORE_CONFIGURATION_INVALID');
    const archive = await archiveProof(databaseBackup, archiveDirectory), target = identity(targetIdentity);
    if (target.bucket === archive.source.bucket || !/(?:^|[.-])restore(?:[.-]|$)/.test(target.bucket)) fail('OBJECT_RESTORE_TARGET_REJECTED');
    const targetIdentityHash = sha(JSON.stringify(target)), receiptPath = join(archive.directory, `restore-${targetIdentityHash}.json`);
    lockPath = `${receiptPath}.lock`;
    try { lock = await open(lockPath, 'wx', 0o600); } catch { fail('OBJECT_RESTORE_LOCKED'); }
    const binding = { version: 1, archiveSha256: archive.archiveSha256, databaseBackupSha256: archive.proof.sha256,
      databaseManifestSha256: archive.proof.manifestSha256, sourceIdentity: archive.source, targetIdentity: target, targetIdentityHash };
    let receipt;
    if (await exists(receiptPath)) {
      receipt = (await jsonFile(receiptPath, true)).value;
      if (!object(receipt) || !['IN_PROGRESS', 'JOINT_RESTORE_VERIFIED'].includes(receipt.status)
        || Object.entries(binding).some(([key, value]) => JSON.stringify(receipt[key]) !== JSON.stringify(value))) fail('OBJECT_RESTORE_RECEIPT_MISMATCH');
    }
    const objects = archive.manifest.objects, expected = new Set(objects.map(entry => entry.key));
    const current = await targetKeys(targetStore, objects.length, expected);
    if (current.size && !receipt) fail('OBJECT_RESTORE_TARGET_NOT_EMPTY');
    // Read back any pre-existing objects before attempting a database restore.
    for (const entry of objects) if (current.has(entry.key)) await verifyTarget(targetStore, entry, archive.limits);
    if (receipt?.status === 'JOINT_RESTORE_VERIFIED' && current.size !== objects.length) fail('OBJECT_RESTORE_COMPLETED_TARGET_CHANGED');
    const report = await verifyDatabase();
    if (!object(report) || report.status !== 'RESTORE_VERIFIED' || report.backupSha256 !== archive.proof.sha256
      || report.objectReferencesVerified !== true || report.objectReferencesVersion !== 1) fail('DATABASE_RESTORE_UNVERIFIED');
    if (!receipt) await publishJson(receiptPath, { ...binding, status: 'IN_PROGRESS', objectCount: objects.length });
    for (const entry of objects) {
      if (current.has(entry.key)) continue;
      const { handle, info } = await regular(join(archive.directory, 'objects', entry.sha256), true);
      const stream = handle.createReadStream({ autoClose: false }); streamLengths.set(stream, info.size);
      try {
        try { await targetStore.put(entry.key, stream, { contentType: entry.contentType, ifNoneMatch: '*' }); }
        catch {
          // Timeout/precondition races can already have persisted the object.
          // Only an exact GET match is acceptable; never retry with overwrite.
          try { await verifyTarget(targetStore, entry, archive.limits); }
          catch { fail('OBJECT_RESTORE_WRITE_OR_CONFLICT'); }
        }
      } finally { stream.destroy(); await handle.close(); }
      await verifyTarget(targetStore, entry, archive.limits);
    }
    const finalKeys = await targetKeys(targetStore, objects.length, expected);
    if (finalKeys.size !== objects.length) fail('OBJECT_RESTORE_TARGET_INCOMPLETE');
    for (const entry of objects) await verifyTarget(targetStore, entry, archive.limits);
    if (receipt?.status !== 'JOINT_RESTORE_VERIFIED') await publishJson(receiptPath, { ...binding, status: 'JOINT_RESTORE_VERIFIED', objectCount: objects.length }, true);
    return { status: 'JOINT_RESTORE_VERIFIED', objectCount: objects.length };
  } catch (error) { throw safe(error, 'OBJECT_RESTORE_FAILED'); }
  finally { if (lock) { await lock.close().catch(() => {}); await unlink(lockPath).catch(() => {}); } }
}

function configuredStore(env, prefix, load) {
  const required = suffix => { const value = env[prefix + suffix]; if (typeof value !== 'string' || !value.trim()) fail('OBJECT_STORE_CONFIGURATION_REQUIRED'); return value.trim(); };
  const region = required('S3_REGION');
  const storeIdentity = identity({ bucket: required('S3_BUCKET'), endpoint: env[prefix + 'S3_ENDPOINT']?.trim() || `aws:${region}` });
  const force = env[prefix + 'S3_FORCE_PATH_STYLE'];
  if (force !== undefined && !['true', 'false'].includes(force)) fail('OBJECT_STORE_CONFIGURATION_INVALID');
  const credentials = { accessKeyId: required('AWS_ACCESS_KEY_ID'), secretAccessKey: required('AWS_SECRET_ACCESS_KEY') };
  if (env[prefix + 'AWS_SESSION_TOKEN']) credentials.sessionToken = env[prefix + 'AWS_SESSION_TOKEN'];
  const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = load('@aws-sdk/client-s3');
  const client = new S3Client({ region, endpoint: storeIdentity.endpoint.startsWith('aws:') ? undefined : storeIdentity.endpoint,
    credentials, forcePathStyle: force === 'true', ignoreConfiguredEndpointUrls: true, maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED',
    requestHandler: { connectionTimeout: 5000, requestTimeout: 30000, throwOnRequestTimeout: true } });
  const Bucket = storeIdentity.bucket;
  return { identity: storeIdentity, close: () => client.destroy(), store: {
    async get(Key) { const response = await client.send(new GetObjectCommand({ Bucket, Key }), { abortSignal: AbortSignal.timeout(30000) }); return { body: response.Body, contentType: response.ContentType }; },
    async put(Key, Body, { contentType, ifNoneMatch }) {
      if (ifNoneMatch !== '*') fail('OBJECT_OVERWRITE_FORBIDDEN');
      const ContentLength = Body instanceof Uint8Array ? Body.byteLength : streamLengths.get(Body);
      if (!Number.isSafeInteger(ContentLength)) fail('OBJECT_STORE_INPUT_INVALID');
      await client.send(new PutObjectCommand({ Bucket, Key, Body, ContentLength, ContentType: contentType, IfNoneMatch: '*', CacheControl: 'private, no-store' }), { abortSignal: AbortSignal.timeout(30000) });
    },
    async list(limit) {
      const keys = []; let token;
      do {
        const response = await client.send(new ListObjectsV2Command({ Bucket, ContinuationToken: token, MaxKeys: Math.min(1000, limit + 1 - keys.length) }), { abortSignal: AbortSignal.timeout(30000) });
        for (const row of response.Contents ?? []) keys.push(row.Key);
        if (keys.length > limit || !response.IsTruncated) return keys;
        if (!response.NextContinuationToken || response.NextContinuationToken === token) fail('OBJECT_STORE_LIST_INVALID');
        token = response.NextContinuationToken;
      } while (true);
    },
  } };
}
function restoreTarget(value) {
  let url; try { url = new URL(value); } catch { fail('DATABASE_RESTORE_TARGET_INVALID'); }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.password || url.search || url.hash || !/^[a-z_][a-z0-9_-]{0,62}$/i.test(database)
    || !/(?:^|[_-])(?:test|restore)(?:[_-]|$)/i.test(database)) fail('DATABASE_RESTORE_TARGET_INVALID');
  return url.href;
}
export async function runObjectBackupCli(argv = process.argv.slice(2), env = process.env) {
  let configured;
  try {
    if (argv.length === 1 && argv[0] === '--help') {
      console.log('object-backup backup --backup PATH --output NEW_DIR | restore --backup PATH --archive DIR --target-url LOCAL_TEST_POSTGRES_URL'); return 0;
    }
    const [command, ...args] = argv, flags = new Map();
    const allowed = command === 'backup' ? ['--backup', '--output'] : command === 'restore' ? ['--backup', '--archive', '--target-url'] : [];
    for (let index = 0; index < args.length; index += 2) {
      if (!allowed.includes(args[index]) || !args[index + 1] || flags.has(args[index])) fail('OBJECT_BACKUP_USAGE');
      flags.set(args[index], args[index + 1]);
    }
    if (!allowed.length || flags.size !== allowed.length || env.NODE_TLS_REJECT_UNAUTHORIZED === '0') fail('OBJECT_BACKUP_USAGE');
    const load = createRequire(new URL('../apps/web/package.json', import.meta.url));
    configured = configuredStore(env, command === 'restore' ? 'RESTORE_' : '', load);
    let result;
    if (command === 'backup') result = await backupObjects({ databaseBackup: flags.get('--backup'), outputDirectory: flags.get('--output'), sourceStore: configured.store, sourceIdentity: configured.identity });
    else {
      const targetUrl = restoreTarget(flags.get('--target-url')), archiveDirectory = resolve(flags.get('--archive'));
      const reportPath = join(archiveDirectory, `database-restore-${sha(targetUrl)}.json`);
      result = await restoreObjects({ databaseBackup: flags.get('--backup'), archiveDirectory, targetStore: configured.store, targetIdentity: configured.identity,
        verifyDatabase: async () => {
          const childEnv = { PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin', PGPASSWORD: env.RESTORE_PGPASSWORD || '', PGPASSFILE: '/dev/null' };
          if (env.PG_BIN) childEnv.PG_BIN = env.PG_BIN;
          await promisify(execFile)('/bin/bash', [fileURLToPath(new URL('./restore-check.sh', import.meta.url)), '--backup', resolve(flags.get('--backup')), '--target-url', targetUrl, '--report', reportPath], { env: childEnv, timeout: 600000, maxBuffer: 1024 * 1024 });
          return (await jsonFile(reportPath, true)).value;
        },
      });
    }
    console.log(JSON.stringify(result)); return 0;
  } catch (error) { console.error(JSON.stringify({ status: 'FAILED', errorCode: safe(error, 'OBJECT_BACKUP_COMMAND_FAILED').code })); return 1; }
  finally { configured?.close(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await runObjectBackupCli();
