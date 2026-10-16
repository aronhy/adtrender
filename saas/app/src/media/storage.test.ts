import { Readable } from 'node:stream';
import type { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S3Storage, putPrivateFile, signPrivateFile, deletePrivateFile } from './storage';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
function storageFixture() {
  const requests: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
  let fail = false;
  const storage = new S3Storage({
    bucket: 'private-test-bucket', region: 'us-east-1', maxAttempts: 1,
    credentials: { accessKeyId: 'TEST_ACCESS', secretAccessKey: 'TEST_SECRET' },
    requestHandler: { handle: async (request: typeof requests[number]) => {
      requests.push(request);
      if (fail) throw new Error('PROVIDER_TOKEN_DO_NOT_LEAK');
      return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } };
    } },
  });
  return { storage, requests, fail: () => { fail = true; } };
}
function dbFixture(role = 'VIEWER') {
  let member = true;
  let file: Record<string, any> = { id: 'file-1', organizationId: 'org-a', workspaceId: 'ws-a',
    storageKey: 'private/org-a/ws-a/12345678-1234-4234-8234-123456789012', status: 'READY', expiresAt: null };
  const db = {
    user: { findUnique: async () => ({ id: 'user', disabledAt: null, isAdmin: false }) },
    workspace: { findUnique: async ({ where }: any) => ({ id: where.id, organizationId: where.id === 'ws-a' ? 'org-a' : 'org-b', archivedAt: null }) },
    organizationMember: { findUnique: async ({ where }: any) => member && where.organizationId_userId.organizationId === 'org-a' ? { role: 'MEMBER', organization: { id: 'org-a', status: 'ACTIVE' } } : null },
    workspaceMember: { findUnique: async () => ({ role, organizationId: 'org-a' }) },
    privateFile: {
      findUnique: async ({ where }: any) => where.id === file.id ? { ...file } : null,
      create: async ({ data }: any) => { file = { id: 'created-file', ...data }; return file; },
      update: async ({ data }: any) => { file = { ...file, ...data }; return file; },
    },
  } as unknown as Prisma.TransactionClient;
  return { db, file: () => file, set: (data: Record<string, unknown>) => { file = { ...file, ...data }; }, removeMember: () => { member = false; } };
}
afterEach(() => { vi.useRealTimers(); });

describe('S3 media storage', () => {
  it('generates unique server keys and sends validated bytes without a public ACL', async () => {
    const { storage, requests } = storageFixture();
    const first = await storage.put({ bytes: png, mimeType: 'image/png', scope: { kind: 'public' } });
    const second = await storage.put({ bytes: png, mimeType: 'image/png', scope: { kind: 'public' } });
    expect(first).toMatchObject({ sizeBytes: 12n, mimeType: 'image/png' });
    expect(first.storageKey).toMatch(/^public-media\/[a-f0-9-]{36}$/);
    expect(first.storageKey).not.toBe(second.storageKey);
    expect(requests[0].method).toBe('PUT');
    expect(requests[0].headers['content-type']).toBe('image/png');
    expect(requests[0].headers).not.toHaveProperty('x-amz-acl');
    await storage.delete(first.storageKey);
    expect(requests.at(-1)?.method).toBe('DELETE');
  });
  it('rejects forged MIME and object key paths before sending any object request', async () => {
    const { storage, requests } = storageFixture();
    await expect(storage.put({ bytes: Buffer.from('HTML'), mimeType: 'image/png', scope: { kind: 'public' } })).rejects.toMatchObject({ code: 'MEDIA_TYPE_REJECTED' });
    await expect(storage.signGet('../private/file')).rejects.toMatchObject({ code: 'STORAGE_KEY_REJECTED' });
    await expect(storage.delete('private/org/../file')).rejects.toMatchObject({ code: 'STORAGE_KEY_REJECTED' });
    expect(requests).toHaveLength(0);
  });
  it('signs for 60 seconds by default, bounds TTL to 300 and rejects expiry', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T00:00:00Z'));
    const { storage } = storageFixture();
    const key = 'public-media/12345678-1234-4234-8234-123456789012';
    const signed = await storage.signGet(key);
    expect(new URL(signed.url).searchParams.get('X-Amz-Expires')).toBe('60');
    expect(signed.expiresAt.toISOString()).toBe('2026-10-04T00:01:00.000Z');
    const limited = await storage.signGet(key, { expiresInSeconds: 300, objectExpiresAt: new Date('2026-10-04T00:00:12Z') });
    expect(new URL(limited.url).searchParams.get('X-Amz-Expires')).toBe('12');
    await expect(storage.signGet(key, { expiresInSeconds: 301 })).rejects.toMatchObject({ code: 'STORAGE_TTL_REJECTED' });
    await expect(storage.signGet(key, { objectExpiresAt: new Date('2026-10-03T00:00:00Z') })).rejects.toMatchObject({ code: 'FILE_EXPIRED' });
  });
  it('returns stable provider failure codes without exposing provider messages', async () => {
    const fixture = storageFixture(); fixture.fail();
    await expect(fixture.storage.put({ bytes: png, mimeType: 'image/png', scope: { kind: 'public' } }))
      .rejects.toMatchObject({ code: 'STORAGE_WRITE_FAILED', message: 'STORAGE_WRITE_FAILED' });
  });
  it('preserves inline previews and signs an attachment filename into download URLs', async () => {
    const { storage } = storageFixture();
    const key = 'public-media/12345678-1234-4234-8234-123456789012';
    const preview = await storage.signGet(key);
    expect(new URL(preview.url).searchParams.get('response-content-disposition')).toBe('inline');
    const download = await storage.signGet(key, { disposition: 'attachment', filename: 'creative-12345678-1234-4234-8234-123456789012.jpg', expiresInSeconds: 300 });
    expect(new URL(download.url).searchParams.get('response-content-disposition')).toBe('attachment; filename="creative-12345678-1234-4234-8234-123456789012.jpg"');
    expect(new URL(download.url).searchParams.get('X-Amz-Expires')).toBe('300');
    expect(new URL(download.url).searchParams.get('X-Amz-Signature')).not.toBe(new URL(preview.url).searchParams.get('X-Amz-Signature'));
  });
  it.each(['../../private', 'injected"; other="header', 'evil\r\nheader', 'unsafe name.jpg'])('rejects unsafe signed download filenames: %s', async filename => {
    const { storage } = storageFixture();
    await expect(storage.signGet('public-media/12345678-1234-4234-8234-123456789012', { disposition: 'attachment', filename })).rejects.toMatchObject({ code: 'STORAGE_DISPOSITION_REJECTED' });
  });
});

