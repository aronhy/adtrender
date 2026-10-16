import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { purgeExpiredSecurityRecords } from './retention';

const require = createRequire(new URL('../../app/package.json', import.meta.url));
const testUrl = process.env.SAAS_TEST_DATABASE_URL;
const namespace = `security-retention-${randomUUID()}`;
const rateIds = new Set<string>(), codeHashes = new Set<string>();
let db: any, otherWorker: any, userId: string, databaseNow: Date;
const scope = (rows: Array<{ rateId: string; codeHash: string }>) => ({ rateLimitBucketIds: rows.map(row => row.rateId), oauthCodeUseHashes: rows.map(row => row.codeHash) });
async function fixture(expiredHours: number) {
  const rateId = createHash('sha256').update(`${namespace}:rate:${randomUUID()}`).digest('hex');
  const codeHash = createHash('sha256').update(`${namespace}:code:${randomUUID()}`).digest('hex');
  rateIds.add(rateId); codeHashes.add(codeHash);
  const expiresAt = new Date(databaseNow.getTime() - expiredHours * 3_600_000);
  await db.rateLimitBucket.create({ data: { id: rateId, scope: namespace, principalHash: rateId,
    windowStart: new Date(expiresAt.getTime() - 60_000), expiresAt, count: 1 } });
  await db.oAuthCodeUse.create({ data: { tokenHash: codeHash, userId, authId: namespace, source: 'GOOGLE',
    consumedAt: new Date(expiresAt.getTime() - 30_000), expiresAt } });
  return { rateId, codeHash };
}
async function exists(row: { rateId: string; codeHash: string }) {
  return {
    rate: Boolean(await db.rateLimitBucket.findUnique({ where: { id: row.rateId } })),
    code: Boolean(await db.oAuthCodeUse.findUnique({ where: { tokenHash: row.codeHash } })),
  };
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => {
  // No global truncate/purge: all fixture cleanup is bound to this file's IDs.
  if (db) {
    await db.rateLimitBucket.deleteMany({ where: { id: { in: [...rateIds] }, scope: namespace } });
    await db.oAuthCodeUse.deleteMany({ where: { tokenHash: { in: [...codeHashes] }, userId } });
    if (userId) await db.user.delete({ where: { id: userId } });
    await Promise.all([db.$disconnect(), otherWorker.$disconnect()]);
  }
});

it.each([0, -1, 1001, 1.5, NaN, Infinity])('rejects an invalid security cleanup limit before touching storage: %s', async limit => {
  await expect(purgeExpiredSecurityRecords({} as any, { limit })).rejects.toThrow('INVALID_SECURITY_RETENTION_LIMIT');
});
it.each([
  { rateLimitBucketIds: [''], oauthCodeUseHashes: [] },
  { rateLimitBucketIds: [], oauthCodeUseHashes: ['not-a-sha256'] },
  { rateLimitBucketIds: Array(1001).fill('x'), oauthCodeUseHashes: [] },
  { rateLimitBucketIds: [], oauthCodeUseHashes: null },
])('rejects malformed explicit scopes rather than falling back to all rows %#', async value => {
  await expect(purgeExpiredSecurityRecords({} as any, { scope: value as any })).rejects.toThrow('INVALID_SECURITY_RETENTION_SCOPE');
});
it('does not access the database after shutdown', async () => {
  const controller = new AbortController(); controller.abort();
  expect(await purgeExpiredSecurityRecords({} as any, { signal: controller.signal })).toEqual({ status: 'CANCELED', rateLimitBucketsDeleted: 0, oauthCodeUsesDeleted: 0, totalDeleted: 0 });
});

