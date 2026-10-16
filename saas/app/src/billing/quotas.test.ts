import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { initializeTrial, admitQuota, releaseQuota, reserveAnalysis, settleUsage, releaseUsage } from './quotas';

const db = new PrismaClient({datasources: {db: {url: process.env.SAAS_TEST_DATABASE_URL ?? 'postgresql://saas_local@127.0.0.1:55438/saas_test'}}});
afterAll(() => db.$disconnect());
async function fixture() {
  const id = randomUUID();
  const user = await db.user.create({data:{email:`quota-${id}@example.org`}});
  const org = await db.organization.create({data:{name:'Quota test',slug:id,members:{create:{userId:user.id,role:'OWNER'}}}});
  await db.$transaction(tx => initializeTrial(tx, org.id, {days:7,workspaces:2,members:2,savedAds:3,analyses:2}));
  return org;
}
describe('transactional organization quotas', () => {
  it('never over-reserves with concurrent requests and deduplicates retries', async () => {
    const org = await fixture();
    const attempts = await Promise.allSettled(Array.from({length:8},(_,i) => db.$transaction(tx => reserveAnalysis(tx, org.id, `job-${i}`))));
    expect(attempts.filter(x=>x.status==='fulfilled')).toHaveLength(2);
    const row = await db.entitlement.findFirstOrThrow({where:{organizationId:org.id,key:'ANALYSES'}});
    expect([row.used,row.reserved]).toEqual([0,2]);
    const first = await db.usageLedger.findFirstOrThrow({where:{organizationId:org.id}});
    const again = await db.$transaction(tx => reserveAnalysis(tx, org.id, first.idempotencyKey));
    expect(again.id).toBe(first.id);
    await db.$transaction(tx => settleUsage(tx,org.id,first.id));
    await db.$transaction(tx => settleUsage(tx,org.id,first.id));
    const after = await db.entitlement.findUniqueOrThrow({where:{id:row.id}});
    expect([after.used,after.reserved]).toEqual([1,1]);
  });
  it('releases failures once and forbids settling a released reservation', async () => {
    const org = await fixture();
    const usage = await db.$transaction(tx => reserveAnalysis(tx,org.id,'failed-job'));
    await db.$transaction(tx=>releaseUsage(tx,org.id,usage.id,'MODEL_FAILURE'));
    await db.$transaction(tx=>releaseUsage(tx,org.id,usage.id,'MODEL_FAILURE'));
    await expect(db.$transaction(tx=>settleUsage(tx,org.id,usage.id))).rejects.toMatchObject({code:'USAGE_RELEASED'});
    const row = await db.entitlement.findUniqueOrThrow({where:{id:usage.entitlementId}});
    expect([row.used,row.reserved]).toEqual([0,0]);
  });
  it('retains paid-period access after cancellation but rejects expired entitlements', async () => {
    const org = await fixture();
    await db.subscription.update({where:{organizationId:org.id},data:{cancelAtPeriodEnd:true}});
    await db.$transaction(tx=>admitQuota(tx,org.id,'WORKSPACES',1));
    await db.entitlement.updateMany({where:{organizationId:org.id},data:{validUntil:new Date(0)}});
    await expect(db.$transaction(tx=>admitQuota(tx,org.id,'WORKSPACES',1))).rejects.toMatchObject({code:'ENTITLEMENT_EXPIRED'});
    expect(await db.organization.findUnique({where:{id:org.id}})).not.toBeNull();
  });
  it('preserves over-limit records on downgrade and releases counts without new rights', async () => {
    const org = await fixture();
    await db.$transaction(tx=>admitQuota(tx,org.id,'SAVED_ADS',3));
    await db.entitlement.updateMany({where:{organizationId:org.id,key:'SAVED_ADS'},data:{limit:1}});
    await expect(db.$transaction(tx=>admitQuota(tx,org.id,'SAVED_ADS',1))).rejects.toMatchObject({code:'QUOTA_EXCEEDED'});
    await db.$transaction(tx=>releaseQuota(tx,org.id,'SAVED_ADS',1));
    const row = await db.entitlement.findFirstOrThrow({where:{organizationId:org.id,key:'SAVED_ADS'}});
    expect([row.limit,row.used]).toEqual([1,2]);
  });
  it('rejects foreign ledger ids and invalid quantities', async () => {
    const a=await fixture(), b=await fixture();
    const usage=await db.$transaction(tx=>reserveAnalysis(tx,a.id,'private'));
    await expect(db.$transaction(tx=>settleUsage(tx,b.id,usage.id))).rejects.toMatchObject({code:'USAGE_NOT_FOUND'});
    await expect(db.$transaction(tx=>admitQuota(tx,a.id,'MEMBERS',-1))).rejects.toMatchObject({code:'INVALID_QUANTITY'});
  });
});
