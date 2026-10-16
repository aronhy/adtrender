import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Invitation, Organization, Prisma, PrismaClient } from '@prisma/client';
import { DomainError, lockAccountAdministration, requireActiveUser, requireOrgRole } from './access';
import { cancelWorkspaceAnalysis } from '../analysis/service';

type QuotaKey = 'WORKSPACES' | 'MEMBERS';
type WorkspaceRole = 'EDITOR' | 'VIEWER';
type OrganizationRole = 'ADMIN' | 'MEMBER';
type Actor = { userId: string; organizationId: string };
type WorkspaceActor = Actor & { workspaceId: string };
type WorkspaceMemberInput = WorkspaceActor & { memberUserId: string };

export interface TeamHooks {
  initializeOrganization?: (tx: Prisma.TransactionClient, organizationId: string) => Promise<unknown>;
  admitQuota?: (tx: Prisma.TransactionClient, organizationId: string, key: QuotaKey, quantity: number) => Promise<unknown>;
  releaseQuota?: (tx: Prisma.TransactionClient, organizationId: string, key: QuotaKey, quantity: number) => Promise<unknown>;
  onInvitationCreated?: (tx: Prisma.TransactionClient, data: { invitation: Invitation; organization: Organization; token: string }) => Promise<unknown>;
}

function text(value: unknown, code: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new DomainError(400, code);
  return value.trim();
}

function email(value: unknown) {
  const normalized = text(value, 'INVALID_EMAIL', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new DomainError(400, 'INVALID_EMAIL');
  return normalized;
}

function workspaceRole(value: unknown): WorkspaceRole {
  if (value !== 'EDITOR' && value !== 'VIEWER') throw new DomainError(400, 'INVALID_WORKSPACE_ROLE');
  return value;
}

function organizationRole(value: unknown): OrganizationRole {
  if (value !== 'ADMIN' && value !== 'MEMBER') throw new DomainError(400, 'INVALID_ORGANIZATION_ROLE');
  return value;
}

function slug(value: unknown, prefix: string) {
  if (value === undefined) return `${prefix}-${randomUUID().slice(0, 12)}`;
  const normalized = text(value, 'INVALID_SLUG', 80).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(normalized)) throw new DomainError(400, 'INVALID_SLUG');
  return normalized;
}

function publicInvitation(invitation: Invitation) {
  const { tokenHash: _tokenHash, ...result } = invitation;
  return result;
}

