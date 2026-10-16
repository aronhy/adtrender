import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { requireActiveUser, requireOrgRole, requirePlatformAdmin, requireWorkspaceRole } from './access';

// This bounded in-memory read fixture exercises authorization decisions. The
// service integration suite separately checks real PostgreSQL constraints/locks.
function fixture(role = 'MEMBER', workspaceRole: string | null = 'VIEWER') {
  const user = { id: 'user-1', email: 'viewer@example.test', isAdmin: false, disabledAt: null as Date | null };
  const organization = { id: 'org-a', name: 'A', status: 'ACTIVE' };
  let memberExists = true;
  const db = {
    user: { findUnique: async ({ where }: any) => where.id === user.id ? { ...user } : null },
    organizationMember: { findUnique: async ({ where }: any) => memberExists && where.organizationId_userId.organizationId === organization.id && where.organizationId_userId.userId === user.id ? { id: 'membership', organizationId: organization.id, userId: user.id, role, organization } : null },
    workspace: { findUnique: async ({ where }: any) => where.id === 'workspace-a' ? { id: 'workspace-a', organizationId: organization.id, archivedAt: null } : where.id === 'workspace-b' ? { id: 'workspace-b', organizationId: 'org-b', archivedAt: null } : null },
    workspaceMember: { findUnique: async ({ where }: any) => workspaceRole && where.workspaceId_userId.workspaceId === 'workspace-a' && where.workspaceId_userId.userId === user.id ? { id: 'workspace-membership', organizationId: organization.id, workspaceId: 'workspace-a', userId: user.id, role: workspaceRole } : null },
  } as unknown as Prisma.TransactionClient;
  return { db, user, removeMember: () => { memberExists = false; } };
}

describe('server-side team authorization', () => {
  it('rejects missing and disabled users and rereads the account on the next request', async () => {
    const { db, user } = fixture();
    await expect(requireActiveUser(db, 'absent')).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    await expect(requireActiveUser(db, user.id)).resolves.toMatchObject({ id: user.id });
    user.disabledAt = new Date();
    await expect(requireActiveUser(db, user.id)).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_DISABLED' });
  });

  it('rejects cross-organization workspace IDs and newly removed memberships', async () => {
    const { db, removeMember } = fixture();
    await expect(requireWorkspaceRole(db, 'user-1', 'workspace-b')).rejects.toMatchObject({ status: 403 });
    await expect(requireWorkspaceRole(db, 'user-1', 'workspace-a')).resolves.toMatchObject({ workspace: { id: 'workspace-a' } });
    removeMember();
    await expect(requireWorkspaceRole(db, 'user-1', 'workspace-a')).rejects.toMatchObject({ status: 403 });
  });

  it('grants a viewer read access but denies edits and organization administration', async () => {
    const { db } = fixture();
    await expect(requireWorkspaceRole(db, 'user-1', 'workspace-a')).resolves.toBeDefined();
    await expect(requireWorkspaceRole(db, 'user-1', 'workspace-a', true)).rejects.toMatchObject({ code: 'WORKSPACE_FORBIDDEN' });
    await expect(requireOrgRole(db, 'user-1', 'org-a', ['OWNER', 'ADMIN'])).rejects.toMatchObject({ code: 'ORGANIZATION_FORBIDDEN' });
  });

  it('grants editors writes but rejects a member without an assigned workspace', async () => {
    await expect(requireWorkspaceRole(fixture('MEMBER', 'EDITOR').db, 'user-1', 'workspace-a', true)).resolves.toBeDefined();
    await expect(requireWorkspaceRole(fixture('MEMBER', null).db, 'user-1', 'workspace-a')).rejects.toMatchObject({ code: 'WORKSPACE_FORBIDDEN' });
  });

  it.each(['OWNER', 'ADMIN'])('grants %s all organization workspaces without an explicit workspace membership', async (role) => {
    await expect(requireWorkspaceRole(fixture(role, null).db, 'user-1', 'workspace-a', true)).resolves.toBeDefined();
  });

  it('requires explicit platform admin and does not grant platform admins implicit private access', async () => {
    const { db, user } = fixture('OWNER');
    await expect(requirePlatformAdmin(db, user.id)).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
    user.isAdmin = true;
    await expect(requirePlatformAdmin(db, user.id)).resolves.toMatchObject({ isAdmin: true });
    await expect(requireWorkspaceRole(db, user.id, 'workspace-b')).rejects.toMatchObject({ status: 403 });
  });
});
