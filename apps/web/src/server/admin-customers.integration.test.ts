import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { listAdminPage } from './admin-pagination';

const url = process.env.SAAS_TEST_DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
const admin = randomUUID(), otherAdmin = randomUUID(), owner = randomUUID(), otherOwner = randomUUID();
const organizations: string[] = [], plans: string[] = [];
const secret = `provider-private-${randomUUID()}`;
const keys = ['WORKSPACES', 'MEMBERS', 'SAVED_ADS', 'ANALYSES'] as const;
const day = 86_400_000;

async function organization(userId = owner) {
  const id = randomUUID(); organizations.push(id);
  return db.$transaction(async tx => {
    const row = await tx.organization.create({ data: { id, slug: id, name: `Customer ${id}` } });
    await tx.organizationMember.create({ data: { organizationId: id, userId, role: 'OWNER' } });
    return row;
  });
}
async function subscription(organizationId: string, status: string, cancelAtPeriodEnd = false) {
  const id = randomUUID(); plans.push(id);
  const plan = await db.planVersion.create({ data: { id, key: id, version: 1, name: `Plan ${status}`, providerPriceId: secret } });
  const now = Date.now();
  return db.subscription.create({ data: { organizationId, planVersionId: plan.id, status, provider: 'STRIPE', providerCustomerId: secret, providerSubscriptionId: `${secret}-${organizationId}`, currentPeriodStart: new Date(now - day), currentPeriodEnd: new Date(now + day), trialEndsAt: status === 'TRIALING' ? new Date(now + day / 2) : null, cancelAtPeriodEnd } });
}
async function customer(id: string, cursor?: string) {
  const page = await listAdminPage(db, { userId: admin, kind: 'customers', limit: 100, cursor });
  const row = page.customers.find(item => item.id === id);
  expect(row).toBeDefined();
  return row!;
}

afterEach(() => { vi.useRealTimers(); });
afterAll(async () => {
  if (url) await db.$transaction(async tx => {
    await tx.entitlement.deleteMany({ where: { organizationId: { in: organizations } } });
    await tx.subscription.deleteMany({ where: { organizationId: { in: organizations } } });
    await tx.organizationMember.deleteMany({ where: { organizationId: { in: organizations } } });
    await tx.organization.deleteMany({ where: { id: { in: organizations } } });
    await tx.planVersion.deleteMany({ where: { id: { in: plans } } });
    await tx.user.deleteMany({ where: { id: { in: [admin, otherAdmin, owner, otherOwner] } } });
  });
  await db.$disconnect();
});

