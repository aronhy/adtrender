import {createRequire} from 'node:module';import {randomUUID} from 'node:crypto';import {describe,it,expect} from 'vitest';
import {importAdvertiserDirectory} from './directory';
const url=process.env.SAAS_TEST_DATABASE_URL;
describe.skipIf(!url)('shared advertiser-name directory import',()=>{
 it('imports old source-only catalogs as draft clues for all three name platforms without native identities',async()=>{
  const u=new URL(url!);if(!['localhost','127.0.0.1'].includes(u.hostname)||!u.pathname.includes('_test_'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const {PrismaClient}=createRequire(new URL('../../package.json',import.meta.url))('@prisma/client'),db=new PrismaClient({datasources:{db:{url}}}),id=randomUUID(),admin=await db.user.create({data:{email:`directory-${id}@example.test`,isAdmin:true}});
  const feed=JSON.stringify({schema:1,generatedAt:new Date().toISOString(),candidates:[{publisher:'Brand '+id,sources:['meta_ad_library','google_ads_transparency']},{publisher:'BRAND '+id,sources:['snapchat_ads_gallery']}]});
  try{
   const command={actorUserId:admin.id,idempotencyKey:'directory',reason:'catalog fixture',json:feed};await importAdvertiserDirectory(db,command);await importAdvertiserDirectory(db,{...command,idempotencyKey:'directory-replay'});
   const rows=await db.seedDefinition.findMany({where:{namespace:'advertiser_name_directory',normalizedValue:'brand '+id},include:{evidence:true}});expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({kind:'NAME',status:'DRAFT',verificationStatus:'CANDIDATE'});expect(rows[0].targetPlatforms.sort()).toEqual(['google_ads_transparency','meta_ad_library','snapchat_ads_gallery']);expect(rows[0].evidence).toHaveLength(3);expect(rows[0].evidence.every((e:any)=>e.originKind==='DIRECTORY_ONLY'&&e.observationId===null&&e.runId===null)).toBe(true);expect(await db.seedQueryBinding.count({where:{seedId:rows[0].id}})).toBe(0);
  }finally{await db.$disconnect();}
 });
});
