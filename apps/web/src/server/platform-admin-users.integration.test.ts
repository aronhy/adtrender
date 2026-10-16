import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queryPlatformAdminUsers, runPlatformAdminUsersCommand } from './platform-admin-users';

const url = process.env.SAAS_TEST_DATABASE_URL;
if(url){const parsed=new URL(url);if(!['localhost','127.0.0.1'].includes(parsed.hostname)||!/_test(?:_|$)/.test(parsed.pathname))throw new Error('LOCAL_ISOLATED_DATABASE_REQUIRED');}
const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
const adminId = randomUUID(), ownerId = randomUUID(), memberId = randomUUID(), organizationId = randomUUID(), workspaceId = randomUUID(), sourceId = randomUUID(), adId = randomUUID();
const users = Array.from({ length: 25 }, () => randomUUID());
const allUsers = [adminId, ownerId, memberId, ...users];
const prefix = `admin-users-integration-${randomUUID()}`;
const privateMarker = `credential-private-${randomUUID()}`;
const planId = randomUUID();
const day = 86_400_000;
const email = (id: string) => `${prefix}-${id}@example.test`;

afterAll(async () => {
  if (url) await db.$transaction(async tx => {
    await tx.auditEvent.deleteMany({ where: { OR: [{ actorUserId: { in: allUsers } }, { organizationId }] } });
    await tx.productEvent.deleteMany({ where: { organizationId } });
    await tx.analysisJob.deleteMany({ where: { organizationId } });
    await tx.usageLedger.deleteMany({ where: { organizationId } });
    await tx.savedAd.deleteMany({ where: { organizationId } });
    await tx.feedback.deleteMany({ where: { organizationId } });
    await tx.accountSupportRequest.deleteMany({ where: { userId: { in: allUsers } } });
    await tx.workspaceMember.deleteMany({ where: { organizationId } });
    await tx.workspace.deleteMany({ where: { organizationId } });
    await tx.entitlement.deleteMany({ where: { organizationId } });
    await tx.subscription.deleteMany({ where: { organizationId } });
    await tx.organizationMember.deleteMany({ where: { organizationId } });
    await tx.organization.deleteMany({ where: { id: organizationId } });
    await tx.planVersion.deleteMany({ where: { id: planId } });
    await tx.ad.deleteMany({ where: { id: adId } });
    await tx.dataSource.deleteMany({ where: { id: sourceId } });
    await tx.user.deleteMany({ where: { id: { in: allUsers } } });
  });
  await db.$disconnect();
});

