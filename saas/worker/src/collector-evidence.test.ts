import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectorEvidenceKey, createCollectorEvidenceStore } from './collector-evidence';

// BOM, CRLF, indentation, Unicode and a literal JSON escape must survive unchanged.
const raw = Buffer.from('\uFEFF{\r\n  "sourceKey": "meta_ad_library",\r\n  "value": "咖啡☕", "escaped": "\\u0061"\r\n}\r\n', 'utf8');
const sha256 = '365b008dac943a1bbdc4be102017afcc7521b80ee6922b5a6248071e01f129a2';
const namespace = { prefix: 'private-collector-evidence', sourceKey: 'meta_ad_library' };
const key = `private-collector-evidence/meta_ad_library/${sha256}.bin`;
const directories: string[] = [];
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'collector-evidence-'));
  directories.push(root); return root;
}
async function local(maxObjectBytes?: number) {
  const root = await directory();
  const store = await createCollectorEvidenceStore({ kind: 'local', rootDirectory: root, namespace, maxObjectBytes });
  return { root, store, path: join(root, key) };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('exact-byte private collector evidence', () => {
  it('constructs content addressed keys inside a server-selected source namespace', () => {
    expect(collectorEvidenceKey(namespace, sha256)).toBe(key);
  });
  it('stores original UTF8 bytes and verifies their hash on readback', async () => {
    const { store, path, root } = await local();
    expect(await store.putIfAbsent(key, raw, sha256)).toBe('CREATED');
    expect(Buffer.from(await store.get(key))).toEqual(raw);
    expect(await readFile(path)).toEqual(raw);
    expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(sha256);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, namespace.prefix))).mode & 0o777).toBe(0o700);
  });
  it('allows concurrent identical puts with one atomic creation and one verified replay', async () => {
    const { store } = await local();
    const results = await Promise.all([store.putIfAbsent(key, raw, sha256), store.putIfAbsent(key, raw, sha256)]);
    expect(results.sort()).toEqual(['CREATED', 'EXISTS']);
    expect(Buffer.from(await store.get(key))).toEqual(raw);
  });
  it('rejects altered input bytes before writing any evidence', async () => {
    const { store, root } = await local();
    await expect(store.putIfAbsent(key, Buffer.concat([raw, Buffer.from(' ')]), sha256)).rejects.toThrow('COLLECTOR_EVIDENCE_HASH_MISMATCH');
    expect(await readdir(root)).toEqual([]);
  });
  it('rejects a digest that differs from the key digest before writing', async () => {
    const { store, root } = await local();
    await expect(store.putIfAbsent(key, raw, '0'.repeat(64))).rejects.toThrow('COLLECTOR_EVIDENCE_HASH_MISMATCH');
    expect(await readdir(root)).toEqual([]);
  });
  it('rejects corrupt stored bytes both on GET and on replay without overwriting them', async () => {
    const { store, path } = await local();
    await store.putIfAbsent(key, raw, sha256);
    await writeFile(path, 'corrupt');
    await expect(store.get(key)).rejects.toThrow('COLLECTOR_EVIDENCE_HASH_MISMATCH');
    await expect(store.putIfAbsent(key, raw, sha256)).rejects.toThrow('COLLECTOR_EVIDENCE_HASH_MISMATCH');
    expect(await readFile(path, 'utf8')).toBe('corrupt');
  });
  it.each([
    `private-collector-evidence/google_ads_transparency/${sha256}.bin`,
    `private-collector-evidence/meta_ad_library/../${sha256}.bin`,
    `/private-collector-evidence/meta_ad_library/${sha256}.bin`,
    `https://example.test/${sha256}.bin`,
    `private-collector-evidence/meta_ad_library/%2e%2e/${sha256}.bin`,
    `private-collector-evidence/meta_ad_library\\${sha256}.bin`,
    `private-collector-evidence/meta_ad_library/${sha256}.bin?token=private`,
  ])('rejects another source or escaped object key: %s', async invalidKey => {
    const { store, root } = await local();
    await expect(store.putIfAbsent(invalidKey, raw, sha256)).rejects.toThrow('COLLECTOR_EVIDENCE_KEY_REJECTED');
    await expect(store.get(invalidKey)).rejects.toThrow('COLLECTOR_EVIDENCE_KEY_REJECTED');
    expect(await readdir(root)).toEqual([]);
  });
  it('rejects a symlinked namespace directory rather than escaping the private root', async () => {
    const { store, root } = await local(); const outside = await directory();
    await symlink(outside, join(root, namespace.prefix));
    await expect(store.putIfAbsent(key, raw, sha256)).rejects.toThrow('COLLECTOR_EVIDENCE_PATH_REJECTED');
    expect(await readdir(outside)).toEqual([]);
  });
  it('rejects a symlinked object on read and conditional put', async () => {
    const { store, root, path } = await local(); const outside = await directory();
    const target = join(outside, 'raw.bin'); await writeFile(target, raw, { mode: 0o600 });
    await mkdir(join(root, namespace.prefix, namespace.sourceKey), { recursive: true, mode: 0o700 });
    await symlink(target, path);
    await expect(store.get(key)).rejects.toThrow('COLLECTOR_EVIDENCE_PATH_REJECTED');
    await expect(store.putIfAbsent(key, raw, sha256)).rejects.toThrow('COLLECTOR_EVIDENCE_PATH_REJECTED');
    expect(await readFile(target)).toEqual(raw);
  });
  it('rejects oversized writes as a per-object resource limit', async () => {
    const { store, root } = await local(32);
    await expect(store.putIfAbsent(key, raw, sha256)).rejects.toThrow('COLLECTOR_EVIDENCE_TOO_LARGE');
    expect(await readdir(root)).toEqual([]);
  });
  it('rejects oversized persisted data before accepting its hash', async () => {
    const { store, path, root } = await local(32);
    await mkdir(join(root, namespace.prefix, namespace.sourceKey), { recursive: true, mode: 0o700 });
    await writeFile(path, raw, { mode: 0o600 });
    await expect(store.get(key)).rejects.toThrow('COLLECTOR_EVIDENCE_TOO_LARGE');
  });
  it('rejects missing objects with a stable code', async () => {
    const { store } = await local();
    await expect(store.get(key)).rejects.toThrow('COLLECTOR_EVIDENCE_NOT_FOUND');
  });
  it('rejects relative or non-private root configuration', async () => {
    await expect(createCollectorEvidenceStore({ kind: 'local', rootDirectory: './public', namespace })).rejects.toThrow('COLLECTOR_EVIDENCE_CONFIG_INVALID');
    const root = await directory(); await mkdir(join(root, 'public'), { mode: 0o755 });
    await expect(createCollectorEvidenceStore({ kind: 'local', rootDirectory: join(root, 'public'), namespace })).rejects.toThrow('COLLECTOR_EVIDENCE_ROOT_NOT_PRIVATE');
  });
});

