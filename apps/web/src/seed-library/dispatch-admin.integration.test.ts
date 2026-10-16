import {createRequire} from 'node:module';import {randomUUID} from 'node:crypto';import {describe,it,expect} from 'vitest';
import {runSeedDispatchAdminCommand} from './dispatch-admin';
const url=process.env.SAAS_TEST_DATABASE_URL;
describe.skipIf(!url)('audited seed dispatch administration',()=>{
 it('requires an administrator, replays node registration, and cannot clear source cooldown on resume',async()=>{
  const u=new URL(url!);if(!['localhost','127.0.0.1'].includes(u.hostname)||!u.pathname.includes('_test_'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const {PrismaClient}=createRequire(new URL('../../package.json',import.meta.url))('@prisma/client'),db=new PrismaClient({datasources:{db:{url}}});
  const id=randomUUID(),admin=await db.user.create({data:{email:`control-${id}@example.test`,isAdmin:true}}),member=await db.user.create({data:{email:`control-member-${id}@example.test`}});
  const env={COLLECTOR_DISPATCH_ENABLED:'true',COLLECTOR_GRANT_SECRET:'fixture-secret-with-at-least-thirty-two-chars',COLLECTOR_LEASE_MS:'120000',COLLECTOR_REQUEST_BUDGET_MS:'30000',COLLECTOR_EXIT_MARGIN_MS:'10000',COLLECTOR_REQUEST_SPACING_MS:'1000',COLLECTOR_CYCLE_MS:'60000',COLLECTOR_UNKNOWN_BACKOFF_MS:'60000',COLLECTOR_EVIDENCE_ROOT:'/private/tmp/seed-admin-unused-fixture'};
  const input={actorUserId:admin.id,type:'REGISTER_COLLECTOR_NODE',idempotencyKey:'register',reason:'fixture',payload:{nodeId:`control-${id}`,incarnationId:randomUUID(),registryRevision:1,enabled:true,expiresAt:'2026-11-01T00:00:00.000Z',codeRevision:'fixture',protocolVersions:[1]}};
  try{
   await expect(runSeedDispatchAdminCommand(db,{...input,actorUserId:member.id},env)).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});
   const first=await runSeedDispatchAdminCommand(db,input,env);expect(await runSeedDispatchAdminCommand(db,input,env)).toEqual(first);expect(first.status).toBe('REGISTERED');
   const source=await db.dataSource.upsert({where:{key:'snapchat_ads_gallery'},create:{key:'snapchat_ads_gallery',name:'fixture',adapterVersion:'fixture'},update:{}}),notBefore=new Date(Date.now()+86400000);
   await db.collectorSourceControl.upsert({where:{sourceKey_channel_scopeKey:{sourceKey:source.key,channel:'*',scopeKey:'SOURCE'}},create:{dataSourceId:source.id,sourceKey:source.key,channel:'*',scopeKey:'SOURCE',manualPause:true,notBefore},update:{manualPause:true,notBefore}});
   await runSeedDispatchAdminCommand(db,{actorUserId:admin.id,type:'SET_COLLECTOR_SOURCE_PAUSE',idempotencyKey:'resume',reason:'operator resume',payload:{sourceKey:source.key,manualPause:false}},env);
   const control=await db.collectorSourceControl.findUnique({where:{sourceKey_channel_scopeKey:{sourceKey:source.key,channel:'*',scopeKey:'SOURCE'}}});expect(control.manualPause).toBe(false);expect(control.notBefore).toEqual(notBefore);
   await expect(runSeedDispatchAdminCommand(db,{...input,idempotencyKey:'unknown',type:'ARBITRARY_COMMAND'},env)).rejects.toMatchObject({code:'SEED_DISPATCH_COMMAND_INVALID'});
  }finally{await db.$disconnect();}
 });
});
