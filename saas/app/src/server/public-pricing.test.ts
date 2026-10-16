import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadPublicPricing, publicPricingEnabled } from './public-pricing';

const enabled={PUBLIC_PRICING_ENABLED:'true',BILLING_ENABLED:'true',LIVE_BILLING_ENABLED:'true',STRIPE_SECRET_KEY:'sk_live_fixture_not_real',STRIPE_WEBHOOK_SECRET:'whsec_fixture',STRIPE_REFUND_POLICY:'RETAIN_PAID_PERIOD'};
const db=new PrismaClient({datasources:{db:{url:process.env.SAAS_TEST_DATABASE_URL??'postgresql://unused@127.0.0.1:1/not_run'}}});
const ids:string[]=[];
afterEach(async()=>{if(ids.length)await db.planVersion.deleteMany({where:{id:{in:ids.splice(0)}}});});
afterAll(()=>db.$disconnect());
async function plan(overrides:Record<string,unknown>={}) {
 const row=await db.planVersion.create({data:{key:`public-${randomUUID()}`,version:1,name:'经确认正式套餐',status:'ACTIVE',priceMinor:1000,currency:'usd',billingInterval:'MONTH',workspaceLimit:2,memberLimit:4,savedAdLimit:60,monthlyAnalysisLimit:8,providerPriceId:`price_${randomUUID()}`,verifiedProviderMode:'LIVE',publicConfirmedAt:new Date(),...overrides}});ids.push(row.id);return row;
}
describe('explicit public price configuration',()=>{
 it('defaults to unpublished without reading a database or exposing trial defaults',async()=>{
  expect(publicPricingEnabled({})).toBe(false);
  const state=await loadPublicPricing({} as PrismaClient,{});
  expect(state).toEqual({status:'UNPUBLISHED',message:expect.any(String),plans:[]});
  expect(Object.keys(state).sort()).toEqual(['message','plans','status']);
 });
 it('requires an exact explicit public flag and a completely configured live checkout',()=>{
  expect(publicPricingEnabled(enabled)).toBe(true);
  for(const override of [{PUBLIC_PRICING_ENABLED:'yes'},{BILLING_ENABLED:'false'},{LIVE_BILLING_ENABLED:'false'},{STRIPE_SECRET_KEY:'sk_test_fixture'},{STRIPE_WEBHOOK_SECRET:''},{STRIPE_REFUND_POLICY:''}])expect(()=>publicPricingEnabled({...enabled,...override})).toThrow();
 });
});
describe.skipIf(!process.env.SAAS_TEST_DATABASE_URL)('anonymous public price DTO with PostgreSQL',()=>{
 it('exposes only confirmed active live versions and an exact field allowlist',async()=>{
  const yes=await plan();
  const no=[await plan({publicConfirmedAt:null}),await plan({verifiedProviderMode:'TEST',publicConfirmedAt:null}),await plan({verifiedProviderMode:null,publicConfirmedAt:null}),await plan({status:'DRAFT'}),await plan({status:'RETIRED'})];
  const state=await loadPublicPricing(db,enabled);expect(state.status).toBe('PUBLISHED');
  const selected=state.plans.find(p=>p.id===yes.id);expect(selected).toEqual({id:yes.id,name:yes.name,priceMinor:1000,currency:'usd',interval:'MONTH',workspaceLimit:2,memberLimit:4,savedAdLimit:60,monthlyAnalysisLimit:8});
  expect(state.plans.some(p=>no.some(hidden=>hidden.id===p.id))).toBe(false);
  expect(JSON.stringify(state)).not.toMatch(/providerPriceId|verifiedProviderMode|publicConfirmedAt|trialDays|createdAt/);
 });
 it('hides all approved prices when the operator closes the public gate',async()=>{
  await plan();expect(await loadPublicPricing(db,{...enabled,PUBLIC_PRICING_ENABLED:'false'})).toMatchObject({status:'UNPUBLISHED',plans:[]});
 });
 it('re-reads withdrawal immediately rather than serving a previously published plan',async()=>{
  const yes=await plan();expect((await loadPublicPricing(db,enabled)).plans.some(p=>p.id===yes.id)).toBe(true);
  await db.planVersion.update({where:{id:yes.id},data:{publicConfirmedAt:null}});
  expect((await loadPublicPricing(db,enabled)).plans.some(p=>p.id===yes.id)).toBe(false);
 });
 it('database rejects public confirmation of sandbox and unknown provider modes',async()=>{
  for(const verifiedProviderMode of ['TEST',null])await expect(plan({verifiedProviderMode})).rejects.toThrow();
 });
});
