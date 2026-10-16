import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signPublicAdMediaDownload } from './public-download';

const url = process.env.SAAS_TEST_DATABASE_URL;
describe.skipIf(!url)('PostgreSQL public creative download authorization', () => {
  let db: PrismaClient, viewerId: string, disabledId: string, outsiderId: string, workspaceId: string, adId: string;
  let readyId: string, otherAdMediaId: string, pendingId: string, expiredId: string;
  const signGet = vi.fn().mockResolvedValue({ url: 'https://objects.example/download?signed=fixture', expiresAt: new Date(Date.now() + 300_000) });
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url } } });
    const token = `download-${randomUUID()}`;
    const ownerId = (await db.user.create({ data: { email: `owner-${token}@example.test` } })).id;
    viewerId = (await db.user.create({ data: { email: `viewer-${token}@example.test` } })).id;
    disabledId = (await db.user.create({ data: { email: `disabled-${token}@example.test`, disabledAt: new Date() } })).id;
    outsiderId = (await db.user.create({ data: { email: `outsider-${token}@example.test` } })).id;
    const organization = await db.organization.create({ data: { name: token, slug: token, members: { create: [{ userId: ownerId, role: 'OWNER' }, { userId: viewerId, role: 'MEMBER' }] } } });
    workspaceId = (await db.workspace.create({ data: { organizationId: organization.id, name: token, slug: 'download', members: { create: { userId: viewerId, role: 'VIEWER' } } } })).id;
    const source = await db.dataSource.create({ data: { name: token, key: token, adapterVersion: 'fixture' } });
    const otherSource = await db.dataSource.create({ data: { name: `other-${token}`, key: `other-${token}`, adapterVersion: 'fixture' } });
    adId = (await db.ad.create({ data: { dataSourceId: source.id, sourceAdId: randomUUID(), sourceUrl: 'https://example.test/ad' } })).id;
    const otherAdId = (await db.ad.create({ data: { dataSourceId: otherSource.id, sourceAdId: randomUUID(), sourceUrl: 'https://example.test/other-ad' } })).id;
    const createReady = (targetAdId: string, extra = {}) => db.mediaObject.create({ data: { adId: targetAdId, sourceUrl: `https://cdn.example.test/${randomUUID()}.png`, status: 'READY', type: 'IMAGE', mimeType: 'image/png', storageKey: `public-media/${randomUUID()}`, sha256: 'a'.repeat(64), sizeBytes: 12n, downloadedAt: new Date(), ...extra } });
    readyId = (await createReady(adId)).id;
    otherAdMediaId = (await createReady(otherAdId)).id;
    pendingId = (await db.mediaObject.create({ data: { adId, sourceUrl: 'https://cdn.example.test/not-stored.png', status: 'PENDING', type: 'IMAGE' } })).id;
    // The archive trigger clears source-CDN expiry for complete owned captures.
    // A legacy row without verified bytes metadata can still carry an expiry.
    expiredId = (await createReady(adId, { expiresAt: new Date(0), sha256: null })).id;
  });
  // Captured bytes evidence is intentionally immutable and survives this fixture;
  // only the disposable local database can be discarded after all release checks.
  afterAll(async () => { await db?.$disconnect(); });
  const input = () => ({ userId: viewerId, workspaceId, adId, mediaId: readyId });

  it('lets a viewer sign only their requested ad persisted creative without exposing metadata', async () => {
    const result = await signPublicAdMediaDownload(db, input(), { signGet });
    expect(result).toEqual({ url: 'https://objects.example/download?signed=fixture', expiresAt: expect.any(Date) });
    expect(signGet.mock.calls.at(-1)![1]).toMatchObject({ disposition: 'attachment', filename: `creative-${readyId}.png`, expiresInSeconds: 300 });
    expect(result).not.toHaveProperty('storageKey');
    expect(result).not.toHaveProperty('sourceUrl');
  });

  it('rejects other-ad objects, unpersisted and expired bytes instead of signing a source URL', async () => {
    for (const [mediaId, code] of [[otherAdMediaId, 'AD_MEDIA_NOT_FOUND'], [pendingId, 'AD_MEDIA_UNAVAILABLE'], [expiredId, 'AD_MEDIA_EXPIRED'], [randomUUID(), 'AD_MEDIA_NOT_FOUND']]) {
      const before = signGet.mock.calls.length;
      await expect(signPublicAdMediaDownload(db, { ...input(), mediaId }, { signGet })).rejects.toMatchObject({ code });
      expect(signGet.mock.calls.length).toBe(before);
    }
  });

  it('denies disabled, unauthenticated and nonmember accounts before issuing a URL', async () => {
    for (const [userId, code] of [['', 'AUTH_REQUIRED'], [disabledId, 'ACCOUNT_DISABLED'], [outsiderId, 'ORGANIZATION_FORBIDDEN']]) {
      await expect(signPublicAdMediaDownload(db, { ...input(), userId }, { signGet })).rejects.toMatchObject({ code });
    }
    await expect(signPublicAdMediaDownload(db, { ...input(), workspaceId: randomUUID() }, { signGet })).rejects.toMatchObject({ code: 'WORKSPACE_FORBIDDEN' });
  });
});
