import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAdvertiserSummary, getRelatedAds } from './advertiser';

const url = process.env.SAAS_TEST_DATABASE_URL;
describe.skipIf(!url)('PostgreSQL source-scoped advertiser library', () => {
  let db: PrismaClient, userId: string, outsiderId: string, disabledId: string, workspaceId: string;
  let sourceId: string, sourceKey: string, advertiserId: string, alternateAdvertiserId: string, alternateAdId: string, anchorId: string, unlinkedId: string, syntheticId: string;
  const createdIds: string[] = [];
  const sameIdentityIds: string[] = [];
  const excludedIds: string[] = [];
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url } } });
    const token = `advertiser-${randomUUID()}`;
    sourceKey = token;
    userId = (await db.user.create({ data: { email: `${token}@example.test` } })).id;
    outsiderId = (await db.user.create({ data: { email: `outsider-${token}@example.test` } })).id;
    disabledId = (await db.user.create({ data: { email: `disabled-${token}@example.test`, disabledAt: new Date() } })).id;
    const organization = await db.organization.create({ data: { name: token, slug: token, members: { create: { userId, role: 'OWNER' } } } });
    workspaceId = (await db.workspace.create({ data: { organizationId: organization.id, name: token, slug: 'library' } })).id;
    sourceId = (await db.dataSource.create({ data: { name: token, key: token, adapterVersion: 'fixture' } })).id;
    const secondSource = await db.dataSource.create({ data: { name: `${token}-other`, key: `${token}-other`, adapterVersion: 'fixture' } });
    const brand = await db.advertiser.create({ data: { dataSourceId: sourceId, sourceAdvertiserId: '123456', name: 'Same display name', pageDomain: 'brand.example' } });
    advertiserId = brand.id;
    const sameNameBrand = await db.advertiser.create({ data: { dataSourceId: sourceId, sourceAdvertiserId: 'different-source-id', name: brand.name } });
    alternateAdvertiserId = sameNameBrand.id;
    const otherSourceBrand = await db.advertiser.create({ data: { dataSourceId: secondSource.id, sourceAdvertiserId: brand.sourceAdvertiserId, name: brand.name } });
    const syntheticBrand = await db.advertiser.create({ data: { dataSourceId: sourceId, sourceAdvertiserId: `page-url-sha256:${'a'.repeat(64)}`, name: brand.name } });
    const now = Date.now();
    const createdAt = new Date(now - 86_400_000);
    const recent = new Date(now - 2 * 86_400_000);
    const old = new Date(now - 9 * 86_400_000);
    const create = async (extra: Record<string, unknown>) => {
      const ad = await db.ad.create({ data: { dataSourceId: sourceId, advertiserId, sourceAdId: randomUUID(), sourceUrl: 'https://www.facebook.com/ads/library/', body: 'Same display name', createdAt, sourceStatus: 'UNKNOWN', ...extra } as any });
      createdIds.push(ad.id);
      return ad;
    };
    anchorId = (await create({ sourceStatus: 'ACTIVE', statusObservedAt: recent, firstObservedAt: recent })).id;
    for (const extra of [
      { sourceStatus: 'ACTIVE', statusObservedAt: recent, firstObservedAt: recent },
      { sourceStatus: 'INACTIVE', statusObservedAt: old, firstObservedAt: old },
      { sourceStatus: 'UNKNOWN' },
      { sourceStatus: 'ACTIVE', statusObservedAt: new Date(now + 86_400_000), firstObservedAt: new Date(now + 86_400_000) },
    ]) sameIdentityIds.push((await create(extra)).id);
    alternateAdId = (await create({ advertiserId: sameNameBrand.id, sourceStatus: 'ACTIVE', firstObservedAt: recent })).id;
    excludedIds.push(alternateAdId);
    excludedIds.push((await create({ advertiserId: otherSourceBrand.id, dataSourceId: secondSource.id, sourceStatus: 'ACTIVE', firstObservedAt: recent })).id);
    excludedIds.push((await create({ createdAt: new Date(now + 86_400_000), sourceStatus: 'ACTIVE', firstObservedAt: recent })).id);
    unlinkedId = (await create({ advertiserId: null, fieldProvenance: { advertiserName: { value: brand.name } } })).id;
    syntheticId = (await create({ advertiserId: syntheticBrand.id })).id;
    await db.mediaObject.create({ data: { adId: sameIdentityIds[0], type: 'IMAGE', sourceUrl: 'https://source.example/image.jpg', status: 'PENDING' } });
  });
  afterAll(async () => {
    if (db) {
      await db.mediaObject.deleteMany({ where: { adId: { in: createdIds } } });
      await db.ad.deleteMany({ where: { id: { in: createdIds } } });
      await db.$disconnect();
    }
  });
  const input = () => ({ userId, workspaceId, adId: anchorId });

  it('counts exact source advertiser identity, keeps old/unknown statuses distinct and excludes future observations', async () => {
    const summary = await getAdvertiserSummary(db, input());
    expect(summary).toMatchObject({ name: 'Same display name', sourceAdvertiserId: '123456', collectedAds: 5, activeAds: 2, newAds7Days: 2, websiteUrl: 'https://brand.example' });
    expect(summary!.recentAds).toHaveLength(3);
    expect(summary!.recentAds.map(ad => ad.id)).not.toContain(anchorId);
    expect(summary!.recentAds.every(ad => sameIdentityIds.includes(ad.id))).toBe(true);
    expect(summary!.recentAds.every(ad => ad.dataSourceId === sourceId && ad.advertiserId === advertiserId)).toBe(true);
  });

  it('paginates equal import timestamps by ID and never merges same-name or cross-source advertisers', async () => {
    const first = await getRelatedAds(db, { ...input(), limit: 2 });
    const second = await getRelatedAds(db, { ...input(), limit: 2, cursor: first.nextCursor! });
    const ids = [...first.ads, ...second.ads].map(ad => ad.id);
    expect(ids).toEqual([...sameIdentityIds].sort().reverse());
    expect(new Set(ids).size).toBe(4);
    expect(ids.some(id => excludedIds.includes(id))).toBe(false);
    expect(first.total).toBe(4);
    expect(first).toMatchObject({ anchorIdentity: { sourceAdvertiserId: '123456', dataSourceKey: sourceKey } });
    expect(second.total).toBe(4);
    expect(second.asOf).toBe(first.asOf);
    expect(second.nextCursor).toBeNull();
  });

  it('keeps imports after the first-page cutoff out of subsequent pages', async () => {
    const first = await getRelatedAds(db, { ...input(), limit: 2 });
    const ad = await db.ad.create({ data: { dataSourceId: sourceId, advertiserId, sourceAdId: randomUUID(), sourceUrl: 'https://www.facebook.com/ads/library/', createdAt: new Date(Date.parse(first.asOf) + 1000) } });
    createdIds.push(ad.id);
    const second = await getRelatedAds(db, { ...input(), limit: 2, cursor: first.nextCursor! });
    expect(second.ads.map(row => row.id)).not.toContain(ad.id);
    expect(second.total).toBe(4);
  });

  it('binds cursors to the anchor ad and rejects future dates', async () => {
    const first = await getRelatedAds(db, { ...input(), limit: 1 });
    await expect(getRelatedAds(db, { ...input(), adId: sameIdentityIds[0], cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'INVALID_RELATED_CURSOR' });
    const value = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'));
    value.asOf = new Date(Date.now() + 86_400_000).toISOString();
    await expect(getRelatedAds(db, { ...input(), cursor: Buffer.from(JSON.stringify(value)).toString('base64url') })).rejects.toMatchObject({ code: 'INVALID_RELATED_CURSOR' });
  });

  it('returns no invented grouping for unlinked or URL-hashed identities', async () => {
    for (const adId of [unlinkedId, syntheticId]) {
      expect(await getAdvertiserSummary(db, { ...input(), adId })).toBeNull();
      expect(await getRelatedAds(db, { ...input(), adId })).toMatchObject({ total: 0, ads: [], nextCursor: null, anchorIdentity: null });
    }
  });

  it('enforces active account and workspace membership for both aggregate and related data', async () => {
    for (const operation of [getAdvertiserSummary, getRelatedAds]) {
      await expect(operation(db, { ...input(), userId: '' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      await expect(operation(db, { ...input(), userId: disabledId })).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
      await expect(operation(db, { ...input(), userId: outsiderId })).rejects.toMatchObject({ code: 'ORGANIZATION_FORBIDDEN' });
      await expect(operation(db, { ...input(), workspaceId: randomUUID() })).rejects.toMatchObject({ code: 'WORKSPACE_FORBIDDEN' });
    }
  });

  it('returns the actual anchor identity after collection relinks an advertiser even when display names match', async () => {
    const oldPage = await getRelatedAds(db, { ...input(), limit: 1 });
    expect(oldPage.anchorIdentity).toEqual({ sourceAdvertiserId: '123456', dataSourceKey: sourceKey });
    await db.ad.update({ where: { id: anchorId }, data: { advertiserId: alternateAdvertiserId } });
    try {
      const relinkedPage = await getRelatedAds(db, input());
      expect(relinkedPage.anchorIdentity).toEqual({ sourceAdvertiserId: 'different-source-id', dataSourceKey: sourceKey });
      expect(relinkedPage.ads.map(ad => ad.id)).toEqual([alternateAdId]);
      expect(relinkedPage.anchorIdentity).not.toEqual(oldPage.anchorIdentity);
      expect(oldPage.nextCursor).not.toBeNull();
      await expect(getRelatedAds(db, { ...input(), cursor: oldPage.nextCursor! })).rejects.toMatchObject({ code: 'INVALID_RELATED_CURSOR' });
    } finally {
      await db.ad.update({ where: { id: anchorId }, data: { advertiserId } });
    }
  });
});
