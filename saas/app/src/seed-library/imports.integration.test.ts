import {createRequire} from 'node:module';import {randomUUID} from 'node:crypto';import {describe,it,expect} from 'vitest';
import {saveSeedDefinition,importSeedBaseline} from './catalog';
const url=process.env.SAAS_TEST_DATABASE_URL;
describe.skipIf(!url)('seed catalog PostgreSQL commands',()=>{
 it('deduplicates baseline, preserves evidence and rejects privilege and revision conflicts',async()=>{
  const u=new URL(url!);if(!['127.0.0.1','localhost'].includes(u.hostname)||!u.pathname.includes('_test_'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const {PrismaClient}=createRequire(new URL('../../package.json',import.meta.url))('@prisma/client');const db=new PrismaClient({datasources:{db:{url}}});
  const suffix=randomUUID();const admin=await db.user.create({data:{email:`seed-admin-${suffix}@example.test`,isAdmin:true}}),member=await db.user.create({data:{email:`seed-member-${suffix}@example.test`}});
  const payload={kind:'NAME',namespace:'fixture',rawValue:'Brand '+suffix,language:'en',purposeTags:[{family:'GAMES',category:'slots'}],targetScope:{kind:'CONFIGURED_MARKETS'},targetPlatforms:['snapchat_ads_gallery'],status:'DRAFT',priority:0};
  try{
   await expect(saveSeedDefinition(db,{actorUserId:member.id,payload,idempotencyKey:'one',reason:'fixture'})).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});
   const first=await saveSeedDefinition(db,{actorUserId:admin.id,payload,idempotencyKey:'one',reason:'fixture'});const repeated=await saveSeedDefinition(db,{actorUserId:admin.id,payload,idempotencyKey:'one',reason:'fixture'});expect(repeated).toEqual(first);
   await expect(saveSeedDefinition(db,{actorUserId:admin.id,payload:{...payload,rawValue:'different'},idempotencyKey:'one',reason:'fixture'})).rejects.toMatchObject({code:'SEED_IDEMPOTENCY_CONFLICT'});
   await expect(saveSeedDefinition(db,{actorUserId:admin.id,targetId:first.targetId,expectedRevision:0,payload,idempotencyKey:'edit',reason:'fixture'})).rejects.toMatchObject({code:'SEED_REVISION_CONFLICT'});
   const input={actorUserId:admin.id,definitions:[payload],idempotencyKey:'baseline-'+suffix,reason:'baseline fixture'};const a=await importSeedBaseline(db,input);const b=await importSeedBaseline(db,input);expect(a).toEqual(b);expect(await db.seedDefinition.count({where:{normalizedValue:payload.rawValue.toLowerCase()}})).toBe(1);
   await expect(saveSeedDefinition(db,{actorUserId:admin.id,payload:{...payload,verificationStatus:'VERIFIED'},idempotencyKey:'spoof',reason:'fixture'})).rejects.toMatchObject({code:'SEED_VERIFICATION_SERVER_ONLY'});
  }finally{await db.$disconnect();}
 });
});
