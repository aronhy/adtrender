import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPlanManagement, parsePlanImport } from './plan-management';

const testUrl=process.env.SAAS_TEST_DATABASE_URL;
const db=new PrismaClient({datasources:{db:{url:testUrl??'postgresql://unused@127.0.0.1:1/not_run'}}});
const publicPlanIds:string[]=[];
afterEach(async()=>{if(publicPlanIds.length)await db.planVersion.updateMany({where:{id:{in:publicPlanIds.splice(0)}},data:{publicConfirmedAt:null}});});
afterAll(()=>db.$disconnect());
function specification(overrides:Record<string,unknown>={}) {
  const suffix=randomUUID().replaceAll('-','');
  return {schemaVersion:1,mode:'test',key:`catalog-${suffix}`,version:1,name:'明确配置的测试套餐',currency:'usd',priceMinor:1234,billingInterval:'MONTH',trialDays:0,workspaceLimit:2,memberLimit:3,savedAdLimit:40,monthlyAnalysisLimit:5,providerPriceId:`price_${suffix}`,...overrides};
}
async function fixture(mode:'test'|'live'='test') {
  const actor=await db.user.create({data:{email:`${randomUUID()}@example.test`,isAdmin:true}});
  const plan=specification({mode}),requests:Array<{method:string;path:string}>=[];
  const state={price:{id:plan.providerPriceId,object:'price',active:true,livemode:mode==='live',type:'recurring',currency:'usd',unit_amount:1234,billing_scheme:'per_unit',recurring:{interval:'month',interval_count:1,usage_type:'licensed'},transform_quantity:null,custom_unit_amount:null}};
  const sdk=new Stripe('sk_test_explicit_fake_transport',{maxNetworkRetries:0,httpClient:Stripe.createFetchHttpClient(async(url:RequestInfo|URL,init?:RequestInit)=>{
    const path=new URL(String(url)).pathname,method=init?.method??'GET';requests.push({method,path});
    if(method!=='GET'||!path.startsWith('/v1/prices/'))throw new Error('UNEXPECTED_PROVIDER_MUTATION');
    return new Response(JSON.stringify({...state.price,id:decodeURIComponent(path.slice('/v1/prices/'.length))}),{headers:{'content-type':'application/json'}});
  })});
  return {actor,plan,requests,state,sdk,service:createPlanManagement(db,sdk,{mode,livePaymentsEnabled:mode==='live'})};
}

describe('explicit plan file validation',()=>{
  it('accepts only explicit bounded commercial fields and excludes secrets',()=>{
    expect(parsePlanImport(specification())).toMatchObject({priceMinor:1234,trialDays:0});
    for(const overrides of [{priceMinor:-1},{workspaceLimit:0},{monthlyAnalysisLimit:1.5},{currency:'USD'},{version:0},{trialDays:14},{providerPriceId:'prod_wrong'},{mode:'unknown'},{secretKey:'sk_test_not_allowed'},{billingInterval:'YEAR'}]) {
      expect(()=>parsePlanImport(specification(overrides))).toThrow('INVALID_PLAN_IMPORT');
    }
    const missing=specification() as Record<string,unknown>;delete missing.memberLimit;
    expect(()=>parsePlanImport(missing)).toThrow('INVALID_PLAN_IMPORT');
  });
});

