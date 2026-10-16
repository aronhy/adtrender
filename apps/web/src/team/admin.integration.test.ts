import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { bootstrapPlatformAdmin, seedDataSources, setUserDisabled } from './admin';
import { createTeamService } from './service';

const testUrl = process.env.SAAS_TEST_DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url: testUrl ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
afterAll(() => db.$disconnect());
async function user(isAdmin = false, disabled = false) {
  return db.user.create({ data: { email: `${randomUUID()}@example.test`, isAdmin, disabledAt: disabled ? new Date() : null } });
}
async function organization(owners: string[], members: string[] = []) {
  return db.$transaction(async tx => {
    const org = await tx.organization.create({ data: { name: '权限测试', slug: `admin-${randomUUID()}` } });
    await tx.organizationMember.createMany({ data: [...owners.map(userId => ({ organizationId: org.id, userId, role: 'OWNER' })), ...members.map(userId => ({ organizationId: org.id, userId, role: 'MEMBER' }))] });
    return org;
  });
}
function command(actorUserId: string, targetUserId: string, disabled = true) {
  return setUserDisabled(db, { actorUserId, targetUserId, disabled, reason: '支持工单审核' });
}

describe.skipIf(!testUrl)('platform account administration against PostgreSQL', () => {
  it('requires a currently active platform admin, a reason and a distinct disable target', async () => {
    const admin = await user(true), ordinary = await user(), disabled = await user(true, true), target = await user();
    await expect(command(ordinary.id, target.id)).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
    await expect(command(disabled.id, target.id)).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    await expect(command(admin.id, admin.id)).rejects.toMatchObject({ code: 'SELF_DISABLE_FORBIDDEN' });
    await expect(setUserDisabled(db, { actorUserId: admin.id, targetUserId: target.id, disabled: true, reason: ' ' })).rejects.toMatchObject({ code: 'INVALID_ADMIN_REASON' });
    expect(await db.user.findUnique({ where: { id: target.id } })).toMatchObject({ disabledAt: null });
  });

  it('disables and restores with audit, revokes only target sessions and burns outstanding auth links', async () => {
    const admin = await user(true), target = await user(), other = await user();
    const auth = await db.auth.create({ data: { userId: target.id } }), otherAuth = await db.auth.create({ data: { userId: other.id } });
    await db.session.createMany({ data: [auth, otherAuth].map(a => ({ id: randomUUID(), userId: a.id, expiresAt: new Date(Date.now() + 60_000) })) });
    await db.authLink.create({ data: { recipientEmail: target.email!, purpose: 'RESET', tokenHash: randomUUID(), encryptedPayload: 'encrypted-fixture', expiresAt: new Date(Date.now() + 60_000) } });
    expect(await command(admin.id, target.id)).toMatchObject({ id: target.id, disabledAt: expect.any(Date) });
    expect(await db.session.count({ where: { userId: auth.id } })).toBe(0);
    expect(await db.session.count({ where: { userId: otherAuth.id } })).toBe(1);
    expect(await db.authLink.findFirst({ where: { recipientEmail: target.email! } })).toMatchObject({ consumedAt: expect.any(Date), encryptedPayload: '' });
    expect(await command(admin.id, target.id, false)).toMatchObject({ disabledAt: null });
    expect(await db.session.count({ where: { userId: auth.id } })).toBe(0);
    const audits = await db.auditEvent.findMany({ where: { targetId: target.id }, orderBy: { createdAt: 'asc' } });
    expect(audits.map(a => a.action)).toEqual(['USER_DISABLED', 'USER_RESTORED']);
    expect(audits.every(a => a.actorUserId === admin.id)).toBe(true);
    expect(audits[0].metadata).toMatchObject({ reason: '支持工单审核', sessionsRevoked: 1, authLinksRevoked: 1 });
  });

  it('protects the final effective owner in every organization and allows disabling a redundant owner', async () => {
    const admin = await user(true), owner = await user(), inactive = await user(false, true), secondOwner = await user();
    const org = await organization([owner.id, inactive.id]);
    await expect(command(admin.id, owner.id)).rejects.toMatchObject({ code: 'LAST_ACTIVE_OWNER' });
    await db.organizationMember.create({ data: { organizationId: org.id, userId: secondOwner.id, role: 'OWNER' } });
    await expect(command(admin.id, owner.id)).resolves.toMatchObject({ disabledAt: expect.any(Date) });
    await expect(command(admin.id, secondOwner.id)).rejects.toMatchObject({ code: 'LAST_ACTIVE_OWNER' });
  });

  it('serializes reciprocal platform admin disables so one effective administrator remains', async () => {
    const first = await user(true), second = await user(true);
    const outcomes = await Promise.allSettled([command(first.id, second.id), command(second.id, first.id)]);
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    expect(await db.user.count({ where: { id: { in: [first.id, second.id] }, isAdmin: true, disabledAt: null } })).toBe(1);
  });

  it('serializes owner transfer with disabling the new owner', async () => {
    const admin = await user(true), owner = await user(), target = await user();
    const org = await organization([owner.id], [target.id]);
    const team = createTeamService(db);
    const outcomes = await Promise.allSettled([
      team.transferOwnership({ userId: owner.id, organizationId: org.id, targetUserId: target.id }),
      command(admin.id, target.id),
    ]);
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    expect(await db.organizationMember.count({ where: { organizationId: org.id, role: 'OWNER', user: { disabledAt: null } } })).toBe(1);
  });

  it('does not remove the last active owner when another owner is disabled', async () => {
    const owner = await user(), inactive = await user(false, true);
    const org = await organization([owner.id, inactive.id]);
    await expect(createTeamService(db, { releaseQuota: async () => {} }).removeMember({ userId: owner.id, organizationId: org.id, memberUserId: owner.id })).rejects.toMatchObject({ code: 'LAST_OWNER' });
  });

  it('bootstraps only an existing active Wasp email identity with a verified address', async () => {
    const account = await user(), noAuth = await user(), disabled = await user(false, true);
    await expect(bootstrapPlatformAdmin(db, { email: `${randomUUID()}@example.test` })).rejects.toMatchObject({ code: 'BOOTSTRAP_USER_NOT_FOUND' });
    await expect(bootstrapPlatformAdmin(db, { email: noAuth.email! })).rejects.toMatchObject({ code: 'BOOTSTRAP_EMAIL_UNVERIFIED' });
    await expect(bootstrapPlatformAdmin(db, { email: disabled.email! })).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    const auth = await db.auth.create({ data: { userId: account.id } });
    await db.authIdentity.create({ data: { authId: auth.id, providerName: 'email', providerUserId: account.email!, providerData: JSON.stringify({ isEmailVerified: false, hashedPassword: 'fixture-existing-hash' }) } });
    await expect(bootstrapPlatformAdmin(db, { email: account.email! })).rejects.toMatchObject({ code: 'BOOTSTRAP_EMAIL_UNVERIFIED' });
    await db.authIdentity.update({ where: { providerName_providerUserId: { providerName: 'email', providerUserId: account.email! } }, data: { providerData: JSON.stringify({ isEmailVerified: true, hashedPassword: 'fixture-existing-hash' }) } });
    const before = await db.authIdentity.findUniqueOrThrow({ where: { providerName_providerUserId: { providerName: 'email', providerUserId: account.email! } } });
    await expect(bootstrapPlatformAdmin(db, { email: ` ${account.email!.toUpperCase()} ` })).resolves.toMatchObject({ id: account.id, isAdmin: true });
    await bootstrapPlatformAdmin(db, { email: account.email! });
    expect(await db.authIdentity.findUniqueOrThrow({ where: { providerName_providerUserId: { providerName: 'email', providerUserId: account.email! } } })).toEqual(before);
    expect(await db.auditEvent.count({ where: { targetId: account.id, action: 'PLATFORM_ADMIN_GRANTED' } })).toBe(1);
  });

  it('seeds a paused source without creating tasks or overwriting existing source state', async () => {
    const existing = await db.dataSource.findUnique({ where: { key: 'meta_ad_library' } });
    const beforeTasks = existing ? await db.collectionTask.count({ where: { dataSourceId: existing.id } }) : 0;
    const seeded = await seedDataSources(db);
    expect(seeded.status).toBe(existing?.status ?? 'PAUSED');
    const again = await seedDataSources(db);
    expect(again).toEqual(seeded);
    expect(await db.collectionTask.count({ where: { dataSourceId: seeded.id } })).toBe(beforeTasks);
    expect(await db.dataSource.findUnique({ where: { id: seeded.id } })).toMatchObject({ adapterVersion: existing?.adapterVersion ?? 'meta-dom-1', configuration: existing?.configuration ?? {}, capabilities: existing?.capabilities ?? {version:1,verification:'UNVERIFIED',verifiedQueryProfiles:[]} });
  });
});
