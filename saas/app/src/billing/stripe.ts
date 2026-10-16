import { createHash } from 'node:crypto';
import type { PlanVersion, Prisma, PrismaClient, Subscription } from '@prisma/client';
import type Stripe from 'stripe';
import { DomainError, requireOrgRole } from '../team/access';
import { lockOrganization } from './quotas';
import { availablePlanWhere, lockPlanCatalog } from './plan-management';

export interface StripeBillingConfig {
  publicAppUrl: string;
  webhookSecret: string;
  mode: 'test' | 'live';
  livePaymentsEnabled?: boolean;
  publicPricingEnabled?: boolean;
  refundPolicy: 'RETAIN_PAID_PERIOD' | 'REVOKE_FULL_CURRENT_PERIOD';
  onSubscriptionNotice?: (tx: Prisma.TransactionClient, notice: SubscriptionNotice) => Promise<void>;
}
export interface SubscriptionNotice {
  organizationId: string;
  subscriptionId: string;
  type: 'PAYMENT_ATTENTION'|'STATUS_CHANGED'|'CANCELLATION_SCHEDULED'|'CANCELLATION_REVOKED'|'PERIOD_UPDATED';
  status: string;
  periodEnd: Date|null;
  eventId: string;
}
type Actor = { userId: string; organizationId: string };
const handledEvents = new Set([
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required',
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'charge.refunded', 'refund.created', 'refund.updated', 'refund.failed',
]);
function id(value: string | { id?: string } | null | undefined) { return typeof value === 'string' ? value : value?.id; }
function invoiceSubscription(invoice: Stripe.Invoice) { return id(invoice.parent?.subscription_details?.subscription); }
function safeLink(value: string | null | undefined) {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null; } catch { return null; }
}

/** Stripe API is supplied explicitly so tests use the real SDK with a fake HTTP
 * transport. This factory does not start a listener or read desktop credentials. */