describe.skipIf(!testUrl)('plan version catalog with real PostgreSQL and explicit SDK fake HTTP transport',()=>{
  it('persists verified provider mode without publishing an imported or activated version',async()=>{
    const f=await fixture(),draft=await f.service.importVersion({actorUserId:f.actor.id,plan:f.plan});
    expect(draft).toMatchObject({verifiedProviderMode:'TEST',publicConfirmedAt:null});
    expect(await f.service.activateVersion({actorUserId:f.actor.id,key:draft.key,version:draft.version})).toMatchObject({verifiedProviderMode:'TEST',publicConfirmedAt:null});
  });
  it('does not publish sandbox plans even when they are active',async()=>{
    const f=await fixture(),draft=await f.service.importVersion({actorUserId:f.actor.id,plan:f.plan});
    await f.service.activateVersion({actorUserId:f.actor.id,key:draft.key,version:draft.version});
    const before=f.requests.length;
    await expect(f.service.publishVersion({actorUserId:f.actor.id,key:draft.key,version:draft.version})).rejects.toMatchObject({code:'PUBLIC_PLAN_REQUIRES_LIVE'});
    expect(f.requests).toHaveLength(before);
  });
  it('publishes only an active live version after fresh verification, with one audit under concurrency',async()=>{
    const f=await fixture('live'),draft=await f.service.importVersion({actorUserId:f.actor.id,plan:f.plan});
    await expect(f.service.publishVersion({actorUserId:f.actor.id,key:draft.key,version:draft.version})).rejects.toMatchObject({code:'PLAN_NOT_PUBLISHABLE'});
    await f.service.activateVersion({actorUserId:f.actor.id,key:draft.key,version:draft.version});
    f.state.price.unit_amount=4321;
    await expect(f.service.publishVersion({actorUserId:f.actor.id,key:draft.key,version:draft.version})).rejects.toMatchObject({code:'PLAN_PRICE_MISMATCH'});
    expect((await db.planVersion.findUniqueOrThrow({where:{id:draft.id}})).publicConfirmedAt).toBeNull();
    f.state.price.unit_amount=1234;const before=f.requests.length;
    const rows=await Promise.all([1,2].map(()=>f.service.publishVersion({actorUserId:f.actor.id,key:draft.key,version:draft.version})));
    publicPlanIds.push(draft.id);
    expect(rows[0]).toMatchObject({verifiedProviderMode:'LIVE',publicConfirmedAt:expect.any(Date)});expect(rows[1]).toEqual(rows[0]);
    expect(f.requests.length-before).toBe(2);
    expect(await db.auditEvent.count({where:{targetId:draft.id,action:'PLAN_PUBLICATION_CONFIRMED'}})).toBe(1);
    expect(f.requests.every(row=>row.method==='GET'&&row.path.startsWith('/v1/prices/'))).toBe(true);
  });
  it('checks fresh admin permission before publishing or withdrawing and before requesting Stripe',async()=>{
    const f=await fixture('live'),draft=await f.service.importVersion({actorUserId:f.actor.id,plan:f.plan});
    await f.service.activateVersion({actorUserId:f.actor.id,key:draft.key,version:draft.version});
    const ordinary=await db.user.create({data:{email:`${randomUUID()}@example.test`}}),before=f.requests.length;
    for(const method of ['publishVersion','unpublishVersion'] as const)await expect(f.service[method]({actorUserId:ordinary.id,key:draft.key,version:1})).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});
    await db.user.update({where:{id:f.actor.id},data:{disabledAt:new Date()}});
    for(const method of ['publishVersion','unpublishVersion'] as const)await expect(f.service[method]({actorUserId:f.actor.id,key:draft.key,version:1})).rejects.toMatchObject({code:'ACCOUNT_DISABLED'});
    expect(f.requests.length).toBe(before);
  });
  it('withdraws publication without Stripe, changing an existing subscription, or disabling its plan',async()=>{
    const f=await fixture('live'),draft=await f.service.importVersion({actorUserId:f.actor.id,plan:f.plan});
    await f.service.activateVersion({actorUserId:f.actor.id,key:draft.key,version:1});
    await f.service.publishVersion({actorUserId:f.actor.id,key:draft.key,version:1}); publicPlanIds.push(draft.id);
    const org=await db.organization.create({data:{name:'既有付费客户',slug:randomUUID(),members:{create:{userId:f.actor.id,role:'OWNER'}}}});
    const subscription=await db.subscription.create({data:{organizationId:org.id,planVersionId:draft.id,status:'ACTIVE',provider:'STRIPE'}});
    const entitlement=await db.entitlement.create({data:{organizationId:org.id,key:'ANALYSES',limit:5,used:2,reserved:1,validFrom:new Date(),periodStart:new Date()}});
    const before=f.requests.length;
    const noProvider=createPlanManagement(db,{prices:{retrieve:async()=>{throw new Error('NO_PROVIDER_ALLOWED');}}} as unknown as Pick<Stripe,'prices'>,{mode:'live'});
    await Promise.all([1,2].map(()=>noProvider.unpublishVersion({actorUserId:f.actor.id,key:draft.key,version:1})));
    expect(await db.planVersion.findUniqueOrThrow({where:{id:draft.id}})).toMatchObject({status:'ACTIVE',verifiedProviderMode:'LIVE',publicConfirmedAt:null});
    expect(await db.subscription.findUniqueOrThrow({where:{id:subscription.id}})).toEqual(subscription);
    expect(await db.entitlement.findUniqueOrThrow({where:{id:entitlement.id}})).toEqual(entitlement);
    expect(await db.auditEvent.count({where:{targetId:draft.id,action:'PLAN_PUBLICATION_WITHDRAWN'}})).toBe(1);
    expect(f.requests.length).toBe(before);
  });
  it('never switches an already verified test plan to a live plan or publishes an unverified legacy row',async()=>{
    const f=await fixture(),draft=await f.service.importVersion({actorUserId:f.actor.id,plan:f.plan});
    const live=createPlanManagement(db,f.sdk,{mode:'live',livePaymentsEnabled:true}); f.state.price.livemode=true;
    await expect(live.importVersion({actorUserId:f.actor.id,plan:{...f.plan,mode:'live'}})).rejects.toMatchObject({code:'PLAN_MODE_MISMATCH'});
    await expect(live.publishVersion({actorUserId:f.actor.id,key:draft.key,version:1})).rejects.toMatchObject({code:'PLAN_NOT_PUBLISHABLE'});
    const legacy=await db.planVersion.create({data:{key:`legacy-${randomUUID()}`,version:1,name:'历史行',status:'ACTIVE',currency:'usd',priceMinor:1234,providerPriceId:`price_${randomUUID()}`,workspaceLimit:1,memberLimit:1}});
    await expect(live.publishVersion({actorUserId:f.actor.id,key:legacy.key,version:1})).rejects.toMatchObject({code:'PLAN_NOT_PUBLISHABLE'});
  });
  it('requires a currently active platform admin before any provider request',async()=>{
    const f=await fixture(),ordinary=await db.user.create({data:{email:`${randomUUID()}@example.test`}});
    await expect(f.service.importVersion({actorUserId:ordinary.id,plan:f.plan})).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});
    await db.user.update({where:{id:f.actor.id},data:{disabledAt:new Date()}});
    await expect(f.service.importVersion({actorUserId:f.actor.id,plan:f.plan})).rejects.toMatchObject({code:'ACCOUNT_DISABLED'});
    expect(f.requests).toHaveLength(0);
  });
  it('imports an immutable draft idempotently with a single audit under concurrency',async()=>{
    const f=await fixture();
    const rows=await Promise.all([1,2].map(()=>f.service.importVersion({actorUserId:f.actor.id,plan:f.plan})));
    expect(rows[0]).toEqual(rows[1]);expect(rows[0]).toMatchObject({status:'DRAFT',priceMinor:1234});
    expect(await db.auditEvent.count({where:{targetId:rows[0].id,action:'PLAN_VERSION_IMPORTED'}})).toBe(1);
    for(const overrides of [{priceMinor:2000},{name:'改名'}, {workspaceLimit:3},{providerPriceId:'price_other'}]) {
      await expect(f.service.importVersion({actorUserId:f.actor.id,plan:{...f.plan,...overrides}})).rejects.toMatchObject({code:'PLAN_VERSION_IMMUTABLE'});
    }
    expect(await db.planVersion.findUnique({where:{id:rows[0].id}})).toEqual(rows[0]);
  });
  it('refuses price reuse across versions even for concurrent imports',async()=>{
    const f=await fixture();
    const result=await Promise.allSettled([f.plan,{...f.plan,key:`other-${randomUUID()}`}].map(plan=>f.service.importVersion({actorUserId:f.actor.id,plan})));
    expect(result.filter(row=>row.status==='fulfilled')).toHaveLength(1);
    expect(result.find(row=>row.status==='rejected')).toMatchObject({reason:{code:'PLAN_PRICE_ALREADY_ASSIGNED'}});
  });
  it('compares the provider amount, currency, recurrence, fixed quantity and mode before creating a row',async()=>{
    const cases=[{unit_amount:999},{currency:'eur'},{active:false},{livemode:true},{type:'one_time'},{billing_scheme:'tiered'},{recurring:{interval:'year',interval_count:1,usage_type:'licensed'}},{recurring:{interval:'month',interval_count:1,usage_type:'metered'}},{transform_quantity:{divide_by:10,round:'up'}}];
    for(const mismatch of cases) {
      const f=await fixture();Object.assign(f.state.price,mismatch);
      await expect(f.service.importVersion({actorUserId:f.actor.id,plan:f.plan})).rejects.toMatchObject({code:'PLAN_PRICE_MISMATCH'});
      expect(await db.planVersion.count({where:{key:f.plan.key}})).toBe(0);
    }
  });
  it('activates after fresh verification without changing old subscriptions, entitlements or plans',async()=>{
    const f=await fixture();const draft=await f.service.importVersion({actorUserId:f.actor.id,plan:f.plan});
    const oldPlan=await db.planVersion.create({data:{...draft,id:undefined,createdAt:undefined,key:`old-${randomUUID()}`,providerPriceId:`price_${randomUUID()}`,status:'ACTIVE'}});
    const organization=await db.organization.create({data:{name:'既有组织',slug:`catalog-${randomUUID()}`,members:{create:{userId:f.actor.id,role:'OWNER'}}}});
    const subscription=await db.subscription.create({data:{organizationId:organization.id,planVersionId:oldPlan.id,provider:'STRIPE',status:'ACTIVE'}});
    const entitlement=await db.entitlement.create({data:{organizationId:organization.id,key:'ANALYSES',limit:10,used:3,reserved:2,validFrom:new Date(),periodStart:new Date()}});
    f.state.price.active=false;
    await expect(f.service.activateVersion({actorUserId:f.actor.id,key:draft.key,version:draft.version})).rejects.toMatchObject({code:'PLAN_PRICE_MISMATCH'});
    f.state.price.active=true;
    await Promise.all([1,2].map(()=>f.service.activateVersion({actorUserId:f.actor.id,key:draft.key,version:draft.version})));
    expect(await db.planVersion.findUnique({where:{id:draft.id}})).toMatchObject({status:'ACTIVE'});
    expect(await db.auditEvent.count({where:{targetId:draft.id,action:'PLAN_VERSION_ACTIVATED'}})).toBe(1);
    expect(await db.subscription.findUnique({where:{id:subscription.id}})).toEqual(subscription);
    expect(await db.entitlement.findUnique({where:{id:entitlement.id}})).toEqual(entitlement);
    expect(await db.planVersion.findUnique({where:{id:oldPlan.id}})).toEqual(oldPlan);
    expect(f.requests.every(row=>row.method==='GET'&&row.path.startsWith('/v1/prices/'))).toBe(true);
  });
  it('fails closed on mode mismatch and live activation without an explicit gate',async()=>{
    const f=await fixture();
    await expect(f.service.importVersion({actorUserId:f.actor.id,plan:{...f.plan,mode:'live'}})).rejects.toMatchObject({code:'PLAN_MODE_MISMATCH'});
    f.state.price.livemode=true;
    const live=createPlanManagement(db,f.sdk,{mode:'live'}),enabled=createPlanManagement(db,f.sdk,{mode:'live',livePaymentsEnabled:true});
    const draft=await live.importVersion({actorUserId:f.actor.id,plan:{...f.plan,mode:'live'}});
    await expect(live.activateVersion({actorUserId:f.actor.id,key:draft.key,version:1})).rejects.toMatchObject({code:'LIVE_BILLING_NOT_ENABLED'});
    await expect(enabled.activateVersion({actorUserId:f.actor.id,key:draft.key,version:1})).resolves.toMatchObject({status:'ACTIVE'});
    await expect(f.service.activateVersion({actorUserId:f.actor.id,key:draft.key,version:1})).rejects.toMatchObject({code:'PLAN_MODE_MISMATCH'});
  });
});