describe('private file authorization', () => {
  it('allows a viewer to sign their workspace file and denies another organization or removed member', async () => {
    const fixture = dbFixture(), { storage } = storageFixture();
    expect((await signPrivateFile(fixture.db, 'user', 'file-1', storage)).url).toContain('X-Amz-Signature');
    fixture.set({ workspaceId: 'ws-b', organizationId: 'org-b' });
    await expect(signPrivateFile(fixture.db, 'user', 'file-1', storage)).rejects.toMatchObject({ status: 403 });
    fixture.set({ workspaceId: 'ws-a', organizationId: 'org-a' }); fixture.removeMember();
    await expect(signPrivateFile(fixture.db, 'user', 'file-1', storage)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects a private key belonging to another workspace and unavailable/expired records', async () => {
    const fixture = dbFixture(), { storage } = storageFixture();
    fixture.set({ storageKey: 'private/org-a/ws-other/12345678-1234-4234-8234-123456789012' });
    await expect(signPrivateFile(fixture.db, 'user', 'file-1', storage)).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' });
    fixture.set({ storageKey: 'private/org-a/ws-a/12345678-1234-4234-8234-123456789012', status: 'PENDING' });
    await expect(signPrivateFile(fixture.db, 'user', 'file-1', storage)).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' });
    fixture.set({ status: 'READY', expiresAt: new Date(0) });
    await expect(signPrivateFile(fixture.db, 'user', 'file-1', storage)).rejects.toMatchObject({ code: 'FILE_EXPIRED' });
  });
  it('requires editor authorization for upload and deletion and persists server-derived metadata', async () => {
    const viewer = dbFixture(), { storage, requests } = storageFixture();
    const upload = { bytes: png, mimeType: 'image/png', filename: 'PRIVATE_NAME.png' };
    await expect(putPrivateFile(viewer.db, 'user', 'ws-a', upload, storage)).rejects.toMatchObject({ code: 'WORKSPACE_FORBIDDEN' });
    await expect(deletePrivateFile(viewer.db, 'user', 'file-1', storage)).rejects.toMatchObject({ code: 'WORKSPACE_FORBIDDEN' });
    expect(requests).toHaveLength(0);
    const editor = dbFixture('EDITOR');
    const file = await putPrivateFile(editor.db, 'user', 'ws-a', upload, storage);
    expect(file).toMatchObject({ organizationId: 'org-a', workspaceId: 'ws-a', sizeBytes: 12n, status: 'READY' });
    expect(file.storageKey).not.toContain(upload.filename);
    await deletePrivateFile(editor.db, 'user', file.id, storage);
    expect(editor.file().status).toBe('DELETED');
  });
  it('cleans up an uploaded object when metadata persistence fails without exposing database errors', async () => {
    const fixture = dbFixture('EDITOR'), { storage, requests } = storageFixture();
    fixture.db.privateFile.create = (async () => { throw new Error('PRIVATE_DATABASE_VALUE'); }) as never;
    await expect(putPrivateFile(fixture.db, 'user', 'ws-a', { bytes: png, mimeType: 'image/png', filename: 'a.png' }, storage))
      .rejects.toMatchObject({ code: 'FILE_SAVE_FAILED', message: 'FILE_SAVE_FAILED' });
    expect(requests.map(request => request.method)).toEqual(['PUT', 'DELETE']);
  });
});
