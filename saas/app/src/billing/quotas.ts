import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { DomainError } from '../team/access';
export type QuotaKey = 'WORKSPACES'|'MEMBERS'|'SAVED_ADS'|'ANALYSES';
export type TrialConfig = { days:number;workspaces:number;members:number;savedAds:number;analyses:number };
export async function lockOrganization(tx:Prisma.TransactionClient, organizationId:string) {
  const rows = await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM "Organization" WHERE id=${organizationId} AND status='ACTIVE' FOR UPDATE`;
  if (!rows.length) throw new DomainError(403,'ORGANIZATION_FORBIDDEN');
}
function quantityCheck(quantity:number) {
  if (!Number.isSafeInteger(quantity) || quantity<1) throw new DomainError(400,'INVALID_QUANTITY');
}
function findActiveEntitlement(tx:Prisma.TransactionClient, organizationId:string,key:QuotaKey,now:Date) {
  return tx.entitlement.findFirst({where:{organizationId,key,validFrom:{lte:now},OR:[{validUntil:null},{validUntil:{gt:now}}]},orderBy:{periodStart:'desc'}});
}
export async function activeEntitlement(tx:Prisma.TransactionClient, organizationId:string,key:QuotaKey) {
  const [clock] = await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AS now`;
  const entitlement = await findActiveEntitlement(tx,organizationId,key,clock.now);
  if (!entitlement) throw new DomainError(402,'ENTITLEMENT_EXPIRED','试用或订阅已到期，已有研究仍可查看。');
  return entitlement;
}
export async function initializeTrial(tx:Prisma.TransactionClient,organizationId:string,config:TrialConfig={days:14,workspaces:1,members:3,savedAds:100,analyses:20}):Promise<void> {
  await lockOrganization(tx,organizationId);
  if (await tx.subscription.findUnique({where:{organizationId}})) return;
  if (Object.values(config).some(n=>!Number.isSafeInteger(n)||n<1) || config.days>90) throw new DomainError(400,'INVALID_TRIAL_CONFIG');
  const key='trial-'+createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0,16);
  const plan=await tx.planVersion.upsert({where:{key_version:{key,version:1}},create:{key,version:1,name:'试用',status:'ACTIVE',trialDays:config.days,workspaceLimit:config.workspaces,memberLimit:config.members,savedAdLimit:config.savedAds,monthlyAnalysisLimit:config.analyses},update:{}});
  const now=new Date(),end=new Date(now.getTime()+config.days*86400000);
  await tx.subscription.create({data:{organizationId,planVersionId:plan.id,status:'TRIALING',provider:'TRIAL',currentPeriodStart:now,currentPeriodEnd:end,trialEndsAt:end}});
  for (const [key,limit] of Object.entries({WORKSPACES:config.workspaces,MEMBERS:config.members,SAVED_ADS:config.savedAds,ANALYSES:config.analyses})) {
    await tx.entitlement.create({data:{organizationId,key,limit,validFrom:now,validUntil:end,periodStart:now,periodEnd:end}});
  }
}
export async function admitQuota(tx:Prisma.TransactionClient,organizationId:string,key:QuotaKey,quantity:number):Promise<void> {
  quantityCheck(quantity); await lockOrganization(tx,organizationId);
  const row=await activeEntitlement(tx,organizationId,key);
  if (row.used+row.reserved+quantity>row.limit) throw new DomainError(402,'QUOTA_EXCEEDED','当前套餐额度不足。');
  await tx.entitlement.update({where:{id:row.id},data:{used:{increment:quantity},version:{increment:1}}});
}
export async function releaseQuota(tx:Prisma.TransactionClient,organizationId:string,key:QuotaKey,quantity:number):Promise<void> {
  quantityCheck(quantity); await lockOrganization(tx,organizationId);
  const [clock] = await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AS now`;
  // A replaced trial can start later than the paid period. Release the active
  // allowance first; after expiry use the last ended period, never a future one.
  const row=await findActiveEntitlement(tx,organizationId,key,clock.now)
    ?? await tx.entitlement.findFirst({where:{organizationId,key,validFrom:{lte:clock.now},validUntil:{lte:clock.now}},orderBy:[{validUntil:'desc'},{periodStart:'desc'}]});
  if (!row || row.used<quantity) throw new DomainError(409,'QUOTA_COUNT_MISMATCH');
  await tx.entitlement.update({where:{id:row.id},data:{used:{decrement:quantity},version:{increment:1}}});
}
export async function reserveAnalysis(tx:Prisma.TransactionClient,organizationId:string,idempotencyKey:string) {
  if (!idempotencyKey || idempotencyKey.length>160) throw new DomainError(400,'INVALID_IDEMPOTENCY_KEY');
  await lockOrganization(tx,organizationId);
  const prior=await tx.usageLedger.findUnique({where:{organizationId_idempotencyKey:{organizationId,idempotencyKey}}});
  if (prior) return prior;
  const row=await activeEntitlement(tx,organizationId,'ANALYSES');
  if (row.used+row.reserved>=row.limit) throw new DomainError(402,'QUOTA_EXCEEDED','本周期分析额度不足。');
  await tx.entitlement.update({where:{id:row.id},data:{reserved:{increment:1},version:{increment:1}}});
  return tx.usageLedger.create({data:{organizationId,entitlementId:row.id,idempotencyKey,quantity:1}});
}
export async function settleUsage(tx:Prisma.TransactionClient,organizationId:string,id:string):Promise<void> {
  await lockOrganization(tx,organizationId);
  const usage=await tx.usageLedger.findFirst({where:{id,organizationId}});
  if (!usage) throw new DomainError(404,'USAGE_NOT_FOUND');
  if (usage.status==='SETTLED') return;
  if (usage.status!=='RESERVED') throw new DomainError(409,'USAGE_RELEASED');
  const updated=await tx.entitlement.updateMany({where:{id:usage.entitlementId,organizationId,reserved:{gte:usage.quantity}},data:{reserved:{decrement:usage.quantity},used:{increment:usage.quantity},version:{increment:1}}});
  if (updated.count!==1) throw new DomainError(409,'QUOTA_COUNT_MISMATCH');
  await tx.usageLedger.update({where:{id},data:{status:'SETTLED',settledAt:new Date()}});
}
export async function releaseUsage(tx:Prisma.TransactionClient,organizationId:string,id:string,reason:string):Promise<void> {
  await lockOrganization(tx,organizationId);
  const usage=await tx.usageLedger.findFirst({where:{id,organizationId}});
  if (!usage) throw new DomainError(404,'USAGE_NOT_FOUND');
  if (usage.status==='RELEASED') return;
  if (usage.status!=='RESERVED') throw new DomainError(409,'USAGE_ALREADY_SETTLED');
  const updated=await tx.entitlement.updateMany({where:{id:usage.entitlementId,organizationId,reserved:{gte:usage.quantity}},data:{reserved:{decrement:usage.quantity},version:{increment:1}}});
  if (updated.count!==1) throw new DomainError(409,'QUOTA_COUNT_MISMATCH');
  await tx.usageLedger.update({where:{id},data:{status:'RELEASED',releasedAt:new Date(),releaseReason:reason.slice(0,80)}});
}
