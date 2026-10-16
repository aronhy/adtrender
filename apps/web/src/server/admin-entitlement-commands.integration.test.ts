import { createHmac, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appCommand } from './operations';

const injected = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));
vi.mock('wasp/server', async () => {
  const { PrismaClient } = await import('@prisma/client');
  injected.db = new PrismaClient({ datasources: { db: { url: process.env.SAAS_TEST_DATABASE_URL ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
  return { prisma: injected.db, HttpError: class extends Error { constructor(public statusCode: number, message: string) { super(message); } } };
});
const db = injected.db;
const url = process.env.SAAS_TEST_DATABASE_URL;
const admin = randomUUID(), owner = randomUUID(), outsider = randomUUID();
const organizations: string[] = [];
const day = 86_400_000;
const command = (userId: string, organizationId: string, key = 'ANALYSES', limit = 2) => appCommand({ type: 'ADJUST_ENTITLEMENT', organizationId, key, limit, reason: '核对后的人工额度调整' }, { user: { id: userId } });

async function organization(userId = owner) {
  const id = randomUUID(); organizations.push(id);
  await db.$transaction(async tx => {
    await tx.organization.create({ data: { id, name: '额度调整命令合成团队', slug: id } });
    await tx.organizationMember.create({ data: { organizationId: id, userId, role: 'OWNER' } });
  });
  return id;
}
async function rows(organizationId: string) {
  return db.entitlement.findMany({ where: { organizationId }, orderBy: { id: 'asc' } });
}
afterAll(async () => {
  if (url) await db.$transaction(async tx => {
    await tx.auditEvent.deleteMany({ where: { organizationId: { in: organizations } } });
    await tx.entitlement.deleteMany({ where: { organizationId: { in: organizations } } });
    await tx.organizationMember.deleteMany({ where: { organizationId: { in: organizations } } });
    await tx.organization.deleteMany({ where: { id: { in: organizations } } });
    const secret = process.env.RATE_LIMIT_HMAC_SECRET ?? process.env.JWT_SECRET ?? 'local-development-only';
    await tx.rateLimitBucket.deleteMany({ where: { scope: 'ACTION', principalHash: { in: [admin, owner, outsider].map(id => createHmac('sha256', secret).update(id).digest('hex')) } } });
    await tx.user.deleteMany({ where: { id: { in: [admin, owner, outsider] } } });
  });
  await db.$disconnect();
});

describe.skipIf(!url)('actual admin entitlement command selects the effective period', () => {
  beforeAll(async () => { await db.user.createMany({ data: [admin, owner, outsider].map(id => ({ id, email: `quota-command-${id}@example.test`, isAdmin: id === admin })) }); });

  it.each(['WORKSPACES', 'MEMBERS', 'SAVED_ADS', 'ANALYSES'])('adjusts only current %s limit/version and audit, preserving use and other periods or organizations', async key => {
    const organizationId = await organization(), otherId = await organization(outsider), now = Date.now();
    const current = await db.entitlement.create({ data: { organizationId, key, limit: 10, used: 3, reserved: 2, version: 5, periodStart: new Date(now - 2 * day), validFrom: new Date(now - 2 * day), validUntil: new Date(now + day) } });
    await db.entitlement.createMany({ data: [
      { organizationId, key, limit: 999, used: 9, version: 1, periodStart: new Date(now - 3 * day), validFrom: new Date(now - 3 * day), validUntil: null },
      { organizationId, key, limit: 888, used: 8, version: 2, periodStart: new Date(now - day), validFrom: new Date(now - day), validUntil: new Date(now - 1000) },
      { organizationId, key, limit: 777, used: 7, version: 3, periodStart: new Date(now + day), validFrom: new Date(now + day), validUntil: null },
      { organizationId: otherId, key, limit: 666, used: 6, version: 4, periodStart: new Date(now - day), validFrom: new Date(now - day), validUntil: null },
    ] });
    const before = await rows(organizationId), otherBefore = await rows(otherId);
    await expect(command(admin, organizationId, key)).resolves.toBeDefined();
    const after = await rows(organizationId), changed = after.find(row => row.id === current.id)!;
    expect(changed).toMatchObject({ ...current, updatedAt: expect.any(Date), limit: 2, source: 'MANUAL', version: 6, used: 3, reserved: 2 });
    expect(after.filter(row => row.id !== current.id)).toEqual(before.filter(row => row.id !== current.id));
    expect(await rows(otherId)).toEqual(otherBefore);
    const audit = await db.auditEvent.findMany({ where: { organizationId, action: 'ENTITLEMENT_ADJUSTED' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: admin, targetType: 'Entitlement', targetId: current.id, metadata: { before: 10, after: 2, reason: '核对后的人工额度调整' } });
  });

  it('rejects missing, expired and future-only entitlement without rewriting any history or recording an adjustment', async () => {
    const organizationId = await organization(), now = Date.now();
    await db.entitlement.createMany({ data: [
      { organizationId, key: 'WORKSPACES', limit: 10, used: 3, periodStart: new Date(now - day), validFrom: new Date(now - day), validUntil: new Date(now - 1000) },
      { organizationId, key: 'MEMBERS', limit: 20, periodStart: new Date(now + day), validFrom: new Date(now + day), validUntil: null },
    ] });
    const before = await rows(organizationId);
    for (const key of ['WORKSPACES', 'MEMBERS', 'ANALYSES']) await expect(command(admin, organizationId, key)).rejects.toMatchObject({ statusCode: 402, message: 'ENTITLEMENT_EXPIRED' });
    expect(await rows(organizationId)).toEqual(before);
    expect(await db.auditEvent.count({ where: { organizationId, action: 'ENTITLEMENT_ADJUSTED' } })).toBe(0);
  });

  it('rejects ordinary organization owners for both own and another organization without changing quotas', async () => {
    const ownId = await organization(), otherId = await organization(outsider), now = Date.now();
    for (const organizationId of [ownId, otherId]) await db.entitlement.create({ data: { organizationId, key: 'ANALYSES', limit: 9, used: 1, reserved: 1, validFrom: new Date(now - day), validUntil: null } });
    const before = await Promise.all([rows(ownId), rows(otherId)]);
    for (const organizationId of [ownId, otherId]) await expect(command(owner, organizationId)).rejects.toMatchObject({ statusCode: 403, message: 'PLATFORM_ADMIN_REQUIRED' });
    expect(await Promise.all([rows(ownId), rows(otherId)])).toEqual(before);
    expect(await db.auditEvent.count({ where: { organizationId: { in: [ownId, otherId] }, action: 'ENTITLEMENT_ADJUSTED' } })).toBe(0);
  });
});
