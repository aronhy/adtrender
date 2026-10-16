import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { listOwnOrganizationSupportRequests, resolveOrganizationSupportRequest } from './organization';

const url = process.env.SAAS_TEST_DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
const users: string[] = [], organizations: string[] = [];
afterAll(async () => {
  if (url) await db.$transaction(async tx => {
    await tx.auditEvent.deleteMany({ where: { actorUserId: { in: users } } });
    await tx.feedback.deleteMany({ where: { organizationId: { in: organizations } } });
    await tx.workspace.deleteMany({ where: { organizationId: { in: organizations } } });
    await tx.organizationMember.deleteMany({ where: { organizationId: { in: organizations } } });
    await tx.organization.deleteMany({ where: { id: { in: organizations } } });
    await tx.user.deleteMany({ where: { id: { in: users } } });
  });
  await db.$disconnect();
});
async function fixture() {
  const owner = randomUUID(), requester = randomUUID(), peer = randomUUID(), foreignOwner = randomUUID(), admin = randomUUID();
  const organizationId = randomUUID(), foreignOrganizationId = randomUUID(), workspaceId = randomUUID();
  users.push(owner, requester, peer, foreignOwner, admin); organizations.push(organizationId, foreignOrganizationId);
  await db.$transaction(async tx => {
    await tx.user.createMany({ data: [owner, requester, peer, foreignOwner, admin].map(id => ({ id, email: `organization-support-${id}@example.test`, isAdmin: id === admin, notificationPreference: { privateMarker: 'must-not-leak' } })) });
    await tx.organization.createMany({ data: [{ id: organizationId, name: '申请所属团队', slug: organizationId }, { id: foreignOrganizationId, name: '其他团队', slug: foreignOrganizationId }] });
    await tx.organizationMember.createMany({ data: [{ organizationId, userId: owner, role: 'OWNER' }, { organizationId, userId: requester, role: 'MEMBER' }, { organizationId, userId: peer, role: 'ADMIN' }, { organizationId: foreignOrganizationId, userId: foreignOwner, role: 'OWNER' }] });
    await tx.workspace.create({ data: { id: workspaceId, organizationId, name: '原始反馈工作区', slug: workspaceId } });
  });
  const own = await db.feedback.create({ data: { organizationId, workspaceId, userId: requester, subject: '用户反馈', category: 'BUG', body: '本人合成反馈' } });
  const ownDeletion = await db.feedback.create({ data: { organizationId, userId: requester, subject: '删除申请：ORGANIZATION', category: 'DELETION_REQUEST', body: '本人历史删除申请' } });
  const peerRequest = await db.feedback.create({ data: { organizationId, userId: peer, subject: '用户反馈', body: '其他成员的私有反馈' } });
  const foreign = await db.feedback.create({ data: { organizationId: foreignOrganizationId, userId: foreignOwner, subject: '用户反馈', body: '跨租户反馈' } });
  return { owner, requester, peer, foreignOwner, admin, organizationId, foreignOrganizationId, workspaceId, own, ownDeletion, peerRequest, foreign };
}

