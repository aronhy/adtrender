import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { DomainError, requireWorkspaceRole } from './access';
import { createTeamService } from './service';

// This suite uses an explicitly supplied throwaway database. It never truncates
// shared tables; every test has its own UUID organization/user namespace.
const testUrl = process.env.SAAS_TEST_DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url: testUrl ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
afterAll(() => db.$disconnect());

async function fixture(limits = { MEMBERS: 4, WORKSPACES: 3 }) {
  const tokens = new Map<string, string>();
  const hooks = {
    initializeOrganization: async (tx: Prisma.TransactionClient, organizationId: string) => {
      await tx.entitlement.createMany({ data: Object.entries(limits).map(([key, limit]) => ({ organizationId, key, limit })) });
    },
    admitQuota: async (tx: Prisma.TransactionClient, organizationId: string, key: 'MEMBERS' | 'WORKSPACES', quantity: number) => {
      const entitlement = await tx.entitlement.findFirstOrThrow({ where: { organizationId, key } });
      const result = await tx.entitlement.updateMany({ where: { id: entitlement.id, used: { lte: entitlement.limit - quantity } }, data: { used: { increment: quantity } } });
      if (result.count !== 1) throw new DomainError(409, 'QUOTA_EXCEEDED');
    },
    releaseQuota: async (tx: Prisma.TransactionClient, organizationId: string, key: 'MEMBERS' | 'WORKSPACES', quantity: number) => {
      const result = await tx.entitlement.updateMany({ where: { organizationId, key, used: { gte: quantity } }, data: { used: { decrement: quantity } } });
      if (result.count !== 1) throw new Error('Quota accounting mismatch');
    },
    onInvitationCreated: async (tx: Prisma.TransactionClient, data: any) => {
      tokens.set(data.invitation.id, data.token);
      // Real row proves the callback is part of the enclosing transaction. No
      // token is stored in plaintext; production injects encrypted mail payloads.
      await tx.emailDelivery.create({ data: { organizationId: data.organization.id, recipientEmail: data.invitation.email, templateKey: 'INVITATION', dedupeKey: data.invitation.id } });
    },
  };
  const service = createTeamService(db, hooks);
  const owner = await db.user.create({ data: { email: `${randomUUID()}@example.test` } });
  const { organization, workspace } = await service.createOrganization({ userId: owner.id, name: '测试组织' });
  async function user() {
    return db.user.create({ data: { email: `${randomUUID()}@example.test` } });
  }
  async function inviteAndJoin(role: 'MEMBER' | 'ADMIN' = 'MEMBER', workspaceRole: 'EDITOR' | 'VIEWER' = 'VIEWER') {
    const target = await user();
    const invitation = await service.invite({ userId: owner.id, organizationId: organization.id, email: target.email!, role, workspaceId: workspace.id, workspaceRole });
    await service.acceptInvitation({ userId: target.id, token: tokens.get(invitation.id)! });
    return target;
  }
  return { service, hooks, owner, organization, workspace, user, tokens, inviteAndJoin };
}

