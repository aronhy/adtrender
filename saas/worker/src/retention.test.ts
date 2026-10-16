import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { expireStoredFiles } from './retention';

const require = createRequire(new URL('../../app/package.json', import.meta.url));
const testUrl = process.env.SAAS_TEST_DATABASE_URL;
let db: any, workspace: any, ad: any;
it('does not query after a shutdown signal', async () => {
  const controller = new AbortController(); controller.abort();
  expect(await expireStoredFiles({} as any, undefined, { signal: controller.signal })).toMatchObject({ status: 'CANCELED', deleted: 0 });
});
async function fixture(expiresAt: Date | null = new Date(Date.now() - 60_000)) {
  const file = await db.privateFile.create({ data: { organizationId: workspace.organizationId, workspaceId: workspace.id, storageKey: `private/${workspace.organizationId}/${workspace.id}/${randomUUID()}`, filename: 'expiry.png', mimeType: 'image/png', sizeBytes: 12n, sha256: 'a'.repeat(64), status: 'READY', expiresAt } });
  const media = await db.mediaObject.create({ data: { adId: ad.id, sourceUrl: `https://example.invalid/${randomUUID()}`, type: 'IMAGE', storageKey: `public-media/${randomUUID()}`, status: 'READY', expiresAt } });
  return { file, media, options: { scope: { privateFileIds: [file.id], mediaObjectIds: [media.id] } } };
}
describe.skipIf(!testUrl)('PostgreSQL expiry retention and storage boundary', () => {
  beforeAll(async () => {
    const { PrismaClient } = require('@prisma/client'); db = new PrismaClient({ datasources: { db: { url: testUrl } } });
    const user = await db.user.create({ data: { email: `retention-${randomUUID()}@example.invalid` } });
    const organization = await db.organization.create({ data: { name: 'Retention test', slug: `retention-${randomUUID()}`, members: { create: { userId: user.id, role: 'OWNER' } } } });
    workspace = await db.workspace.create({ data: { organizationId: organization.id, name: 'Retention scope', slug: `retention-${randomUUID()}` } });
    const source = await db.dataSource.create({ data: { key: `retention-${randomUUID()}`, name: 'Retention test', adapterVersion: 'test' } });
    ad = await db.ad.create({ data: { dataSourceId: source.id, sourceAdId: randomUUID(), sourceUrl: 'https://example.invalid/ad' } });
  });
  afterAll(async () => { await db?.$disconnect(); });
  it('expires references without pretending storage deletion when storage is absent', async () => {
    const f = await fixture();
    expect(await expireStoredFiles(db, undefined, f.options)).toMatchObject({ status: 'CONFIGURATION_REQUIRED', deleted: 0 });
    expect((await db.privateFile.findUnique({ where: { id: f.file.id } })).status).toBe('EXPIRED');
    expect((await db.mediaObject.findUnique({ where: { id: f.media.id } })).status).toBe('EXPIRED');
  });
  it('preserves failures as expired and retries successfully on a later sweep', async () => {
    const f = await fixture(); const storage = { delete: vi.fn(async (): Promise<void> => { throw new Error('PRIVATE_PROVIDER_DETAILS'); }) };
    expect(await expireStoredFiles(db, storage, f.options)).toMatchObject({ deleted: 0, failed: 2 });
    expect(await db.mediaObject.findUnique({ where: { id: f.media.id } })).toMatchObject({ status: 'EXPIRED', errorCode: 'STORAGE_DELETE_FAILED' });
    expect((await db.privateFile.findUnique({ where: { id: f.file.id } })).status).toBe('EXPIRED');
    storage.delete.mockImplementation(async () => {});
    expect(await expireStoredFiles(db, storage, f.options)).toMatchObject({ deleted: 2, failed: 0 });
    expect((await db.privateFile.findUnique({ where: { id: f.file.id } })).status).toBe('DELETED');
    expect(await db.mediaObject.findUnique({ where: { id: f.media.id } })).toMatchObject({ status: 'DELETED', errorCode: null });
  });
  it('deletes a locked object only once across concurrent sweeps', async () => {
    const f = await fixture(); const options = { scope: { privateFileIds: [f.file.id], mediaObjectIds: [] } };
    let unblock!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
    const storage = { delete: vi.fn(async () => { entered(); await gate; }) };
    const first = expireStoredFiles(db, storage, options); await started;
    try { expect(await expireStoredFiles(db, storage, options)).toMatchObject({ deleted: 0 }); }
    finally { unblock(); }
    expect(await first).toMatchObject({ deleted: 1 }); expect(storage.delete).toHaveBeenCalledTimes(1);
  });
  it('only acts on explicit elapsed expiry and stops before work on shutdown', async () => {
    const never = await fixture(null); const future = await fixture(new Date(Date.now() + 3600_000));
    const storage = { delete: vi.fn(async () => {}) };
    const options = { scope: { privateFileIds: [never.file.id, future.file.id], mediaObjectIds: [never.media.id, future.media.id] } };
    expect(await expireStoredFiles(db, storage, options)).toMatchObject({ deleted: 0 });
    expect(storage.delete).not.toHaveBeenCalled();
    const elapsed = await fixture(); const controller = new AbortController(); controller.abort();
    expect(await expireStoredFiles(db, storage, { ...elapsed.options, signal: controller.signal })).toMatchObject({ status: 'CANCELED', deleted: 0 });
    expect((await db.privateFile.findUnique({ where: { id: elapsed.file.id } })).status).toBe('READY');
  });
  it('keeps archived public bytes permanently while private file expiry still deletes', async () => {
    const f = await fixture();
    await db.mediaObject.update({ where: { id: f.media.id }, data: {
      sha256: 'a'.repeat(64), mimeType: 'image/png', sizeBytes: 12n, downloadedAt: new Date('2026-10-05T00:00:00Z'),
    } });
    const deletedKeys: string[] = [];
    const storage = { delete: async (key: string) => { deletedKeys.push(key); } };
    expect(await expireStoredFiles(db, storage, f.options)).toMatchObject({ deleted: 1, failed: 0 });
    expect(deletedKeys).toEqual([f.file.storageKey]);
    expect(await db.mediaObject.findUnique({ where: { id: f.media.id } })).toMatchObject({ status: 'READY', storageKey: f.media.storageKey });
    expect(await db.privateFile.findUnique({ where: { id: f.file.id } })).toMatchObject({ status: 'DELETED' });
  });
  it('excludes archived candidates before the bounded scan so they cannot starve unarchived cleanup', async () => {
    const archived = [await fixture(), await fixture()];
    for (const f of archived) await db.mediaObject.update({ where: { id: f.media.id }, data: {
      sha256: 'b'.repeat(64), mimeType: 'image/png', sizeBytes: 12n, downloadedAt: new Date(),
      updatedAt: new Date('2026-10-01T00:00:00Z'),
    } });
    const unarchived = await fixture(), deletedKeys: string[] = [];
    const storage = { delete: async (key: string) => { deletedKeys.push(key); } };
    expect(await expireStoredFiles(db, storage, { limit: 1, scope: { privateFileIds: [],
      mediaObjectIds: [...archived.map(f => f.media.id), unarchived.media.id] } })).toMatchObject({ deleted: 1, failed: 0 });
    expect(deletedKeys).toEqual([unarchived.media.storageKey]);
    expect(await db.mediaObject.findUnique({ where: { id: unarchived.media.id } })).toMatchObject({ status: 'DELETED' });
  });
  it('rechecks the locked public reference if it becomes archived after candidate selection', async () => {
    const f = await fixture(), deletedKeys: string[] = [];
    let first = true;
    const racingDb = new Proxy(db, { get(target, key) {
      if (key !== '$transaction') return target[key];
      return async (callback: any, options: any) => {
        if (first) {
          first = false;
          await db.mediaObject.update({ where: { id: f.media.id }, data: {
            sha256: 'c'.repeat(64), mimeType: 'image/png', sizeBytes: 12n, downloadedAt: new Date(),
          } });
        }
        return target.$transaction(callback, options);
      };
    } });
    expect(await expireStoredFiles(racingDb, { delete: async (key: string) => { deletedKeys.push(key); } },
      { scope: { privateFileIds: [], mediaObjectIds: [f.media.id] } })).toMatchObject({ deleted: 0, failed: 0 });
    expect(deletedKeys).toEqual([]);
    expect(await db.mediaObject.findUnique({ where: { id: f.media.id } })).toMatchObject({ status: 'READY' });
  });
});
