import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { billingView, loadAppState } from './views';

const url = process.env.SAAS_TEST_DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
const organizations: string[] = [], users: string[] = [];
const keys = ['WORKSPACES', 'MEMBERS', 'SAVED_ADS', 'ANALYSES'] as const;
const day = 86_400_000;

async function fixture() {
  const organizationId = randomUUID(), userId = randomUUID();
  organizations.push(organizationId); users.push(userId);
  return db.$transaction(async tx => {
    await tx.user.create({ data: { id: userId, email: `billing-view-${userId}@example.test` } });
    await tx.organization.create({ data: { id: organizationId, slug: organizationId, name: 'Billing view regression' } });
    await tx.organizationMember.create({ data: { organizationId, userId, role: 'OWNER' } });
    const workspace = await tx.workspace.create({ data: { organizationId, slug: randomUUID(), name: 'Current workspace' } });
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    return { organizationId, userId, workspaceId: workspace.id, now: clock.now.getTime() };
  });
}

afterEach(() => vi.useRealTimers());
afterAll(async () => {
  if (url) await db.$transaction(async tx => {
    await tx.entitlement.deleteMany({ where: { organizationId: { in: organizations } } });
    await tx.workspace.deleteMany({ where: { organizationId: { in: organizations } } });
    await tx.organizationMember.deleteMany({ where: { organizationId: { in: organizations } } });
    await tx.organization.deleteMany({ where: { id: { in: organizations } } });
    await tx.user.deleteMany({ where: { id: { in: users } } });
  });
  await db.$disconnect();
});

describe.skipIf(!url)('customer billing uses current effective entitlements', () => {
  it('selects the latest effective period for all four quotas and preserves reserved use', async () => {
    const f = await fixture();
    for (const key of keys) await db.entitlement.createMany({ data: [
      { organizationId: f.organizationId, key, limit: 5, used: 1, periodStart: new Date(f.now - 3 * day), validFrom: new Date(f.now - 3 * day), validUntil: null },
      { organizationId: f.organizationId, key, limit: 12, used: 4, reserved: 3, periodStart: new Date(f.now - 2 * day), periodEnd: new Date(f.now + 2 * day), validFrom: new Date(f.now - day), validUntil: new Date(f.now + day) },
      { organizationId: f.organizationId, key, limit: 500, used: 99, periodStart: new Date(f.now - day), validFrom: new Date(f.now - day), validUntil: new Date(f.now - 1000) },
      { organizationId: f.organizationId, key, limit: 900, used: 100, periodStart: new Date(f.now + day), validFrom: new Date(f.now + day), validUntil: null },
    ] });
    const view = await billingView(db, f.organizationId);
    expect(view.entitlements).toHaveLength(4);
    for (const key of keys) expect(view.entitlements.find(row => row.key === key)).toMatchObject({ key, status: 'ACTIVE', used: 7, limit: 12, resetAt: new Date(f.now + day) });
  });

  it('distinguishes missing, future and expired quotas from a currently valid zero allowance', async () => {
    const f = await fixture();
    await db.entitlement.createMany({ data: [
      { organizationId: f.organizationId, key: 'WORKSPACES', limit: 1, used: 1, validFrom: new Date(f.now - day), validUntil: new Date(f.now - 1000) },
      { organizationId: f.organizationId, key: 'MEMBERS', limit: 500, validFrom: new Date(f.now + day), validUntil: null },
      { organizationId: f.organizationId, key: 'SAVED_ADS', limit: 0, used: 4, reserved: 2, validFrom: new Date(f.now - day), validUntil: null },
    ] });
    expect((await billingView(db, f.organizationId)).entitlements).toMatchObject([
      { key: 'WORKSPACES', status: 'UNAVAILABLE', used: null, limit: null, resetAt: null },
      { key: 'MEMBERS', status: 'UNAVAILABLE', used: null, limit: null, resetAt: null },
      { key: 'SAVED_ADS', status: 'ACTIVE', used: 6, limit: 0, resetAt: null },
      { key: 'ANALYSES', status: 'UNAVAILABLE', used: null, limit: null, resetAt: null },
    ]);
  });

  it.each([-10, 10])('uses database time when the application clock differs by %s days', async offset => {
    const f = await fixture();
    await db.entitlement.createMany({ data: [
      { organizationId: f.organizationId, key: 'ANALYSES', limit: 7, used: 2, reserved: 1, periodStart: new Date(f.now - day), validFrom: new Date(f.now - day), validUntil: new Date(f.now + day) },
      { organizationId: f.organizationId, key: 'ANALYSES', limit: 900, periodStart: new Date(f.now + 2 * day), validFrom: new Date(f.now + 2 * day), validUntil: null },
    ] });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(f.now + offset * day));
    expect((await billingView(db, f.organizationId)).entitlements.find(row => row.key === 'ANALYSES')).toMatchObject({ status: 'ACTIVE', limit: 7, used: 3 });
  });

  it('rereads expiry through app state without leaking a different organization allowance', async () => {
    const f = await fixture(), other = await fixture();
    const quota = await db.entitlement.create({ data: { organizationId: f.organizationId, key: 'ANALYSES', limit: 15, used: 2, reserved: 2, validFrom: new Date(f.now - day), validUntil: new Date(f.now + day) } });
    await db.entitlement.create({ data: { organizationId: other.organizationId, key: 'ANALYSES', limit: 987654, used: 765432, validFrom: new Date(f.now - day), validUntil: null } });
    expect((await loadAppState(db, f.userId, f.workspaceId)).billing?.entitlements.find(row => row.key === 'ANALYSES')).toMatchObject({ status: 'ACTIVE', used: 4, limit: 15 });
    await db.entitlement.update({ where: { id: quota.id }, data: { validUntil: new Date(f.now - 1) } });
    expect((await loadAppState(db, f.userId, f.workspaceId)).billing?.entitlements.find(row => row.key === 'ANALYSES')).toMatchObject({ status: 'UNAVAILABLE', used: null, limit: null });
    await expect(loadAppState(db, f.userId, other.workspaceId)).rejects.toMatchObject({ code: 'ORGANIZATION_FORBIDDEN' });
  });
});
