import type { Prisma } from '@prisma/client';
import type { AdminView } from '../client/types';

// Support staff need the identity attached to the submitted request. Never fetch
// authentication, notification preferences, or other organization members here.
export const organizationSupportSelect = {
  id: true, createdAt: true, category: true, subject: true, body: true, status: true,
  user: { select: { id: true, email: true } },
  organization: { select: { id: true, name: true } },
  workspace: { select: { id: true, name: true } },
} satisfies Prisma.FeedbackSelect;

export const accountSupportSelect = {
  id: true, createdAt: true, kind: true, body: true, status: true,
  user: { select: { id: true, email: true } },
} satisfies Prisma.AccountSupportRequestSelect;

type SupportView = AdminView['feedback'][number];
export function organizationSupportView(row: Prisma.FeedbackGetPayload<{ select: typeof organizationSupportSelect }>) {
  return { scope: 'ORGANIZATION', id: row.id, category: row.category, subject: row.subject, message: row.body, status: row.status, createdAt: row.createdAt,
    requester: row.user ? { id: row.user.id, email: row.user.email } : null,
    organization: { id: row.organization.id, name: row.organization.name },
    workspace: row.workspace ? { id: row.workspace.id, name: row.workspace.name } : null } satisfies SupportView;
}

export function accountSupportView(row: Prisma.AccountSupportRequestGetPayload<{ select: typeof accountSupportSelect }>) {
  return { scope: 'ACCOUNT', id: row.id, category: row.kind, subject: null, message: row.body, status: row.status, createdAt: row.createdAt,
    requester: { id: row.user.id, email: row.user.email }, organization: null, workspace: null } satisfies SupportView;
}
