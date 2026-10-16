import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createTeamService } from '../team/service';
import { admitQuota, initializeTrial, reserveAnalysis } from './quotas';
import { createStripeBilling, type StripeBillingConfig } from './stripe';
import { subscriptionNoticeEmail } from './configured';
import { decryptMessage } from '../server/email';
import { createPlanManagement } from './plan-management';

const testUrl = process.env.SAAS_TEST_DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url: testUrl ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
const testOrganizations=new Set<string>();
afterEach(async()=>{
  if(testOrganizations.size)await db.emailDelivery.deleteMany({where:{organizationId:{in:[...testOrganizations]}}});
  testOrganizations.clear();
});
afterAll(() => db.$disconnect());
const secret = 'whsec_test_transport_fixture';
const configuration: StripeBillingConfig = { publicAppUrl: 'https://app.example.test', webhookSecret: secret, mode: 'test', refundPolicy: 'REVOKE_FULL_CURRENT_PERIOD' };

async function fixture(mode: 'test'|'live' = 'test') {
  const suffix = randomUUID();
  const owner = await db.user.create({ data: { email: `${suffix}@example.test` } });
  const team = createTeamService(db, { initializeOrganization: initializeTrial, admitQuota });
  const { organization, workspace } = await team.createOrganization({ userId: owner.id, name: '计费测试' });
  testOrganizations.add(organization.id);
  const plan = await db.planVersion.create({ data: { key: `paid-${suffix}`, version: 1, name: '团队版', status: 'ACTIVE', currency: 'usd', priceMinor: 1000, providerPriceId: `price_${suffix}`, workspaceLimit: 5, memberLimit: 10, savedAdLimit: 1000, monthlyAnalysisLimit: 50 } });
  const nextPlan = await db.planVersion.create({ data: { key: `next-${suffix}`, version: 1, name: '基础版', status: 'ACTIVE', currency: 'usd', priceMinor: 500, providerPriceId: `price_next_${suffix}`, workspaceLimit: 1, memberLimit: 2, savedAdLimit: 50, monthlyAnalysisLimit: 10 } });
  const customerId = `cus_${suffix}`, subscriptionId = `sub_${suffix}`, itemId = `si_${suffix}`, paymentIntentId = `pi_${suffix}`, chargeId = `ch_${suffix}`;
  const start = Math.floor(Date.now() / 1000) - 3600, end = start + 30 * 86400;
  const state: any = {
    customer: { id: customerId, object: 'customer', livemode: mode === 'live', metadata: { organizationId: organization.id } },
    subscription: { id: subscriptionId, object: 'subscription', livemode: mode === 'live', customer: customerId, metadata: { organizationId: organization.id }, status: 'active', cancel_at_period_end: false, canceled_at: null, schedule: null, latest_invoice: `in_${suffix}`, items: { object: 'list', has_more: false, data: [{ id: itemId, object: 'subscription_item', quantity: 1, price: { id: plan.providerPriceId, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, current_period_start: start, current_period_end: end }] } },
    invoices: [], sessions: [], hasSubscription: true, failRetrieve: false,
    charge: { id: chargeId, object: 'charge', livemode: mode === 'live', customer: customerId, payment_intent: paymentIntentId, amount: 1000, amount_refunded: 0, refunded: false, status: 'succeeded' },
    schedule: { id: `sub_sched_${suffix}`, object: 'subscription_schedule', status: 'active', metadata: { organizationId: organization.id, managedBy: 'ad-research-saas' }, current_phase: { start_date: start, end_date: end } },
  };
  const invoice = (id: string, periodStart = start, periodEnd = end, status = 'paid', price = plan.providerPriceId) => ({
    id, object: 'invoice', livemode: mode === 'live', customer: customerId, status, paid: status === 'paid', amount_paid: status === 'paid' ? 1000 : 0, amount_due: 1000, amount_remaining: status === 'paid' ? 0 : 1000, currency: 'usd', created: periodStart, hosted_invoice_url: 'https://invoice.stripe.com/i/test', invoice_pdf: 'https://pay.stripe.com/invoice/test/pdf',
    parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId, metadata: { organizationId: organization.id } } },
    lines: { object: 'list', has_more: false, data: [{ id: `il_${id}`, object: 'line_item', amount: 1000, currency: 'usd', subscription: subscriptionId, quantity: 1, period: { start: periodStart, end: periodEnd }, pricing: { type: 'price_details', price_details: { price } }, parent: { type: 'subscription_item_details', subscription_item_details: { subscription: subscriptionId, subscription_item: itemId, proration: false } } }] },
  });
  state.invoices.push(invoice(state.subscription.latest_invoice));
  const requests: Array<{ method: string; path: string; body: URLSearchParams }> = [];
  const list = (data: any[]) => ({ object: 'list', url: '/test', has_more: false, data });
  const httpClient = Stripe.createFetchHttpClient(async (url: RequestInfo | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const method = init?.method ?? 'GET';
    const body = new URLSearchParams(String(init?.body ?? ''));
    requests.push({ method, path: parsed.pathname, body });
    const path = parsed.pathname;
    let result: any;
    if (path === `/v1/subscriptions/${subscriptionId}` && method === 'GET') {
      if (state.failRetrieve) return new Response(JSON.stringify({ error: { type: 'api_error', message: 'fixture outage' } }), { status: 503 });
      result = state.subscription;
    } else if (path === '/v1/subscriptions' && method === 'GET') result = list(state.hasSubscription ? [state.subscription] : []);
    else if (path === `/v1/subscriptions/${subscriptionId}` && method === 'POST') { state.subscription.cancel_at_period_end = body.get('cancel_at_period_end') === 'true'; result = state.subscription; }
    else if (path === '/v1/customers' && method === 'POST') result = state.customer;
    else if (path === `/v1/customers/${customerId}`) result = state.customer;
    else if (path.startsWith('/v1/prices/')) {
      const candidate = path.endsWith(nextPlan.providerPriceId!) ? nextPlan : plan;
      result = { id: candidate.providerPriceId, object: 'price', active: true, livemode: mode === 'live', type: 'recurring', currency: 'usd', unit_amount: candidate.priceMinor, recurring: { interval: 'month', interval_count: 1 } };
    } else if (path === '/v1/checkout/sessions' && method === 'GET') result = list(state.sessions.filter((session: any) => session.status === 'open'));
    else if (path === '/v1/checkout/sessions' && method === 'POST') {
      result = { id: `cs_${suffix}_${state.sessions.length}`, object: 'checkout.session', status: 'open', customer: customerId, subscription: null, url: 'https://checkout.stripe.com/c/pay/test', metadata: { organizationId: body.get('metadata[organizationId]'), planVersionId: body.get('metadata[planVersionId]') } };
      state.sessions.push(result);
    } else if (path.endsWith('/expire')) { const session = state.sessions.find((row: any) => path.includes(row.id)); session.status = 'expired'; result = session; }
    else if (path.startsWith('/v1/checkout/sessions/')) result = state.sessions.find((row: any) => path.endsWith(row.id));
    else if (path === '/v1/invoices') result = list(state.invoices.filter((row: any) => !parsed.searchParams.get('status') || row.status === parsed.searchParams.get('status')));
    else if (path.startsWith('/v1/invoices/')) result = state.invoices.find((row: any) => path.endsWith(row.id));
    else if (path === '/v1/invoice_payments') result = list([{ id: `inpay_${suffix}`, object: 'invoice_payment', status: 'paid', invoice: parsed.searchParams.get('invoice') ?? state.invoices[0].id, amount_paid: 1000, currency: 'usd', payment: { type: 'payment_intent', payment_intent: paymentIntentId } }]);
    else if (path === '/v1/charges') result = list([state.charge]);
    else if (path === `/v1/charges/${chargeId}`) result = state.charge;
    else if (path === '/v1/subscription_schedules' && method === 'POST') { state.subscription.schedule = state.schedule.id; result = state.schedule; }
    else if (path === `/v1/subscription_schedules/${state.schedule.id}`) result = state.schedule;
    else if (path === `/v1/subscription_schedules/${state.schedule.id}/release`) { state.subscription.schedule = null; result = { ...state.schedule, status: 'released' }; }
    else throw new Error(`Unimplemented test transport: ${method} ${path}`);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_fixture' } });
  });
  const sdk = new Stripe('sk_test_fixture', { httpClient, maxNetworkRetries: 0 });
  const billing = createStripeBilling(db, sdk, { ...configuration, mode, livePaymentsEnabled: mode === 'live', publicPricingEnabled: mode === 'live' });
  await db.subscription.update({ where: { organizationId: organization.id }, data: { provider: 'STRIPE', providerCustomerId: customerId, providerSubscriptionId: subscriptionId } });
  function webhook(type = 'customer.subscription.updated', object: any = state.subscription, created = Math.floor(Date.now() / 1000), eventId = `evt_${randomUUID()}`) {
    const payload = JSON.stringify({ id: eventId, object: 'event', api_version: '2025-03-31.basil', type, livemode: mode === 'live', created, data: { object } });
    const signature = sdk.webhooks.generateTestHeaderString({ payload, secret });
    return { raw: Buffer.from(payload), signature, id: eventId };
  }
  return { billing, sdk, state, requests, owner, organization, workspace, plan, nextPlan, invoice, webhook, start, end, customerId, subscriptionId };
}