export function createStripeBilling(db: PrismaClient, stripe: Stripe, config: StripeBillingConfig) {
  if (config.mode === 'live' && !config.livePaymentsEnabled) throw new DomainError(503, 'LIVE_PAYMENTS_DISABLED');
  if (!['test', 'live'].includes(config.mode) || !['RETAIN_PAID_PERIOD', 'REVOKE_FULL_CURRENT_PERIOD'].includes(config.refundPolicy) || !config.webhookSecret) throw new DomainError(503, 'BILLING_NOT_CONFIGURED');
  let publicUrl: URL;
  try { publicUrl = new URL(config.publicAppUrl); } catch { throw new DomainError(503, 'INVALID_PUBLIC_URL'); }
  if (publicUrl.username || publicUrl.password || (publicUrl.protocol !== 'https:' && !(config.mode === 'test' && publicUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(publicUrl.hostname)))) throw new DomainError(503, 'INVALID_PUBLIC_URL');
  const successUrl = new URL('/app?billing=success', publicUrl).toString();
  const cancelUrl = new URL('/app?billing=canceled', publicUrl).toString();
  const modeCheck = (livemode: boolean) => { if (livemode !== (config.mode === 'live')) throw new DomainError(409, 'STRIPE_MODE_MISMATCH'); };
  const transaction = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => db.$transaction(fn, { maxWait: 10_000, timeout: 30_000 });

  async function owner(tx: Prisma.TransactionClient, actor: Actor) {
    await lockOrganization(tx, actor.organizationId);
    await requireOrgRole(tx, actor.userId, actor.organizationId, ['OWNER']);
    const local = await tx.subscription.findUnique({ where: { organizationId: actor.organizationId } });
    if (!local) throw new DomainError(409, 'SUBSCRIPTION_NOT_INITIALIZED');
    return local;
  }
  async function audit(tx: Prisma.TransactionClient, organizationId: string, action: string, targetId: string, actorUserId?: string, metadata: Prisma.InputJsonObject = {}) {
    await tx.auditEvent.create({ data: { organizationId, actorUserId, action, targetType: 'Subscription', targetId, metadata } });
  }
  async function configuredPlan(tx: Prisma.TransactionClient, planVersionId: string) {
    if(config.mode==='live'&&config.publicPricingEnabled!==true)throw new DomainError(503,'PUBLIC_PRICING_DISABLED');
    // Serialize withdrawal with an in-flight purchase. The plan cannot be
    // withdrawn between eligibility checking and creating the provider request.
    await lockPlanCatalog(tx);
    const plan = await tx.planVersion.findFirst({ where: { id: planVersionId,...availablePlanWhere(config) } });
    if (!plan || !plan.providerPriceId || !plan.currency || plan.priceMinor === null) throw new DomainError(409, config.mode==='live'?'PLAN_NOT_PUBLIC':'PLAN_NOT_PURCHASABLE');
    const price = await stripe.prices.retrieve(plan.providerPriceId);
    modeCheck(price.livemode);
    if (!price.active || price.currency !== plan.currency.toLowerCase() || price.unit_amount !== plan.priceMinor || price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1) throw new DomainError(409, 'PLAN_PRICE_MISMATCH');
    return plan;
  }
  async function verifiedCustomer(customerId: string, organizationId: string) {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted || customer.metadata.organizationId !== organizationId) throw new DomainError(409, 'BILLING_MAPPING_MISMATCH');
    modeCheck(customer.livemode);
    return customer;
  }
  async function authoritative(local: Subscription, subscriptionId: string) {
    // Fetch while holding the organization lock. Concurrent or out-of-order
    // callbacks cannot apply a snapshot fetched before another commit.
    const remote = await stripe.subscriptions.retrieve(subscriptionId);
    modeCheck(remote.livemode);
    if (remote.metadata.organizationId !== local.organizationId || !local.providerCustomerId || id(remote.customer) !== local.providerCustomerId || (local.providerSubscriptionId && local.providerSubscriptionId !== subscriptionId)) throw new DomainError(409, 'BILLING_MAPPING_MISMATCH');
    await verifiedCustomer(local.providerCustomerId, local.organizationId);
    if (remote.items.has_more || remote.items.data.length !== 1 || remote.items.data[0]!.quantity !== 1) throw new DomainError(409, 'UNSUPPORTED_SUBSCRIPTION_SHAPE');
    return remote;
  }
  async function invoiceFullyRefunded(invoice: Stripe.Invoice, customerId: string) {
    if (invoice.amount_paid <= 0) return false;
    const payments = await stripe.invoicePayments.list({ invoice: invoice.id, status: 'paid', limit: 100 });
    if (payments.has_more) throw new DomainError(409, 'BILLING_EVIDENCE_INCOMPLETE');
    let totalPaid = 0;
    let allRefunded = payments.data.length > 0;
    for (const payment of payments.data) {
      if (id(payment.invoice) !== invoice.id || payment.status !== 'paid') throw new DomainError(409, 'BILLING_MAPPING_MISMATCH');
      totalPaid += payment.amount_paid ?? 0;
      let charges: Stripe.Charge[] = [];
      if (payment.payment.type === 'charge' && id(payment.payment.charge)) charges = [await stripe.charges.retrieve(id(payment.payment.charge)!)];
      if (payment.payment.type === 'payment_intent' && id(payment.payment.payment_intent)) {
        const response = await stripe.charges.list({ payment_intent: id(payment.payment.payment_intent)!, limit: 100 });
        if (response.has_more) throw new DomainError(409, 'BILLING_EVIDENCE_INCOMPLETE');
        charges = response.data.filter((charge) => charge.status === 'succeeded' && charge.amount > 0);
      }
      for (const charge of charges) {
        modeCheck(charge.livemode);
        if (id(charge.customer) !== customerId) throw new DomainError(409, 'BILLING_MAPPING_MISMATCH');
      }
      allRefunded &&= charges.length > 0 && charges.every((charge) => charge.refunded && charge.amount_refunded >= charge.amount);
    }
    return allRefunded && totalPaid >= invoice.amount_paid;
  }
  async function paidEvidence(tx: Prisma.TransactionClient, local: Subscription, remote: Stripe.Subscription) {
    // A provider's next billing period is not proof of payment. A failed renewal
    // keeps the last paid invoice's period and never extends access.
    const paid = await stripe.invoices.list({ customer: local.providerCustomerId!, subscription: remote.id, status: 'paid', limit: 10 });
    for (const invoice of paid.data) {
      modeCheck(invoice.livemode);
      if (invoice.status !== 'paid' || invoice.amount_remaining !== 0 || invoiceSubscription(invoice) !== remote.id || id(invoice.customer) !== local.providerCustomerId) throw new DomainError(409, 'BILLING_MAPPING_MISMATCH');
      if (invoice.lines.has_more) throw new DomainError(409, 'BILLING_EVIDENCE_INCOMPLETE');
      const lines = invoice.lines.data.filter((line) => line.parent?.type === 'subscription_item_details' && !line.parent.subscription_item_details?.proration && line.parent.subscription_item_details?.subscription === remote.id && line.quantity === 1);
      if (!lines.length) continue;
      if (lines.length !== 1) throw new DomainError(409, 'UNSUPPORTED_SUBSCRIPTION_SHAPE');
      const line = lines[0]!;
      // An invoice may be prepaid. It cannot activate a future period or reset
      // this month's analysis allowance before that period actually begins.
      if (line.period.start * 1000 > Date.now()) continue;
      const priceId = line.pricing?.price_details?.price;
      const plans = priceId ? await tx.planVersion.findMany({ where: { providerPriceId: priceId }, take: 2 }) : [];
      if (plans.length !== 1) throw new DomainError(409, 'BILLING_PLAN_MAPPING_MISMATCH');
      const plan = plans[0]!;
      if (plan.currency?.toLowerCase() !== invoice.currency || line.period.end <= line.period.start) throw new DomainError(409, 'BILLING_EVIDENCE_INVALID');
      const fullyRefunded = await invoiceFullyRefunded(invoice, local.providerCustomerId!);
      return { invoice, plan, start: new Date(line.period.start * 1000), end: new Date(line.period.end * 1000), fullyRefunded };
    }
    return null;
  }
  async function applyEntitlements(tx: Prisma.TransactionClient, organizationId: string, plan: PlanVersion, periodStart: Date, periodEnd: Date, now: Date) {
    const counts = {
      WORKSPACES: await tx.workspace.count({ where: { organizationId, archivedAt: null } }),
      MEMBERS: await tx.organizationMember.count({ where: { organizationId } }),
      SAVED_ADS: await tx.savedAd.count({ where: { organizationId } }),
    };
    const limits = { WORKSPACES: plan.workspaceLimit, MEMBERS: plan.memberLimit, SAVED_ADS: plan.savedAdLimit, ANALYSES: plan.monthlyAnalysisLimit };
    for (const [key, limit] of Object.entries(limits)) {
      const current = await tx.entitlement.findUnique({ where: { organizationId_key_periodStart: { organizationId, key, periodStart } } });
      let used = key === 'ANALYSES' ? 0 : counts[key as keyof typeof counts];
      let reserved = 0;
      if (key === 'ANALYSES' && current) {
        const totals = await tx.usageLedger.groupBy({ by: ['status'], where: { organizationId, entitlementId: current.id }, _sum: { quantity: true } });
        used = totals.find((total) => total.status === 'SETTLED')?._sum.quantity ?? 0;
        reserved = totals.find((total) => total.status === 'RESERVED')?._sum.quantity ?? 0;
      }
      const row = await tx.entitlement.upsert({
        where: { organizationId_key_periodStart: { organizationId, key, periodStart } },
        create: { organizationId, key, limit, used, reserved, periodStart, periodEnd, validFrom: periodStart, validUntil: periodEnd, source: 'STRIPE' },
        update: { limit: current?.source === 'MANUAL' ? current.limit : limit, used, reserved, periodEnd, validUntil: periodEnd, source: current?.source === 'MANUAL' ? 'MANUAL' : 'STRIPE', version: { increment: 1 } },
      });
      await tx.entitlement.updateMany({ where: { organizationId, key, id: { not: row.id }, OR: [{ validUntil: null }, { validUntil: { gt: now } }] }, data: { validUntil: now, version: { increment: 1 } } });
    }
  }
  async function reconcileLocked(tx: Prisma.TransactionClient, local: Subscription, subscriptionId: string, eventCreated?: Date, eventId?: string) {
    const remote = await authoritative(local, subscriptionId);
    const evidence = await paidEvidence(tx, local, remote);
    const now = new Date();
    const revoked = !!evidence?.fullyRefunded && config.refundPolicy === 'REVOKE_FULL_CURRENT_PERIOD';
    const data: Prisma.SubscriptionUpdateInput = {
      provider: 'STRIPE', providerSubscriptionId: remote.id, status: revoked ? 'REFUNDED' : remote.status.toUpperCase(),
      cancelAtPeriodEnd: remote.cancel_at_period_end, canceledAt: remote.canceled_at ? new Date(remote.canceled_at * 1000) : null,
      lastReconciledAt: now, version: { increment: 1 },
    };
    if (eventCreated && (!local.lastProviderEventAt || local.lastProviderEventAt < eventCreated)) data.lastProviderEventAt = eventCreated;
    if (evidence) {
      const paidEnd = revoked ? new Date(Math.min(now.getTime(), evidence.end.getTime())) : evidence.end;
      data.currentPeriodStart = evidence.start;
      data.currentPeriodEnd = paidEnd;
      data.planVersion = { connect: { id: evidence.plan.id } };
      if (local.scheduledPlanVersionId === evidence.plan.id) data.scheduledPlanVersion = { disconnect: true };
      if (revoked) {
        await tx.entitlement.updateMany({ where: { organizationId: local.organizationId, OR: [{ validUntil: null }, { validUntil: { gt: paidEnd } }] }, data: { validUntil: paidEnd, version: { increment: 1 } } });
      } else await applyEntitlements(tx, local.organizationId, evidence.plan, evidence.start, evidence.end, now);
    }
    const updated = await tx.subscription.update({ where: { id: local.id }, data });
    await audit(tx, local.organizationId, 'SUBSCRIPTION_RECONCILED', local.id, undefined, { providerSubscriptionId: remote.id, status: updated.status, paidInvoiceId: evidence?.invoice.id ?? null, refundPolicy: config.refundPolicy });
    let noticeType:SubscriptionNotice['type']|null=null;
    if (updated.status!==local.status) noticeType=['PAST_DUE','UNPAID','INCOMPLETE'].includes(updated.status)?'PAYMENT_ATTENTION':'STATUS_CHANGED';
    else if (updated.cancelAtPeriodEnd!==local.cancelAtPeriodEnd) noticeType=updated.cancelAtPeriodEnd?'CANCELLATION_SCHEDULED':'CANCELLATION_REVOKED';
    else if (evidence&&!revoked&&(updated.currentPeriodStart?.getTime()!==local.currentPeriodStart?.getTime()||updated.currentPeriodEnd?.getTime()!==local.currentPeriodEnd?.getTime())) noticeType='PERIOD_UPDATED';
    if (noticeType&&config.onSubscriptionNotice) await config.onSubscriptionNotice(tx,{
      organizationId:local.organizationId,subscriptionId:local.id,type:noticeType,status:updated.status,
      // Never describe a trial/local period as paid invoice evidence.
      periodEnd:evidence?updated.currentPeriodEnd:null,eventId:eventId??`reconcile:${local.id}:${updated.version}`,
    });
    return updated;
  }
  async function subscriptionForEvent(event: Stripe.Event): Promise<string | undefined> {
    const object = event.data.object as { id: string };
    if (event.type.startsWith('customer.subscription.')) return object.id;
    if (event.type.startsWith('checkout.session.')) return id((await stripe.checkout.sessions.retrieve(object.id)).subscription);
    if (event.type.startsWith('invoice.')) return invoiceSubscription(await stripe.invoices.retrieve(object.id));
    let paymentIntentId: string | undefined;
    if (event.type === 'charge.refunded') paymentIntentId = id((await stripe.charges.retrieve(object.id)).payment_intent);
    else if (event.type.startsWith('refund.')) paymentIntentId = id((await stripe.refunds.retrieve(object.id)).payment_intent);
    if (!paymentIntentId) return undefined;
    const payments = await stripe.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: paymentIntentId }, limit: 100 });
    if (payments.has_more) throw new DomainError(409, 'BILLING_EVIDENCE_INCOMPLETE');
    const subscriptionIds = new Set<string>();
    for (const payment of payments.data) {
      const invoiceId = id(payment.invoice);
      if (!invoiceId) continue;
      const subscriptionId = invoiceSubscription(await stripe.invoices.retrieve(invoiceId));
      if (subscriptionId) subscriptionIds.add(subscriptionId);
    }
    if (subscriptionIds.size > 1) throw new DomainError(409, 'UNSUPPORTED_PAYMENT_ALLOCATION');
    return [...subscriptionIds][0];
  }
  return {
    async createCheckout(input: Actor & { planVersionId: string; idempotencyKey: string }) {
      if (!input.idempotencyKey || input.idempotencyKey.length > 160) throw new DomainError(400, 'INVALID_IDEMPOTENCY_KEY');
      return transaction(async (tx) => {
        const local = await owner(tx, input);
        const plan = await configuredPlan(tx, input.planVersionId);
        let customerId = local.providerCustomerId;
        if (!customerId) {
          const customer = await stripe.customers.create({ metadata: { organizationId: input.organizationId } }, { idempotencyKey: `org-customer:${input.organizationId}` });
          customerId = customer.id;
        }
        await verifiedCustomer(customerId, input.organizationId);
        const subscriptions = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
        const currentSubscriptions = subscriptions.data.filter((subscription) => !['canceled', 'incomplete_expired'].includes(subscription.status));
        if (subscriptions.has_more || currentSubscriptions.length > 1) throw new DomainError(409, 'SUBSCRIPTION_RECONCILIATION_REQUIRED');
        if (currentSubscriptions.length === 1) {
          const existing = currentSubscriptions[0]!;
          if (existing.metadata.organizationId !== input.organizationId || id(existing.customer) !== customerId) throw new DomainError(409, 'BILLING_MAPPING_MISMATCH');
          // A completed checkout can outlive a rolled-back local commit. Recover
          // its verified mapping instead of charging for a second subscription.
          const mapped = await tx.subscription.update({ where: { id: local.id }, data: { provider: 'STRIPE', providerCustomerId: customerId, providerSubscriptionId: existing.id } });
          await reconcileLocked(tx, mapped, existing.id);
          await audit(tx, input.organizationId, 'CHECKOUT_EXISTING_SUBSCRIPTION_RECOVERED', local.id, input.userId, { providerSubscriptionId: existing.id });
          return { id: existing.id, url: new URL('/app?billing=existing', publicUrl).toString() };
        }
        // Persist a recovered customer even if an idempotent retry finds an
        // already-open checkout created before a lost database commit.
        await tx.subscription.update({ where: { id: local.id }, data: { provider: 'STRIPE', providerCustomerId: customerId, providerSubscriptionId: null } });
        const sessions = await stripe.checkout.sessions.list({ customer: customerId, status: 'open', limit: 100 });
        if (sessions.has_more) throw new DomainError(409, 'CHECKOUT_RECONCILIATION_REQUIRED');
        for (const session of sessions.data) {
          if (session.metadata?.organizationId !== input.organizationId) throw new DomainError(409, 'BILLING_MAPPING_MISMATCH');
          if (session.metadata.planVersionId === plan.id && session.url) {
            await audit(tx, input.organizationId, 'CHECKOUT_REUSED', local.id, input.userId, { checkoutSessionId: session.id, planVersionId: plan.id });
            return { id: session.id, url: session.url };
          }
          await stripe.checkout.sessions.expire(session.id);
        }
        const session = await stripe.checkout.sessions.create({
          mode: 'subscription', customer: customerId, payment_method_types: ['card'], line_items: [{ price: plan.providerPriceId!, quantity: 1 }],
          success_url: successUrl, cancel_url: cancelUrl,
          metadata: { organizationId: input.organizationId, planVersionId: plan.id },
          subscription_data: { metadata: { organizationId: input.organizationId, planVersionId: plan.id } },
        }, { idempotencyKey: `checkout:${input.organizationId}:${input.idempotencyKey}` });
        if (!session.url) throw new DomainError(502, 'CHECKOUT_URL_MISSING');
        await audit(tx, input.organizationId, 'CHECKOUT_CREATED', local.id, input.userId, { checkoutSessionId: session.id, planVersionId: plan.id });
        return { id: session.id, url: session.url };
      });
    },
    async cancelAtPeriodEnd(input: Actor) {
      return transaction(async (tx) => {
        const local = await owner(tx, input);
        if (!local.providerSubscriptionId) throw new DomainError(409, 'PAID_SUBSCRIPTION_REQUIRED');
        const remote = await authoritative(local, local.providerSubscriptionId);
        if (id(remote.schedule)) {
          const schedule = await stripe.subscriptionSchedules.retrieve(id(remote.schedule)!);
          if (schedule.metadata?.organizationId !== input.organizationId || schedule.metadata?.managedBy !== 'ad-research-saas') throw new DomainError(409, 'EXTERNAL_SCHEDULE_UNSUPPORTED');
          await stripe.subscriptionSchedules.release(schedule.id, { preserve_cancel_date: false });
        }
        await stripe.subscriptions.update(remote.id, { cancel_at_period_end: true, proration_behavior: 'none' }, { idempotencyKey: `cancel:${local.id}:${local.version}` });
        const updated = await reconcileLocked(tx, local, remote.id);
        await tx.subscription.update({ where: { id: local.id }, data: { scheduledPlanVersionId: null } });
        await audit(tx, input.organizationId, 'SUBSCRIPTION_CANCELLATION_SCHEDULED', local.id, input.userId);
        return { ...updated, scheduledPlanVersionId: null };
      });
    },
    async changePlanNextPeriod(input: Actor & { planVersionId: string }) {
      return transaction(async (tx) => {
        const local = await owner(tx, input);
        if (!local.providerSubscriptionId) throw new DomainError(409, 'PAID_SUBSCRIPTION_REQUIRED');
        const plan = await configuredPlan(tx, input.planVersionId);
        const remote = await authoritative(local, local.providerSubscriptionId);
        const item = remote.items.data[0]!;
        if (remote.status !== 'active' || remote.cancel_at_period_end || item.current_period_end * 1000 <= Date.now()) throw new DomainError(409, 'SUBSCRIPTION_CHANGE_UNAVAILABLE');
        if (item.price.currency !== plan.currency?.toLowerCase() || item.price.recurring?.interval !== 'month' || item.price.recurring.interval_count !== 1) throw new DomainError(409, 'PLAN_PRICE_MISMATCH');
        let schedule: Stripe.SubscriptionSchedule;
        if (id(remote.schedule)) schedule = await stripe.subscriptionSchedules.retrieve(id(remote.schedule)!);
        else schedule = await stripe.subscriptionSchedules.create({ from_subscription: remote.id, metadata: { organizationId: input.organizationId, managedBy: 'ad-research-saas' } }, { idempotencyKey: `schedule:${remote.id}` });
        if (schedule.metadata?.organizationId !== input.organizationId || schedule.metadata?.managedBy !== 'ad-research-saas') throw new DomainError(409, 'EXTERNAL_SCHEDULE_UNSUPPORTED');
        await stripe.subscriptionSchedules.update(schedule.id, {
          end_behavior: 'release', proration_behavior: 'none',
          phases: [
            { start_date: item.current_period_start, end_date: item.current_period_end, items: [{ price: item.price.id, quantity: 1 }], proration_behavior: 'none', metadata: { organizationId: input.organizationId } },
            { start_date: item.current_period_end, iterations: 1, items: [{ price: plan.providerPriceId!, quantity: 1 }], proration_behavior: 'none', metadata: { organizationId: input.organizationId, planVersionId: plan.id } },
          ],
        }, { idempotencyKey: `schedule-plan:${local.id}:${plan.id}:${local.version}` });
        const updated = await tx.subscription.update({ where: { id: local.id }, data: { scheduledPlanVersionId: plan.id, version: { increment: 1 } } });
        await audit(tx, input.organizationId, 'SUBSCRIPTION_PLAN_CHANGE_SCHEDULED', local.id, input.userId, { planVersionId: plan.id, effectiveAt: new Date(item.current_period_end * 1000).toISOString() });
        return updated;
      });
    },
    async listInvoices(input: Actor) {
      await requireOrgRole(db, input.userId, input.organizationId, ['OWNER']);
      const local = await db.subscription.findUnique({ where: { organizationId: input.organizationId } });
      if (!local?.providerCustomerId || !local.providerSubscriptionId) return [];
      await verifiedCustomer(local.providerCustomerId, input.organizationId);
      const invoices = await stripe.invoices.list({ customer: local.providerCustomerId, subscription: local.providerSubscriptionId, limit: 100 });
      return invoices.data.map((invoice) => {
        if (id(invoice.customer) !== local.providerCustomerId || invoiceSubscription(invoice) !== local.providerSubscriptionId) throw new DomainError(409, 'BILLING_MAPPING_MISMATCH');
        return { id: invoice.id, status: invoice.status, currency: invoice.currency, amountPaid: invoice.amount_paid, createdAt: new Date(invoice.created * 1000), invoiceUrl: safeLink(invoice.hosted_invoice_url), pdfUrl: safeLink(invoice.invoice_pdf) };
      });
    },
    async handleWebhook(rawBody: Buffer, signature: string) {
      let event: Stripe.Event;
      try { event = stripe.webhooks.constructEvent(rawBody, signature, config.webhookSecret); } catch { throw new DomainError(400, 'INVALID_WEBHOOK_SIGNATURE'); }
      modeCheck(event.livemode);
      if (!handledEvents.has(event.type)) return { ignored: true };
      const delivered = await db.billingEvent.findUnique({ where: { provider_providerEventId: { provider: 'STRIPE', providerEventId: event.id } } });
      if (delivered?.processedAt) return { duplicate: true };
      const subscriptionId = await subscriptionForEvent(event);
      if (!subscriptionId) return { ignored: true };
      // This first read routes the event only. It is never used to apply rights.
      const routing = await stripe.subscriptions.retrieve(subscriptionId);
      const organizationId = routing.metadata.organizationId;
      if (!organizationId) throw new DomainError(409, 'BILLING_MAPPING_MISMATCH');
      return transaction(async (tx) => {
        await lockOrganization(tx, organizationId);
        const prior = await tx.billingEvent.findUnique({ where: { provider_providerEventId: { provider: 'STRIPE', providerEventId: event.id } } });
        if (prior) return { duplicate: true };
        const local = await tx.subscription.findUnique({ where: { organizationId } });
        if (!local || !local.providerCustomerId || id(routing.customer) !== local.providerCustomerId) throw new DomainError(409, 'BILLING_MAPPING_MISMATCH');
        // Events from a previous subscription must reconcile the currently
        // mapped subscription, never replace it with old event contents.
        const currentId = local.providerSubscriptionId ?? subscriptionId;
        const subscription = await reconcileLocked(tx, local, currentId, new Date(event.created * 1000), event.id);
        await tx.billingEvent.create({ data: { organizationId, subscriptionId: local.id, provider: 'STRIPE', providerEventId: event.id, eventType: event.type, providerOccurredAt: new Date(event.created * 1000), verifiedAt: new Date(), processedAt: new Date(), status: 'PROCESSED', payloadSha256: createHash('sha256').update(rawBody).digest('hex'), metadata: { providerSubscriptionId: subscriptionId, appliedSubscriptionId: currentId } } });
        return { processed: true, subscriptionId: subscription.id };
      });
    },
    /** System/worker entry: callers must not expose this as an unauthenticated
     * customer mutation. Authorization is provided by the scheduler/admin API. */
    async reconcileSubscription(input: { organizationId: string }) {
      return transaction(async (tx) => {
        await lockOrganization(tx, input.organizationId);
        const local = await tx.subscription.findUnique({ where: { organizationId: input.organizationId } });
        if (!local?.providerSubscriptionId) throw new DomainError(409, 'PAID_SUBSCRIPTION_REQUIRED');
        return reconcileLocked(tx, local, local.providerSubscriptionId);
      });
    },
  };
}
