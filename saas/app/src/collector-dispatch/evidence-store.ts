import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';

export type CollectorEvidenceNamespace = { prefix: string; sourceKey: string };
export interface ArtifactStore {
  putIfAbsent(key: string, bytes: Uint8Array, sha256: string): Promise<'CREATED' | 'EXISTS'>;
  get(key: string): Promise<Uint8Array>;
}
export type CollectorEvidenceStoreConfig = { namespace: CollectorEvidenceNamespace; maxObjectBytes?: number } & (
  { kind: 'local'; rootDirectory: string } |
  { kind: 's3'; bucket: string; region: string; endpoint?: string; forcePathStyle?: boolean; credentials?: S3ClientConfig['credentials'] }
);
export class CollectorEvidenceError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'CollectorEvidenceError'; }
}
const digestPattern = /^[a-f0-9]{64}$/;
const segmentPattern = /^[A-Za-z0-9_-]{1,128}$/;
const defaultMaxObjectBytes = 20 * 1024 * 1024;
function fail(code: string): never { throw new CollectorEvidenceError(`COLLECTOR_EVIDENCE_${code}`); }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const errorCode = (error: unknown) => (error as { code?: string })?.code;
function validateNamespace(namespace: CollectorEvidenceNamespace) {
  if (!namespace || typeof namespace.prefix !== 'string' || namespace.prefix.length > 512
    || !namespace.prefix.split('/').every(segment => segmentPattern.test(segment))
    || typeof namespace.sourceKey !== 'string' || !segmentPattern.test(namespace.sourceKey)) fail('CONFIG_INVALID');
}

/** Called by trusted server code, never with a node-supplied URL or namespace. */
export function collectorEvidenceKey(namespace: CollectorEvidenceNamespace, sha256: string): string {
  validateNamespace(namespace);
  if (typeof sha256 !== 'string' || !digestPattern.test(sha256)) fail('HASH_MISMATCH');
  return `${namespace.prefix}/${namespace.sourceKey}/${sha256}.bin`;
}

/** Server configuration owns the destination and source boundary. The only
 * accepted keys are content-addressed objects within that frozen namespace.
 * maxObjectBytes bounds one transfer; it is not a task, brand or daily quota. */
