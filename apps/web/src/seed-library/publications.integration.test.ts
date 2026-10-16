import {createRequire} from 'node:module';import {randomUUID} from 'node:crypto';import {describe,it,expect} from 'vitest';
import {saveSeedDefinition} from './catalog';import {previewPublication,publishSeedConfig,rollbackSeedConfig,acceptConfigReceipt,scopeManifest} from './publications';
import {seedManifestContentHash} from '@ad-research/contracts/seeds';
import {inventoryLegacyState} from './legacy-import';
import {saveLegacyOwnerIntent} from './legacy-owners';
const url=process.env.SAAS_TEST_DATABASE_URL;
describe.skipIf(!url)('versioned seed publications',()=>{
 it('publishes shared bindings, pauses last owner, and never infers application from publish',async()=>{
  const u=new URL(url!);if(!['localhost','127.0.0.1'].includes(u.hostname)||!u.pathname.includes('_test_'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const {PrismaClient}=createRequire(new URL('../../package.json',import.meta.url))('@prisma/client');const db=new PrismaClient({datasources:{db:{url}}});const suffix=randomUUID(),admin=await db.user.create({data:{email:`pub-${suffix}@example.test`,isAdmin:true}});
  const caps=[{sourceKey:'meta_ad_library',channel:'META',modes:['KEYWORD'],countries:['US'],version:'fixture-1',adapterVersion:'meta-service-dom-1'}];
  await db.dataSource.upsert({where:{key:'meta_ad_library'},create:{key:'meta_ad_library',name:'Publication fixture',adapterVersion:'meta-service-dom-1',capabilities:{seedDispatch:{verification:'VERIFIED',profiles:caps}}},update:{capabilities:{seedDispatch:{verification:'VERIFIED',profiles:caps}}}});
  const payload={kind:'KEYWORD',namespace:'publication-test',rawValue:'pub '+suffix,language:'en',purposeTags:[],targetScope:{kind:'EXPLICIT_COUNTRIES',countries:['US']},targetPlatforms:['meta_ad_library'],status:'ACTIVE',priority:0};
  try{
   const s=await saveSeedDefinition(db,{actorUserId:admin.id,payload,idempotencyKey:'create',reason:'fixture'});
   const prior=await db.seedPublication.findFirst({where:{status:'PUBLISHED'},orderBy:{revision:'desc'}});const parent=prior?.revision??0;
   const pre=await previewPublication(db,{actorUserId:admin.id,parentRevision:parent,idempotencyKey:'preview',reason:'fixture'});const pub=await publishSeedConfig(db,{actorUserId:admin.id,previewId:pre.targetId,parentRevision:parent,idempotencyKey:'publish',reason:'fixture'});
   expect(pub.publicationRevision).toBeGreaterThan(parent);expect(await db.seedCollectorReceipt.count({where:{publicationId:pub.targetId}})).toBe(0);
   await expect(publishSeedConfig(db,{actorUserId:admin.id,previewId:pre.targetId,parentRevision:parent,idempotencyKey:'stale',reason:'fixture'})).rejects.toMatchObject({code:'SEED_PUBLICATION_CONFLICT'});
   const shared=await saveSeedDefinition(db,{actorUserId:admin.id,payload:{...payload,namespace:'shared-owner-fixture'},idempotencyKey:'shared',reason:'fixture'});
   await saveSeedDefinition(db,{actorUserId:admin.id,targetId:s.targetId,expectedRevision:s.revision,payload:{...payload,status:'PAUSED'},idempotencyKey:'pause',reason:'fixture'});
   const pre2=await previewPublication(db,{actorUserId:admin.id,parentRevision:pub.publicationRevision,idempotencyKey:'preview2',reason:'fixture'});const pub2=await publishSeedConfig(db,{actorUserId:admin.id,previewId:pre2.targetId,parentRevision:pub.publicationRevision,idempotencyKey:'publish2',reason:'fixture'});
   const q=await db.seedQuery.findFirst({where:{normalizedParams:{path:['keyword'],equals:payload.rawValue}}});expect(q.desiredEnabled).toBe(true);
   await saveSeedDefinition(db,{actorUserId:admin.id,targetId:shared.targetId,expectedRevision:shared.revision,payload:{...payload,namespace:'shared-owner-fixture',status:'PAUSED'},idempotencyKey:'pause-shared',reason:'fixture'});
   const pre3=await previewPublication(db,{actorUserId:admin.id,parentRevision:pub2.publicationRevision,idempotencyKey:'preview3',reason:'fixture'});const pub3=await publishSeedConfig(db,{actorUserId:admin.id,previewId:pre3.targetId,parentRevision:pub2.publicationRevision,idempotencyKey:'publish3',reason:'fixture'});
   expect((await db.seedQuery.findUnique({where:{id:q.id}})).desiredEnabled).toBe(false);
   await saveSeedDefinition(db,{actorUserId:admin.id,payload:{...payload,rawValue:payload.rawValue+' added'},idempotencyKey:'new-seed',reason:'fixture'});
   const pre4=await previewPublication(db,{actorUserId:admin.id,parentRevision:pub3.publicationRevision,idempotencyKey:'preview4',reason:'fixture'});const pub4=await publishSeedConfig(db,{actorUserId:admin.id,previewId:pre4.targetId,parentRevision:pub3.publicationRevision,idempotencyKey:'publish4',reason:'fixture'});
   const extra=await db.seedQuery.findFirst({where:{normalizedParams:{path:['keyword'],equals:payload.rawValue+' added'}}});
   const rollback=await rollbackSeedConfig(db,{actorUserId:admin.id,targetId:pub.targetId,parentRevision:pub4.publicationRevision,idempotencyKey:'rollback',reason:'fixture'});expect(rollback.publicationRevision).toBeGreaterThan(pub4.publicationRevision);expect((await db.seedQuery.findUnique({where:{id:extra.id}})).desiredEnabled).toBe(false);
   const nodeId='pub-fixture-'+suffix,incarnationId=randomUUID();await db.collectorNode.create({data:{nodeId,incarnationId,registryRevision:1,enabled:true,status:'STANDBY_READY',codeRevision:'fixture',protocolVersions:[1]}});
   const stored=await db.seedPublication.findUnique({where:{id:rollback.targetId}});const receipt={nodeId,incarnationId,sequence:1,publicationId:stored.id,publicationRevision:stored.revision,manifestHash:stored.manifestHash,applyStatus:'DOWNLOADED',nativeJobMappings:[]};
   const a=await acceptConfigReceipt(db,{trustedNodeId:nodeId,sourceScopes:caps.map(c=>c.sourceKey),receipt});const b=await acceptConfigReceipt(db,{trustedNodeId:nodeId,sourceScopes:caps.map(c=>c.sourceKey),receipt});expect(a).toEqual(b);
   await expect(acceptConfigReceipt(db,{trustedNodeId:nodeId,sourceScopes:caps.map(c=>c.sourceKey),receipt:{...receipt,applyStatus:'APPLIED'}})).rejects.toMatchObject({code:'SEED_RECEIPT_CONFLICT'});
  }finally{await db.$disconnect();}
 });
 it('accepts allocated source receipts out of order without accepting a different source hash',async()=>{
  const u=new URL(url!);if(!['localhost','127.0.0.1'].includes(u.hostname)||!u.pathname.includes('_test_'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const {PrismaClient}=createRequire(new URL('../../package.json',import.meta.url))('@prisma/client');const db=new PrismaClient({datasources:{db:{url}}});
  try{
   const prior=await db.seedPublication.findFirst({orderBy:{revision:'desc'}}),nodeId='scope-'+randomUUID(),incarnationId=randomUUID();
   const query=(sourceKey:string,channel:string)=>({queryId:randomUUID(),queryKey:randomUUID(),queryKeyVersion:'fixture',sourceKey,channel,mode:'NAME',params:{country:'US',name:randomUUID()},legacyDims:{},adapterVersion:'fixture',capabilityVersion:'fixture',desiredEnabled:true,nativeJobIds:[randomUUID()]});
   const meta=query('meta_ad_library','META'),google=query('google_ads_transparency','SEARCH');
   const body:any={schemaVersion:1,protocolMin:1,protocolMax:1,publicationId:randomUUID(),revision:(prior?.revision??0)+1,parentRevision:prior?.revision??null,compilerVersion:'fixture',capabilityVersion:'fixture',createdAt:new Date().toISOString(),queries:[meta,google],bindings:[],scanPlans:[],tombstones:[],schedulePolicyVersion:'fixture'};
   const manifest:any={...body,contentHash:seedManifestContentHash(body)};
   await db.seedPublication.create({data:{id:body.publicationId,revision:body.revision,parentRevision:body.parentRevision,manifestHash:manifest.contentHash,configSnapshot:{manifest},status:'PUBLISHED',reason:'Synthetic source scoped receipt regression'}});
   await db.collectorNode.create({data:{nodeId,incarnationId,registryRevision:1,enabled:true,status:'STANDBY_READY',codeRevision:'fixture',protocolVersions:[1]}});
   const receipt=(source:string,sequence:number)=>({nodeId,incarnationId,sequence,publicationId:body.publicationId,publicationRevision:body.revision,manifestHash:scopeManifest(manifest,[source]).contentHash,applyStatus:'APPLIED',nativeJobMappings:manifest.queries.filter((q:any)=>q.sourceKey===source).map((q:any)=>({queryId:q.queryId,nativeJobId:q.nativeJobIds[0]}))});
   const later=receipt(meta.sourceKey,20),earlier=receipt(google.sourceKey,19);
   await acceptConfigReceipt(db,{trustedNodeId:nodeId,sourceScopes:[meta.sourceKey],receipt:later});
   const recorded=await acceptConfigReceipt(db,{trustedNodeId:nodeId,sourceScopes:[google.sourceKey],receipt:earlier});
   expect(recorded.status).toBe('APPLIED');expect(await db.seedCollectorReceipt.count({where:{nodeId}})).toBe(2);
   await expect(acceptConfigReceipt(db,{trustedNodeId:nodeId,sourceScopes:[google.sourceKey],receipt:{...earlier,sequence:20}})).rejects.toMatchObject({code:'SEED_RECEIPT_CONFLICT'});
   await expect(acceptConfigReceipt(db,{trustedNodeId:nodeId,sourceScopes:[meta.sourceKey],receipt:{...earlier,sequence:21}})).rejects.toMatchObject({code:'SEED_RECEIPT_HASH'});
   const fact=await db.seedCollectorReceipt.findUnique({where:{id:recorded.receiptId}});expect(fact.queryCounts).toEqual({queryIds:[google.queryId],sourceScopes:[google.sourceKey]});
  }finally{await db.$disconnect();}
 });

 it('publishes a paused first legacy owner after its provisional binding epoch',async()=>{
  const u=new URL(url!);if(!['localhost','127.0.0.1'].includes(u.hostname)||!u.pathname.includes('_test_'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const {PrismaClient}=createRequire(new URL('../../package.json',import.meta.url))('@prisma/client');const db=new PrismaClient({datasources:{db:{url}}});
  try{
   const suffix=randomUUID(),admin=await db.user.create({data:{email:'legacy-publish-'+suffix+'@example.test',isAdmin:true}}),source=await db.dataSource.findUniqueOrThrow({where:{key:'meta_ad_library'}});
   const head=await db.seedPublication.findFirst({where:{status:'PUBLISHED'},orderBy:{revision:'desc'}}),parentRevision=head?.revision??0,validFromRevision=parentRevision+1;
   const job=inventoryLegacyState('meta_ad_library',{schemaVersion:1,jobs:[{id:'legacy-pending-'+suffix,country:'US',language:'en',keyword:suffix,seen:[]}]}).jobs[0];
   await db.seedQuery.create({data:{id:job.queryId,dataSourceId:source.id,sourceKey:source.key,channel:job.channel,mode:job.mode,normalizedParams:job.params,queryKey:job.queryKey,queryKeyVersion:'legacy-1',adapterVersion:'fixture',capabilityVersion:'fixture',desiredEnabled:true}});
   await db.legacyJobMapping.create({data:{dataSourceId:source.id,sourceKey:source.key,nativeJobId:job.nativeJobId,queryId:job.queryId,legacyKeyVersion:'legacy-1'}});
   const ownerKey='legacy-owner-'+suffix,binding=await db.seedQueryBinding.create({data:{queryId:job.queryId,ownerKind:'LEGACY',legacyOwnerKey:ownerKey,ownerRevision:1,validFromRevision,participationStatus:'ACTIVE'}});
   await saveLegacyOwnerIntent(db,{actorUserId:admin.id,sourceKey:source.key,legacyOwnerKey:ownerKey,status:'PAUSED',idempotencyKey:'pause-before-publish',reason:'Synthetic staged legacy pause'});
   expect((await db.seedQueryBinding.findUnique({where:{id:binding.id}})).participationStatus).toBe('ACTIVE');
   const preview=await previewPublication(db,{actorUserId:admin.id,parentRevision,idempotencyKey:'preview',reason:'Synthetic staged legacy pause'});
   const published=await publishSeedConfig(db,{actorUserId:admin.id,parentRevision,previewId:preview.targetId,idempotencyKey:'publish',reason:'Synthetic staged legacy pause'});
   expect(published.publicationRevision).toBeGreaterThan(validFromRevision);
   expect(await db.seedQueryBinding.findUnique({where:{id:binding.id}})).toMatchObject({validFromRevision,validToRevision:published.publicationRevision});
   expect((await db.seedQuery.findUnique({where:{id:job.queryId}})).desiredEnabled).toBe(false);
  }finally{await db.$disconnect();}
 });

});
