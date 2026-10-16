import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {seedManifestContentHash,type SeedScanPlanInput} from '@ad-research/contracts/seeds';
import {compileSeedPlan} from './planner';
import {activateManifest} from './publications';
import {refreshPublishedScanWindows} from './rolling-scans';

const url=process.env.SAAS_TEST_DATABASE_URL;let db:any;
beforeAll(()=>{if(!url)return;const u=new URL(url);if(!['localhost','127.0.0.1'].includes(u.hostname)||!u.pathname.includes('_test_'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');const {PrismaClient}=createRequire(new URL('../../package.json',import.meta.url))('@prisma/client');db=new PrismaClient({datasources:{db:{url}}});});
afterAll(async()=>{await db?.$disconnect();});
function transactionDb(tx:any){return new Proxy(tx,{get(target,name){return name==='$transaction'?(body:(db:any)=>Promise<unknown>)=>body(tx):Reflect.get(target,name);}});}
async function isolated(body:(tx:any,api:any,f:any)=>Promise<void>,withProfiles=true){const stop=Error('TEST_ROLLBACK');try{await db.$transaction(async(tx:any)=>{
 await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended('seed-publication-head',0))");
 const suffix=randomUUID(),actor=await tx.user.create({data:{email:suffix+'@rolling.example.test',isAdmin:true}}),sourceKey='pinterest_ads_repository',nodeId='rolling-'+suffix,incarnationId=randomUUID();
 const source=await tx.dataSource.upsert({where:{key:sourceKey},create:{key:sourceKey,name:'Synthetic rolling source',adapterVersion:'pinterest-public-dom-1'},update:{}});
 const profiles=[{sourceKey,channel:'SWEEP',modes:['COUNTRY_DATE_SWEEP'],countries:['US','JP'],version:'frozen-1',adapterVersion:'pinterest-public-dom-1'}];
 await tx.collectorNode.create({data:{nodeId,incarnationId,registryRevision:1,enabled:true,status:'STANDBY_READY',codeRevision:'fixture',protocolVersions:[1]}});
 await tx.collectorSourceAssignment.updateMany({where:{sourceKey,state:'ACTIVE'},data:{state:'STOPPED'}});
 const assignmentGeneration=(await tx.collectorSourceAssignment.aggregate({where:{sourceKey},_max:{generation:true}}))._max.generation??0;
 const generation=Math.max(9,assignmentGeneration+1);
 await tx.collectorSourceAssignment.create({data:{dataSourceId:source.id,sourceKey,channel:'SWEEP',nodeId,incarnationId,generation,controlMode:'CONFIG_QUEUE',state:'ACTIVE',tokenHash:'f'.repeat(64),leaseExpiresAt:new Date('2099-01-01')}});
 await tx.collectorSourceControl.upsert({where:{sourceKey_channel_scopeKey:{sourceKey,channel:'SWEEP',scopeKey:'SOURCE'}},create:{dataSourceId:source.id,sourceKey,channel:'SWEEP',scopeKey:'SOURCE',controlMode:'CONFIG_QUEUE',assignmentGeneration:generation},update:{controlMode:'CONFIG_QUEUE',assignmentGeneration:generation}});
 const plan:SeedScanPlanInput={id:randomUUID(),revision:1,sourceKey:'pinterest_ads_repository',targetScope:{kind:'CONFIGURED_MARKETS'},datePolicy:{kind:'ROLLING',windowDays:1},category:'ALL',status:'ACTIVE',evidence:{fixture:suffix}};
 await tx.seedScanPlan.create({data:{...plan,dataSourceId:source.id}});
 const highest=await tx.seedPublication.findFirst({orderBy:{revision:'desc'}}),revision=(highest?.revision??0)+1,compiled=compileSeedPlan([], [plan],profiles,[],new Date('2026-10-10T00:00:00Z'));
 // A shared database may already know these identities; preserve their IDs.
 for(const q of compiled.queries){const existing=await tx.seedQuery.findUnique({where:{sourceKey_channel_queryKey:{sourceKey,channel:q.channel,queryKey:q.queryKey}}});if(existing){const id=q.queryId;q.queryId=existing.id;for(const b of compiled.bindings)if(b.queryId===id)b.queryId=existing.id;}}
 const shared=compiled.queries.find(q=>q.params.country==='US')!,retired=compiled.queries.find(q=>q.params.country==='JP')!;
 const bodyManifest={schemaVersion:1 as const,protocolMin:1,protocolMax:1,publicationId:randomUUID(),revision,parentRevision:highest?.revision??null,compilerVersion:'seed-compiler-1',capabilityVersion:'native-capabilities-1',createdAt:'2026-10-10T00:00:00Z',queries:compiled.queries,bindings:[...compiled.bindings.map(b=>({...b,validFromRevision:revision})),{...compiled.bindings.find(b=>b.queryId===shared.queryId)!,ownerKind:'LEGACY' as const,scanPlanId:null,legacyOwnerKey:'frozen-shared-'+suffix,validFromRevision:revision}],scanPlans:[plan],tombstones:[],schedulePolicyVersion:'compatibility-fair-1'};
 const manifest={...bodyManifest,contentHash:seedManifestContentHash(bodyManifest)};
 await activateManifest(tx,manifest);await tx.seedPublication.create({data:{id:manifest.publicationId,revision,parentRevision:manifest.parentRevision,manifestHash:manifest.contentHash,status:'PUBLISHED',reason:'Synthetic rolling fixture',createdByUserId:actor.id,configSnapshot:{manifest,...(withProfiles?{capabilityProfiles:profiles}:{})}}});
 await body(tx,transactionDb(tx),{actor,source,sourceKey,nodeId,incarnationId,generation,plan,profiles,manifest,shared,retired,suffix});throw stop;
 },{timeout:30000});}catch(error){if(error!==stop)throw error;}}

describe.skipIf(!url)('published scan rollover with PostgreSQL facts',()=>{
 it('ignores unpublished catalog changes, stops old unshared tasks, and preserves progress and shared owners',()=>isolated(async(tx,api,f)=>{
  for(const q of f.manifest.queries)await tx.seedRuntimeState.update({where:{queryId:q.queryId},data:{collectorId:'retained-owner-'+f.suffix,assignmentGeneration:f.generation+1,executionState:'RUNNING',seenCount:9,checkpointSequence:3,checkpointDigest:'a'.repeat(64),checkpointSha:'a'.repeat(64),checkpointRef:'local-private:old-checkpoint',nextAllowedAt:new Date('2026-10-12T00:00:00Z')}});
  const ready=await tx.seedExecutionTask.create({data:{queryId:f.retired.queryId,dataSourceId:f.source.id,sourceKey:f.sourceKey,cycleKey:f.suffix,workUnitKey:'ready',publicationRevision:f.manifest.revision,schedulePolicyVersion:f.manifest.schedulePolicyVersion}});
  const running=await tx.seedExecutionTask.create({data:{queryId:f.retired.queryId,dataSourceId:f.source.id,sourceKey:f.sourceKey,cycleKey:f.suffix,workUnitKey:'running',state:'RUNNING',publicationRevision:f.manifest.revision,schedulePolicyVersion:f.manifest.schedulePolicyVersion}});
  const attempt=await tx.seedTaskAttempt.create({data:{taskId:running.id,dataSourceId:f.source.id,sourceKey:f.sourceKey,attemptNo:1,nodeId:f.nodeId,incarnationId:f.incarnationId,assignmentGeneration:f.generation,leaseVersion:1,tokenHash:createHash('sha256').update(f.suffix).digest('hex'),leaseExpiresAt:new Date('2026-10-12'),publicationRevision:f.manifest.revision,configHash:f.manifest.contentHash,state:'RUNNING'}});
  await tx.seedScanPlan.update({where:{id:f.plan.id},data:{revision:2,status:'DRAFT',targetScope:{kind:'EXPLICIT_COUNTRIES',countries:['FR']},datePolicy:{kind:'ROLLING',windowDays:99}}});
  await tx.seedScanPlan.create({data:{dataSourceId:f.source.id,sourceKey:f.sourceKey,targetScope:{kind:'EXPLICIT_COUNTRIES',countries:['FR']},datePolicy:{kind:'ROLLING',windowDays:31},status:'ACTIVE'}});
  await tx.dataSource.update({where:{id:f.source.id},data:{capabilities:{seedDispatch:{verification:'VERIFIED',profiles:[{sourceKey:f.sourceKey,channel:'SWEEP',modes:['COUNTRY_DATE_SWEEP'],countries:['FR'],version:'unpublished-2',adapterVersion:'unpublished-adapter'}]}}}});
  const initialPublicationCount=await tx.seedPublication.count(),result=await refreshPublishedScanWindows(api,{actorUserId:f.actor.id},new Date('2026-10-11T00:00:00Z'));
  expect(result).toMatchObject({changed:true,utcDay:'2026-10-11',revision:f.manifest.revision+1});
  const stored=await tx.seedPublication.findUnique({where:{id:result.publicationId}}),m=stored.configSnapshot.manifest;
  expect(stored).toMatchObject({parentRevision:f.manifest.revision,status:'PUBLISHED',manifestHash:m.contentHash});expect(m.scanPlans).toEqual(f.manifest.scanPlans);expect(stored.configSnapshot.capabilityProfiles[0].countries).toEqual(['US','JP']);
  const fresh=m.queries.filter((q:any)=>q.params.dateEnd==='2026-10-11');expect(fresh).toHaveLength(2);expect(fresh.every((q:any)=>q.params.dateStart==='2026-10-11'&&q.capabilityVersion==='frozen-1')).toBe(true);
  for(const q of fresh){expect(await tx.seedQuery.findUnique({where:{id:q.queryId}})).toMatchObject({desiredEnabled:true,controlMode:'CONFIG_QUEUE',assignmentGeneration:f.generation});expect(await tx.seedRuntimeState.findUnique({where:{queryId:q.queryId}})).toMatchObject({collectorId:f.nodeId,assignmentGeneration:f.generation,checkpointSequence:0,seenCount:0});}
  expect(await tx.seedQuery.findUnique({where:{id:f.shared.queryId}})).toMatchObject({desiredEnabled:true});expect(await tx.seedQuery.findUnique({where:{id:f.retired.queryId}})).toMatchObject({desiredEnabled:false,status:'DORMANT'});
  expect(m.bindings.filter((b:any)=>b.queryId===f.shared.queryId)).toMatchObject([{ownerKind:'LEGACY',participationStatus:'ACTIVE'}]);expect(m.bindings.some((b:any)=>b.queryId===f.retired.queryId)).toBe(false);
  expect(await tx.seedExecutionTask.findUnique({where:{id:ready.id}})).toMatchObject({state:'CANCELED'});expect(await tx.seedExecutionTask.findUnique({where:{id:running.id}})).toMatchObject({state:'STOP_REQUESTED'});expect(await tx.seedTaskAttempt.findUnique({where:{id:attempt.id}})).toMatchObject({state:'STOP_REQUESTED'});
  for(const q of f.manifest.queries)expect(await tx.seedRuntimeState.findUnique({where:{queryId:q.queryId}})).toMatchObject({collectorId:'retained-owner-'+f.suffix,assignmentGeneration:f.generation+1,seenCount:9,checkpointSequence:3,checkpointRef:'local-private:old-checkpoint',checkpointSha:'a'.repeat(64),nextAllowedAt:new Date('2026-10-12T00:00:00Z')});
  const auditCount=await tx.auditEvent.count({where:{actorUserId:f.actor.id,action:'SEED_SCAN_WINDOWS_REFRESHED'}});
  expect(await refreshPublishedScanWindows(api,{actorUserId:f.actor.id},new Date('2026-10-11T23:59:59Z'))).toMatchObject({changed:false,reason:'SCAN_WINDOWS_UNCHANGED',publicationId:stored.id,revision:stored.revision});
  expect(await tx.seedPublication.count()).toBe(initialPublicationCount+1);expect(await tx.auditEvent.count({where:{actorUserId:f.actor.id,action:'SEED_SCAN_WINDOWS_REFRESHED'}})).toBe(auditCount);
 }));
 it('checks fresh platform permission and holds historical publications without frozen profiles',()=>isolated(async(tx,api,f)=>{
  const before=await tx.seedPublication.count();
  expect(await refreshPublishedScanWindows(api,{actorUserId:f.actor.id},new Date('2026-10-11'))).toMatchObject({changed:false,reason:'FROZEN_CAPABILITIES_MISSING'});expect(await tx.seedPublication.count()).toBe(before);
  await tx.user.update({where:{id:f.actor.id},data:{isAdmin:false}});await expect(refreshPublishedScanWindows(api,{actorUserId:f.actor.id},new Date('2026-10-11'))).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});
 },false));
 it('reuses a registered query ID even when that registry row has no runtime or native job yet',()=>isolated(async(tx,api,f)=>{
  const nextDate=new Date('2026-11-20T00:00:00Z'),fresh=compileSeedPlan([],f.manifest.scanPlans,f.profiles,[],nextDate).queries.find(q=>q.params.country==='US')!,id=randomUUID();
  await tx.seedQuery.create({data:{id,dataSourceId:f.source.id,sourceKey:f.sourceKey,channel:fresh.channel,mode:fresh.mode,normalizedParams:fresh.params,queryCountry:'US',queryLanguage:'und',queryKey:fresh.queryKey,queryKeyVersion:fresh.queryKeyVersion,adapterVersion:fresh.adapterVersion,capabilityVersion:fresh.capabilityVersion,legacyDims:fresh.legacyDims,desiredEnabled:false,controlMode:'CONFIG_QUEUE',assignmentGeneration:f.generation}});
  expect(await tx.seedRuntimeState.findUnique({where:{queryId:id}})).toBeNull();
  const result=await refreshPublishedScanWindows(api,{actorUserId:f.actor.id},nextDate),stored=await tx.seedPublication.findUnique({where:{id:result.publicationId}});
  expect(stored.configSnapshot.manifest.queries.find((q:any)=>q.queryKey===fresh.queryKey).queryId).toBe(id);
  expect(await tx.seedQuery.count({where:{sourceKey:f.sourceKey,queryKey:fresh.queryKey}})).toBe(1);expect(await tx.seedRuntimeState.findUnique({where:{queryId:id}})).toMatchObject({collectorId:f.nodeId,assignmentGeneration:f.generation,checkpointSequence:0});
 }));
});
