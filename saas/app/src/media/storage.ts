import { createHash, randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Prisma } from '@prisma/client';
import { DomainError, requireWorkspaceRole } from '../team/access';
import { matchesMediaSignature, MEDIA_MAX_BYTES } from './download';

export type StorageScope = { kind: 'public' } | { kind: 'private'; organizationId: string; workspaceId: string };
export type PutMedia = { bytes: Uint8Array; mimeType: string; scope: StorageScope };
export type SignOptions = { expiresInSeconds?: number; objectExpiresAt?: Date | null; disposition?: 'inline' | 'attachment'; filename?: string };
const uuidPattern = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const keyPattern = new RegExp(`^(?:public-media|private/[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128})/${uuidPattern}$`);
function assertStorageKey(key: string) {
  if (!keyPattern.test(key)) throw new DomainError(400, 'STORAGE_KEY_REJECTED');
}
function privatePrefix(organizationId: string, workspaceId: string) {
  if (![organizationId, workspaceId].every(id => /^[A-Za-z0-9_-]{1,128}$/.test(id))) throw new DomainError(400, 'STORAGE_KEY_REJECTED');
  return `private/${organizationId}/${workspaceId}/`;
}
function checkExpiry(expiresAt?: Date | null) {
  if (expiresAt && (!Number.isFinite(expiresAt.valueOf()) || expiresAt.valueOf() <= Date.now())) throw new DomainError(410, 'FILE_EXPIRED');
}
function contentDisposition(options: SignOptions): string {
  const disposition = options.disposition ?? 'inline';
  if (!['inline', 'attachment'].includes(disposition)
    || (options.filename !== undefined && (typeof options.filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(options.filename) || options.filename.includes('..')))) {
    throw new DomainError(400, 'STORAGE_DISPOSITION_REJECTED');
  }
  return options.filename ? `${disposition}; filename="${options.filename}"` : disposition;
}

/** Server-owned adapter: callers supply scope, never an upload object key or ACL. */
export class S3Storage {
  private readonly client: S3Client;
  private readonly bucket: string;
  constructor(config: S3ClientConfig & { bucket: string }) {
    const { bucket, ...clientConfig } = config;
    if (!bucket || /[\s/]/.test(bucket)) throw new DomainError(500, 'STORAGE_CONFIG_INVALID');
    if (typeof clientConfig.endpoint === 'string') {
      try { if (new URL(clientConfig.endpoint).protocol !== 'https:') throw new Error(); }
      catch { throw new DomainError(500, 'STORAGE_CONFIG_INVALID'); }
    }
    this.bucket = bucket;
    this.client = new S3Client(clientConfig);
  }
  async put(input: PutMedia) {
    if (!input.bytes.length || input.bytes.length > MEDIA_MAX_BYTES) throw new DomainError(400, 'MEDIA_TOO_LARGE');
    if (!matchesMediaSignature(input.mimeType, input.bytes)) throw new DomainError(400, 'MEDIA_TYPE_REJECTED');
    const storageKey = `${input.scope.kind === 'public' ? 'public-media/' : privatePrefix(input.scope.organizationId, input.scope.workspaceId)}${randomUUID()}`;
    const bytes = Buffer.from(input.bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket, Key: storageKey, Body: bytes, ContentType: input.mimeType,
        ContentLength: bytes.length, CacheControl: 'private, no-store',
        ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
      }));
    } catch { throw new DomainError(502, 'STORAGE_WRITE_FAILED'); }
    return { storageKey, mimeType: input.mimeType, sizeBytes: BigInt(bytes.length), sha256 };
  }
  async signGet(storageKey: string, options: SignOptions = {}) {
    assertStorageKey(storageKey);
    checkExpiry(options.objectExpiresAt);
    const disposition = contentDisposition(options);
    const requested = options.expiresInSeconds ?? 60;
    if (!Number.isInteger(requested) || requested < 1 || requested > 300) throw new DomainError(400, 'STORAGE_TTL_REJECTED');
    const now = new Date();
    const expiresIn = options.objectExpiresAt ? Math.min(requested, Math.floor((options.objectExpiresAt.valueOf() - now.valueOf()) / 1000)) : requested;
    if (expiresIn < 1) throw new DomainError(410, 'FILE_EXPIRED');
    try {
      const url = await getSignedUrl(this.client, new GetObjectCommand({
        Bucket: this.bucket, Key: storageKey, ResponseCacheControl: 'private, no-store', ResponseContentDisposition: disposition,
      }), { expiresIn, signingDate: now });
      return { url, expiresAt: new Date(now.valueOf() + expiresIn * 1000) };
    } catch { throw new DomainError(502, 'STORAGE_SIGN_FAILED'); }
  }
  async delete(storageKey: string): Promise<void> {
    assertStorageKey(storageKey);
    try { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey })); }
    catch { throw new DomainError(502, 'STORAGE_DELETE_FAILED'); }
  }
}