export async function createCollectorEvidenceStore(config: CollectorEvidenceStoreConfig): Promise<ArtifactStore> {
  validateNamespace(config?.namespace);
  const namespace = { ...config.namespace };
  const prefix = `${namespace.prefix}/${namespace.sourceKey}/`;
  const maxBytes = config.maxObjectBytes ?? defaultMaxObjectBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('CONFIG_INVALID');
  function expectedHash(key: string): string {
    if (typeof key !== 'string' || !key.startsWith(prefix) || !/^[a-f0-9]{64}\.bin$/.test(key.slice(prefix.length))) fail('KEY_REJECTED');
    return key.slice(prefix.length, -4);
  }
  function checkBytes(bytes: Uint8Array, expected: string) {
    if (!(bytes instanceof Uint8Array)) fail('HASH_MISMATCH');
    if (bytes.byteLength > maxBytes) fail('TOO_LARGE');
    if (hash(bytes) !== expected) fail('HASH_MISMATCH');
  }
  function putBytes(key: string, bytes: Uint8Array, sha256: string): Buffer {
    const expected = expectedHash(key);
    if (sha256 !== expected) fail('HASH_MISMATCH');
    // Copy before any await, so a caller cannot mutate an in-flight upload.
    if (!(bytes instanceof Uint8Array)) fail('HASH_MISMATCH');
    if (bytes.byteLength > maxBytes) fail('TOO_LARGE');
    const snapshot = Buffer.from(bytes);
    checkBytes(snapshot, expected); return snapshot;
  }

  if (config.kind === 'local') {
    if (typeof config.rootDirectory !== 'string' || !isAbsolute(config.rootDirectory)) fail('CONFIG_INVALID');
    const root = resolve(config.rootDirectory);
    async function privateDirectory(path: string, create: boolean, rootDirectory = false) {
      try {
        if (create) await mkdir(path, { mode: 0o700 });
      } catch (error) { if (errorCode(error) !== 'EEXIST') fail('WRITE_FAILED'); }
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isDirectory()) fail('PATH_REJECTED');
        if ((info.mode & 0o777) !== 0o700 || (process.getuid && info.uid !== process.getuid())) fail(rootDirectory ? 'ROOT_NOT_PRIVATE' : 'PATH_REJECTED');
      } catch (error) {
        if (error instanceof CollectorEvidenceError) throw error;
        if (errorCode(error) === 'ENOENT') fail('NOT_FOUND');
        fail('READ_FAILED');
      }
    }
    // The caller provisions the parent; never chmod existing public directories.
    await privateDirectory(root, true, true);
    async function objectDirectory(create: boolean) {
      await privateDirectory(root, false, true);
      let path = root;
      for (const segment of [...namespace.prefix.split('/'), namespace.sourceKey]) {
        path = join(path, segment); await privateDirectory(path, create);
      }
      return path;
    }
    const get = async (key: string): Promise<Uint8Array> => {
      const expected = expectedHash(key); const directory = await objectDirectory(false);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(join(directory, `${expected}.bin`), constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat();
        if (!info.isFile() || (info.mode & 0o077) !== 0) fail('PATH_REJECTED');
        if (info.size > maxBytes) fail('TOO_LARGE');
        // Bound allocation even if a local writer grows the file after stat.
        const chunks: Buffer[] = []; let size = 0;
        for (;;) {
          const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - size + 1));
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
          if (!bytesRead) break;
          size += bytesRead;
          if (size > maxBytes) fail('TOO_LARGE');
          chunks.push(chunk.subarray(0, bytesRead));
        }
        const bytes = Buffer.concat(chunks, size); checkBytes(bytes, expected); return bytes;
      } catch (error) {
        if (error instanceof CollectorEvidenceError) throw error;
        if (errorCode(error) === 'ENOENT') fail('NOT_FOUND');
        if (errorCode(error) === 'ELOOP') fail('PATH_REJECTED');
        fail('READ_FAILED');
      } finally { await handle?.close(); }
    };
    return {
      get,
      async putIfAbsent(key, input, sha256) {
        const bytes = putBytes(key, input, sha256); const directory = await objectDirectory(true);
        const temporary = join(directory, `.evidence-${randomUUID()}.tmp`);
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          handle = await open(temporary, 'wx', 0o600);
          await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
          let status: 'CREATED' | 'EXISTS' = 'CREATED';
          try { await link(temporary, join(directory, `${sha256}.bin`)); }
          catch (error) { if (errorCode(error) !== 'EEXIST') throw error; status = 'EXISTS'; }
          // A conditional conflict is a replay only after exact-byte verification.
          const stored = Buffer.from(await get(key));
          if (!stored.equals(bytes)) fail('HASH_MISMATCH');
          return status;
        } catch (error) {
          if (error instanceof CollectorEvidenceError) throw error;
          fail('WRITE_FAILED');
        } finally {
          await handle?.close();
          await unlink(temporary).catch(() => undefined);
        }
      },
    };
  }

  if (config.kind !== 's3' || typeof config.bucket !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{1,62}$/.test(config.bucket)
    || typeof config.region !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(config.region)) fail('CONFIG_INVALID');
  if (config.endpoint !== undefined) {
    try {
      const endpoint = new URL(config.endpoint);
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new Error();
    } catch { fail('CONFIG_INVALID'); }
  }
  const bucket = config.bucket;
  const client = new S3Client({
    region: config.region, endpoint: config.endpoint, credentials: config.credentials,
    forcePathStyle: config.forcePathStyle ?? false, maxAttempts: 2,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 10000 },
  });
  const get = async (key: string): Promise<Uint8Array> => {
    const expected = expectedHash(key);
    let body: (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(15000) });
      body = response.Body as (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
      if (response.ContentLength !== undefined && response.ContentLength > maxBytes) fail('TOO_LARGE');
      if (!body || typeof body[Symbol.asyncIterator] !== 'function') fail('READ_FAILED');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of body) {
        if (!(chunk instanceof Uint8Array)) fail('READ_FAILED');
        size += chunk.byteLength;
        if (size > maxBytes) fail('TOO_LARGE');
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks, size); checkBytes(bytes, expected); return bytes;
    } catch (error) {
      if (error instanceof CollectorEvidenceError) throw error;
      if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404 || (error as { name?: string })?.name === 'NoSuchKey') fail('NOT_FOUND');
      fail('READ_FAILED');
    } finally { body?.destroy?.(); }
  };
  return {
    get,
    async putIfAbsent(key, input, sha256) {
      const bytes = putBytes(key, input, sha256); let status: 'CREATED' | 'EXISTS' = 'CREATED';
      try {
        await client.send(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: bytes, ContentType: 'application/octet-stream',
          ContentLength: bytes.byteLength, CacheControl: 'private, no-store', IfNoneMatch: '*',
          ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
        }), { abortSignal: AbortSignal.timeout(15000) });
      } catch (error) {
        const httpStatus = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
        if (httpStatus !== 409 && httpStatus !== 412) fail('WRITE_FAILED');
        status = 'EXISTS';
      }
      let stored: Uint8Array;
      try { stored = await get(key); }
      catch (error) {
        if (status === 'EXISTS' && error instanceof CollectorEvidenceError && error.code === 'COLLECTOR_EVIDENCE_NOT_FOUND') fail('CONFLICT');
        throw error;
      }
      if (!Buffer.from(stored).equals(bytes)) fail('HASH_MISMATCH');
      return status;
    },
  };
}
