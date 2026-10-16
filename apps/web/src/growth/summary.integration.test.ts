import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadGrowthSummary } from './summary';

const url = process.env.SAAS_TEST_DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
const userIds = Array.from({ length: 9 }, () => randomUUID());
const [admin, userA, userA2, userB, userC, userTest, userOld, userOrphan, userFuture] = userIds;
const visits = Array.from({ length: 7 }, () => randomUUID());
const [visitA, visitB, visitC, visitTest, visitOld, visitOrphan, visitAfter] = visits;
const organizationId = randomUUID();
const query = { from: '2026-06-01', to: '2026-06-02', userId: admin };
const now = new Date('2026-06-05T10:00:00Z');
async function visit(id: string, at: string, options: { isTest?: boolean; revoked?: boolean; source?: string; content?: string } = {}) {
  await db.$executeRaw(Prisma.sql`INSERT INTO "GrowthVisit" (id, "tokenHash", "createdAt", "lastSeenAt", "expiresAt", "revokedAt", "consentVersion", "landingPath", source, medium, campaign, content, "isTest")
    VALUES (${id}, ${id}, ${new Date(at)}, ${new Date(at)}, ${new Date('2026-07-01T00:00:00Z')}, ${options.revoked ? new Date('2026-06-04T00:00:00Z') : null}, 'website-analytics.v2', '/', ${options.source ?? 'google'}, 'organic', 'launch', ${options.content ?? 'post-a'}, ${options.isTest ?? false})`);
}
async function event(visitId: string, name: 'PAGE_VIEW' | 'CTA_CLICK', at = '2026-06-02T05:00:00Z') {
  await db.$executeRaw(Prisma.sql`INSERT INTO "GrowthEvent" (id, "visitId", "createdAt", name, pathname, target, "dedupeKey") VALUES (${randomUUID()}, ${visitId}, ${new Date(at)}, ${name}, '/', ${name === 'CTA_CLICK' ? 'signup' : null}, ${randomUUID()})`);
}
async function conversion(userId: string, visitId: string, name: string, at: string) {
  await db.$executeRaw(Prisma.sql`INSERT INTO "ConversionEvent" (id, "userId", "visitId", "createdAt", name) VALUES (${randomUUID()}, ${userId}, ${visitId}, ${new Date(at)}, ${name})`);
}