describe.skipIf(!url)('customer operations show actual subscriptions and effective quotas', () => {
  beforeAll(async () => {
    await db.user.createMany({ data: [admin, otherAdmin, owner, otherOwner].map(id => ({ id, email: `customer-review-${id}@example.test`, isAdmin: id === admin || id === otherAdmin })) });
  });

  it.each(['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED'])('keeps organization status separate from %s subscription and exposes no provider identifiers', async status => {
    const org = await organization();
    const stored = await subscription(org.id, status, status === 'ACTIVE');
    const row = await customer(org.id);
    expect(row).toMatchObject({ status: 'ACTIVE', planName: `Plan ${status}`, subscription: {
      status, currentPeriodStart: stored.currentPeriodStart, currentPeriodEnd: stored.currentPeriodEnd,
      trialEndsAt: stored.trialEndsAt, cancelAtPeriodEnd: status === 'ACTIVE',
    } });
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(JSON.stringify(row)).not.toContain('provider');
  });

  it('uses all four actual effective ledger rows, including manual limits and reservations, rather than newer future or expired rows', async () => {
    const org = await organization();
    await subscription(org.id, 'CANCELED'); // Paid-period access is determined by entitlement validity, not subscription status.
    const now = Date.now();
    for (const [index, key] of keys.entries()) {
      await db.entitlement.createMany({ data: [
        { organizationId: org.id, key, limit: 999, periodStart: new Date(now - 3 * day), validFrom: new Date(now - 3 * day), validUntil: null },
        { organizationId: org.id, key, limit: 10 + index, used: 2 + index, reserved: index, source: index === 3 ? 'MANUAL' : 'PLAN', periodStart: new Date(now - 2 * day), periodEnd: new Date(now + day), validFrom: new Date(now - day), validUntil: new Date(now + day) },
        { organizationId: org.id, key, limit: 777, periodStart: new Date(now - day), validFrom: new Date(now - day), validUntil: new Date(now - 1000) },
        { organizationId: org.id, key, limit: 888, periodStart: new Date(now + 2 * day), validFrom: new Date(now + 2 * day), validUntil: new Date(now + 3 * day) },
      ] });
    }
    const row = await customer(org.id);
    expect(row).toMatchObject({ entitlements: [
      { key: 'WORKSPACES', current: { limit: 10, used: 2, reserved: 0, source: 'PLAN' } },
      { key: 'MEMBERS', current: { limit: 11, used: 3, reserved: 1, source: 'PLAN' } },
      { key: 'SAVED_ADS', current: { limit: 12, used: 4, reserved: 2, source: 'PLAN' } },
      { key: 'ANALYSES', current: { limit: 13, used: 5, reserved: 3, source: 'MANUAL', periodStart: new Date(now - 2 * day), periodEnd: new Date(now + day), validFrom: new Date(now - day), validUntil: new Date(now + day) } },
    ] });
  });

  it('reports absent subscription and missing or expired quotas explicitly without inventing zero use or a plan allowance', async () => {
    const org = await organization();
    const now = Date.now();
    await db.entitlement.createMany({ data: [
      { organizationId: org.id, key: 'WORKSPACES', limit: 1, used: 1, validFrom: new Date(now - day), validUntil: new Date(now - 1000) },
      { organizationId: org.id, key: 'MEMBERS', limit: 5, validFrom: new Date(now + day), validUntil: null },
      { organizationId: org.id, key: 'SAVED_ADS', limit: 0, used: 4, reserved: 0, validFrom: new Date(now - day), validUntil: null },
    ] });
    expect(await customer(org.id)).toMatchObject({ subscription: null, entitlements: [
      { key: 'WORKSPACES', current: null }, { key: 'MEMBERS', current: null },
      { key: 'SAVED_ADS', current: { limit: 0, used: 4, reserved: 0, validUntil: null } },
      { key: 'ANALYSES', current: null },
    ] });
  });

  it('identifies a paid Stripe entitlement without losing its actual use and reservation counts', async () => {
    const org = await organization(), now = Date.now();
    await subscription(org.id, 'ACTIVE');
    await db.entitlement.create({ data: { organizationId: org.id, key: 'ANALYSES', source: 'STRIPE', limit: 30, used: 6, reserved: 2, validFrom: new Date(now - day), validUntil: new Date(now + day) } });
    expect(await customer(org.id)).toMatchObject({ entitlements: expect.arrayContaining([{ key: 'ANALYSES', current: expect.objectContaining({ source: 'STRIPE', limit: 30, used: 6, reserved: 2 }) }]) });
  });

  it('uses database time for effective access even when the application clock is ahead', async () => {
    const org = await organization(); const now = Date.now();
    await db.entitlement.createMany({ data: [
      { organizationId: org.id, key: 'ANALYSES', limit: 7, used: 2, periodStart: new Date(now - day), validFrom: new Date(now - day), validUntil: new Date(now + day) },
      { organizationId: org.id, key: 'ANALYSES', limit: 900, periodStart: new Date(now + 2 * day), validFrom: new Date(now + 2 * day), validUntil: null },
    ] });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now + 3 * day));
    expect(await customer(org.id)).toMatchObject({ entitlements: expect.arrayContaining([{ key: 'ANALYSES', current: expect.objectContaining({ limit: 7, used: 2 }) }]) });
  });

  it('reads changed limits and expiry again when refreshing the same customer page', async () => {
    const org = await organization(); const now = Date.now();
    const quota = await db.entitlement.create({ data: { organizationId: org.id, key: 'ANALYSES', limit: 5, used: 2, reserved: 1, validFrom: new Date(now - day), validUntil: new Date(now + day) } });
    expect(await customer(org.id)).toMatchObject({ entitlements: expect.arrayContaining([{ key: 'ANALYSES', current: expect.objectContaining({ limit: 5, used: 2, reserved: 1 }) }]) });
    await db.entitlement.update({ where: { id: quota.id }, data: { limit: 12, source: 'MANUAL' } });
    expect(await customer(org.id)).toMatchObject({ entitlements: expect.arrayContaining([{ key: 'ANALYSES', current: expect.objectContaining({ limit: 12, source: 'MANUAL' }) }]) });
    await db.entitlement.update({ where: { id: quota.id }, data: { validUntil: new Date(now - 1) } });
    expect(await customer(org.id)).toMatchObject({ entitlements: expect.arrayContaining([{ key: 'ANALYSES', current: null }]) });
  });

  it('denies either customer owner and rechecks platform role and account status for customer pagination', async () => {
    await organization(otherOwner);
    for (const userId of [owner, otherOwner]) await expect(listAdminPage(db, { userId, kind: 'customers' })).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
    const page = await listAdminPage(db, { userId: otherAdmin, kind: 'customers', limit: 1 });
    expect(page.nextCursor).not.toBeNull();
    await expect(listAdminPage(db, { userId: admin, kind: 'customers', cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'INVALID_ADMIN_CURSOR' });
    await db.user.update({ where: { id: otherAdmin }, data: { isAdmin: false } });
    await expect(listAdminPage(db, { userId: otherAdmin, kind: 'customers', cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
    await db.user.update({ where: { id: otherAdmin }, data: { isAdmin: true, disabledAt: new Date() } });
    await expect(listAdminPage(db, { userId: otherAdmin, kind: 'customers' })).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    await db.user.update({ where: { id: otherAdmin }, data: { disabledAt: null } });
  });
});
