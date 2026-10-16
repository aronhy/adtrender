import type { PrismaClient, Prisma } from '@prisma/client';
import { HttpError } from 'wasp/server';

export async function assertRegistrationAllowed(db: PrismaClient | Prisma.TransactionClient, email: string) {
  if (process.env.REGISTRATION_MODE === 'public') return;
  const allowed = (process.env.REGISTRATION_ALLOWLIST ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (allowed.includes(email)) return;
  const invitation = await db.invitation.findFirst({ where: {
    email, expiresAt: { gt: new Date() }, acceptedAt: null, revokedAt: null,
    organization: { status: 'ACTIVE' }, invitedBy: { disabledAt: null },
  } });
  if (!invitation) throw new HttpError(403, 'INVITATION_REQUIRED');
}