async function lockOrganization(tx: Prisma.TransactionClient, organizationId: string) {
  text(organizationId, 'INVALID_ORGANIZATION_ID', 100);
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`;
  if (!rows.length) throw new DomainError(403, 'ORGANIZATION_FORBIDDEN');
}

async function manageOrganization(tx: Prisma.TransactionClient, input: Actor, roles = ['OWNER', 'ADMIN']) {
  await lockOrganization(tx, input.organizationId);
  return requireOrgRole(tx, input.userId, input.organizationId, roles);
}

async function workspaceInOrganization(tx: Prisma.TransactionClient, organizationId: string, workspaceId: string, allowArchived = false) {
  text(workspaceId, 'INVALID_WORKSPACE_ID', 100);
  const workspace = await tx.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace || workspace.organizationId !== organizationId || (!allowArchived && workspace.archivedAt)) throw new DomainError(403, 'WORKSPACE_FORBIDDEN');
  return workspace;
}

async function audit(tx: Prisma.TransactionClient, input: Actor, action: string, targetType: string, targetId: string, workspaceId?: string, metadata: Prisma.InputJsonObject = {}) {
  await tx.auditEvent.create({ data: { organizationId: input.organizationId, actorUserId: input.userId, workspaceId, action, targetType, targetId, metadata } });
}

/** Mutations serialize on their organization row. The quota and email hooks
 * receive the SAME transaction; they must not use a separate database client. */
export function createTeamService(db: PrismaClient, hooks: TeamHooks = {}) {
  async function transact<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await db.$transaction(fn, { maxWait: 10_000, timeout: 20_000 });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw new DomainError(409, 'RESOURCE_CONFLICT');
      throw error;
    }
  }
  async function admit(tx: Prisma.TransactionClient, organizationId: string, key: QuotaKey) {
    if (!hooks.admitQuota) throw new DomainError(503, 'QUOTA_UNAVAILABLE');
    await hooks.admitQuota(tx, organizationId, key, 1);
  }
  async function release(tx: Prisma.TransactionClient, organizationId: string, key: QuotaKey) {
    if (!hooks.releaseQuota) throw new DomainError(503, 'QUOTA_UNAVAILABLE');
    await hooks.releaseQuota(tx, organizationId, key, 1);
  }
  return {
    async createOrganization(input: { userId: string; name: string; slug?: string; workspaceName?: string }) {
      const name = text(input.name, 'INVALID_NAME', 80);
      const workspaceName = text(input.workspaceName ?? '默认工作区', 'INVALID_NAME', 80);
      const organizationSlug = slug(input.slug, 'team');
      if (!hooks.initializeOrganization || !hooks.admitQuota) throw new DomainError(503, 'QUOTA_UNAVAILABLE');
      return transact(async (tx) => {
        await lockAccountAdministration(tx);
        await requireActiveUser(tx, input.userId);
        const organization = await tx.organization.create({ data: { name, slug: organizationSlug } });
        await hooks.initializeOrganization!(tx, organization.id);
        await admit(tx, organization.id, 'MEMBERS');
        await tx.organizationMember.create({ data: { organizationId: organization.id, userId: input.userId, role: 'OWNER' } });
        await admit(tx, organization.id, 'WORKSPACES');
        const workspace = await tx.workspace.create({ data: { organizationId: organization.id, name: workspaceName, slug: 'default' } });
        await audit(tx, { ...input, organizationId: organization.id }, 'ORGANIZATION_CREATED', 'Organization', organization.id, workspace.id, { initialOwnerUserId: input.userId, initialWorkspaceId: workspace.id });
        return { organization, workspace };
      });
    },
    async createWorkspace(input: Actor & { name: string; slug?: string }) {
      const name = text(input.name, 'INVALID_NAME', 80);
      const workspaceSlug = slug(input.slug, 'workspace');
      return transact(async (tx) => {
        await manageOrganization(tx, input);
        await admit(tx, input.organizationId, 'WORKSPACES');
        const workspace = await tx.workspace.create({ data: { organizationId: input.organizationId, name, slug: workspaceSlug } });
        await audit(tx, input, 'WORKSPACE_CREATED', 'Workspace', workspace.id, workspace.id);
        return workspace;
      });
    },
    async archiveWorkspace(input: WorkspaceActor) {
      return transact(async (tx) => {
        await manageOrganization(tx, input);
        const workspace = await workspaceInOrganization(tx, input.organizationId, input.workspaceId, true);
        const canceledAnalysisCount = await cancelWorkspaceAnalysis(tx, input.organizationId, workspace.id);
        if (workspace.archivedAt) return workspace;
        await release(tx, input.organizationId, 'WORKSPACES');
        const archived = await tx.workspace.update({ where: { id: workspace.id }, data: { archivedAt: new Date() } });
        await audit(tx, input, 'WORKSPACE_ARCHIVED', 'Workspace', workspace.id, workspace.id, { canceledAnalysisCount });
        return archived;
      });
    },
    async invite(input: Actor & { email: string; role: OrganizationRole; workspaceId?: string; workspaceRole?: WorkspaceRole; ttlHours?: number }) {
      const recipientEmail = email(input.email);
      const role = organizationRole(input.role);
      const targetWorkspaceRole = input.workspaceId ? workspaceRole(input.workspaceRole ?? 'VIEWER') : null;
      if (!input.workspaceId && input.workspaceRole) throw new DomainError(400, 'WORKSPACE_REQUIRED');
      const ttl = input.ttlHours ?? 72;
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > 168) throw new DomainError(400, 'INVALID_INVITATION_TTL');
      if (!hooks.onInvitationCreated) throw new DomainError(503, 'INVITATION_EMAIL_UNAVAILABLE');
      return transact(async (tx) => {
        const { organization } = await manageOrganization(tx, input);
        if (input.workspaceId) await workspaceInOrganization(tx, organization.id, input.workspaceId);
        const token = randomBytes(32).toString('hex');
        const tokenHash = createHash('sha256').update(token).digest('hex');
        const invitation = await tx.invitation.create({ data: {
          organizationId: organization.id, workspaceId: input.workspaceId, email: recipientEmail,
          role, workspaceRole: targetWorkspaceRole, tokenHash, expiresAt: new Date(Date.now() + ttl * 3_600_000), invitedByUserId: input.userId,
        } });
        await hooks.onInvitationCreated!(tx, { invitation, organization, token });
        await audit(tx, input, 'INVITATION_CREATED', 'Invitation', invitation.id, input.workspaceId, { role, workspaceRole: targetWorkspaceRole });
        return publicInvitation(invitation);
      });
    },
    async acceptInvitation(input: { userId: string; token: string }) {
      if (typeof input.token !== 'string' || !/^[0-9a-f]{64}$/.test(input.token)) throw new DomainError(400, 'INVALID_TOKEN');
      const tokenHash = createHash('sha256').update(input.token).digest('hex');
      return transact(async (tx) => {
        await requireActiveUser(tx, input.userId);
        const lookup = await tx.invitation.findUnique({ where: { tokenHash }, select: { organizationId: true } });
        if (!lookup) throw new DomainError(410, 'INVITATION_UNAVAILABLE');
        await lockOrganization(tx, lookup.organizationId);
        // Re-read after taking the lock, including the account and invitation.
        const user = await requireActiveUser(tx, input.userId);
        const invitation = await tx.invitation.findUnique({ where: { tokenHash } });
        const now = new Date();
        if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= now || !invitation.invitedByUserId) throw new DomainError(410, 'INVITATION_UNAVAILABLE');
        if (!user.email || user.email.trim().toLowerCase() !== invitation.email.toLowerCase()) throw new DomainError(403, 'INVITATION_EMAIL_MISMATCH');
        if (!['MEMBER', 'ADMIN'].includes(invitation.role)) throw new DomainError(410, 'INVITATION_UNAVAILABLE');
        try {
          await requireOrgRole(tx, invitation.invitedByUserId, invitation.organizationId, ['OWNER', 'ADMIN']);
        } catch (error) {
          if (error instanceof DomainError) throw new DomainError(410, 'INVITATION_UNAVAILABLE');
          throw error;
        }
        if (invitation.workspaceId) {
          await workspaceInOrganization(tx, invitation.organizationId, invitation.workspaceId);
          workspaceRole(invitation.workspaceRole);
        }
        const consumed = await tx.invitation.updateMany({ where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } }, data: { acceptedAt: now } });
        if (consumed.count !== 1) throw new DomainError(410, 'INVITATION_UNAVAILABLE');
        let membership = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: invitation.organizationId, userId: user.id } } });
        if (!membership) {
          await admit(tx, invitation.organizationId, 'MEMBERS');
          membership = await tx.organizationMember.create({ data: { organizationId: invitation.organizationId, userId: user.id, role: invitation.role } });
        }
        if (invitation.workspaceId) {
          // An invitation never changes an existing member's role. Role changes
          // use an explicitly authorized management operation instead.
          await tx.workspaceMember.upsert({
            where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId: user.id } },
            create: { organizationId: invitation.organizationId, workspaceId: invitation.workspaceId, userId: user.id, role: invitation.workspaceRole! }, update: {},
          });
        }
        await audit(tx, { userId: user.id, organizationId: invitation.organizationId }, 'INVITATION_ACCEPTED', 'Invitation', invitation.id, invitation.workspaceId ?? undefined, { membershipId: membership.id });
        return { organizationId: invitation.organizationId, workspaceId: invitation.workspaceId, membership };
      });
    },
    async revokeInvitation(input: Actor & { invitationId: string }) {
      return transact(async (tx) => {
        await manageOrganization(tx, input);
        const invitation = await tx.invitation.findUnique({ where: { id: text(input.invitationId, 'INVALID_INVITATION_ID', 100) } });
        if (!invitation || invitation.organizationId !== input.organizationId) throw new DomainError(404, 'INVITATION_NOT_FOUND');
        if (invitation.acceptedAt) throw new DomainError(409, 'INVITATION_ALREADY_ACCEPTED');
        if (invitation.revokedAt) return publicInvitation(invitation);
        const revoked = await tx.invitation.update({ where: { id: invitation.id }, data: { revokedAt: new Date() } });
        await audit(tx, input, 'INVITATION_REVOKED', 'Invitation', invitation.id, invitation.workspaceId ?? undefined);
        return publicInvitation(revoked);
      });
    },
    async transferOwnership(input: Actor & { targetUserId: string }) {
      return transact(async (tx) => {
        await lockAccountAdministration(tx);
        await manageOrganization(tx, input, ['OWNER']);
        const targetUserId = text(input.targetUserId, 'INVALID_USER_ID', 100);
        const target = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: input.organizationId, userId: targetUserId } } });
        if (!target) throw new DomainError(404, 'MEMBER_NOT_FOUND');
        await requireActiveUser(tx, targetUserId);
        if (targetUserId === input.userId) return { ownerUserId: targetUserId, previousOwnerUserId: input.userId };
        await tx.organizationMember.update({ where: { id: target.id }, data: { role: 'OWNER' } });
        await tx.organizationMember.update({ where: { organizationId_userId: { organizationId: input.organizationId, userId: input.userId } }, data: { role: 'ADMIN' } });
        await audit(tx, input, 'OWNERSHIP_TRANSFERRED', 'Organization', input.organizationId, undefined, { previousOwnerUserId: input.userId, ownerUserId: targetUserId });
        return { ownerUserId: targetUserId, previousOwnerUserId: input.userId };
      });
    },
    async removeMember(input: Actor & { memberUserId: string }) {
      return transact(async (tx) => {
        await lockAccountAdministration(tx);
        const access = await manageOrganization(tx, input);
        const target = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: input.organizationId, userId: text(input.memberUserId, 'INVALID_USER_ID', 100) } }, include: { user: { select: { email: true } } } });
        if (!target) return { removed: false };
        if (target.role === 'OWNER') {
          if (access.membership.role !== 'OWNER') throw new DomainError(403, 'OWNER_PROTECTED');
          const otherOwners = await tx.organizationMember.count({ where: { organizationId: input.organizationId, role: 'OWNER', userId: { not: target.userId }, user: { disabledAt: null } } });
          if (otherOwners === 0) throw new DomainError(409, 'LAST_OWNER');
        }
        await release(tx, input.organizationId, 'MEMBERS');
        await tx.organizationMember.delete({ where: { id: target.id } });
        const pendingInvitations: Prisma.InvitationWhereInput[] = [{ invitedByUserId: target.userId }];
        if (target.user.email) pendingInvitations.push({ email: { equals: target.user.email, mode: 'insensitive' } });
        await tx.invitation.updateMany({ where: { organizationId: input.organizationId, acceptedAt: null, revokedAt: null, OR: pendingInvitations }, data: { revokedAt: new Date() } });
        await audit(tx, input, 'MEMBER_REMOVED', 'OrganizationMember', target.id, undefined, { memberUserId: target.userId, previousRole: target.role });
        return { removed: true };
      });
    },
    async setWorkspaceMember(input: WorkspaceMemberInput & { role: WorkspaceRole }) {
      const role = workspaceRole(input.role);
      return transact(async (tx) => {
        const access = await manageOrganization(tx, input);
        await workspaceInOrganization(tx, input.organizationId, input.workspaceId);
        const target = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: input.organizationId, userId: text(input.memberUserId, 'INVALID_USER_ID', 100) } } });
        if (!target) throw new DomainError(404, 'MEMBER_NOT_FOUND');
        if (target.role === 'OWNER' && access.membership.role !== 'OWNER') throw new DomainError(403, 'OWNER_PROTECTED');
        await requireActiveUser(tx, target.userId);
        const membership = await tx.workspaceMember.upsert({
          where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: target.userId } },
          create: { organizationId: input.organizationId, workspaceId: input.workspaceId, userId: target.userId, role }, update: { role },
        });
        await audit(tx, input, 'WORKSPACE_MEMBER_SET', 'WorkspaceMember', membership.id, input.workspaceId, { memberUserId: target.userId, role });
        return membership;
      });
    },
    async removeWorkspaceMember(input: WorkspaceMemberInput) {
      return transact(async (tx) => {
        const access = await manageOrganization(tx, input);
        await workspaceInOrganization(tx, input.organizationId, input.workspaceId);
        const target = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: input.organizationId, userId: text(input.memberUserId, 'INVALID_USER_ID', 100) } } });
        if (target?.role === 'OWNER' && access.membership.role !== 'OWNER') throw new DomainError(403, 'OWNER_PROTECTED');
        if (!target) throw new DomainError(404, 'MEMBER_NOT_FOUND');
        if (target.role !== 'MEMBER') throw new DomainError(409, 'WORKSPACE_ROLE_INHERITED');
        const membership = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.memberUserId } } });
        if (!membership) return { removed: false };
        await tx.workspaceMember.delete({ where: { id: membership.id } });
        await audit(tx, input, 'WORKSPACE_MEMBER_REMOVED', 'WorkspaceMember', membership.id, input.workspaceId, { memberUserId: input.memberUserId });
        return { removed: true };
      });
    },
  };
}
