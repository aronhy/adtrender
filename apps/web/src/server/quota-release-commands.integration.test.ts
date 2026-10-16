import { createHmac, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { appCommand } from './operations';
import type { AppCommand } from '../client/types';
import { createTeamService } from '../team/service';
import { admitQuota, initializeTrial, releaseQuota } from '../billing/quotas';
import { createStripeBilling } from '../billing/stripe';
import { saveAd } from '../research/service';

const injected = vi.hoisted(() => ({ db: null as any }));
vi.mock('wasp/server', async () => {
  const { PrismaClient } = await import('@prisma/client');
  injected.db = new PrismaClient({ datasources: { db: { url: process.env.SAAS_TEST_DATABASE_URL ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
  return { prisma: injected.db, HttpError: class extends Error { constructor(public statusCode: number, message: string) { super(message); } } };
});

const url = process.env.SAAS_TEST_DATABASE_URL;
const db: PrismaClient = injected.db;
const organizations: string[] = [], users: string[] = [], sources: string[] = [], plans: string[] = [];
const day = 86_400_000;
const keys = ['SAVED_ADS', 'MEMBERS', 'WORKSPACES'] as const;
type CountKey = (typeof keys)[number];
const team = createTeamService(db, { initializeOrganization: (tx, id) => initializeTrial(tx, id, { days: 14, workspaces: 5, members: 5, savedAds: 5, analyses: 5 }), admitQuota, releaseQuota });

async function fixture() {
  const owner = await db.user.create({ data: { email: `release-owner-${randomUUID()}@example.test` } }); users.push(owner.id);
  const created = await team.createOrganization({ userId: owner.id, name: 'Quota release regression' }); organizations.push(created.organization.id);
  const trial = await db.entitlement.findMany({ where: { organizationId: created.organization.id } });
  const [clock] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  return { ...created, owner, trial, now: clock.now.getTime() };
}

async function reconcilePaid(f: Awaited<ReturnType<typeof fixture>>) {
  const suffix = randomUUID(), customerId = `cus_${suffix}`, subscriptionId = `sub_${suffix}`, invoiceId = `in_${suffix}`, chargeId = `ch_${suffix}`;
  const plan = await db.planVersion.create({ data: { key: suffix, version: 1, name: 'Explicit fake paid plan', providerPriceId: `price_${suffix}`, currency: 'usd', priceMinor: 1000, workspaceLimit: 5, memberLimit: 5, savedAdLimit: 5, monthlyAnalysisLimit: 5 } }); plans.push(plan.id);
  // Real invoice periods can begin before a trial was created (or at the
  // preceding whole second); no future entitlement is inserted by this fixture.
  const start = Math.floor(f.now / 1000) - 60, end = start + 30 * 86400;
  const list = (data: unknown[]) => ({ object: 'list', has_more: false, data });
  const sdk = new Stripe('sk_test_explicit_fake_transport', { maxNetworkRetries: 0, httpClient: Stripe.createFetchHttpClient(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if ((init?.method ?? 'GET') !== 'GET') throw new Error('UNEXPECTED_PROVIDER_MUTATION');
    let result: unknown;
    if (path === `/v1/subscriptions/${subscriptionId}`) result = { id: subscriptionId, object: 'subscription', livemode: false, customer: customerId, metadata: { organizationId: f.organization.id }, status: 'active', cancel_at_period_end: false, canceled_at: null, items: list([{ id: `si_${suffix}`, quantity: 1, price: { id: plan.providerPriceId }, current_period_start: start, current_period_end: end }]) };
    else if (path === `/v1/customers/${customerId}`) result = { id: customerId, object: 'customer', livemode: false, metadata: { organizationId: f.organization.id } };
    else if (path === '/v1/invoices') result = list([{ id: invoiceId, object: 'invoice', livemode: false, customer: customerId, status: 'paid', amount_paid: 1000, amount_remaining: 0, currency: 'usd', parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId } }, lines: list([{ quantity: 1, period: { start, end }, pricing: { price_details: { price: plan.providerPriceId } }, parent: { type: 'subscription_item_details', subscription_item_details: { subscription: subscriptionId, proration: false } } }]) }]);
    else if (path === '/v1/invoice_payments') result = list([{ id: `inpay_${suffix}`, invoice: invoiceId, status: 'paid', amount_paid: 1000, payment: { type: 'charge', charge: chargeId } }]);
    else if (path === `/v1/charges/${chargeId}`) result = { id: chargeId, livemode: false, customer: customerId, status: 'succeeded', amount: 1000, amount_refunded: 0, refunded: false };
    else throw new Error(`UNEXPECTED_FAKE_PROVIDER_PATH:${path}`);
    return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
  }) });
  await db.subscription.update({ where: { organizationId: f.organization.id }, data: { provider: 'STRIPE', providerCustomerId: customerId, providerSubscriptionId: subscriptionId } });
  const billing = createStripeBilling(db, sdk, { mode: 'test', publicAppUrl: 'https://app.example.test', webhookSecret: 'whsec_fake_only', refundPolicy: 'RETAIN_PAID_PERIOD' });
  await billing.reconcileSubscription({ organizationId: f.organization.id });
  const current = await db.entitlement.findMany({ where: { organizationId: f.organization.id, source: 'STRIPE' } });
  expect(current).toHaveLength(4);
  for (const row of current) expect(row.periodStart.getTime()).toBeLessThan(f.trial.find(old => old.key === row.key)!.periodStart.getTime());
  return current;
}

async function removal(f: Awaited<ReturnType<typeof fixture>>, key: CountKey) {
  let command: AppCommand;
  let remaining: () => Promise<number>;
  if (key === 'SAVED_ADS') {
    const source = await db.dataSource.create({ data: { key: randomUUID(), name: 'Release regression only', adapterVersion: 'fixture' } }); sources.push(source.id);
    const ad = await db.ad.create({ data: { dataSourceId: source.id, sourceAdId: randomUUID(), sourceUrl: 'https://example.test/ad' } });
    const saved = await saveAd(db, { userId: f.owner.id, workspaceId: f.workspace.id, adId: ad.id });
    command = { type: 'REMOVE_SAVED_AD', workspaceId: f.workspace.id, savedAdId: saved.id };
    remaining = () => db.savedAd.count({ where: { organizationId: f.organization.id } });
  } else if (key === 'MEMBERS') {
    const user = await db.user.create({ data: { email: `release-member-${randomUUID()}@example.test` } }); users.push(user.id);
    const member = await db.$transaction(async tx => {
      await admitQuota(tx, f.organization.id, 'MEMBERS', 1);
      return tx.organizationMember.create({ data: { organizationId: f.organization.id, userId: user.id, role: 'MEMBER' } });
    });
    command = { type: 'REMOVE_MEMBER', workspaceId: f.workspace.id, memberId: member.id };
    remaining = () => db.organizationMember.count({ where: { organizationId: f.organization.id } });
  } else {
    command = { type: 'ARCHIVE_WORKSPACE', organizationId: f.organization.id, workspaceId: f.workspace.id };
    remaining = () => db.workspace.count({ where: { organizationId: f.organization.id, archivedAt: null } });
  }
  return { run: () => appCommand(command, { user: { id: f.owner.id } }), remaining };
}

afterAll(async () => {
  if (url) await db.$transaction(async tx => {
    const scope = { organizationId: { in: organizations } };
    await tx.auditEvent.deleteMany({ where: scope });
    await tx.savedAd.deleteMany({ where: scope });
    await tx.workspaceMember.deleteMany({ where: scope });
    await tx.workspace.deleteMany({ where: scope });
    await tx.entitlement.deleteMany({ where: scope });
    await tx.subscription.deleteMany({ where: scope });
    await tx.organizationMember.deleteMany({ where: scope });
    await tx.organization.deleteMany({ where: { id: { in: organizations } } });
    await tx.ad.deleteMany({ where: { dataSourceId: { in: sources } } });
    await tx.dataSource.deleteMany({ where: { id: { in: sources } } });
    await tx.planVersion.deleteMany({ where: { id: { in: plans } } });
    const secret = process.env.RATE_LIMIT_HMAC_SECRET ?? process.env.JWT_SECRET ?? 'local-development-only';
    await tx.rateLimitBucket.deleteMany({ where: { scope: 'ACTION', principalHash: { in: users.map(id => createHmac('sha256', secret).update(id).digest('hex')) } } });
    await tx.user.deleteMany({ where: { id: { in: users } } });
  });
  await db.$disconnect();
});

describe.skipIf(!url)('actual removal commands release the correct quota period', () => {
  it.each(keys)('releases current paid %s after real reconciliation even when the expired trial has a later periodStart', async key => {
    const f = await fixture(); const paid = await reconcilePaid(f);
    const operation = await removal(f, key), remaining = (await operation.remaining()) - 1;
    const trialBefore = await db.entitlement.findUniqueOrThrow({ where: { id: f.trial.find(row => row.key === key)!.id } });
    expect(trialBefore.validUntil!.getTime()).toBeLessThanOrEqual(Date.now());
    await expect(operation.run()).resolves.toBeDefined();
    expect(await operation.remaining()).toBe(remaining);
    const currentAfter = await db.entitlement.findUniqueOrThrow({ where: { id: paid.find(row => row.key === key)!.id } });
    const trialAfter = await db.entitlement.findUniqueOrThrow({ where: { id: trialBefore.id } });
    expect({ paidUsed: currentAfter.used, trialUsed: trialAfter.used }).toEqual({ paidUsed: remaining, trialUsed: trialBefore.used });
  });

  it.each([0, 3])('removes a saved ad without deducting a not-yet-effective allowance with used=%s', async futureUsed => {
    const f = await fixture(); const operation = await removal(f, 'SAVED_ADS');
    const future = await db.entitlement.create({ data: { organizationId: f.organization.id, key: 'SAVED_ADS', limit: 5, used: futureUsed, periodStart: new Date(f.now + day), validFrom: new Date(f.now + day), validUntil: new Date(f.now + 2 * day) } });
    await expect(operation.run()).resolves.toBeDefined();
    expect(await operation.remaining()).toBe(0);
    const currentAfter = await db.entitlement.findUniqueOrThrow({ where: { id: f.trial.find(row => row.key === 'SAVED_ADS')!.id } });
    const futureAfter = await db.entitlement.findUniqueOrThrow({ where: { id: future.id } });
    expect({ currentUsed: currentAfter.used, futureUsed: futureAfter.used }).toEqual({ currentUsed: 0, futureUsed });
  });

  it.each(keys)('still removes existing %s after every period expires, using the most recently ended period', async key => {
    const f = await fixture(); const paid = await reconcilePaid(f);
    const operation = await removal(f, key), remaining = (await operation.remaining()) - 1;
    // The paid period ended most recently, despite starting before the trial.
    await db.entitlement.updateMany({ where: { organizationId: f.organization.id, source: 'PLAN' }, data: { validUntil: new Date(f.now - 2000) } });
    await db.entitlement.updateMany({ where: { organizationId: f.organization.id, source: 'STRIPE' }, data: { validUntil: new Date(f.now - 1000) } });
    const trialBefore = await db.entitlement.findUniqueOrThrow({ where: { id: f.trial.find(row => row.key === key)!.id } });
    await expect(operation.run()).resolves.toBeDefined();
    expect(await operation.remaining()).toBe(remaining);
    const currentAfter = await db.entitlement.findUniqueOrThrow({ where: { id: paid.find(row => row.key === key)!.id } });
    const trialAfter = await db.entitlement.findUniqueOrThrow({ where: { id: trialBefore.id } });
    expect({ paidUsed: currentAfter.used, trialUsed: trialAfter.used }).toEqual({ paidUsed: remaining, trialUsed: trialBefore.used });
  });
});