describe.skipIf(!url)('platform user management reads actual Wasp and quota records', () => {
  beforeAll(async () => {
    const now = Date.now();
    await db.user.createMany({ data: allUsers.map(id => ({ id, email: email(id), displayName: `${prefix} ${id}`, isAdmin: id === adminId, createdAt: new Date(now - day), notificationPreference: { hidden: privateMarker }, onboardingState: { hidden: privateMarker } })) });
    for (const [index, userId] of users.entries()) await db.auth.create({ data: { userId, identities: { create: { providerName: 'email', providerUserId: email(userId), providerData: JSON.stringify({ isEmailVerified: index % 2 === 0, hashedPassword: privateMarker }) } } } });
    await db.auth.create({ data: { userId: memberId, identities: { create: { providerName: 'google', providerUserId: memberId, providerData: JSON.stringify({ version: 1, admitted: true, verifiedEmail: email(memberId) }) } } } });
    await db.$transaction(async tx => {
      await tx.organization.create({ data: { id: organizationId, slug: organizationId, name: `${prefix} organization` } });
      await tx.organizationMember.createMany({ data: [{ organizationId, userId: ownerId, role: 'OWNER' }, { organizationId, userId: memberId, role: 'MEMBER' }] });
    });
    await db.workspace.create({ data: { id: workspaceId, organizationId, slug: workspaceId, name: 'Private fixture workspace' } });
    await db.workspaceMember.create({ data: { organizationId, workspaceId, userId: memberId, role: 'VIEWER' } });
    await db.planVersion.create({ data: { id: planId, key: planId, version: 3, name: 'Current fixture plan' } });
    await db.subscription.create({ data: { organizationId, planVersionId: planId, status: 'CANCELED', provider: 'STRIPE', providerSubscriptionId: `${privateMarker}-last`, providerCustomerId: privateMarker, currentPeriodStart: new Date(now - day), currentPeriodEnd: new Date(now + day), cancelAtPeriodEnd: true } });
    await db.entitlement.createMany({ data: [
      { organizationId, key: 'ANALYSES', limit: 1000, periodStart: new Date(now - 3 * day), validFrom: new Date(now - 3 * day), validUntil: null },
      { organizationId, key: 'ANALYSES', limit: 10, used: 7, reserved: 2, periodStart: new Date(now - 2 * day), validFrom: new Date(now - day), validUntil: new Date(now + day) },
      { organizationId, key: 'ANALYSES', limit: 888, periodStart: new Date(now - day), validFrom: new Date(now - day), validUntil: new Date(now - 1000) },
      { organizationId, key: 'ANALYSES', limit: 999, periodStart: new Date(now + 2 * day), validFrom: new Date(now + 2 * day), validUntil: null },
      { organizationId, key: 'MEMBERS', limit: 777, periodStart: new Date(now + 2 * day), validFrom: new Date(now + 2 * day), validUntil: null },
    ] });
    await db.dataSource.create({ data: { id: sourceId, key: sourceId, name: 'Fixture source', adapterVersion: 'fixture' } });
    await db.ad.create({ data: { id: adId, dataSourceId: sourceId, sourceAdId: adId, sourceUrl: 'https://example.test/fixture' } });
    await db.savedAd.create({ data: { organizationId, workspaceId, adId, savedByUserId: memberId } });
    await db.analysisJob.create({ data: { organizationId, workspaceId, requestedByUserId: memberId, adId, idempotencyKey: randomUUID(), inputSnapshot: { private: privateMarker }, inputSha256: 'a'.repeat(64), model: 'fixture', promptVersion: 'fixture' } });
    await db.productEvent.create({ data: { organizationId, workspaceId, userId: memberId, name: 'ad_detail_open', metadata: { private: privateMarker } } });
    await db.accountSupportRequest.createMany({ data: Array.from({ length: 25 }, () => ({ userId: memberId, kind: 'FEEDBACK', body: privateMarker })) });
    await db.feedback.create({ data: { organizationId, workspaceId, userId: memberId, subject: 'Support fixture', body: privateMarker } });
  });

  it('paginates same-timestamp users without duplicates and filters real verification status', async () => {
    const seen = new Set<string>(); let cursor: string | undefined;
    do {
      const page = await queryPlatformAdminUsers(db, adminId, { section: 'users', search: prefix, cursor });
      expect(page.rows.length).toBeLessThanOrEqual(20);
      for (const row of page.rows) { expect(seen.has(row.id)).toBe(false); seen.add(row.id); }
      expect(JSON.stringify(page)).not.toContain(privateMarker);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.size).toBe(allUsers.length);
    const verified = await queryPlatformAdminUsers(db, adminId, { section: 'users', search: prefix, status: 'VERIFIED' });
    const unverified = await queryPlatformAdminUsers(db, adminId, { section: 'users', search: prefix, status: 'UNVERIFIED' });
    expect(verified.total).toBe(14); expect(unverified.total).toBe(14);
    expect(verified.rows.every(row => 'emailVerified' in row && row.emailVerified)).toBe(true);
    expect(unverified.rows.every(row => 'emailVerified' in row && !row.emailVerified)).toBe(true);
  });

  it('reads safe user details and scopes recent activity and support counts to that user', async () => {
    const page = await queryPlatformAdminUsers(db, adminId, { section: 'users', detailId: memberId });
    expect(page.detail).toMatchObject({ kind: 'USER', organizationCount: 1, savedCount: 1, analysisCount: 1, supportCount: 26, emailVerified: true, lastActivityAt: expect.any(Date), organizations: [{ id: organizationId, role: 'MEMBER' }] });
    expect(page.detail && 'supportRequests' in page.detail ? page.detail.supportRequests : []).toHaveLength(20);
    expect(JSON.stringify(page.detail)).not.toContain(privateMarker);
  });

  it('uses active entitlement validity rather than subscription state, and masks provider identifiers', async () => {
    const page = await queryPlatformAdminUsers(db, adminId, { section: 'organizations', search: prefix, detailId: organizationId });
    expect(page.rows[0]).toMatchObject({ memberCount: 2, subscription: { status: 'CANCELED', planVersion: 3, cancelAtPeriodEnd: true }, entitlements: expect.arrayContaining([{ key: 'ANALYSES', current: expect.objectContaining({ limit: 10, used: 7, reserved: 2 }) }, { key: 'MEMBERS', current: null }]) });
    expect(page.detail).toMatchObject({ kind: 'ORGANIZATION', workspaceCount: 1, savedCount: 1, periodAnalysisCount: 1, providerSubscriptionId: '••••last', members: expect.arrayContaining([{ id: memberId, email: email(memberId), displayName: expect.any(String), organizationRole: 'MEMBER', workspaceRoles: [{ name: 'Private fixture workspace', role: 'VIEWER' }] }]) });
    expect(JSON.stringify(page)).not.toContain(privateMarker);
  });

  it('preserves quota consumption and other periods during a confirmed manual downgrade', async () => {
    const before = await db.entitlement.findMany({ where: { organizationId, key: 'ANALYSES' }, orderBy: { periodStart: 'asc' } });
    await runPlatformAdminUsersCommand(db, adminId, { type: 'ADJUST_ENTITLEMENT', organizationId, key: 'ANALYSES', limit: 4, reason: '客户降级' });
    const after = await db.entitlement.findMany({ where: { organizationId, key: 'ANALYSES' }, orderBy: { periodStart: 'asc' } });
    expect(after[1]).toMatchObject({ limit: 4, used: 7, reserved: 2, source: 'MANUAL', version: before[1].version + 1 });
    for (const index of [0, 2, 3]) expect(after[index]).toEqual(before[index]);
    expect(await db.auditEvent.findFirst({ where: { organizationId, action: 'ENTITLEMENT_ADJUSTED' } })).toMatchObject({ actorUserId: adminId, metadata: { before: 10, after: 4, reason: '客户降级' } });
  });

  it('protects sole owners, requires exact confirmation, and restores an account with a reason', async () => {
    await expect(runPlatformAdminUsersCommand(db, adminId, { type: 'SET_ACCOUNT_STATUS', targetUserId: ownerId, disabled: true, reason: '核对', confirmationEmail: email(ownerId) })).rejects.toMatchObject({ code: 'LAST_ACTIVE_OWNER' });
    await expect(runPlatformAdminUsersCommand(db, adminId, { type: 'SET_ACCOUNT_STATUS', targetUserId: memberId, disabled: true, reason: '核对', confirmationEmail: email(memberId).toUpperCase() })).rejects.toMatchObject({ code: 'ACCOUNT_CONFIRMATION_MISMATCH' });
    expect((await db.user.findUniqueOrThrow({ where: { id: memberId } })).disabledAt).toBeNull();
    await runPlatformAdminUsersCommand(db, adminId, { type: 'SET_ACCOUNT_STATUS', targetUserId: memberId, disabled: true, reason: '测试停用', confirmationEmail: email(memberId) });
    await expect(queryPlatformAdminUsers(db, memberId, { section: 'users' })).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    await runPlatformAdminUsersCommand(db, adminId, { type: 'SET_ACCOUNT_STATUS', targetUserId: memberId, disabled: false, reason: '测试恢复' });
    expect((await db.user.findUniqueOrThrow({ where: { id: memberId } })).disabledAt).toBeNull();
    expect(await db.auditEvent.count({ where: { targetId: memberId, action: { in: ['USER_DISABLED', 'USER_RESTORED'] } } })).toBe(2);
  });

  it('rejects role revocation and cursors reused with changed filters', async () => {
    const page = await queryPlatformAdminUsers(db, adminId, { section: 'users', search: prefix });
    await expect(queryPlatformAdminUsers(db, adminId, { section: 'users', search: 'different', cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'INVALID_ADMIN_CURSOR' });
    await db.user.update({ where: { id: adminId }, data: { isAdmin: false } });
    try {
      await expect(queryPlatformAdminUsers(db, adminId, { section: 'users', search: prefix, cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
      await expect(runPlatformAdminUsersCommand(db, adminId, { type: 'ADJUST_ENTITLEMENT', organizationId, key: 'ANALYSES', limit: 8, reason: '核对' })).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
    } finally { await db.user.update({ where: { id: adminId }, data: { isAdmin: true } }); }
  });
});