// Replace only S3 transport. The store, commands, byte hashing and streamed GET
// remain real. This endpoint emulates S3 create-if-absent semantics without IO.
function s3Transport(conflictStatus = 412) {
  const objects = new Map<string, Buffer>();
  const writes: Array<PutObjectCommand['input']> = [];
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: any) => {
    if (command instanceof PutObjectCommand) {
      const input = command.input; writes.push(input);
      if (input.Bucket !== 'owned-evidence' || input.IfNoneMatch !== '*') throw new Error('BAD_CONDITIONAL_WRITE');
      if (objects.has(input.Key!)) throw Object.assign(new Error('private provider detail'), { $metadata: { httpStatusCode: conflictStatus } });
      objects.set(input.Key!, Buffer.from(input.Body as Uint8Array)); return {};
    }
    if (command instanceof GetObjectCommand) {
      const bytes = objects.get(command.input.Key!);
      if (!bytes) throw Object.assign(new Error('private bucket details'), { $metadata: { httpStatusCode: 404 } });
      return { Body: Readable.from([bytes.subarray(0, 10), bytes.subarray(10)]), ContentLength: bytes.length };
    }
    throw new Error('UNEXPECTED_COMMAND');
  });
  return { objects, writes };
}
const s3Config = { kind: 's3' as const, namespace, bucket: 'owned-evidence', region: 'us-east-1', endpoint: 'https://evidence.example.test', credentials: { accessKeyId: 'test-only', secretAccessKey: 'test-only' } };
describe('server-owned S3 collector evidence', () => {
  it('uploads exact bytes privately with a conditional PUT and verifies streamed GET', async () => {
    const transport = s3Transport(); const store = await createCollectorEvidenceStore(s3Config);
    expect(await store.putIfAbsent(key, raw, sha256)).toBe('CREATED');
    expect(transport.objects.get(key)).toEqual(raw);
    expect(Buffer.from(await store.get(key))).toEqual(raw);
    expect(transport.writes[0]).toMatchObject({ CacheControl: 'private, no-store', ContentLength: 89, ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'), IfNoneMatch: '*' });
    expect(transport.writes[0]).not.toHaveProperty('ACL');
  });
  it.each([409, 412])('accepts a conditional %i conflict only after identical GET readback', async status => {
    const transport = s3Transport(status); transport.objects.set(key, Buffer.from(raw));
    const store = await createCollectorEvidenceStore(s3Config);
    expect(await store.putIfAbsent(key, raw, sha256)).toBe('EXISTS');
    transport.objects.set(key, Buffer.from('tampered'));
    await expect(store.putIfAbsent(key, raw, sha256)).rejects.toThrow('COLLECTOR_EVIDENCE_HASH_MISMATCH');
    expect(transport.objects.get(key)?.toString()).toBe('tampered');
  });
  it('rejects corrupt readback after a provider reports successful PUT', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (command: any) => command instanceof PutObjectCommand ? {} : { Body: Readable.from([Buffer.from('wrong bytes')]), ContentLength: 11 });
    const store = await createCollectorEvidenceStore(s3Config);
    await expect(store.putIfAbsent(key, raw, sha256)).rejects.toThrow('COLLECTOR_EVIDENCE_HASH_MISMATCH');
  });
  it('bounds streamed GET even when the provider understates ContentLength', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ Body: Readable.from([raw]), ContentLength: 1 } as never);
    const store = await createCollectorEvidenceStore({ ...s3Config, maxObjectBytes: 32 });
    await expect(store.get(key)).rejects.toThrow('COLLECTOR_EVIDENCE_TOO_LARGE');
  });
  it('rejects source/path escape before sending anything to the provider', async () => {
    const transport = s3Transport(); const store = await createCollectorEvidenceStore(s3Config);
    await expect(store.putIfAbsent(`other/${sha256}.bin`, raw, sha256)).rejects.toThrow('COLLECTOR_EVIDENCE_KEY_REJECTED');
    expect(transport.writes).toEqual([]); expect(transport.objects.size).toBe(0);
  });
  it('hides provider exception details behind a stable failure code', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(new Error('secretAccessKey private bucket URL'));
    const store = await createCollectorEvidenceStore(s3Config);
    await expect(store.putIfAbsent(key, raw, sha256)).rejects.toThrow(/^COLLECTOR_EVIDENCE_WRITE_FAILED$/);
    await expect(store.get(key)).rejects.toThrow(/^COLLECTOR_EVIDENCE_READ_FAILED$/);
  });
  it.each(['http://evidence.example.test', 'https://user:password@evidence.example.test', 'https://evidence.example.test/?token=private'])('rejects unsafe server destination: %s', async endpoint => {
    await expect(createCollectorEvidenceStore({ ...s3Config, endpoint })).rejects.toThrow('COLLECTOR_EVIDENCE_CONFIG_INVALID');
  });
  it.each([{ prefix: '../public', sourceKey: 'meta_ad_library' }, { prefix: 'private', sourceKey: '../google' }, { prefix: 'https://example.test', sourceKey: 'meta_ad_library' }])('rejects malformed server namespaces', async invalidNamespace => {
    await expect(createCollectorEvidenceStore({ ...s3Config, namespace: invalidNamespace })).rejects.toThrow('COLLECTOR_EVIDENCE_CONFIG_INVALID');
  });
});