afterAll(async () => {
  if (url) {
    await db.$executeRaw(Prisma.sql`DELETE FROM "ConversionEvent" WHERE "visitId" IN (${Prisma.join(visits)})`);
    await db.$executeRaw(Prisma.sql`DELETE FROM "GrowthEvent" WHERE "visitId" IN (${Prisma.join(visits)})`);
    await db.$executeRaw(Prisma.sql`DELETE FROM "GrowthVisit" WHERE id IN (${Prisma.join(visits)})`);
    await db.$transaction(async tx => {
      await tx.organizationMember.deleteMany({ where: { organizationId } });
      await tx.organization.deleteMany({ where: { id: organizationId } });
    });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await db.$disconnect();
});

describe.skipIf(!url)('growth aggregation uses one consented visit cohort', () => {
  beforeAll(async () => {
    await db.user.createMany({ data: userIds.map(id => ({ id, email: `growth-private-${id}@example.test`, isAdmin: id === admin })) });
    await db.$transaction(async tx => {
      await tx.organization.create({ data: { id: organizationId, slug: organizationId, name: 'Growth report isolation fixture' } });
      await tx.organizationMember.create({ data: { organizationId, userId: userB, role: 'OWNER' } });
    });
    await visit(visitA, '2026-05-31T16:00:00Z'); // First instant of June 1, UTC+8.
    await visit(visitB, '2026-06-01T10:00:00Z', { content: 'post-b' });
    await visit(visitC, '2026-06-01T16:00:00Z', { source: 'newsletter', revoked: true });
    await visit(visitTest, '2026-06-01T10:00:00Z', { source: 'codex', isTest: true });
    await visit(visitOld, '2026-05-31T15:59:59Z');
    await visit(visitOrphan, '2026-06-02T15:59:59Z', { source: 'unbound' });
    await visit(visitAfter, '2026-06-02T16:00:00Z'); // Excluded exclusive end.
    for (const id of [visitA, visitA, visitB, visitC, visitTest, visitOld, visitAfter]) await event(id, 'PAGE_VIEW');
    for (const id of [visitA, visitA, visitC, visitTest, visitOld]) await event(id, 'CTA_CLICK');
    for (const [user, id] of [[userA, visitA], [userA2, visitA], [userB, visitB], [userC, visitC], [userTest, visitTest], [userOld, visitOld]]) {
      await conversion(user, id, 'ACCOUNT_CREATED', '2026-06-02T06:00:00Z');
    }
    for (const [user, id] of [[userA, visitA], [userA2, visitA], [userC, visitC], [userTest, visitTest], [userOld, visitOld], [userOrphan, visitOrphan]]) {
      await conversion(user, id, 'REGISTRATION_VERIFIED', '2026-06-04T06:00:00Z'); // Later than the selected visit dates, but same cohort.
    }
    for (const [user, id] of [[userA, visitA], [userB, visitB], [userC, visitC], [userTest, visitTest], [userOld, visitOld]]) await conversion(user, id, 'FIRST_AD_SAVED', '2026-06-05T06:00:00Z');
    await conversion(userFuture, visitB, 'ACCOUNT_CREATED', '2026-06-06T00:00:00Z'); // Excluded by snapshot time.
  });

  it('deduplicates clicked visitors and registered users while keeping late conversions in the original cohort', async () => {
    const result = await loadGrowthSummary(db, query, now);
    expect(result.totals).toEqual({ visitors: 4, pageViews: 4, clickedVisitors: 2, registeredVisitors: 3, registeredUsers: 4, verifiedUsers: 3, firstUseUsers: 2 });
    expect(result.byDay.map(row => [row.day, row.visitors, row.registeredUsers, row.verifiedUsers])).toEqual([
      ['2026-06-01', 2, 3, 2], ['2026-06-02', 2, 1, 1],
    ]);
    expect(result.excludedTestTraffic).toBe(true);
    expect(result.regionStatus).toBe('not_collected');
    const serialized = JSON.stringify(result);
    for (const secret of [...userIds, ...visits, '@example.test', 'tokenHash']) expect(serialized).not.toContain(secret);
  });

  it('separates campaign content and retains collected history after withdrawal', async () => {
    const result = await loadGrowthSummary(db, query, now);
    expect(result.bySource.find(row => row.source === 'google' && row.content === 'post-a')).toMatchObject({ visitors: 1, registeredUsers: 2, firstUseUsers: 1 });
    expect(result.bySource.find(row => row.source === 'google' && row.content === 'post-b')).toMatchObject({ visitors: 1, registeredUsers: 1, verifiedUsers: 0, firstUseUsers: 0 });
    expect(result.bySource.find(row => row.source === 'newsletter')).toMatchObject({ visitors: 1, verifiedUsers: 1, firstUseUsers: 1 });
    expect(result.bySource.some(row => row.source === 'codex')).toBe(false);
    expect(result.byLanding).toEqual([{ landingPath: '/', ...result.totals }]);
  });

  it('denies tenant owners, logged-out callers and disabled or demoted platform admins', async () => {
    await expect(loadGrowthSummary(db, { ...query, userId: userB }, now)).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
    await expect(loadGrowthSummary(db, { ...query, userId: '' }, now)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await db.user.update({ where: { id: admin }, data: { isAdmin: false } });
    await expect(loadGrowthSummary(db, query, now)).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
    await db.user.update({ where: { id: admin }, data: { isAdmin: true, disabledAt: now } });
    await expect(loadGrowthSummary(db, query, now)).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    await db.user.update({ where: { id: admin }, data: { disabledAt: null } });
  });
});
