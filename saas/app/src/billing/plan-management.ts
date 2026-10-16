import type { PlanVersion, Prisma, PrismaClient } from '@prisma/client';
import type Stripe from 'stripe';
import { DomainError, lockAccountAdministration, requirePlatformAdmin } from '../team/access';

export type PlanImport = {
  schemaVersion: 1; mode: 'test'|'live'; key: string; version: number; name: string;
  currency: string; priceMinor: number; billingInterval: 'MONTH'; trialDays: 0;
  workspaceLimit: number; memberLimit: number; savedAdLimit: number; monthlyAnalysisLimit: number;
  providerPriceId: string;
};
export type PlanManagementConfig = { mode: 'test'|'live'; livePaymentsEnabled?: boolean };
const commercialFields=['key','version','name','currency','priceMinor','billingInterval','trialDays','workspaceLimit','memberLimit','savedAdLimit','monthlyAnalysisLimit','providerPriceId'] as const;
const integer=(value:unknown,min=0):value is number=>typeof value==='number'&&Number.isInteger(value)&&value>=min&&value<=2_147_483_647;
const validKey=(value:unknown):value is string=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,79}$/.test(value);

/** Only the declared commercial contract is accepted; credentials never belong in plan JSON. */
export function parsePlanImport(value:unknown):PlanImport {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new DomainError(400,'INVALID_PLAN_IMPORT');
  const row=value as Record<string,unknown>;
  if(Object.keys(row).some(key=>!['schemaVersion','mode',...commercialFields].includes(key))
    ||row.schemaVersion!==1||!['test','live'].includes(String(row.mode))||!validKey(row.key)||!integer(row.version,1)
    ||typeof row.name!=='string'||!row.name.trim()||row.name!==row.name.trim()||row.name.length>100||/[\u0000-\u001f]/.test(row.name)
    ||typeof row.currency!=='string'||!/^[a-z]{3}$/.test(row.currency)||!integer(row.priceMinor,1)
    ||row.billingInterval!=='MONTH'||row.trialDays!==0
    ||!integer(row.workspaceLimit,1)||!integer(row.memberLimit,1)||!integer(row.savedAdLimit)||!integer(row.monthlyAnalysisLimit)
    ||typeof row.providerPriceId!=='string'||!/^price_[A-Za-z0-9_]{1,120}$/.test(row.providerPriceId))throw new DomainError(400,'INVALID_PLAN_IMPORT');
  return row as PlanImport;
}
function commercialData(plan:PlanImport) {
  const {schemaVersion:_,mode:__,...data}=plan;
  return data;
}

/** Shared by public display, authenticated offers, and new purchases. Existing
 * subscriptions are reconciled independently of whether a plan is on sale. */