describe.skipIf(!url)('customer organization support history against PostgreSQL', () => {
  it('returns only own submissions with their original organization/workspace and a minimal DTO', async () => {
    const f = await fixture();
    const rows = await listOwnOrganizationSupportRequests(db, { userId: f.requester });
    expect(new Set(rows.map(row => row.id))).toEqual(new Set([f.own.id, f.ownDeletion.id]));
    expect(rows.find(row => row.id === f.own.id)).toEqual({ id: f.own.id, category: 'BUG', subject: '用户反馈', body: '本人合成反馈', status: 'OPEN', createdAt: f.own.createdAt, resolvedAt: null, organization: { id: f.organizationId, name: '申请所属团队' }, workspace: { id: f.workspaceId, name: '原始反馈工作区' } });
    expect(rows.find(row => row.id === f.ownDeletion.id)?.workspace).toBeNull();
    expect(JSON.stringify(rows)).not.toContain('must-not-leak');
  });

  it('never grants organization owners, organization admins or platform admins other members history', async () => {
    const f = await fixture();
    expect(await listOwnOrganizationSupportRequests(db, { userId: f.owner })).toEqual([]);
    expect((await listOwnOrganizationSupportRequests(db, { userId: f.peer })).map(row => row.id)).toEqual([f.peerRequest.id]);
    await db.user.update({ where: { id: f.requester }, data: { isAdmin: true } });
    expect(new Set((await listOwnOrganizationSupportRequests(db, { userId: f.requester })).map(row => row.id))).toEqual(new Set([f.own.id, f.ownDeletion.id]));
    expect(await listOwnOrganizationSupportRequests(db, { userId: f.admin })).toEqual([]);
  });

  it('hides own historical submissions once membership is removed, including requests in a different tenant', async () => {
    const f = await fixture();
    await db.feedback.create({ data: { organizationId: f.foreignOrganizationId, userId: f.requester, subject: '原团队历史反馈', body: '无当前成员关系' } });
    expect((await listOwnOrganizationSupportRequests(db, { userId: f.requester })).length).toBe(2);
    await db.organizationMember.delete({ where: { organizationId_userId: { organizationId: f.organizationId, userId: f.requester } } });
    expect(await listOwnOrganizationSupportRequests(db, { userId: f.requester })).toEqual([]);
    expect(await db.feedback.count({ where: { userId: f.requester } })).toBe(3);
  });

  it('excludes inactive organizations without deleting the customer history', async () => {
    const f = await fixture();
    await db.organization.update({ where: { id: f.organizationId }, data: { status: 'SUSPENDED' } });
    expect(await listOwnOrganizationSupportRequests(db, { userId: f.requester })).toEqual([]);
    expect(await db.feedback.count({ where: { userId: f.requester } })).toBe(2);
  });

  it('keeps own history after its workspace was archived even without current workspace access', async () => {
    const f = await fixture();
    await db.workspace.update({ where: { id: f.workspaceId }, data: { archivedAt: new Date() } });
    expect((await listOwnOrganizationSupportRequests(db, { userId: f.requester })).find(row => row.id === f.own.id)).toMatchObject({ workspace: { id: f.workspaceId, name: '原始反馈工作区' }, body: '本人合成反馈' });
  });

  it('rejects missing and disabled identities on each query', async () => {
    const f = await fixture();
    await expect(listOwnOrganizationSupportRequests(db, { userId: '' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(listOwnOrganizationSupportRequests(db, { userId: randomUUID() })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await db.user.update({ where: { id: f.requester }, data: { disabledAt: new Date() } });
    await expect(listOwnOrganizationSupportRequests(db, { userId: f.requester })).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
  });

  it('bounds history to the newest 100 and uses ID to make equal timestamps stable', async () => {
    const f = await fixture(), when = new Date('2026-01-01T00:00:00Z');
    await db.feedback.deleteMany({ where: { userId: f.requester } });
    const ids = Array.from({ length: 102 }, () => randomUUID());
    await db.feedback.createMany({ data: ids.map(id => ({ id, userId: f.requester, organizationId: f.organizationId, subject: '分页边界', body: '合成申请', createdAt: when })) });
    expect((await listOwnOrganizationSupportRequests(db, { userId: f.requester })).map(row => row.id)).toEqual(ids.sort().reverse().slice(0, 100));
  });

  it('shows actual resolved status and timestamp after concurrent admin review while auditing only once', async () => {
    const f = await fixture();
    const results = await Promise.all([1, 2].map(() => resolveOrganizationSupportRequest(db, { actorUserId: f.admin, requestId: f.own.id })));
    expect(results[0]).toMatchObject({ status: 'RESOLVED', resolvedAt: expect.any(Date) });
    expect(results[0].resolvedAt).toEqual(results[1].resolvedAt);
    expect((await listOwnOrganizationSupportRequests(db, { userId: f.requester })).find(row => row.id === f.own.id)).toMatchObject({ status: 'RESOLVED', resolvedAt: results[0].resolvedAt });
    expect(await db.auditEvent.count({ where: { targetId: f.own.id, action: 'FEEDBACK_RESOLVED' } })).toBe(1);
    expect(await db.workspace.findUnique({ where: { id: f.workspaceId } })).not.toBeNull();
    expect(await db.user.findUnique({ where: { id: f.requester } })).not.toBeNull();
    expect(await db.emailDelivery.count({ where: { organizationId: f.organizationId } })).toBe(0);
  });

  it('denies customer resolution and disabled admin resolution and does not change the request', async () => {
    const f = await fixture();
    for (const actorUserId of [f.owner, f.requester, f.peer, f.foreignOwner]) await expect(resolveOrganizationSupportRequest(db, { actorUserId, requestId: f.own.id })).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
    await db.user.update({ where: { id: f.admin }, data: { disabledAt: new Date() } });
    await expect(resolveOrganizationSupportRequest(db, { actorUserId: f.admin, requestId: f.own.id })).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    expect(await db.feedback.findUnique({ where: { id: f.own.id } })).toMatchObject({ status: 'OPEN', resolvedAt: null });
    expect(await db.auditEvent.count({ where: { targetId: f.own.id } })).toBe(0);
  });
});
