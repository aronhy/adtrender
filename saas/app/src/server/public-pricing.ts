import type { PrismaClient } from '@prisma/client';
import { DomainError } from '../team/access';
import { availablePlanWhere } from '../billing/plan-management';

export type PublicPlanView={id:string;name:string;priceMinor:number;currency:string;interval:'MONTH';workspaceLimit:number;memberLimit:number;savedAdLimit:number;monthlyAnalysisLimit:number};
export type PublicPricingView={status:'UNPUBLISHED'|'PUBLISHED';message:string;plans:PublicPlanView[]};

/** One server-only launch gate. Prices are never enabled by a test key or by
 * merely activating a catalog version. No provider request occurs here. */
export function publicPricingEnabled(env:Record<string,string|undefined>):boolean {
  if(env.PUBLIC_PRICING_ENABLED===undefined||env.PUBLIC_PRICING_ENABLED==='false')return false;
  if(env.PUBLIC_PRICING_ENABLED!=='true')throw new DomainError(503,'INVALID_PUBLIC_PRICING_CONFIG');
  if(env.BILLING_ENABLED!=='true'||env.LIVE_BILLING_ENABLED!=='true'||!env.STRIPE_SECRET_KEY?.startsWith('sk_live_')||!env.STRIPE_WEBHOOK_SECRET?.trim()||!['RETAIN_PAID_PERIOD','REVOKE_FULL_CURRENT_PERIOD'].includes(env.STRIPE_REFUND_POLICY??''))throw new DomainError(503,'PUBLIC_PRICING_NOT_CONFIGURED');
  return true;
}
const unpublished=():PublicPricingView=>({status:'UNPUBLISHED',message:'正式套餐价格尚未公布。试用时长和额度以已开通权益为准。',plans:[]});
export async function loadPublicPricing(db:PrismaClient,env:Record<string,string|undefined>=process.env):Promise<PublicPricingView> {
  if(!publicPricingEnabled(env))return unpublished();
  const plans=await db.planVersion.findMany({where:availablePlanWhere({mode:'live',publicPricingEnabled:true}),take:101,orderBy:[{key:'asc'},{version:'desc'},{id:'asc'}],select:{id:true,name:true,priceMinor:true,currency:true,billingInterval:true,workspaceLimit:true,memberLimit:true,savedAdLimit:true,monthlyAnalysisLimit:true}});
  if(!plans.length)return unpublished();
  if(plans.length>100)throw new DomainError(503,'PUBLIC_CATALOG_LIMIT_EXCEEDED');
  return {status:'PUBLISHED',message:'订阅属于组织，由组织所有者购买。试用时长和额度以已开通权益为准。',plans:plans.map(plan=>{
    if(!plan.name.trim()||!plan.currency||!/^[a-z]{3}$/.test(plan.currency)||plan.priceMinor===null)throw new DomainError(503,'INVALID_PUBLIC_PLAN');
    return {id:plan.id,name:plan.name,priceMinor:plan.priceMinor,currency:plan.currency,interval:'MONTH',workspaceLimit:plan.workspaceLimit,memberLimit:plan.memberLimit,savedAdLimit:plan.savedAdLimit,monthlyAnalysisLimit:plan.monthlyAnalysisLimit};
  })};
}
