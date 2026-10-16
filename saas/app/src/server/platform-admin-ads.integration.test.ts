import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { loadPlatformAdminAdsStats, listPlatformAdminSources, listPlatformAdminMedia, listPlatformAdminRuns, loadPlatformAdminRunDetail, retryPlatformAdminMediaOn, setPlatformAdminSourceStatusOn } from './platform-admin-ads';
import { applyPlatformAdminTask, listPlatformAdminTasks } from './platform-admin-tasks';
const url = process.env.SAAS_TEST_DATABASE_URL;
if(url){const parsed=new URL(url);if(!['localhost','127.0.0.1'].includes(parsed.hostname)||!/_test(?:_|$)/.test(parsed.pathname))throw new Error('LOCAL_ISOLATED_DATABASE_REQUIRED');}
const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
afterAll(() => db.$disconnect());
// All fixtures and actions roll back together. No application/source credentials
// are used, and this suite only runs against an explicitly supplied test URL.
async function isolated(test: (tx: Prisma.TransactionClient, serviceDb: PrismaClient, userId: string) => Promise<void>) {
  const rollback = new Error('ROLLBACK_ISOLATED_ADMIN_FIXTURE');
  await db.$transaction(async tx => { const user = await tx.user.create({ data: { email: `admin-ads-${randomUUID()}@example.test`, isAdmin: true } }); const serviceDb = new Proxy(tx, { get(target, key) { return key === '$transaction' ? (fn: (client: Prisma.TransactionClient) => Promise<unknown>) => fn(target) : Reflect.get(target, key); } }) as unknown as PrismaClient; await test(tx, serviceDb, user.id); throw rollback; }, { timeout: 30_000 }).catch(error => { if (error !== rollback) throw error; });
}
async function source(tx: Prisma.TransactionClient, adapterVersion = 'fixture-dom-1') { return tx.dataSource.create({ data: { key: `admin-ads-test-${randomUUID()}`, name: 'Integration source', adapterVersion, status: 'PAUSED' } }); }
describe.skipIf(!url)('isolated PostgreSQL admin ads and application queue', () => {
  it('returns old pending media when the overview link requests all dates', async () => isolated(async (tx, serviceDb, userId) => {
    const s = await source(tx);
    const ad = await tx.ad.create({ data: { dataSourceId: s.id, sourceAdId: 'older-pending-ad', sourceUrl: 'https://example.test/ad' } });
    const old = await tx.mediaObject.create({ data: { adId: ad.id, sourceUrl: 'https://cdn.test/old-image', type: 'IMAGE', status: 'FAILED', createdAt: new Date(Date.now() - 30 * 86400_000) } });
    const all = await listPlatformAdminMedia(serviceDb, userId, { sourceId: s.id, status: 'FAILED' });
    expect(all.total).toBe(1); expect(all.rows[0].id).toBe(old.id);
    const week = await listPlatformAdminMedia(serviceDb, userId, { sourceId: s.id, status: 'FAILED', dateFrom: new Date(Date.now() - 7 * 86400_000).toISOString(), dateTo: new Date().toISOString() });
    expect(week.total).toBe(0); expect(week.rows).toEqual([]);
  }));
  it('counts stable source-native ad and advertiser identities without merging same names', async () => isolated(async (tx, serviceDb, userId) => {
    const one = await source(tx); const two = await source(tx); const baseline = await loadPlatformAdminAdsStats(serviceDb, userId);
    for (const s of [one, two]) { const advertiser = await tx.advertiser.create({ data: { dataSourceId: s.id, sourceAdvertiserId: 'same-id', name: 'Same display name' } }); await tx.ad.create({ data: { dataSourceId: s.id, sourceAdId: 'same-id', sourceUrl: 'https://example.test/ad', advertiserId: advertiser.id } }); }
    const actual = await loadPlatformAdminAdsStats(serviceDb, userId); expect(actual.kpis.ads).toBe(baseline.kpis.ads + 2); expect(actual.kpis.advertisers).toBe(baseline.kpis.advertisers + 2);
    expect(actual.sources.find(s => s.id === one.id)?.adCount).toBe(1); expect(actual.sources.find(s => s.id === two.id)?.advertiserCount).toBe(1);
    expect(actual.daily.filter(day => day.count > 0).length).toBeGreaterThan(0);
  }));
  it('uses the same persisted READY predicate in KPIs, chart states, filters and media rows', async () => isolated(async (tx, serviceDb, userId) => {
    const s = await source(tx); const ad = await tx.ad.create({ data: { dataSourceId: s.id, sourceAdId: 'asset-ad', sourceUrl: 'https://example.test/ad' } });
    const saved = await tx.mediaObject.create({ data: { adId: ad.id, sourceUrl: 'https://cdn.test/a?token=NEVER_SHOW', type: 'IMAGE', status: 'READY', mimeType: 'image/png', storageKey: `public-media/${randomUUID()}`, sizeBytes: 20n, sha256: 'a'.repeat(64) } });
    await tx.mediaObject.create({ data: { adId: ad.id, sourceUrl: 'https://cdn.test/player', type: 'VIDEO', status: 'READY', mimeType: 'text/html', storageKey: `public-media/${randomUUID()}`, sizeBytes: 20n, sha256: 'a'.repeat(64) } });
    await tx.mediaObject.create({ data: { adId: ad.id, sourceUrl: 'https://cdn.test/template', type: 'UNKNOWN', status: 'PENDING' } });
    const failed = await tx.mediaObject.create({ data: { adId: ad.id, sourceUrl: 'https://cdn.test/failed', type: 'IMAGE', status: 'FAILED', errorCode: 'MEDIA_HTTP_FAILED', downloadAttempts: 5 } });
    const stats = await loadPlatformAdminAdsStats(serviceDb, userId, { sourceId: s.id }); expect(stats.kpis.readyMedia).toBe(1); expect(stats.sources[0].mediaTotal).toBe(3);
    const page = await listPlatformAdminMedia(serviceDb, userId, { sourceId: s.id }); expect(page.total).toBe(3); expect(page.states).toEqual(expect.arrayContaining([{ status: 'READY', count: 1 }, { status: 'UNAVAILABLE', count: 1 }, { status: 'FAILED', count: 1 }])); expect(JSON.stringify(page)).not.toContain('NEVER_SHOW');
    const ready = await listPlatformAdminMedia(serviceDb, userId, { sourceId: s.id, status: 'READY' }); expect(ready.rows.map(row => row.id)).toEqual([saved.id]);
    await retryPlatformAdminMediaOn(serviceDb, userId, { mediaIds: [failed.id], reason: 'Fixture recovery' }); const updated = await tx.mediaObject.findUniqueOrThrow({ where: { id: failed.id } }); expect(updated.status).toBe('PENDING'); expect(updated.downloadAttempts).toBe(0);
    const audit = await tx.auditEvent.findFirstOrThrow({ where: { targetId: failed.id, action: 'MEDIA_REQUEUED' } }); expect(audit.metadata).toMatchObject({ reason: 'Fixture recovery', before: { attempts: 5 }, after: { status: 'PENDING' } });
  }));
  it('paginates fixed run times without duplicate identities and exposes only safe snapshots and run items', async () => isolated(async (tx, serviceDb, userId) => {
    const s = await source(tx, 'fixture-native-1'); const task = await tx.collectionTask.create({ data: { dataSourceId: s.id, name: 'Native archived fixture', query: {}, status: 'PAUSED' } }); const time = new Date(Date.now() - 3600_000);
    const runs = []; for (let index = 0; index < 3; index++) runs.push(await tx.collectionRun.create({ data: { taskId: task.id, dataSourceId: s.id, idempotencyKey: randomUUID(), adapterVersion: 'fixture-native-1', startedAt: time, querySnapshot: { country: 'DE', token: 'NEVER_SHOW', endpoint: 'https://cdn.test/a?signature=NEVER_SHOW' }, coverage: { outcome: index === 0 ? 'no-results' : 'restricted' }, status: index === 0 ? 'SUCCEEDED' : 'FAILED', errorCode: index === 0 ? null : 'HTTP_429', evidenceReference: 'https://evidence.test/id?token=NEVER_SHOW' } }));
    const first = await listPlatformAdminRuns(serviceDb, userId, { sourceId: s.id, limit: 2 }); expect(first.rows).toHaveLength(2); const next = await listPlatformAdminRuns(serviceDb, userId, { sourceId: s.id, limit: 2, cursor: first.nextCursor! }); expect(next.rows).toHaveLength(1); expect(new Set([...first.rows, ...next.rows].map(row => row.id)).size).toBe(3); expect(first.rows.every(row => row.isArchive)).toBe(true);
    await tx.runItem.create({ data: { runId: runs[0].id, dataSourceId: s.id, itemKey: 'one', sourceAdId: 'source-id', status: 'QUARANTINED', parserVersion: 'parser-1', evidenceReference: 'https://evidence.test/item?X-Amz-Signature=NEVER_SHOW' } });
    const detail = await loadPlatformAdminRunDetail(serviceDb, userId, { runId: runs[0].id }); expect(detail.outcomeLabel).toBe('无结果'); expect(detail.items.rows[0].parserVersion).toBe('parser-1'); expect(JSON.stringify(detail)).not.toContain('NEVER_SHOW');
  }));
  it('preserves verified application queue controls, audits reasons atomically and refuses native archives', async () => isolated(async (tx, serviceDb, userId) => {
    const s = await source(tx); const expiresAt = new Date(Date.now() + 86400_000).toISOString(); const query = { keyword: 'fixture', country: 'US', status: 'all' as const, mediaType: 'all' as const, limit: 3 };
    await tx.dataSource.update({ where: { id: s.id }, data: { capabilities: { version: 1, verification: 'VERIFIED', verifiedQueryProfiles: [{ id: 'admin-fixture', sourceId: s.id, adapterVersion: s.adapterVersion, query, verifiedAt: new Date(Date.now() - 1000).toISOString(), expiresAt, provenance: 'live-meta-probe', authorization: 'operator-signed-probe', evidenceReference: 'local-private:private-source-evidence/admin-fixture/snapshot.html', evidenceSha256: 'a'.repeat(64), probeManifestSha256: 'b'.repeat(64) }] } } });
    await setPlatformAdminSourceStatusOn(serviceDb, userId, { sourceId: s.id, status: 'ACTIVE', reason: 'Verified fixture' });
    const sourcePage = await listPlatformAdminSources(serviceDb, userId, { sourceId: s.id }); expect(sourcePage.rows[0].capabilities[0]).toContain(expiresAt);
    const created = await applyPlatformAdminTask(serviceDb, userId, { type: 'CREATE_TASK', sourceId: s.id, name: 'Application fixture', query, intervalMinutes: null, reason: 'Create fixture' }); expect(created.id).toBeTruthy();
    await applyPlatformAdminTask(serviceDb, userId, { type: 'SET_TASK_STATUS', taskId: created.id!, status: 'ACTIVE', reason: 'Activate fixture' });
    const queued = await applyPlatformAdminTask(serviceDb, userId, { type: 'ENQUEUE_TASK', taskId: created.id!, idempotencyKey: 'fixture-once', reason: 'Queue fixture' });
    const repeated = await applyPlatformAdminTask(serviceDb, userId, { type: 'ENQUEUE_TASK', taskId: created.id!, idempotencyKey: 'fixture-once', reason: 'Retry same request' }); expect(repeated.id).toBe(queued.id);
    await applyPlatformAdminTask(serviceDb, userId, { type: 'CANCEL_RUN', runId: queued.id!, confirmationRunId: queued.id!, reason: 'Cancel fixture' }); expect((await tx.collectionRun.findUniqueOrThrow({ where: { id: queued.id } })).status).toBe('CANCELED');
    const audits = await tx.auditEvent.findMany({ where: { targetId: { in: [created.id!, queued.id!] } } }); expect(audits.length).toBeGreaterThanOrEqual(4); expect(audits.every(audit => !!(audit.metadata as any).reason)).toBe(true);
    const archived = await tx.collectionTask.create({ data: { dataSourceId: s.id, name: 'Native fixture', query, status: 'PAUSED' } }); await expect(applyPlatformAdminTask(serviceDb, userId, { type: 'SET_TASK_STATUS', taskId: archived.id, status: 'ACTIVE', reason: 'Must refuse archive' })).rejects.toMatchObject({ code: 'ARCHIVE_CONTROL_FORBIDDEN' }); expect((await listPlatformAdminTasks(serviceDb, userId)).rows.find(row => row.id === archived.id)).toBeUndefined();
  }));
});