describe.skipIf(!testUrl)('Stripe billing with real PostgreSQL and explicit SDK fake HTTP transport', () => {
  it('blocks live checkout and plan changes for unpublished plans before contacting Stripe',async()=>{
    const f=await fixture('live');
    for(const operation of [()=>f.billing.createCheckout({userId:f.owner.id,organizationId:f.organization.id,planVersionId:f.plan.id,idempotencyKey:'unpublished'}),()=>f.billing.changePlanNextPeriod({userId:f.owner.id,organizationId:f.organization.id,planVersionId:f.plan.id})])await expect(operation()).rejects.toMatchObject({code:'PLAN_NOT_PUBLIC'});
    expect(f.requests).toHaveLength(0);
    await db.planVersion.update({where:{id:f.plan.id},data:{verifiedProviderMode:'LIVE',publicConfirmedAt:new Date()}});
    const closed=createStripeBilling(db,f.sdk,{...configuration,mode:'live',livePaymentsEnabled:true,publicPricingEnabled:false});
    await expect(closed.createCheckout({userId:f.owner.id,organizationId:f.organization.id,planVersionId:f.plan.id,idempotencyKey:'closed'})).rejects.toMatchObject({code:'PUBLIC_PRICING_DISABLED'});
    await expect(closed.changePlanNextPeriod({userId:f.owner.id,organizationId:f.organization.id,planVersionId:f.plan.id})).rejects.toMatchObject({code:'PUBLIC_PRICING_DISABLED'});
    expect(f.requests).toHaveLength(0);
    await db.planVersion.update({where:{id:f.plan.id},data:{publicConfirmedAt:null}});
  });
  it('permits an explicitly published live checkout and rejects it immediately after withdrawal',async()=>{
    const f=await fixture('live');
    await db.planVersion.update({where:{id:f.plan.id},data:{verifiedProviderMode:'LIVE',publicConfirmedAt:new Date()}});
    f.state.hasSubscription=false;await db.subscription.update({where:{organizationId:f.organization.id},data:{providerSubscriptionId:null}});
    try {
      await expect(f.billing.createCheckout({userId:f.owner.id,organizationId:f.organization.id,planVersionId:f.plan.id,idempotencyKey:'published'})).resolves.toMatchObject({url:'https://checkout.stripe.com/c/pay/test'});
    } finally {await db.planVersion.update({where:{id:f.plan.id},data:{publicConfirmedAt:null}});}
    await expect(f.billing.createCheckout({userId:f.owner.id,organizationId:f.organization.id,planVersionId:f.plan.id,idempotencyKey:'withdrawn'})).rejects.toMatchObject({code:'PLAN_NOT_PUBLIC'});
  });
  it('keeps reconciliation and period-end cancellation working when public sales are switched off',async()=>{
    const f=await fixture('live');
    const closed=createStripeBilling(db,f.sdk,{...configuration,mode:'live',livePaymentsEnabled:true,publicPricingEnabled:false});
    await expect(closed.reconcileSubscription({organizationId:f.organization.id})).resolves.toMatchObject({status:'ACTIVE'});
    await expect(closed.cancelAtPeriodEnd({userId:f.owner.id,organizationId:f.organization.id})).resolves.toMatchObject({cancelAtPeriodEnd:true});
  });
  it('serializes withdrawal with a live purchase that already passed eligibility checks',async()=>{
    const f=await fixture('live');await db.user.update({where:{id:f.owner.id},data:{isAdmin:true}});
    await db.planVersion.update({where:{id:f.plan.id},data:{verifiedProviderMode:'LIVE',publicConfirmedAt:new Date()}});
    f.state.hasSubscription=false;await db.subscription.update({where:{organizationId:f.organization.id},data:{providerSubscriptionId:null}});
    let started!:()=>void,resume!:()=>void;const startedPrice=new Promise<void>(resolve=>{started=resolve;}),continuePrice=new Promise<void>(resolve=>{resume=resolve;});
    const delayed=new Proxy(f.sdk,{get(target,name){return name==='prices'?{retrieve:async(id:string)=>{started();await continuePrice;return target.prices.retrieve(id);}}:Reflect.get(target,name);}});
    const billing=createStripeBilling(db,delayed,{...configuration,mode:'live',livePaymentsEnabled:true,publicPricingEnabled:true});
    const checkout=billing.createCheckout({userId:f.owner.id,organizationId:f.organization.id,planVersionId:f.plan.id,idempotencyKey:'before-withdrawal'});
    await startedPrice;
    const withdraw=createPlanManagement(db,null,{mode:'live'}).unpublishVersion({actorUserId:f.owner.id,key:f.plan.key,version:f.plan.version});
    let waiting=false;
    try {
      for(let attempt=0;attempt<100&&!waiting;attempt++){
        const rows=await db.$queryRaw<Array<{waiting:boolean}>>`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=1748210450::oid AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting`;
        waiting=rows[0].waiting;if(!waiting)await new Promise(resolve=>setTimeout(resolve,5));
      }
    } finally {resume();}
    await expect(checkout).resolves.toMatchObject({url:'https://checkout.stripe.com/c/pay/test'});
    await expect(withdraw).resolves.toMatchObject({publicConfirmedAt:null});
    expect(waiting).toBe(true);
    await expect(billing.createCheckout({userId:f.owner.id,organizationId:f.organization.id,planVersionId:f.plan.id,idempotencyKey:'after-withdrawal'})).rejects.toMatchObject({code:'PLAN_NOT_PUBLIC'});
  });
  it('queues a renewal attention notice once for eligible owners and ignores stale failure payloads', async () => {
    const f=await fixture();
    await f.billing.reconcileSubscription({organizationId:f.organization.id});
    for (const [role,disabled,optOut] of [['OWNER',false,true],['OWNER',true,false],['ADMIN',false,false]] as const) {
      const user=await db.user.create({data:{email:`${randomUUID()}@example.test`,disabledAt:disabled?new Date():null,notificationPreference:{email:!optOut}}});
      await db.organizationMember.create({data:{organizationId:f.organization.id,userId:user.id,role}});
    }
    const key='d'.repeat(64);
    const billing=createStripeBilling(db,f.sdk,{...configuration,onSubscriptionNotice:subscriptionNoticeEmail(key)});
    f.state.subscription.status='past_due';
    const failed=f.invoice(`in_failed_${randomUUID()}`,f.end,f.end+30*86400,'open');
    f.state.invoices.unshift(failed);f.state.subscription.latest_invoice=failed.id;
    const event=f.webhook('invoice.payment_failed',failed);
    await Promise.all([1,2].map(()=>billing.handleWebhook(event.raw,event.signature)));
    await billing.reconcileSubscription({organizationId:f.organization.id});
    let rows=await db.emailDelivery.findMany({where:{organizationId:f.organization.id}});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({recipientEmail:f.owner.email,templateKey:'SUBSCRIPTION_PAYMENT_ATTENTION'});
    expect(decryptMessage(rows[0].encryptedPayload!,key).text).toContain('待处理付款');
    expect(await db.subscription.findUnique({where:{organizationId:f.organization.id}})).toMatchObject({currentPeriodEnd:new Date(f.end*1000)});
    f.state.subscription.status='active';
    const old=f.webhook('invoice.payment_failed',failed,Math.floor(Date.now()/1000)-1000);
    await billing.handleWebhook(old.raw,old.signature);
    rows=await db.emailDelivery.findMany({where:{organizationId:f.organization.id}});
    expect(rows).toHaveLength(2);
    expect(rows.filter(row=>row.templateKey==='SUBSCRIPTION_PAYMENT_ATTENTION')).toHaveLength(1);
    expect(rows.some(row=>row.templateKey==='SUBSCRIPTION_STATUS_CHANGED')).toBe(true);
  });

  it('rolls subscription, event and email back together when notice enqueue fails', async () => {
    const f=await fixture(),key='d'.repeat(64);
    await f.billing.reconcileSubscription({organizationId:f.organization.id});
    const before=await db.subscription.findUniqueOrThrow({where:{organizationId:f.organization.id}});
    f.state.subscription.status='past_due';
    const event=f.webhook();
    const broken=createStripeBilling(db,f.sdk,{...configuration,onSubscriptionNotice:async(tx,notice)=>{await subscriptionNoticeEmail(key)(tx,notice);throw new Error('OUTBOX_TRANSACTION_FAILURE');}});
    await expect(broken.handleWebhook(event.raw,event.signature)).rejects.toThrow('OUTBOX_TRANSACTION_FAILURE');
    expect(await db.emailDelivery.count({where:{organizationId:f.organization.id}})).toBe(0);
    expect(await db.billingEvent.count({where:{providerEventId:event.id}})).toBe(0);
    expect(await db.subscription.findUnique({where:{organizationId:f.organization.id}})).toMatchObject({status:before.status,version:before.version});
    const billing=createStripeBilling(db,f.sdk,{...configuration,onSubscriptionNotice:subscriptionNoticeEmail(key)});
    await billing.handleWebhook(event.raw,event.signature);
    expect(await db.emailDelivery.count({where:{organizationId:f.organization.id}})).toBe(1);
  });

  it('uses neutral status wording without claiming a payment when no paid invoice exists', async () => {
    const f=await fixture(),key='d'.repeat(64);
    f.state.invoices=[];
    const billing=createStripeBilling(db,f.sdk,{...configuration,onSubscriptionNotice:subscriptionNoticeEmail(key)});
    const event=f.webhook();
    await expect(billing.handleWebhook(event.raw,'invalid')).rejects.toMatchObject({code:'INVALID_WEBHOOK_SIGNATURE'});
    expect(await db.emailDelivery.count({where:{organizationId:f.organization.id}})).toBe(0);
    await billing.handleWebhook(event.raw,event.signature);
    const row=await db.emailDelivery.findFirstOrThrow({where:{organizationId:f.organization.id}});
    const message=decryptMessage(row.encryptedPayload!,key);
    expect(row.templateKey).toBe('SUBSCRIPTION_STATUS_CHANGED');
    expect(message.text).not.toMatch(/付款成功|续费成功|支付成功|https?:\/\//);
  });

  it('notifies cancellation once while retaining the verified paid period', async () => {
    const f=await fixture(),key='d'.repeat(64);
    await f.billing.reconcileSubscription({organizationId:f.organization.id});
    const billing=createStripeBilling(db,f.sdk,{...configuration,onSubscriptionNotice:subscriptionNoticeEmail(key)});
    await billing.cancelAtPeriodEnd({organizationId:f.organization.id,userId:f.owner.id});
    await billing.reconcileSubscription({organizationId:f.organization.id});
    const rows=await db.emailDelivery.findMany({where:{organizationId:f.organization.id}});
    expect(rows).toHaveLength(1);
    expect(rows[0].templateKey).toBe('SUBSCRIPTION_CANCELLATION_SCHEDULED');
    expect(decryptMessage(rows[0].encryptedPayload!,key).text).toContain(new Date(f.end*1000).toISOString());
  });

  it('creates checkout only for the owner, fixes redirect URLs and does not grant paid rights', async () => {
    const f = await fixture();
    const member = await db.user.create({ data: { email: `${randomUUID()}@example.test` } });
    await db.organizationMember.create({ data: { organizationId: f.organization.id, userId: member.id, role: 'ADMIN' } });
    await expect(f.billing.createCheckout({ userId: member.id, organizationId: f.organization.id, planVersionId: f.plan.id, idempotencyKey: 'one' })).rejects.toMatchObject({ status: 403 });
    f.state.hasSubscription = false;
    await db.subscription.update({ where: { organizationId: f.organization.id }, data: { providerSubscriptionId: null } });
    const before = await db.entitlement.findFirst({ where: { organizationId: f.organization.id, key: 'ANALYSES' } });
    const checkout = await f.billing.createCheckout({ userId: f.owner.id, organizationId: f.organization.id, planVersionId: f.plan.id, idempotencyKey: 'one' });
    expect(checkout).toMatchObject({ url: 'https://checkout.stripe.com/c/pay/test' });
    const request = f.requests.find((row) => row.path === '/v1/checkout/sessions' && row.method === 'POST')!;
    expect(request.body.get('success_url')).toBe('https://app.example.test/app?billing=success');
    expect(request.body.get('cancel_url')).toBe('https://app.example.test/app?billing=canceled');
    expect(request.body.get('subscription_data[metadata][organizationId]')).toBe(f.organization.id);
    expect((await db.entitlement.findUnique({ where: { id: before!.id } }))!.limit).toBe(before!.limit);
    await f.billing.createCheckout({ userId: f.owner.id, organizationId: f.organization.id, planVersionId: f.plan.id, idempotencyKey: 'two' });
    expect(f.requests.filter((row) => row.path === '/v1/checkout/sessions' && row.method === 'POST')).toHaveLength(1);
    // Simulate a provider success followed by a lost local transaction commit.
    await db.subscription.update({ where: { organizationId: f.organization.id }, data: { providerCustomerId: null } });
    await f.billing.createCheckout({ userId: f.owner.id, organizationId: f.organization.id, planVersionId: f.plan.id, idempotencyKey: 'one' });
    expect(await db.subscription.findUnique({ where: { organizationId: f.organization.id } })).toMatchObject({ providerCustomerId: f.customerId });
    // Recovery also works if the checkout finished while its local mapping was lost.
    await db.subscription.update({ where: { organizationId: f.organization.id }, data: { providerCustomerId: null, providerSubscriptionId: null } });
    f.state.hasSubscription = true;
    const recovered = await f.billing.createCheckout({ userId: f.owner.id, organizationId: f.organization.id, planVersionId: f.plan.id, idempotencyKey: 'one' });
    expect(recovered.url).toBe('https://app.example.test/app?billing=existing');
    expect(await db.subscription.findUnique({ where: { organizationId: f.organization.id } })).toMatchObject({ providerCustomerId: f.customerId, providerSubscriptionId: f.subscriptionId, status: 'ACTIVE' });
    expect(f.requests.filter((row) => row.path === '/v1/checkout/sessions' && row.method === 'POST')).toHaveLength(1);
  });

  it('grants verified paid rights once, ignores stale payload state, and preserves current analysis reservations', async () => {
    const f = await fixture();
    const event = f.webhook();
    await f.billing.handleWebhook(event.raw, event.signature);
    await db.$transaction((tx) => reserveAnalysis(tx, f.organization.id, `analysis-${randomUUID()}`));
    await f.billing.handleWebhook(event.raw, event.signature);
    const older = f.webhook('customer.subscription.deleted', { ...f.state.subscription, status: 'canceled' }, Math.floor(Date.now() / 1000) - 500);
    await f.billing.handleWebhook(older.raw, older.signature);
    const local = await db.subscription.findUniqueOrThrow({ where: { organizationId: f.organization.id } });
    expect(local).toMatchObject({ status: 'ACTIVE', planVersionId: f.plan.id, currentPeriodEnd: new Date(f.end * 1000) });
    const analysis = await db.entitlement.findUniqueOrThrow({ where: { organizationId_key_periodStart: { organizationId: f.organization.id, key: 'ANALYSES', periodStart: new Date(f.start * 1000) } } });
    expect(analysis).toMatchObject({ limit: 50, reserved: 1, used: 0 });
    expect(await db.billingEvent.count({ where: { provider: 'STRIPE', providerEventId: event.id } })).toBe(1);
    expect(local.lastProviderEventAt).toEqual(new Date(JSON.parse(event.raw.toString()).created * 1000));
    f.state.failRetrieve = true;
    await expect(f.billing.handleWebhook(event.raw, event.signature)).resolves.toMatchObject({ duplicate: true });
  });

  it('rejects cross-organization provider/customer mapping before granting rights', async () => {
    const f = await fixture();
    f.state.subscription.customer = 'cus_another_organization';
    const event = f.webhook();
    await expect(f.billing.handleWebhook(event.raw, event.signature)).rejects.toMatchObject({ code: 'BILLING_MAPPING_MISMATCH' });
    expect(await db.billingEvent.count({ where: { providerEventId: event.id } })).toBe(0);
  });

  it('preserves an audited manual limit in the same paid period while refreshing actual usage', async () => {
    const f = await fixture();
    await f.billing.reconcileSubscription({ organizationId: f.organization.id });
    const current = await db.entitlement.findUniqueOrThrow({ where: { organizationId_key_periodStart: { organizationId: f.organization.id, key: 'MEMBERS', periodStart: new Date(f.start * 1000) } } });
    await db.entitlement.update({ where: { id: current.id }, data: { source: 'MANUAL', limit: 42 } });
    const member = await db.user.create({ data: { email: `${randomUUID()}@example.test` } });
    await db.organizationMember.create({ data: { organizationId: f.organization.id, userId: member.id, role: 'MEMBER' } });
    await f.billing.reconcileSubscription({ organizationId: f.organization.id });
    expect(await db.entitlement.findUnique({ where: { id: current.id } })).toMatchObject({ limit: 42, source: 'MANUAL', used: 2 });
  });

  it('deduplicates concurrent delivery of one verified webhook in a single organization transaction', async () => {
    const f = await fixture();
    const event = f.webhook();
    const results = await Promise.all([1, 2].map(() => f.billing.handleWebhook(event.raw, event.signature)));
    expect(results.filter((result) => 'processed' in result && result.processed)).toHaveLength(1);
    expect(await db.billingEvent.count({ where: { providerEventId: event.id } })).toBe(1);
    expect(await db.entitlement.count({ where: { organizationId: f.organization.id, periodStart: new Date(f.start * 1000) } })).toBe(4);
  });

  it('refuses inactive or unconfigured plan versions before creating checkout', async () => {
    const f = await fixture();
    await db.planVersion.update({ where: { id: f.plan.id }, data: { status: 'DRAFT' } });
    await expect(f.billing.createCheckout({ userId: f.owner.id, organizationId: f.organization.id, planVersionId: f.plan.id, idempotencyKey: 'inactive' })).rejects.toMatchObject({ code: 'PLAN_NOT_PURCHASABLE' });
    await db.planVersion.update({ where: { id: f.plan.id }, data: { status: 'ACTIVE', providerPriceId: null } });
    await expect(f.billing.createCheckout({ userId: f.owner.id, organizationId: f.organization.id, planVersionId: f.plan.id, idempotencyKey: 'missing' })).rejects.toMatchObject({ code: 'PLAN_NOT_PURCHASABLE' });
    expect(f.requests.filter((row) => row.path === '/v1/checkout/sessions' && row.method === 'POST')).toHaveLength(0);
  });

  it('does not extend paid-through time on renewal failure and creates a new analysis period only after payment', async () => {
    const f = await fixture();
    await f.billing.reconcileSubscription({ organizationId: f.organization.id });
    const reservation = await db.$transaction((tx) => reserveAnalysis(tx, f.organization.id, `carry-${randomUUID()}`));
    const renewalEnd = f.end + 30 * 86400;
    f.state.subscription.items.data[0].current_period_start = f.end;
    f.state.subscription.items.data[0].current_period_end = renewalEnd;
    f.state.subscription.status = 'past_due';
    f.state.subscription.latest_invoice = `in_renewal_${randomUUID()}`;
    f.state.invoices.unshift(f.invoice(f.state.subscription.latest_invoice, f.end, renewalEnd, 'open'));
    await f.billing.reconcileSubscription({ organizationId: f.organization.id });
    expect(await db.subscription.findUnique({ where: { organizationId: f.organization.id } })).toMatchObject({ status: 'PAST_DUE', currentPeriodEnd: new Date(f.end * 1000) });
    f.state.invoices[0].status = 'paid'; f.state.invoices[0].amount_paid = 1000; f.state.invoices[0].amount_remaining = 0; f.state.subscription.status = 'active';
    await f.billing.reconcileSubscription({ organizationId: f.organization.id });
    expect(await db.subscription.findUnique({ where: { organizationId: f.organization.id } })).toMatchObject({ currentPeriodEnd: new Date(f.end * 1000) });
    expect(await db.entitlement.findUnique({ where: { id: reservation.entitlementId } })).toMatchObject({ reserved: 1, validUntil: new Date(f.end * 1000) });
    expect(await db.entitlement.findUnique({ where: { organizationId_key_periodStart: { organizationId: f.organization.id, key: 'ANALYSES', periodStart: new Date(f.end * 1000) } } })).toBeNull();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(f.end * 1000 + 1000));
      await f.billing.reconcileSubscription({ organizationId: f.organization.id });
      expect(await db.subscription.findUnique({ where: { organizationId: f.organization.id } })).toMatchObject({ currentPeriodEnd: new Date(renewalEnd * 1000) });
      expect(await db.entitlement.findUnique({ where: { organizationId_key_periodStart: { organizationId: f.organization.id, key: 'ANALYSES', periodStart: new Date(f.end * 1000) } } })).toMatchObject({ reserved: 0, used: 0 });
    } finally { vi.useRealTimers(); }
  });

  it('does not mark a webhook processed or mutate local subscription during provider failure', async () => {
    const f = await fixture();
    const before = await db.subscription.findUniqueOrThrow({ where: { organizationId: f.organization.id } });
    f.state.failRetrieve = true;
    const event = f.webhook();
    await expect(f.billing.handleWebhook(event.raw, event.signature)).rejects.toMatchObject({ statusCode: 503 });
    expect(await db.subscription.findUnique({ where: { organizationId: f.organization.id } })).toMatchObject({ version: before.version, currentPeriodEnd: before.currentPeriodEnd });
    expect(await db.billingEvent.count({ where: { providerEventId: event.id } })).toBe(0);
  });

  it('schedules cancellation at the paid period end without revoking paid access early', async () => {
    const f = await fixture();
    await f.billing.reconcileSubscription({ organizationId: f.organization.id });
    await f.billing.cancelAtPeriodEnd({ userId: f.owner.id, organizationId: f.organization.id });
    expect(await db.subscription.findUnique({ where: { organizationId: f.organization.id } })).toMatchObject({ cancelAtPeriodEnd: true, currentPeriodEnd: new Date(f.end * 1000) });
    const request = f.requests.find((row) => row.path === `/v1/subscriptions/${f.subscriptionId}` && row.method === 'POST')!;
    expect(request.body.get('cancel_at_period_end')).toBe('true');
    expect(await db.entitlement.findUnique({ where: { organizationId_key_periodStart: { organizationId: f.organization.id, key: 'ANALYSES', periodStart: new Date(f.start * 1000) } } })).toMatchObject({ validUntil: new Date(f.end * 1000) });
  });

  it('schedules the next plan without changing current price or current entitlements', async () => {
    const f = await fixture();
    await f.billing.reconcileSubscription({ organizationId: f.organization.id });
    await f.billing.changePlanNextPeriod({ userId: f.owner.id, organizationId: f.organization.id, planVersionId: f.nextPlan.id });
    const local = await db.subscription.findUniqueOrThrow({ where: { organizationId: f.organization.id } });
    expect(local).toMatchObject({ planVersionId: f.plan.id, scheduledPlanVersionId: f.nextPlan.id });
    expect(f.state.subscription.items.data[0].price.id).toBe(f.plan.providerPriceId);
    const update = f.requests.find((row) => row.path === `/v1/subscription_schedules/${f.state.schedule.id}` && row.method === 'POST')!;
    expect(update.body.get('phases[0][end_date]')).toBe(String(f.end));
    expect(update.body.get('phases[1][items][0][price]')).toBe(f.nextPlan.providerPriceId);
    expect(update.body.get('proration_behavior')).toBe('none');
  });

  it('revokes a fully refunded current period according to policy and does not resurrect it on reconciliation', async () => {
    const f = await fixture();
    await f.billing.reconcileSubscription({ organizationId: f.organization.id });
    f.state.charge.refunded = true; f.state.charge.amount_refunded = 1000;
    const event = f.webhook('charge.refunded', f.state.charge);
    await f.billing.handleWebhook(event.raw, event.signature);
    await f.billing.reconcileSubscription({ organizationId: f.organization.id });
    const local = await db.subscription.findUniqueOrThrow({ where: { organizationId: f.organization.id } });
    expect(local.status).toBe('REFUNDED');
    expect(local.currentPeriodEnd!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await db.entitlement.count({ where: { organizationId: f.organization.id, validUntil: { gt: new Date() } } })).toBe(0);
  });

  it('retains paid-through access when configured refund policy retains the period', async () => {
    const f = await fixture();
    f.state.charge.refunded = true; f.state.charge.amount_refunded = 1000;
    const billing = createStripeBilling(db, f.sdk, { ...configuration, refundPolicy: 'RETAIN_PAID_PERIOD' });
    await billing.reconcileSubscription({ organizationId: f.organization.id });
    expect(await db.subscription.findUnique({ where: { organizationId: f.organization.id } })).toMatchObject({ currentPeriodEnd: new Date(f.end * 1000), status: 'ACTIVE' });
  });

  it('returns owner-only invoice links without opening a self-service plan-change portal', async () => {
    const f = await fixture();
    const outsider = await db.user.create({ data: { email: `${randomUUID()}@example.test` } });
    await expect(f.billing.listInvoices({ userId: outsider.id, organizationId: f.organization.id })).rejects.toMatchObject({ status: 403 });
    const invoices = await f.billing.listInvoices({ userId: f.owner.id, organizationId: f.organization.id });
    expect(invoices[0]).toMatchObject({ invoiceUrl: 'https://invoice.stripe.com/i/test', pdfUrl: 'https://pay.stripe.com/invoice/test/pdf' });
    expect(f.requests.some((row) => row.path.includes('billing_portal'))).toBe(false);
  });
});
