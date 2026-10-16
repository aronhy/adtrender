import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {previewSeedImport,commitSeedImport,setSeedStatus,confirmSeedRelation} from './admin';
import {listSeedPage,listSeedImportPreview} from './queries';
const url=process.env.SAAS_TEST_DATABASE_URL;
describe.skipIf(!url)('seed administration with durable import previews',()=>{
 it('previews invalid rows, commits once, preserves countries and denies ordinary users',async()=>{
  const target=new URL(url!);if(!['127.0.0.1','localhost'].includes(target.hostname)||!target.pathname.includes('_test_'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const {PrismaClient}=createRequire(new URL('../../package.json',import.meta.url))('@prisma/client');const db=new PrismaClient({datasources:{db:{url}}});
  const suffix=randomUUID(),admin=await db.user.create({data:{email:`seed-import-${suffix}@example.test`,isAdmin:true}}),member=await db.user.create({data:{email:`seed-normal-${suffix}@example.test`}});
  const csv=`country,query_language,family,category,keyword\nUS,en,GAMES,slots,${suffix}\nGB,en,GAMES,slots,${suffix}\nZZ,invalid!,GAMES,slots,bad\n`;
  try{
   const job=await previewSeedImport(db,{actorUserId:admin.id,idempotencyKey:'preview',reason:'import fixture',csv});expect(job.counts.invalid).toBe(1);
   await expect(listSeedImportPreview(db,{userId:member.id,importId:job.targetId})).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});
   const preview=await listSeedImportPreview(db,{userId:admin.id,importId:job.targetId});expect(preview.items).toHaveLength(3);expect(preview.status).toBe('PREVIEWED');
   await expect(commitSeedImport(db,{actorUserId:admin.id,targetId:job.targetId,mode:'ALL_OR_NOTHING',idempotencyKey:'strict',reason:'fixture'})).rejects.toMatchObject({code:'SEED_IMPORT_HAS_ERRORS'});
   const command={actorUserId:admin.id,targetId:job.targetId,mode:'SKIP_ERRORS' as const,idempotencyKey:'commit',reason:'fixture'};
   const result=await commitSeedImport(db,command);expect(await commitSeedImport(db,command)).toEqual(result);expect(result.inserted).toBe(1);
   const page=await listSeedPage(db,{userId:admin.id,query:suffix,limit:1});expect(page.items).toHaveLength(1);expect(page.items[0].targetScope).toEqual({kind:'EXPLICIT_COUNTRIES',countries:['GB','US']});
   const seed=page.items[0];await setSeedStatus(db,{actorUserId:admin.id,targetId:seed.id,expectedRevision:seed.revision,status:'ACTIVE',idempotencyKey:'activate',reason:'fixture'});expect(await db.seedQueryBinding.count({where:{seedId:seed.id}})).toBe(0);
   const other=await db.seedDefinition.create({data:{kind:'NAME',namespace:'relation-fixture',language:'und',rawValue:'Other '+suffix,normalizedValue:('Other '+suffix).toLowerCase(),targetScope:{kind:'CONFIGURED_MARKETS'},purposeTags:[],targetPlatforms:['meta_ad_library']}});
   const relation=await db.seedRelation.create({data:{fromSeedId:seed.id,toSeedId:other.id,relationType:'ALIAS_OF'}});
   await expect(confirmSeedRelation(db,{actorUserId:admin.id,targetId:relation.id,decision:'CONFIRMED',idempotencyKey:'relation',reason:'fixture'})).rejects.toMatchObject({code:'SEED_RELATION_EVIDENCE_REQUIRED'});
  }finally{await db.$disconnect();}
 });
});