export function availablePlanWhere(config:{mode:'test'|'live'|'unconfigured';publicPricingEnabled?:boolean}):Prisma.PlanVersionWhereInput {
  const base:Prisma.PlanVersionWhereInput={status:'ACTIVE',providerPriceId:{not:null},currency:{not:null},priceMinor:{gt:0},billingInterval:'MONTH',trialDays:0,workspaceLimit:{gte:1},memberLimit:{gte:1},savedAdLimit:{gte:0},monthlyAnalysisLimit:{gte:0}};
  if(config.mode==='live'&&config.publicPricingEnabled===true)return {...base,verifiedProviderMode:'LIVE',publicConfirmedAt:{not:null}};
  if(config.mode==='test')return {...base,OR:[{verifiedProviderMode:'TEST'},{verifiedProviderMode:null}]};
  return {id:{in:[]}};
}
export async function lockPlanCatalog(tx:Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(1748210450)`;
}

/** Catalog changes never mutate subscribers. Stripe is used only for GET /v1/prices/:id. */
export function createPlanManagement(db:PrismaClient,stripe:Pick<Stripe,'prices'>|null,config:PlanManagementConfig) {
  if(!['test','live'].includes(config.mode))throw new DomainError(503,'PLAN_MODE_NOT_CONFIGURED');
  async function verifyPrice(plan:Pick<PlanImport,'providerPriceId'|'currency'|'priceMinor'>) {
    let price:Stripe.Price;
    try {if(!stripe)throw new Error('NO_PRICE_PROVIDER');price=await stripe.prices.retrieve(plan.providerPriceId);}
    catch {throw new DomainError(502,'PLAN_PRICE_VERIFICATION_FAILED');}
    if(price.id!==plan.providerPriceId||price.livemode!==(config.mode==='live')||price.active!==true||price.type!=='recurring'
      ||price.currency!==plan.currency||price.unit_amount!==plan.priceMinor||price.billing_scheme!=='per_unit'
      ||price.recurring?.interval!=='month'||price.recurring.interval_count!==1||price.recurring.usage_type!=='licensed'
      ||price.transform_quantity!=null||price.custom_unit_amount!=null)throw new DomainError(409,'PLAN_PRICE_MISMATCH');
  }
  async function catalogTransaction<T>(actorUserId:string,operation:(tx:Prisma.TransactionClient)=>Promise<T>) {
    return db.$transaction(async tx=>{
      // Shared account lock ensures a concurrent disable cannot pass the active-admin check.
      await lockAccountAdministration(tx);
      await requirePlatformAdmin(tx,actorUserId);
      // Also protects price uniqueness across different plan keys; the legacy model has no such unique index.
      await lockPlanCatalog(tx);
      return operation(tx);
    },{timeout:20000,maxWait:5000});
  }
  return {
    async importVersion(input:{actorUserId:string;plan:unknown}):Promise<PlanVersion> {
      const plan=parsePlanImport(input.plan);
      if(plan.mode!==config.mode)throw new DomainError(409,'PLAN_MODE_MISMATCH');
      return catalogTransaction(input.actorUserId,async tx=>{
        const prior=await tx.planVersion.findUnique({where:{key_version:{key:plan.key,version:plan.version}}});
        if(prior&&commercialFields.some(field=>prior[field]!==plan[field]))throw new DomainError(409,'PLAN_VERSION_IMMUTABLE');
        if(prior?.verifiedProviderMode&&prior.verifiedProviderMode!==config.mode.toUpperCase())throw new DomainError(409,'PLAN_MODE_MISMATCH');
        if(await tx.planVersion.count({where:{providerPriceId:plan.providerPriceId,...(prior?{id:{not:prior.id}}:{})}}))throw new DomainError(409,'PLAN_PRICE_ALREADY_ASSIGNED');
        await verifyPrice(plan);
        if(prior) {
          if(prior.verifiedProviderMode)return prior;
          const verified=await tx.planVersion.update({where:{id:prior.id},data:{verifiedProviderMode:config.mode.toUpperCase()}});
          await tx.auditEvent.create({data:{actorUserId:input.actorUserId,action:'PLAN_PRICE_VERIFIED',targetType:'PlanVersion',targetId:prior.id,metadata:{via:'LOCAL_CLI',mode:config.mode}}});
          return verified;
        }
        const created=await tx.planVersion.create({data:{...commercialData(plan),status:'DRAFT',verifiedProviderMode:config.mode.toUpperCase()}});
        await tx.auditEvent.create({data:{actorUserId:input.actorUserId,action:'PLAN_VERSION_IMPORTED',targetType:'PlanVersion',targetId:created.id,metadata:{via:'LOCAL_CLI',mode:config.mode,schemaVersion:1,plan:commercialData(plan)}}});
        return created;
      });
    },
    async activateVersion(input:{actorUserId:string;key:string;version:number}):Promise<PlanVersion> {
      if(!validKey(input.key)||!integer(input.version,1))throw new DomainError(400,'INVALID_PLAN_VERSION');
      if(config.mode==='live'&&config.livePaymentsEnabled!==true)throw new DomainError(503,'LIVE_BILLING_NOT_ENABLED');
      return catalogTransaction(input.actorUserId,async tx=>{
        const plan=await tx.planVersion.findUnique({where:{key_version:{key:input.key,version:input.version}}});
        if(!plan)throw new DomainError(404,'PLAN_NOT_FOUND');
        if(!['DRAFT','ACTIVE'].includes(plan.status))throw new DomainError(409,'PLAN_NOT_ACTIVATABLE');
        if(plan.verifiedProviderMode&&plan.verifiedProviderMode!==config.mode.toUpperCase())throw new DomainError(409,'PLAN_MODE_MISMATCH');
        // Legacy/manual catalog rows must meet the same explicit contract before they can be enabled.
        const specification=parsePlanImport({schemaVersion:1,mode:config.mode,...Object.fromEntries(commercialFields.map(field=>[field,plan[field]]))});
        if(await tx.planVersion.count({where:{providerPriceId:plan.providerPriceId,id:{not:plan.id}}}))throw new DomainError(409,'PLAN_PRICE_ALREADY_ASSIGNED');
        await verifyPrice(specification);
        if(plan.status==='ACTIVE'&&plan.verifiedProviderMode)return plan;
        const activated=await tx.planVersion.update({where:{id:plan.id},data:{status:'ACTIVE',verifiedProviderMode:config.mode.toUpperCase()}});
        await tx.auditEvent.create({data:{actorUserId:input.actorUserId,action:plan.status==='ACTIVE'?'PLAN_PRICE_VERIFIED':'PLAN_VERSION_ACTIVATED',targetType:'PlanVersion',targetId:plan.id,metadata:{via:'LOCAL_CLI',mode:config.mode,key:plan.key,version:plan.version,providerPriceId:plan.providerPriceId}}});
        return activated;
      });
    },
    async publishVersion(input:{actorUserId:string;key:string;version:number}):Promise<PlanVersion> {
      if(!validKey(input.key)||!integer(input.version,1))throw new DomainError(400,'INVALID_PLAN_VERSION');
      return catalogTransaction(input.actorUserId,async tx=>{
        if(config.mode!=='live')throw new DomainError(409,'PUBLIC_PLAN_REQUIRES_LIVE');
        if(!config.livePaymentsEnabled)throw new DomainError(503,'LIVE_BILLING_NOT_ENABLED');
        const plan=await tx.planVersion.findUnique({where:{key_version:{key:input.key,version:input.version}}});
        if(!plan)throw new DomainError(404,'PLAN_NOT_FOUND');
        if(plan.status!=='ACTIVE'||plan.verifiedProviderMode!=='LIVE')throw new DomainError(409,'PLAN_NOT_PUBLISHABLE');
        const specification=parsePlanImport({schemaVersion:1,mode:'live',...Object.fromEntries(commercialFields.map(field=>[field,plan[field]]))});
        if(await tx.planVersion.count({where:{providerPriceId:plan.providerPriceId,id:{not:plan.id}}}))throw new DomainError(409,'PLAN_PRICE_ALREADY_ASSIGNED');
        await verifyPrice(specification);
        if(plan.publicConfirmedAt)return plan;
        const published=await tx.planVersion.update({where:{id:plan.id},data:{publicConfirmedAt:new Date()}});
        await tx.auditEvent.create({data:{actorUserId:input.actorUserId,action:'PLAN_PUBLICATION_CONFIRMED',targetType:'PlanVersion',targetId:plan.id,metadata:{via:'LOCAL_CLI',mode:'live',key:plan.key,version:plan.version,plan:commercialData(specification)}}});
        return published;
      });
    },
    async unpublishVersion(input:{actorUserId:string;key:string;version:number}):Promise<PlanVersion> {
      if(!validKey(input.key)||!integer(input.version,1))throw new DomainError(400,'INVALID_PLAN_VERSION');
      return catalogTransaction(input.actorUserId,async tx=>{
        const plan=await tx.planVersion.findUnique({where:{key_version:{key:input.key,version:input.version}}});
        if(!plan)throw new DomainError(404,'PLAN_NOT_FOUND');
        if(!plan.publicConfirmedAt)return plan;
        const withdrawn=await tx.planVersion.update({where:{id:plan.id},data:{publicConfirmedAt:null}});
        await tx.auditEvent.create({data:{actorUserId:input.actorUserId,action:'PLAN_PUBLICATION_WITHDRAWN',targetType:'PlanVersion',targetId:plan.id,metadata:{via:'LOCAL_CLI',key:plan.key,version:plan.version}}});
        return withdrawn;
      });
    },
  };
}
