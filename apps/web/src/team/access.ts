import type { Prisma } from '@prisma/client';

export class DomainError extends Error {
  constructor(public readonly status: number, public readonly code: string, message = code) {
    super(message);
    this.name = 'DomainError';
  }
}

/** Account disable and owner changes share this lock before organization locks.
 * It prevents assigning an account as the sole owner while it is being disabled. */
export async function lockAccountAdministration(db: Prisma.TransactionClient) {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(1748210449)`;
}

export async function requireActiveUser(db: Prisma.TransactionClient, userId: string) {
  if (!userId) throw new DomainError(401, 'AUTH_REQUIRED');
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, isAdmin: true, disabledAt: true },
  });
  if (!user) throw new DomainError(401, 'AUTH_REQUIRED');
  if (user.disabledAt) throw new DomainError(403, 'ACCOUNT_DISABLED');
  return user;
}
export async function requireOrgRole(db: Prisma.TransactionClient, userId: string, organizationId: string, roles?: readonly string[]) {
  const user = await requireActiveUser(db, userId);
  const membership = await db.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    include: { organization: true },
  });
  if (!membership || membership.organization.status !== 'ACTIVE'
    || !['OWNER', 'ADMIN', 'MEMBER'].includes(membership.role)
    || (roles && !roles.includes(membership.role))) {
    throw new DomainError(403, 'ORGANIZATION_FORBIDDEN');
  }
  return { user, organization: membership.organization, membership };
}
export async function requireWorkspaceRole(db: Prisma.TransactionClient, userId: string, workspaceId: string, write = false) {
  await requireActiveUser(db, userId);
  const workspace = await db.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace || workspace.archivedAt) throw new DomainError(403, 'WORKSPACE_FORBIDDEN');
  const access = await requireOrgRole(db, userId, workspace.organizationId);
  if (access.membership.role === 'OWNER' || access.membership.role === 'ADMIN') {
    return { ...access, workspace, workspaceMembership: null };
  }
  const workspaceMembership = await db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
  if (!workspaceMembership || workspaceMembership.organizationId !== workspace.organizationId
    || !['EDITOR', 'VIEWER'].includes(workspaceMembership.role)
    || (write && workspaceMembership.role !== 'EDITOR')) {
    throw new DomainError(403, 'WORKSPACE_FORBIDDEN');
  }
  return { ...access, workspace, workspaceMembership };
}
export async function requirePlatformAdmin(db: Prisma.TransactionClient, userId: string) {
  const user = await requireActiveUser(db, userId);
  if (!user.isAdmin) throw new DomainError(403, 'PLATFORM_ADMIN_REQUIRED');
  return user;
}
