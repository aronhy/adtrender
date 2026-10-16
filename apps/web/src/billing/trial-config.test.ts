import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {afterAll,describe,expect,it} from 'vitest';
import {trialConfigFromEnvironment} from './trial-config';
import {initializeTrial} from './quotas';

const production={NODE_ENV:'production',TRIAL_DAYS:'7',TRIAL_WORKSPACES:'2',TRIAL_MEMBERS:'4',TRIAL_SAVED_ADS:'80',TRIAL_ANALYSES:'11'};
describe('explicit trial environment contract',()=>{
  it('keeps the existing documented defaults in development only',()=>{
    expect(trialConfigFromEnvironment({})).toEqual({days:14,workspaces:1,members:3,savedAds:100,analyses:20});
    expect(trialConfigFromEnvironment({TRIAL_DAYS:'3'})).toMatchObject({days:3,members:3});
  });
  it('requires every commercial trial value in production',()=>{
    expect(trialConfigFromEnvironment(production)).toEqual({days:7,workspaces:2,members:4,savedAds:80,analyses:11});
    for(const name of ['TRIAL_DAYS','TRIAL_WORKSPACES','TRIAL_MEMBERS','TRIAL_SAVED_ADS','TRIAL_ANALYSES']) {
      const env:NodeJS.ProcessEnv={...production};delete env[name];expect(()=>trialConfigFromEnvironment(env)).toThrow('TRIAL_NOT_CONFIGURED');
    }
  });
  it('rejects partial numbers, zero, excessive days and numbers outside PostgreSQL integer bounds',()=>{
    for(const value of ['','0','-1','1.5','1e2','Infinity','NaN','7days','2147483648','9007199254740992']) {
      expect(()=>trialConfigFromEnvironment({...production,TRIAL_ANALYSES:value})).toThrow('INVALID_TRIAL_CONFIG');
    }
    expect(()=>trialConfigFromEnvironment({...production,TRIAL_DAYS:'91'})).toThrow('INVALID_TRIAL_CONFIG');
  });
  it('normalizes property ordering so equivalent environment inputs produce the same version hash',()=>{
    const reverse=Object.fromEntries(Object.entries(production).reverse());
    expect(JSON.stringify(trialConfigFromEnvironment(reverse))).toBe(JSON.stringify(trialConfigFromEnvironment(production)));
  });
});

const testUrl=process.env.SAAS_TEST_DATABASE_URL;
const db=new PrismaClient({datasources:{db:{url:testUrl??'postgresql://unused@127.0.0.1:1/not_run'}}});
afterAll(()=>db.$disconnect());
describe.skipIf(!testUrl)('trial configuration versions against PostgreSQL',()=>{
  it('versions changed quotas and leaves existing subscriptions and entitlements unchanged',async()=>{
    const config=trialConfigFromEnvironment(production),changed=trialConfigFromEnvironment({...production,TRIAL_ANALYSES:'12'});
    const user=await db.user.create({data:{email:`trial-config-${randomUUID()}@example.test`}});
    async function create(trial:typeof config) {
      return db.$transaction(async tx=>{
        const organization=await tx.organization.create({data:{name:'Configured trial fixture',slug:randomUUID(),members:{create:{userId:user.id,role:'OWNER'}}}});
        await initializeTrial(tx,organization.id,trial);
        return tx.subscription.findUniqueOrThrow({where:{organizationId:organization.id},include:{planVersion:true}});
      });
    }
    const original=await create(config),same=await create(config),newVersion=await create(changed);
    expect(original.planVersionId).toBe(same.planVersionId);expect(newVersion.planVersionId).not.toBe(original.planVersionId);
    expect(original.planVersion).toMatchObject({trialDays:7,workspaceLimit:2,memberLimit:4,savedAdLimit:80,monthlyAnalysisLimit:11});
    expect(newVersion.planVersion.monthlyAnalysisLimit).toBe(12);
    expect(await db.subscription.findUnique({where:{id:original.id},include:{planVersion:true}})).toEqual(original);
    expect(await db.entitlement.findFirst({where:{organizationId:original.organizationId,key:'ANALYSES'}})).toMatchObject({limit:11,used:0,reserved:0});
  });
});