describe.skipIf(!testUrl)('bounded PostgreSQL security-record retention', () => {
  beforeAll(async () => {
    const { PrismaClient } = require('@prisma/client');
    db = new PrismaClient({ datasources: { db: { url: testUrl } } });
    otherWorker = new PrismaClient({ datasources: { db: { url: testUrl } } });
    userId = (await db.user.create({ data: { email: `${namespace}@example.test` } })).id;
    const [clock] = await db.$queryRaw`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
    databaseNow = clock.now;
  });

  it('deletes only records expired at least 24 hours and preserves the current protection window', async () => {
    const old = await fixture(25), recent = await fixture(23), justExpired = await fixture(1 / 60), active = await fixture(-1);
    const result = await purgeExpiredSecurityRecords(db, { scope: scope([old, recent, justExpired, active]) });
    expect(result).toEqual({ status: 'COMPLETED', rateLimitBucketsDeleted: 1, oauthCodeUsesDeleted: 1, totalDeleted: 2 });
    expect(await exists(old)).toEqual({ rate: false, code: false });
    for (const row of [recent, justExpired, active]) expect(await exists(row)).toEqual({ rate: true, code: true });
  });

  it('uses the database clock even when the worker clock is seven days ahead', async () => {
    const old = await fixture(25), recent = await fixture(23), active = await fixture(-1);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(databaseNow.getTime() + 7 * 86_400_000));
    try {
      expect(await purgeExpiredSecurityRecords(db, { scope: scope([old, recent, active]) })).toMatchObject({ totalDeleted: 2 });
      expect(await exists(recent)).toEqual({ rate: true, code: true });
      expect(await exists(active)).toEqual({ rate: true, code: true });
    } finally { vi.useRealTimers(); }
  });

  it('bounds the combined deletion count and permits repeat batches without touching other fixtures', async () => {
    const rows = await Promise.all([25, 26, 27, 28].map(fixture)), outside = await fixture(30);
    const counts = [];
    for (let i = 0; i < 4; i++) counts.push((await purgeExpiredSecurityRecords(db, { limit: 3, scope: scope(rows) })).totalDeleted);
    expect(counts).toEqual([3, 3, 2, 0]);
    expect(await exists(outside)).toEqual({ rate: true, code: true });
    expect(await purgeExpiredSecurityRecords(db, { scope: scope([]) })).toMatchObject({ totalDeleted: 0 });
  });

  it('skips locked rows and clears them after the owning transaction commits', async () => {
    const row = await fixture(30), held = gate(), release = gate();
    const locking = db.$transaction(async (tx: any) => {
      await tx.$queryRaw`SELECT id FROM "RateLimitBucket" WHERE id=${row.rateId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "tokenHash" FROM "OAuthCodeUse" WHERE "tokenHash"=${row.codeHash} FOR UPDATE`;
      held.release(); await release.promise;
    });
    await held.promise;
    try { expect(await purgeExpiredSecurityRecords(otherWorker, { scope: scope([row]) })).toMatchObject({ totalDeleted: 0 }); }
    finally { release.release(); await locking; }
    expect(await purgeExpiredSecurityRecords(db, { scope: scope([row]) })).toMatchObject({ totalDeleted: 2 });
  });

  it('keeps concurrent batches disjoint and returns counts without record identifiers', async () => {
    const rows = await Promise.all([25, 26, 27, 28].map(fixture));
    const results = await Promise.all([db, otherWorker].map(client => purgeExpiredSecurityRecords(client, { limit: 4, scope: scope(rows) })));
    const last = await purgeExpiredSecurityRecords(db, { limit: 4, scope: scope(rows) });
    expect(results.reduce((total, result) => total + result.totalDeleted, last.totalDeleted)).toBe(8);
    for (const result of [...results, last]) {
      expect(result.totalDeleted).toBeLessThanOrEqual(4);
      expect(Object.keys(result).sort()).toEqual(['oauthCodeUsesDeleted', 'rateLimitBucketsDeleted', 'status', 'totalDeleted']);
    }
    for (const row of rows) expect(await exists(row)).toEqual({ rate: false, code: false });
  });
});
