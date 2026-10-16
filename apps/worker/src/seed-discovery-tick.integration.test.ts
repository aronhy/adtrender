import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {seedDiscoveryTick,evidenceStoresFromEnvironment} from './seed-control';
import {collectorEvidenceKey} from './collector-evidence';

const url=process.env.SAAS_TEST_DATABASE_URL;let db:any;
beforeAll(()=>{if(!url)return;const u=new URL(url);if(!['localhost','127.0.0.1'].includes(u.hostname)||!u.pathname.includes('_test_'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');const {PrismaClient}=createRequire(new URL('../../web/package.json',import.meta.url))('@prisma/client');db=new PrismaClient({datasources:{db:{url}}});});
afterAll(async()=>{await db?.$disconnect();});
describe.skipIf(!url)('discovery lane reads server-configured exact-byte namespace',()=>{
 it('projects only the configured source while preserving the default all-source behavior',async()=>{
  const stop=Error('TEST_ROLLBACK');
  try{await db.$transaction(async(tx:any)=>{
   const suffix=randomUUID(),runIds:string[]=[],bySource:Record<string,string>={};
   for(const key of ['meta_ad_library','google_ads_transparency']){
    const source=await tx.dataSource.upsert({where:{key},create:{key,name:'Synthetic filtered discovery',adapterVersion:'fixture'},update:{}});
    const task=await tx.collectionTask.create({data:{dataSourceId:source.id,name:'Synthetic filtered '+suffix,query:{},status:'PAUSED'}});
    const observedAt=new Date(),sourceAdId=key+suffix,snapshot={sourceAdId,advertiserName:'Synthetic '+key+' '+suffix};
    const run=await tx.collectionRun.create({data:{dataSourceId:source.id,taskId:task.id,querySnapshot:{},adapterVersion:'fixture',idempotencyKey:key+suffix,status:'SUCCEEDED',finishedAt:observedAt}});
    const ad=await tx.ad.create({data:{dataSourceId:source.id,sourceAdId,sourceUrl:'https://example.invalid/'+suffix}});
    await tx.runItem.create({data:{runId:run.id,dataSourceId:source.id,sourceAdId,adId:ad.id,itemKey:sourceAdId,status:'INGESTED',parserVersion:'fixture'}});
    await tx.adObservation.create({data:{dataSourceId:source.id,adId:ad.id,collectionRunId:run.id,observedAt,snapshot,parserVersion:'fixture'}});
    runIds.push(run.id);bySource[key]=run.id;
   }
   const scopedRuns=new Proxy(tx.collectionRun,{get(target,name){if(name==='findMany')return(args:any)=>target.findMany({...args,where:{AND:[args.where,{id:{in:runIds}}]}});return Reflect.get(target,name);}});
   const api=new Proxy(tx,{get(target,name){if(name==='collectionRun')return scopedRuns;if(name==='$transaction')return(body:(db:any)=>Promise<unknown>)=>body(tx);return Reflect.get(target,name);}});
   expect(await seedDiscoveryTick(api,{extractionVersion:'public-clues-filter-test',sourceKeys:['meta_ad_library']} as any)).toEqual({processed:1,skipped:0,failed:0});
   expect(await tx.seedEvidence.count({where:{runId:bySource.meta_ad_library}})).toBeGreaterThan(0);
   expect(await tx.seedEvidence.count({where:{runId:bySource.google_ads_transparency}})).toBe(0);
   expect(await tx.auditEvent.count({where:{action:'SEED_DISCOVERY_RECONCILED',targetId:bySource.google_ads_transparency}})).toBe(0);
   expect(await seedDiscoveryTick(api,{extractionVersion:'public-clues-filter-test'})).toEqual({processed:1,skipped:1,failed:0});
   const original=await tx.collectionRun.findUniqueOrThrow({where:{id:bySource.meta_ad_library}}),observedAt=new Date(),sourceAdId='later-'+suffix;
   const later=await tx.collectionRun.create({data:{dataSourceId:original.dataSourceId,taskId:original.taskId,querySnapshot:{},adapterVersion:'fixture',idempotencyKey:sourceAdId,status:'SUCCEEDED',finishedAt:observedAt}});
   const laterAd=await tx.ad.create({data:{dataSourceId:original.dataSourceId,sourceAdId,sourceUrl:'https://example.invalid/later/'+suffix}});
   await tx.runItem.create({data:{runId:later.id,dataSourceId:original.dataSourceId,sourceAdId,adId:laterAd.id,itemKey:sourceAdId,status:'INGESTED',parserVersion:'fixture'}});
   await tx.adObservation.create({data:{dataSourceId:original.dataSourceId,adId:laterAd.id,collectionRunId:later.id,observedAt,snapshot:{sourceAdId,advertiserName:'Synthetic later '+suffix},parserVersion:'fixture'}});
   runIds.push(later.id);
   expect(await seedDiscoveryTick(api,{extractionVersion:'public-clues-filter-test',sourceKeys:['meta_ad_library']})).toEqual({processed:1,skipped:1,failed:0});
   expect(await tx.seedDefinition.findFirst({where:{rawValue:'Synthetic later '+suffix}})).toMatchObject({status:'DRAFT',verificationStatus:'CANDIDATE'});
   throw stop;
  },{timeout:30000});}catch(error){if(error!==stop)throw error;}
 });
 it('rejects empty and unknown source filters before reading facts',async()=>{
  await expect(seedDiscoveryTick({}, {extractionVersion:'filter-test',sourceKeys:[]} as any)).rejects.toThrow('SEED_DISCOVERY_SOURCE_FILTER_INVALID');
  await expect(seedDiscoveryTick({}, {extractionVersion:'filter-test',sourceKeys:['unknown']} as any)).rejects.toThrow('SEED_DISCOVERY_SOURCE_FILTER_INVALID');
 });
 it('passes a custom evidencePrefix through the real stores spread into the real discovery tick',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'seed-tick-prefix-')),stop=Error('TEST_ROLLBACK');
  try{await db.$transaction(async(tx:any)=>{
   const suffix=randomUUID(),sourceKey='meta_ad_library' as const,sourceAdId=BigInt('0x'+suffix.replaceAll('-','')).toString(),observedAt=new Date('2026-10-11T01:00:00Z'),snapshot={sourceAdId,sourceUrl:'https://www.facebook.com/ads/library/?id='+sourceAdId,advertiserName:'Synthetic tick '+suffix};
   const raw=' '+JSON.stringify({sourceKey,observedAt:observedAt.toISOString(),ads:[snapshot]})+'\n',bytes=Buffer.from(raw,'utf8'),hash=createHash('sha256').update(bytes).digest('hex');
   const source=await tx.dataSource.upsert({where:{key:sourceKey},create:{key:sourceKey,name:'Synthetic discovery tick',adapterVersion:'fixture'},update:{}}),task=await tx.collectionTask.create({data:{dataSourceId:source.id,name:'Synthetic discovery '+suffix,query:{},status:'PAUSED'}});
   const run=await tx.collectionRun.create({data:{dataSourceId:source.id,taskId:task.id,querySnapshot:{},adapterVersion:'fixture',idempotencyKey:'meta-service:'+hash,status:'SUCCEEDED',finishedAt:observedAt}}),ad=await tx.ad.create({data:{dataSourceId:source.id,sourceAdId,sourceUrl:snapshot.sourceUrl}});
   await tx.runItem.create({data:{runId:run.id,dataSourceId:source.id,sourceAdId,adId:ad.id,itemKey:sourceAdId,status:'INGESTED',parserVersion:'fixture',evidenceSha256:hash}});
   await tx.adObservation.create({data:{dataSourceId:source.id,adId:ad.id,collectionRunId:run.id,observedAt,snapshot,parserVersion:'fixture',evidenceSha256:hash}});
   await tx.seedAttempt.create({data:{dataSourceId:source.id,sourceKey,runId:run.id,batchSha256:hash,attributionQuality:'UNATTRIBUTED',outcome:'HAS_RESULTS',startedAt:new Date('2026-10-11T00:59:59Z'),finishedAt:observedAt,fetchedCount:1,insertedCount:1,updatedCount:0}});
   const stores=evidenceStoresFromEnvironment({COLLECTOR_EVIDENCE_ROOT:directory,COLLECTOR_EVIDENCE_PREFIX:'private-seed-evidence'})!;expect(stores.prefix).toBe('private-seed-evidence');
   const store=await stores.sourceStore(sourceKey),key=collectorEvidenceKey({prefix:stores.prefix,sourceKey},hash);await store.putIfAbsent(key,bytes,hash);expect(Buffer.from(await store.get(key))).toEqual(bytes);
   // Preserve actual ORM paging while excluding other concurrently shared
   // fixtures from this transaction's reconciliation scope.
   const scopedRuns=new Proxy(tx.collectionRun,{get(target,name){if(name==='findMany')return(args:any)=>target.findMany({...args,where:{AND:[args.where,{id:run.id}]}});return Reflect.get(target,name);}});
   const api=new Proxy(tx,{get(target,name){if(name==='collectionRun')return scopedRuns;if(name==='$transaction')return(body:(db:any)=>Promise<unknown>)=>body(tx);return Reflect.get(target,name);}});
   const result=await seedDiscoveryTick(api,{extractionVersion:'public-clues-1',...stores});expect(result).toMatchObject({processed:1,failed:0});
   expect(await tx.seedEvidence.count({where:{runId:run.id,evidenceSha256:hash}})).toBe(1);expect(await tx.seedDefinition.findFirst({where:{rawValue:snapshot.advertiserName}})).toMatchObject({status:'DRAFT',verificationStatus:'CANDIDATE'});
   expect(await seedDiscoveryTick(api,{extractionVersion:'public-clues-1',...stores})).toMatchObject({processed:0,skipped:1,failed:0});throw stop;
  },{timeout:30000});}catch(error){if(error!==stop)throw error;}finally{await rm(directory,{recursive:true,force:true});}
 });
});