describe.skipIf(!testUrl)('team service against PostgreSQL', () => {
  it('creates an owner, default workspace, quota counts and audit atomically', async () => {
    const f = await fixture();
    expect(await db.organizationMember.findFirst({ where: { organizationId: f.organization.id } })).toMatchObject({ userId: f.owner.id, role: 'OWNER' });
    const counts = await db.entitlement.findMany({ where: { organizationId: f.organization.id } });
    expect(Object.fromEntries(counts.map((row) => [row.key, row.used]))).toEqual({ MEMBERS: 1, WORKSPACES: 1 });
    expect(await db.auditEvent.count({ where: { organizationId: f.organization.id } })).toBeGreaterThan(0);
  });

  it('writes the chosen initial workspace name inside organization creation and rejects invalid names atomically', async () => {
    const f = await fixture();
    const created = await f.service.createOrganization({ userId: f.owner.id, name: '品牌组织', workspaceName: '  客户甲  ' });
    expect(created.workspace.name).toBe('客户甲');
    expect(await db.workspace.findUnique({ where: { id: created.workspace.id } })).toMatchObject({ name: '客户甲' });
    const slug = `invalid-workspace-${randomUUID()}`;
    await expect(f.service.createOrganization({ userId: f.owner.id, name: '失败组织', slug, workspaceName: 'bad\nname' })).rejects.toMatchObject({ code: 'INVALID_NAME' });
    expect(await db.organization.findUnique({ where: { slug } })).toBeNull();
  });

  it('fails closed without quota hooks and rolls back a failed initialization', async () => {
    const user = await db.user.create({ data: { email: `${randomUUID()}@example.test` } });
    const slug = `rollback-${randomUUID()}`;
    await expect(createTeamService(db).createOrganization({ userId: user.id, name: '失败', slug })).rejects.toMatchObject({ code: 'QUOTA_UNAVAILABLE' });
    expect(await db.organization.findUnique({ where: { slug } })).toBeNull();
    const service = createTeamService(db, { initializeOrganization: async () => {}, admitQuota: async () => { throw new DomainError(409, 'QUOTA_EXCEEDED'); } });
    await expect(service.createOrganization({ userId: user.id, name: '失败', slug })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(await db.organization.findUnique({ where: { slug } })).toBeNull();
  });

  it('allows only one of two concurrent workspace creations at the remaining quota', async () => {
    const f = await fixture({ MEMBERS: 4, WORKSPACES: 2 });
    const outcomes = await Promise.allSettled(['A', 'B'].map((name) => f.service.createWorkspace({ userId: f.owner.id, organizationId: f.organization.id, name })));
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await db.workspace.count({ where: { organizationId: f.organization.id, archivedAt: null } })).toBe(2);
    expect(await db.entitlement.findFirst({ where: { organizationId: f.organization.id, key: 'WORKSPACES' } })).toMatchObject({ used: 2 });
  });

  it('archives once and releases one workspace quota without deleting prior data', async () => {
    const f = await fixture();
    await f.service.archiveWorkspace({ userId: f.owner.id, organizationId: f.organization.id, workspaceId: f.workspace.id });
    await f.service.archiveWorkspace({ userId: f.owner.id, organizationId: f.organization.id, workspaceId: f.workspace.id });
    expect(await db.workspace.findUnique({ where: { id: f.workspace.id } })).toMatchObject({ archivedAt: expect.any(Date) });
    expect(await db.entitlement.findFirst({ where: { organizationId: f.organization.id, key: 'WORKSPACES' } })).toMatchObject({ used: 0 });
  });

  it('binds invitations to email, rejects expiry and consumes a token exactly once under concurrency', async () => {
    const f = await fixture();
    const target = await f.user();
    const wrong = await f.user();
    const invitation = await f.service.invite({ userId: f.owner.id, organizationId: f.organization.id, email: target.email!, role: 'MEMBER', workspaceId: f.workspace.id, workspaceRole: 'VIEWER' });
    expect(invitation).not.toHaveProperty('token');
    expect(invitation).not.toHaveProperty('tokenHash');
    const token = f.tokens.get(invitation.id)!;
    await expect(f.service.acceptInvitation({ userId: wrong.id, token })).rejects.toMatchObject({ code: 'INVITATION_EMAIL_MISMATCH' });
    const outcomes = await Promise.allSettled([1, 2].map(() => f.service.acceptInvitation({ userId: target.id, token })));
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await db.organizationMember.count({ where: { organizationId: f.organization.id, userId: target.id } })).toBe(1);
    const expired = await f.service.invite({ userId: f.owner.id, organizationId: f.organization.id, email: wrong.email!, role: 'MEMBER' });
    await db.invitation.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(f.service.acceptInvitation({ userId: wrong.id, token: f.tokens.get(expired.id)! })).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
  });

  it('does not overwrite an existing owner or charge another seat on acceptance', async () => {
    const f = await fixture();
    const invitation = await f.service.invite({ userId: f.owner.id, organizationId: f.organization.id, email: f.owner.email!, role: 'MEMBER' });
    await f.service.acceptInvitation({ userId: f.owner.id, token: f.tokens.get(invitation.id)! });
    expect(await db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: f.organization.id, userId: f.owner.id } } })).toMatchObject({ role: 'OWNER' });
    expect(await db.entitlement.findFirst({ where: { organizationId: f.organization.id, key: 'MEMBERS' } })).toMatchObject({ used: 1 });
  });

  it('serializes concurrent invitation acceptance against the organization seat quota', async () => {
    const f = await fixture({ MEMBERS: 2, WORKSPACES: 2 });
    const candidates = await Promise.all([f.user(), f.user()]);
    const invitations = await Promise.all(candidates.map((target) => f.service.invite({ userId: f.owner.id, organizationId: f.organization.id, email: target.email!, role: 'MEMBER' })));
    const outcomes = await Promise.allSettled(candidates.map((target, index) => f.service.acceptInvitation({ userId: target.id, token: f.tokens.get(invitations[index]!.id)! })));
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await db.organizationMember.count({ where: { organizationId: f.organization.id } })).toBe(2);
    expect(await db.invitation.count({ where: { organizationId: f.organization.id, acceptedAt: { not: null } } })).toBe(1);
  });

  it('rolls back the invitation when its transactional outbox callback fails', async () => {
    const f = await fixture();
    const target = await f.user();
    const service = createTeamService(db, { ...f.hooks, onInvitationCreated: async () => { throw new Error('MAIL_UNAVAILABLE'); } });
    await expect(service.invite({ userId: f.owner.id, organizationId: f.organization.id, email: target.email!, role: 'MEMBER' })).rejects.toThrow('MAIL_UNAVAILABLE');
    expect(await db.invitation.count({ where: { organizationId: f.organization.id, email: target.email! } })).toBe(0);
  });

  it('refuses invitation delivery and quota release when their required hooks are absent', async () => {
    const f = await fixture();
    const target = await f.user();
    const service = createTeamService(db, { ...f.hooks, onInvitationCreated: undefined, releaseQuota: undefined });
    await expect(service.invite({ userId: f.owner.id, organizationId: f.organization.id, email: target.email!, role: 'MEMBER' })).rejects.toMatchObject({ code: 'INVITATION_EMAIL_UNAVAILABLE' });
    await expect(service.archiveWorkspace({ userId: f.owner.id, organizationId: f.organization.id, workspaceId: f.workspace.id })).rejects.toMatchObject({ code: 'QUOTA_UNAVAILABLE' });
    expect(await db.workspace.findUnique({ where: { id: f.workspace.id } })).toMatchObject({ archivedAt: null });
  });

  it('rejects administrator ownership changes and removal of the final owner', async () => {
    const f = await fixture();
    const admin = await f.inviteAndJoin('ADMIN');
    await expect(f.service.transferOwnership({ userId: admin.id, organizationId: f.organization.id, targetUserId: admin.id })).rejects.toMatchObject({ status: 403 });
    await expect(f.service.removeMember({ userId: admin.id, organizationId: f.organization.id, memberUserId: f.owner.id })).rejects.toMatchObject({ code: 'OWNER_PROTECTED' });
    await expect(f.service.removeMember({ userId: f.owner.id, organizationId: f.organization.id, memberUserId: f.owner.id })).rejects.toMatchObject({ code: 'LAST_OWNER' });
    await f.service.transferOwnership({ userId: f.owner.id, organizationId: f.organization.id, targetUserId: admin.id });
    expect(await db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: f.organization.id, userId: admin.id } } })).toMatchObject({ role: 'OWNER' });
    expect(await db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: f.organization.id, userId: f.owner.id } } })).toMatchObject({ role: 'ADMIN' });
  });

  it('keeps one owner during concurrent reciprocal owner removals', async () => {
    const f = await fixture();
    const secondOwner = await f.inviteAndJoin('ADMIN');
    await db.organizationMember.update({ where: { organizationId_userId: { organizationId: f.organization.id, userId: secondOwner.id } }, data: { role: 'OWNER' } });
    const outcomes = await Promise.allSettled([
      f.service.removeMember({ userId: f.owner.id, organizationId: f.organization.id, memberUserId: secondOwner.id }),
      f.service.removeMember({ userId: secondOwner.id, organizationId: f.organization.id, memberUserId: f.owner.id }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await db.organizationMember.count({ where: { organizationId: f.organization.id, role: 'OWNER' } })).toBe(1);
  });

  it('does not use a stale invitation to escalate existing organization or workspace roles', async () => {
    const f = await fixture();
    const target = await f.inviteAndJoin();
    const invitation = await f.service.invite({ userId: f.owner.id, organizationId: f.organization.id, email: target.email!, role: 'ADMIN', workspaceId: f.workspace.id, workspaceRole: 'EDITOR' });
    await f.service.acceptInvitation({ userId: target.id, token: f.tokens.get(invitation.id)! });
    expect(await db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: f.organization.id, userId: target.id } } })).toMatchObject({ role: 'MEMBER' });
    expect(await db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: f.workspace.id, userId: target.id } } })).toMatchObject({ role: 'VIEWER' });
  });

  it('isolates two workspaces and immediately revokes removed workspace and organization access', async () => {
    const f = await fixture();
    const viewer = await f.inviteAndJoin();
    const second = await f.service.createWorkspace({ userId: f.owner.id, organizationId: f.organization.id, name: '客户二' });
    await expect(requireWorkspaceRole(db, viewer.id, second.id)).rejects.toMatchObject({ status: 403 });
    await f.service.setWorkspaceMember({ userId: f.owner.id, organizationId: f.organization.id, workspaceId: second.id, memberUserId: viewer.id, role: 'EDITOR' });
    await expect(requireWorkspaceRole(db, viewer.id, second.id, true)).resolves.toBeDefined();
    await f.service.removeWorkspaceMember({ userId: f.owner.id, organizationId: f.organization.id, workspaceId: second.id, memberUserId: viewer.id });
    await expect(requireWorkspaceRole(db, viewer.id, second.id)).rejects.toMatchObject({ status: 403 });
    await f.service.removeMember({ userId: f.owner.id, organizationId: f.organization.id, memberUserId: viewer.id });
    await expect(requireWorkspaceRole(db, viewer.id, f.workspace.id)).rejects.toMatchObject({ status: 403 });
    expect(await db.entitlement.findFirst({ where: { organizationId: f.organization.id, key: 'MEMBERS' } })).toMatchObject({ used: 1 });
  });

  it('rejects revoked invitations and invitations whose sender lost management rights', async () => {
    const f = await fixture();
    const target = await f.user();
    const invitation = await f.service.invite({ userId: f.owner.id, organizationId: f.organization.id, email: target.email!, role: 'MEMBER' });
    await f.service.revokeInvitation({ userId: f.owner.id, organizationId: f.organization.id, invitationId: invitation.id });
    await expect(f.service.acceptInvitation({ userId: target.id, token: f.tokens.get(invitation.id)! })).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
    const admin = await f.inviteAndJoin('ADMIN');
    const pending = await f.service.invite({ userId: admin.id, organizationId: f.organization.id, email: target.email!, role: 'ADMIN' });
    await f.service.removeMember({ userId: f.owner.id, organizationId: f.organization.id, memberUserId: admin.id });
    await expect(f.service.acceptInvitation({ userId: target.id, token: f.tokens.get(pending.id)! })).rejects.toMatchObject({ code: 'INVITATION_UNAVAILABLE' });
  });

  it('rejects cross-organization mutations without changing quota or membership', async () => {
    const a = await fixture();
    const b = await fixture();
    await expect(a.service.setWorkspaceMember({ userId: a.owner.id, organizationId: a.organization.id, workspaceId: b.workspace.id, memberUserId: a.owner.id, role: 'EDITOR' })).rejects.toMatchObject({ status: 403 });
    await expect(a.service.createWorkspace({ userId: a.owner.id, organizationId: b.organization.id, name: '越权' })).rejects.toMatchObject({ status: 403 });
    expect(await db.workspace.count({ where: { organizationId: b.organization.id } })).toBe(1);
  });
});
