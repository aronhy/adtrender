import type { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { createTeamService } from './service';

describe('team operation input boundaries', () => {
  const service = createTeamService({} as PrismaClient);
  it('rejects empty organization names before touching the database', async () => {
    await expect(service.createOrganization({ name: ' ', userId: 'user' })).rejects.toMatchObject({ status: 400, code: 'INVALID_NAME' });
  });
  it('rejects invalid workspace names and role values', async () => {
    await expect(service.createWorkspace({ name: 'a\n', userId: 'user', organizationId: 'org' })).rejects.toMatchObject({ status: 400 });
    await expect(service.setWorkspaceMember({ userId: 'user', organizationId: 'org', workspaceId: 'space', memberUserId: 'member', role: 'OWNER' as any })).rejects.toMatchObject({ status: 400, code: 'INVALID_WORKSPACE_ROLE' });
  });
  it('rejects owner invitations and malformed emails', async () => {
    await expect(service.invite({ userId: 'user', organizationId: 'org', email: 'bad-address', role: 'MEMBER' })).rejects.toMatchObject({ status: 400, code: 'INVALID_EMAIL' });
    await expect(service.invite({ userId: 'user', organizationId: 'org', email: 'a@example.test', role: 'OWNER' as any })).rejects.toMatchObject({ status: 400, code: 'INVALID_ORGANIZATION_ROLE' });
  });
  it('rejects malformed invitation tokens', async () => {
    await expect(service.acceptInvitation({ userId: 'user', token: 'abc' })).rejects.toMatchObject({ status: 400, code: 'INVALID_TOKEN' });
  });
});
