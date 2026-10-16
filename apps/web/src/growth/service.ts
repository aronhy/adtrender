import type { Prisma, PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { DomainError } from '../team/access';
import { normalizeAttribution, eventInput, growthEnabled, GROWTH_LIFETIME_MS, GROWTH_CONSENT_VERSION, type AttributionInput, type PublicEventInput } from './contract';

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export async function lockActiveVisit(tx: Prisma.TransactionClient, token: string, now = new Date()) {
  const hash = tokenHash(token);
  await tx.$queryRaw`SELECT id FROM "GrowthVisit" WHERE "tokenHash"=${hash} FOR UPDATE`;
  return tx.growthVisit.findFirst({ where: { tokenHash: hash, revokedAt: null, expiresAt: { gt: now }, consentVersion: GROWTH_CONSENT_VERSION } });
}
export async function acceptConsent(db: PrismaClient, priorToken: string | undefined, input: AttributionInput = { landingPath: '/' }, now = new Date()) {
  if (!growthEnabled()) throw new DomainError(503, 'GROWTH_UNAVAILABLE');
  const attribution = normalizeAttribution(input);
  return db.$transaction(async tx => {
    if (priorToken) { const visit = await lockActiveVisit(tx, priorToken, now); if (visit) return { token: priorToken, visit }; }
    const token = randomBytes(32).toString('base64url');
    const visit = await tx.growthVisit.create({ data: {
      ...attribution, tokenHash: tokenHash(token), createdAt: now, lastSeenAt: now, expiresAt: new Date(now.valueOf() + GROWTH_LIFETIME_MS),
      isTest: attribution.source?.toLowerCase() === 'codex' || attribution.medium?.toLowerCase() === 'qa',
    } });
    return { token, visit };
  });
}
export async function revokeConsent(db: PrismaClient, token: string | undefined, now = new Date()) {
  if (token) await db.growthVisit.updateMany({ where: { tokenHash: tokenHash(token), revokedAt: null }, data: { revokedAt: now } });
}
export async function recordPublicEvent(db: PrismaClient, token: string | undefined, input: PublicEventInput, now = new Date()) {
  if (!growthEnabled() || !token) return { recorded: false };
  const body = eventInput.parse(input);
  return db.$transaction(async tx => {
    const visit = await lockActiveVisit(tx, token, now); if (!visit) return { recorded: false };
    const dedupeKey = createHash('sha256').update(`${visit.id}:${body.requestNonce}`).digest('hex');
    const result = await tx.growthEvent.createMany({ data: [{ visitId: visit.id, name: body.name, pathname: body.pathname, target: body.name === 'CTA_CLICK' ? body.target : null, dedupeKey, createdAt: now }], skipDuplicates: true });
    if (result.count) await tx.growthVisit.update({ where: { id: visit.id }, data: { lastSeenAt: now } });
    return { recorded: result.count === 1 };
  });
}
