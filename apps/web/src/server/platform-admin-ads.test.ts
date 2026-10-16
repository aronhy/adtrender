import { describe, it, expect, vi } from 'vitest';
import { fillAdminAdsDays, isPersistedAdminMedia, loadPlatformAdminAdsStats, listPlatformAdminMedia, redactAdminEvidence, parseAdminAdsFilter, classifyAdminRun, retryPlatformAdminMediaOn, setPlatformAdminSourceStatusOn, decodeAdminAdsCursor, encodeAdminAdsCursor } from './platform-admin-ads';

const userId = '11111111-1111-4111-8111-111111111111';
const targetId = '22222222-2222-4222-8222-222222222222';
function dbFixture(admin = true) {
  const tx: any = { user: { findUnique: vi.fn(async () => ({ id: userId, isAdmin: admin, disabledAt: null })) },
    $queryRaw: vi.fn(async (query: any) => /FROM "MediaObject"/.test(Array.isArray(query) ? query.join('') : query.sql ?? '') ? [{ id: targetId, status: 'FAILED', type: 'IMAGE', storageKey: null, downloadAttempts: 5, errorCode: 'MEDIA_HTTP_FAILED' }] : [{ id: targetId, status: 'PAUSED', adapterVersion: 'v1', capabilities: {} }]),
    dataSource: { update: vi.fn(async () => ({ id: targetId })) }, mediaObject: { updateMany: vi.fn(async () => ({ count: 1 })) },
    auditEvent: { create: vi.fn(async () => ({})) } };
  const db: any = { $transaction: (fn: any) => fn(tx) };
  return { tx, db };
}
describe('platform admin ads guards and projections', () => {
  it('keeps query and coverage values but removes signed URL parameters and credentials recursively', () => {
    expect(redactAdminEvidence({ country: 'US', keyword: 'bag', token: 'secret', nested: { credentialReference: 'vault-key', evidence: 'https://cdn.test/file.png?X-Amz-Signature=secret#x' }, pageId: '123' })).toEqual({ country: 'US', keyword: 'bag', nested: { evidence: 'https://cdn.test/file.png' }, pageId: '123' });
  });
  it('removes signed URL parameters inside free text and URL userinfo', () => {
    expect(redactAdminEvidence('Evidence https://user:pass@cdn.test/file?token=secret#x failed')).toBe('Evidence https://cdn.test/file failed');
  });
  it('counts only persisted nonexpired advertisement bytes as READY, excluding HTML/player templates', () => {
    const file = { status: 'READY', type: 'IMAGE', storageKey: 'public-media/file', sizeBytes: 12n, sha256: 'a'.repeat(64), mimeType: 'image/png', expiresAt: null };
    expect(isPersistedAdminMedia(file, new Date())).toBe(true);
    expect(isPersistedAdminMedia({ ...file, mimeType: 'text/html' }, new Date())).toBe(false);
    expect(isPersistedAdminMedia({ ...file, storageKey: null }, new Date())).toBe(false);
    expect(isPersistedAdminMedia({ ...file, type: 'VIDEO' }, new Date())).toBe(false);
    expect(isPersistedAdminMedia({ ...file, expiresAt: new Date(0) }, new Date())).toBe(false);
    expect(isPersistedAdminMedia({ ...file, sha256: 'invalid' }, new Date())).toBe(false);
  });
  it('fills genuine zero-insert HK days and leaves an entirely empty range empty', () => {
    const from = new Date('2026-10-04T16:00:00.000Z'); const to = new Date('2026-10-11T16:00:00.000Z');
    const days = fillAdminAdsDays([{ date: '2026-10-06', count: 2 }], from, to);
    expect(days).toHaveLength(7); expect(days[0]).toEqual({ date: '2026-10-05', count: 0 }); expect(days[1]).toEqual({ date: '2026-10-06', count: 2 }); expect(days.at(-1)?.date).toBe('2026-10-11');
    expect(fillAdminAdsDays([], from, to)).toEqual([]);
  });
  it('rejects ranges that are inverted, unbounded, or malformed and validates source identities', () => {
    expect(() => parseAdminAdsFilter({ dateFrom: '2026-10-11T00:00:00.000Z', dateTo: '2026-10-10T00:00:00.000Z' })).toThrow('INVALID_ADMIN_ADS_QUERY');
    expect(() => parseAdminAdsFilter({ dateFrom: '2020-01-01T00:00:00.000Z', dateTo: '2026-10-11T00:00:00.000Z' })).toThrow('INVALID_ADMIN_ADS_QUERY');
    expect(() => parseAdminAdsFilter({ sourceId: "';DROP TABLE Ad;--" })).toThrow('INVALID_ADMIN_ADS_QUERY');
  });
  it('separates reliable no-results, source restriction, timeout, and generic failure', () => {
    expect(classifyAdminRun({ status: 'SUCCEEDED', coverage: { outcome: 'no-results' }, errorCode: null })).toBe('无结果');
    expect(classifyAdminRun({ status: 'FAILED', coverage: {}, errorCode: 'META_HTTP_429' })).toBe('受限');
    expect(classifyAdminRun({ status: 'FAILED', coverage: {}, errorCode: 'META_HTTP_403' })).toBe('受限');
    expect(classifyAdminRun({ status: 'FAILED', coverage: {}, errorCode: 'META_TIMEOUT' })).toBe('超时');
    expect(classifyAdminRun({ status: 'FAILED', coverage: {}, errorCode: 'PARSE_FAILED' })).toBe('失败');
  });
  it('binds pagination cursor to actor and exact filter and rejects tampering', () => {
    const scope = 'a'.repeat(64);
    const cursor = encodeAdminAdsCursor({ scope, asOf: '2026-10-11T00:00:00.000Z', at: '2026-10-10T00:00:00.000Z', id: targetId });
    expect(decodeAdminAdsCursor(cursor, scope)?.id).toBe(targetId);
    expect(() => decodeAdminAdsCursor(cursor, 'b'.repeat(64))).toThrow('INVALID_ADMIN_ADS_CURSOR');
    expect(() => decodeAdminAdsCursor(cursor + '$', scope)).toThrow('INVALID_ADMIN_ADS_CURSOR');
  });
  it('rechecks admin permission before source changes or media requeue', async () => {
    const { db, tx } = dbFixture(false);
    await expect(setPlatformAdminSourceStatusOn(db, userId, { sourceId: targetId, status: 'PAUSED', reason: '维护' })).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
    await expect(retryPlatformAdminMediaOn(db, userId, { mediaIds: [targetId], reason: '重新检查' })).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
    expect(tx.dataSource.update).not.toHaveBeenCalled(); expect(tx.mediaObject.updateMany).not.toHaveBeenCalled();
  });
  it('requires a reason for source state and every retry, audits atomic single retries without exposing URLs', async () => {
    const { db, tx } = dbFixture();
    await expect(setPlatformAdminSourceStatusOn(db, userId, { sourceId: targetId, status: 'PAUSED', reason: '' })).rejects.toMatchObject({ code: 'INVALID_ADMIN_ADS_ACTION' });
    await expect(retryPlatformAdminMediaOn(db, userId, { mediaIds: [targetId, userId] })).rejects.toMatchObject({ code: 'INVALID_ADMIN_ADS_ACTION' });
    expect(await retryPlatformAdminMediaOn(db, userId, { mediaIds: [targetId], reason: '重新检查来源' })).toMatchObject({ count: 1 });
    expect(tx.mediaObject.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'FAILED', storageKey: null }) }));
    expect(tx.auditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'MEDIA_REQUEUED', metadata: expect.objectContaining({ reason: '重新检查来源', batchSize: 1 }) }) });
  });
  it('never enables unverified source capabilities and writes reason with pause audit', async () => {
    const { db, tx } = dbFixture();
    await expect(setPlatformAdminSourceStatusOn(db, userId, { sourceId: targetId, status: 'ACTIVE', reason: '启用' })).rejects.toMatchObject({ code: 'SOURCE_CAPABILITY_UNVERIFIED' });
    await setPlatformAdminSourceStatusOn(db, userId, { sourceId: targetId, status: 'PAUSED', reason: '维护' });
    expect(tx.auditEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'SOURCE_STATUS_CHANGED', metadata: { from: 'PAUSED', status: 'PAUSED', reason: '维护', scope: 'APPLICATION_TASKS_ONLY' } }) });
  });  it('does not query aggregate or list data after admin authorization is rejected', async () => {
    const { db, tx } = dbFixture(false);
    await expect(loadPlatformAdminAdsStats(db, userId, {})).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
    await expect(listPlatformAdminMedia(db, userId, {})).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

});
