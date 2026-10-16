import type { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { encryptMessage, decryptMessage } from '../server/email';
import { DomainError } from '../team/access';

type Purpose = 'RESET' | 'VERIFY';
export type LockedAuthLink = { frameworkToken: string; email: string; authId: string; userId: string; providerData: string };
export function credentialHash(providerData: string): string {
  const data = JSON.parse(providerData);
  if (typeof data.hashedPassword !== 'string' || !data.hashedPassword) throw new DomainError(400, 'AUTH_LINK_INVALID');
  return createHash('sha256').update(data.hashedPassword).digest('hex');
}
export async function issueAuthLink(db: Prisma.TransactionClient, input: { email: string; purpose: Purpose; frameworkToken: string; key: string }): Promise<string> {
  const email = input.email.toLowerCase();
  const identity = await db.authIdentity.findUnique({ where: { providerName_providerUserId: { providerName: 'email', providerUserId: email } } });
  if (!identity) throw new DomainError(400, 'AUTH_LINK_INVALID');
  const token = randomBytes(32).toString('hex');
  const envelope = { version: 2, frameworkToken: input.frameworkToken, authId: identity.authId, credentialHash: credentialHash(identity.providerData) };
  await db.authLink.create({ data: { tokenHash: createHash('sha256').update(token).digest('hex'), purpose: input.purpose, recipientEmail: email, encryptedPayload: encryptMessage({ to: email, subject: input.purpose, text: JSON.stringify(envelope) }, input.key), expiresAt: new Date(Date.now() + 28 * 60000) } });
  return token;
}
/** The optional operation executes before consumption in the same transaction.
 * Auth row lock also fences Wasp Session inserts through their foreign key. */
export async function consumeAuthLink<T = LockedAuthLink>(db: PrismaClient, token: string, purpose: Purpose, key: string, apply?: (tx: Prisma.TransactionClient, link: LockedAuthLink) => Promise<T>): Promise<T> {
  if (!/^[a-f\d]{64}$/.test(token)) throw new DomainError(400, 'AUTH_LINK_INVALID');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  return db.$transaction(async tx => {
    const initial = await tx.authLink.findUnique({ where: { tokenHash } });
    if (!initial || initial.purpose !== purpose || initial.consumedAt || initial.expiresAt <= new Date()) throw new DomainError(400, 'AUTH_LINK_INVALID');
    const message = decryptMessage(initial.encryptedPayload, key);
    let envelope: { version?: number; frameworkToken?: string; authId?: string; credentialHash?: string };
    try { envelope = JSON.parse(message.text); } catch { throw new DomainError(400, 'AUTH_LINK_INVALID'); }
    if (message.to.toLowerCase() !== initial.recipientEmail || message.subject !== purpose || envelope.version !== 2 || typeof envelope.frameworkToken !== 'string' || typeof envelope.authId !== 'string') throw new DomainError(400, 'AUTH_LINK_INVALID');
    await tx.$queryRaw`SELECT id FROM "Auth" WHERE id=${envelope.authId} FOR UPDATE`;
    const identity = await tx.authIdentity.findUnique({ where: { providerName_providerUserId: { providerName: 'email', providerUserId: initial.recipientEmail } }, include: { auth: { include: { user: true } } } });
    if (!identity || identity.authId !== envelope.authId || (!identity.auth.user || identity.auth.user.disabledAt) || identity.auth.user?.email?.toLowerCase() !== initial.recipientEmail || credentialHash(identity.providerData) !== envelope.credentialHash) throw new DomainError(400, 'AUTH_LINK_INVALID');
    // Recheck after acquiring Auth: competing consumption/reset must not reuse the old read.
    const link = await tx.authLink.findUniqueOrThrow({ where: { tokenHash } });
    if (link.consumedAt || link.expiresAt <= new Date()) throw new DomainError(400, 'AUTH_LINK_INVALID');
    const locked = { frameworkToken: envelope.frameworkToken, email: link.recipientEmail, authId: identity.authId, userId: identity.auth.user.id, providerData: identity.providerData };
    const result = apply ? await apply(tx, locked) : locked as T;
    const changed = await tx.authLink.updateMany({ where: { id: link.id, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date(), encryptedPayload: '' } });
    if (changed.count !== 1) throw new DomainError(400, 'AUTH_LINK_INVALID');
    return result;
  }, { maxWait: 10_000, timeout: 20_000 });
}
