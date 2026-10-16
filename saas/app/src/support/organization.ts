import type { Prisma, PrismaClient } from '@prisma/client';
import { DomainError, lockAccountAdministration, requireActiveUser, requirePlatformAdmin } from '../team/access';
import type { OrganizationSupportRequestView } from './types';

const requestSelect = {
  id: true, category: true, subject: true, body: true, status: true, createdAt: true, resolvedAt: true,
  organization: { select: { id: true, name: true } },
  workspace: { select: { id: true, name: true } },
} satisfies Prisma.FeedbackSelect;

/** Workspace archival does not remove the submitter's support history. Current
 * organization membership is still required; neither kind of admin may use
 * this customer query to read another person's requests. */
export async function listOwnOrganizationSupportRequests(db: PrismaClient, input: { userId: string }): Promise<OrganizationSupportRequestView[]> {
  await requireActiveUser(db, input.userId);
  return db.feedback.findMany({
    where: {
      userId: input.userId,
      user: { disabledAt: null },
      organization: { status: 'ACTIVE', members: { some: { userId: input.userId, role: { in: ['OWNER', 'ADMIN', 'MEMBER'] } } } },
    },
    select: requestSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100,
  });
}

/** Records support review only. Does not delete data or enqueue notifications. */
export async function resolveOrganizationSupportRequest(db: PrismaClient, input: { actorUserId: string; requestId: string }): Promise<OrganizationSupportRequestView> {
  if (typeof input.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId)) throw new DomainError(400, 'INVALID_SUPPORT_REQUEST');
  return db.$transaction(async tx => {
    // Account disable uses the same lock, so a disabled administrator cannot
    // commit a resolution after its disable transaction has completed.
    await lockAccountAdministration(tx);
    await requirePlatformAdmin(tx, input.actorUserId);
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Feedback" WHERE id=${input.requestId} FOR UPDATE`;
    if (!rows.length) throw new DomainError(404, 'FEEDBACK_NOT_FOUND');
    const request = await tx.feedback.findUniqueOrThrow({ where: { id: input.requestId }, select: requestSelect });
    if (request.status === 'RESOLVED') return request;
    const resolved = await tx.feedback.update({ where: { id: request.id }, data: { status: 'RESOLVED', resolvedAt: new Date() }, select: requestSelect });
    await tx.auditEvent.create({ data: { organizationId: request.organization.id, actorUserId: input.actorUserId, action: 'FEEDBACK_RESOLVED', targetType: 'Feedback', targetId: request.id } });
    return resolved;
  });
}