type PrivateStorage = Pick<S3Storage, 'put' | 'signGet' | 'delete'>;
export type PrivateUpload = { bytes: Uint8Array; mimeType: string; filename: string; expiresAt?: Date | null };
export async function putPrivateFile(db: Prisma.TransactionClient, userId: string, workspaceId: string, input: PrivateUpload, storage: PrivateStorage) {
  const access = await requireWorkspaceRole(db, userId, workspaceId, true);
  if (!input.filename || input.filename.length > 255 || /[\\/\u0000-\u001f]/.test(input.filename)) throw new DomainError(400, 'FILE_NAME_REJECTED');
  checkExpiry(input.expiresAt);
  const object = await storage.put({ bytes: input.bytes, mimeType: input.mimeType,
    scope: { kind: 'private', organizationId: access.workspace.organizationId, workspaceId: access.workspace.id } });
  try {
    return await db.privateFile.create({ data: {
      ...object, organizationId: access.workspace.organizationId, workspaceId: access.workspace.id,
      filename: input.filename, expiresAt: input.expiresAt ?? null, status: 'READY',
    } });
  } catch {
    // The object remains private even if cleanup fails; provider errors are never propagated.
    try { await storage.delete(object.storageKey); } catch { /* A later orphan sweep can remove the private object. */ }
    throw new DomainError(500, 'FILE_SAVE_FAILED');
  }
}

async function authorizeFile(db: Prisma.TransactionClient, userId: string, fileId: string, write: boolean) {
  const file = await db.privateFile.findUnique({ where: { id: fileId } });
  if (!file) throw new DomainError(404, 'FILE_NOT_FOUND');
  const access = await requireWorkspaceRole(db, userId, file.workspaceId, write);
  if (file.organizationId !== access.workspace.organizationId || !file.storageKey.startsWith(privatePrefix(file.organizationId, file.workspaceId))) {
    throw new DomainError(403, 'FILE_UNAVAILABLE');
  }
  assertStorageKey(file.storageKey);
  return file;
}

/** Use this service from authenticated operations; never sign a client-supplied storage key. */
export async function signPrivateFile(db: Prisma.TransactionClient, userId: string, fileId: string, storage: PrivateStorage, expiresInSeconds = 60) {
  const file = await authorizeFile(db, userId, fileId, false);
  if (file.status !== 'READY') throw new DomainError(409, 'FILE_UNAVAILABLE');
  checkExpiry(file.expiresAt);
  return storage.signGet(file.storageKey, { expiresInSeconds, objectExpiresAt: file.expiresAt });
}

export async function deletePrivateFile(db: Prisma.TransactionClient, userId: string, fileId: string, storage: PrivateStorage) {
  const file = await authorizeFile(db, userId, fileId, true);
  if (file.status === 'DELETED') return;
  await storage.delete(file.storageKey);
  try { await db.privateFile.update({ where: { id: file.id }, data: { status: 'DELETED' } }); }
  catch { throw new DomainError(500, 'FILE_DELETE_RECORD_FAILED'); }
}
