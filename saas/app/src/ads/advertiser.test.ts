import { describe, expect, it, vi } from 'vitest';
import { getAdvertiserSummary, getRelatedAds, matchesAdvertiserSummary } from './advertiser';

function fixture(options: { linked?: boolean; identity?: string; disabled?: boolean; member?: boolean } = {}) {
  const tx = {
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'user', disabledAt: options.disabled ? new Date() : null }) },
    workspace: { findUnique: vi.fn().mockResolvedValue({ id: 'workspace', organizationId: 'organization', archivedAt: null }) },
    organizationMember: { findUnique: vi.fn().mockResolvedValue(options.member === false ? null : { role: 'OWNER', organization: { id: 'organization', status: 'ACTIVE' } }) },
    ad: { findUnique: vi.fn().mockResolvedValue({ id: 'ad', dataSourceId: 'source', advertiserId: options.linked === false ? null : 'advertiser', dataSource: { key: 'meta' }, advertiser: options.linked === false ? null : { id: 'advertiser', dataSourceId: 'source', sourceAdvertiserId: options.identity ?? '123456', name: 'Source brand', pageDomain: 'brand.example', fieldProvenance: {} } }), findMany: vi.fn().mockResolvedValue([]) },
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ collectedAds: 5n, activeAds: 2n, newAds7Days: 1n, total: 4n }]),
  };
  const db = { $transaction: vi.fn(async (operation: any) => operation(tx)) };
  return { tx, db: db as any };
}
const input = { userId: 'user', workspaceId: 'workspace', adId: 'ad' };

describe('advertiser library data boundary', () => {
  it('suppresses a parallel summary when the anchor moved to another advertiser or source', () => {
    const summary = { sourceAdvertiserId: '123456', dataSourceKey: 'meta' };
    const ad = { dataSource: { key: 'meta' }, advertiser: { sourceAdvertiserId: '123456', fieldProvenance: {} } };
    expect(matchesAdvertiserSummary(ad, summary)).toBe(true);
    expect(matchesAdvertiserSummary({ ...ad, advertiser: { ...ad.advertiser, sourceAdvertiserId: 'different' } }, summary)).toBe(false);
    expect(matchesAdvertiserSummary({ ...ad, dataSource: { key: 'other' } }, summary)).toBe(false);
    expect(matchesAdvertiserSummary({ ...ad, advertiser: { ...ad.advertiser, sourceAdvertiserId: 'ad-local:123456' } }, summary)).toBe(false);
    expect(matchesAdvertiserSummary({ ...ad, advertiser: null }, summary)).toBe(false);
  });
  it('checks active workspace membership before reading an ad or aggregate', async () => {
    const disabled = fixture({ disabled: true });
    await expect(getAdvertiserSummary(disabled.db, input)).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    expect(disabled.tx.ad.findUnique).not.toHaveBeenCalled();
    const outsider = fixture({ member: false });
    await expect(getRelatedAds(outsider.db, input)).rejects.toMatchObject({ code: 'ORGANIZATION_FORBIDDEN' });
    expect(outsider.tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns no advertiser summary or fuzzy-name related results for an unlinked ad', async () => {
    const { db, tx } = fixture({ linked: false });
    expect(await getAdvertiserSummary(db, input)).toBeNull();
    expect(await getRelatedAds(db, input)).toMatchObject({ ads: [], nextCursor: null, total: 0, anchorIdentity: null });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('keeps inferred grouping identifiers out of the advertiser identity and aggregate', async () => {
    const { db, tx } = fixture({ identity: 'ad-local:123456' });
    expect(await getAdvertiserSummary(db, input)).toBeNull();
    expect(await getRelatedAds(db, input)).toMatchObject({ ads: [], total: 0, anchorIdentity: null });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it.each([0, 101, 1.5])('rejects an unbounded related page limit %s', async limit => {
    const { db, tx } = fixture();
    await expect(getRelatedAds(db, { ...input, limit })).rejects.toMatchObject({ code: 'INVALID_RELATED_LIMIT' });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it.each(['not json', 'x'.repeat(2049)])('rejects malformed related cursors', async cursor => {
    const { db, tx } = fixture();
    await expect(getRelatedAds(db, { ...input, cursor })).rejects.toMatchObject({ code: 'INVALID_RELATED_CURSOR' });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
