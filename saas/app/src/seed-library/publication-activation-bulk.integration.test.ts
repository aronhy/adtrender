import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {seedManifestContentHash,type SeedConfigManifest,type SeedQuerySpec,type OwnerBinding} from '@ad-research/contracts/seeds';
import {legacyQueryIdentity} from './legacy-query-key';
import {activateManifest,nextPublicationRevision} from './publications';
import {createCollectorDispatchService} from '../collector-dispatch/service';

const url=process.env.SAAS_TEST_DATABASE_URL;let db:any,measuring=false,queries:string[]=[];
beforeAll(()=>{if(!url)return;const u=new URL(url);if(!['localhost','127.0.0.1'].includes(u.hostname)||!u.pathname.includes('_test_'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');const {PrismaClient}=createRequire(new URL('../../package.json',import.meta.url))('@prisma/client');db=new PrismaClient({datasources:{db:{url}},log:[{emit:'event',level:'query'}]});db.$on('query',(e:any)=>{if(measuring)queries.push(e.query);});});
afterAll(async()=>{await db?.$disconnect();});
async function measured(body:()=>Promise<void>){queries=[];measuring=true;try{await body();}finally{measuring=false;}return queries.length;}
function nextManifest(m:SeedConfigManifest,revision:number,extra:Partial<SeedConfigManifest>={}):SeedConfigManifest{const body={...m,...extra,publicationId:randomUUID(),revision,parentRevision:m.revision,createdAt:new Date().toISOString()};return {...body,contentHash:seedManifestContentHash(body)};}
async function isolated(body:(tx:any,f:any)=>Promise<void>){const stop=Error('TEST_ROLLBACK');try{await db.$transaction(async(tx:any)=>{
 await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended('seed-publication-head',0))");
 const suffix=randomUUID(),sourceKey='meta_ad_library',source=await tx.dataSource.upsert({where:{key:sourceKey},create:{key:sourceKey,name:'Synthetic activation scale source',adapterVersion:'meta-service-dom-1'},update:{}});
 const nodeId='bulk-'+suffix,incarnationId=randomUUID();await tx.collectorNode.create({data:{nodeId,incarnationId,registryRevision:1,enabled:true,status:'STANDBY_READY',codeRevision:'fixture',protocolVersions:[1]}});
 await tx.collectorSourceAssignment.updateMany({where:{sourceKey,state:{in:['ACTIVE','DRAINING']}},data:{state:'STOPPED'}});
 const generation=((await tx.collectorSourceAssignment.aggregate({where:{sourceKey},_max:{generation:true}}))._max.generation??0)+1;
 await tx.collectorSourceAssignment.create({data:{dataSourceId:source.id,sourceKey,channel:'META',nodeId,incarnationId,generation,controlMode:'CONFIG_QUEUE',tokenHash:'f'.repeat(64),leaseExpiresAt:new Date('2099-01-01')}});
 const seed=await tx.seedDefinition.create({data:{kind:'NAME',namespace:'bulk-fixture',rawValue:suffix,normalizedValue:suffix,language:'en',purposeTags:[{family:'ECOMMERCE',category:'fashion'}],targetScope:{kind:'EXPLICIT_COUNTRIES',countries:['US']},targetPlatforms:[sourceKey],status:'ACTIVE'}});
 const highest=await tx.seedPublication.findFirst({orderBy:{revision:'desc'}}),revision=await nextPublicationRevision(tx);
 const specs:SeedQuerySpec[]=Array.from({length:900},(_,i)=>{const params={country:'US',language:'en',keyword:suffix+':'+i,status:'all',mediaType:'all'},identity=legacyQueryIdentity(sourceKey,params);return {queryId:randomUUID(),queryKey:identity.key,queryKeyVersion:'legacy-1',sourceKey:'meta_ad_library',channel:'META',mode:'KEYWORD',params,legacyDims:{language:'en'},adapterVersion:'meta-service-dom-1',capabilityVersion:'fixture-1',desiredEnabled:true,nativeJobIds:['native-'+suffix+':'+i]};});
 const bindings:OwnerBinding[]=specs.flatMap(q=>[{queryId:q.queryId,ownerKind:'SEED' as const,seedId:seed.id,scanPlanId:null,legacyOwnerKey:null,ownerRevision:1,participationStatus:'ACTIVE' as const,purposeSnapshot:[{family:'ECOMMERCE' as const,category:'fashion'}],validFromRevision:revision,validToRevision:null},{queryId:q.queryId,ownerKind:'LEGACY' as const,seedId:null,scanPlanId:null,legacyOwnerKey:'legacy-'+q.queryId,ownerRevision:1,participationStatus:'ACTIVE' as const,purposeSnapshot:[],validFromRevision:revision,validToRevision:null}]);
 const bodyManifest={schemaVersion:1 as const,protocolMin:1,protocolMax:1,publicationId:randomUUID(),revision,parentRevision:highest?.revision??null,compilerVersion:'seed-compiler-1',capabilityVersion:'native-capabilities-1',createdAt:new Date().toISOString(),queries:specs,bindings,scanPlans:[],tombstones:[],schedulePolicyVersion:'compatibility-fair-1'},manifest={...bodyManifest,contentHash:seedManifestContentHash(bodyManifest)};
 await body(tx,{source,sourceKey,nodeId,incarnationId,generation,seed,manifest,suffix});throw stop;
 },{timeout:30000});}catch(error){if(error!==stop)throw error;}}

describe.skipIf(!url)('bounded bulk publication activation in PostgreSQL',()=>{
 it('activates 900 queries and 1800 owners in bounded SQL pages and preserves epochs on unchanged replay',()=>isolated(async(tx,f)=>{
  const count=await measured(()=>activateManifest(tx,f.manifest));expect(count).toBeLessThanOrEqual(50);
  const ids=f.manifest.queries.map((q:any)=>q.queryId);expect(await tx.seedQuery.count({where:{id:{in:ids}}})).toBe(900);expect(await tx.seedRuntimeState.count({where:{queryId:{in:ids},collectorId:f.nodeId,assignmentGeneration:f.generation,seenCount:0}})).toBe(900);expect(await tx.seedQuery.count({where:{id:{in:ids},controlMode:'CONFIG_QUEUE',assignmentGeneration:f.generation}})).toBe(900);
  expect(await tx.seedQueryBinding.count({where:{queryId:{in:ids},validToRevision:null}})).toBe(1800);
  const original=await tx.seedQueryBinding.findMany({where:{queryId:{in:ids},validToRevision:null},select:{id:true,validFromRevision:true},orderBy:{id:'asc'}});
  const replay=nextManifest(f.manifest,f.manifest.revision+1),replayCount=await measured(()=>activateManifest(tx,replay));expect(replayCount).toBeLessThanOrEqual(50);
  expect(await tx.seedQueryBinding.findMany({where:{queryId:{in:ids},validToRevision:null},select:{id:true,validFromRevision:true},orderBy:{id:'asc'}})).toEqual(original);
  const rollback=nextManifest(replay,replay.revision+1),forceCount=await measured(()=>activateManifest(tx,rollback,true));expect(forceCount).toBeLessThanOrEqual(50);
  process.stdout.write('activation_sql_counts '+JSON.stringify({queries:900,owners:1800,initial:count,replay:replayCount,rollback:forceCount})+'\n');
  expect(await tx.seedQueryBinding.count({where:{queryId:{in:ids},validToRevision:null,validFromRevision:rollback.revision}})).toBe(1800);expect(await tx.seedQueryBinding.count({where:{queryId:{in:ids},validToRevision:rollback.revision}})).toBe(1800);
 }),30000);
 it('pauses only ownerless queries, preserves pending commits and runtime bytes, and updates READY tasks in bulk',()=>isolated(async(tx,f)=>{
  await activateManifest(tx,f.manifest);const ids=f.manifest.queries.map((q:any)=>q.queryId),nextRevision=f.manifest.revision+1;
  await tx.seedRuntimeState.updateMany({where:{queryId:{in:ids}},data:{seenCount:42,checkpointSequence:8,checkpointSha:'a'.repeat(64),checkpointDigest:'a'.repeat(64),checkpointRef:'local-private:retained',pendingManifestRef:'local-private:pending',collectorId:'retained-owner',nextAllowedAt:new Date('2026-10-12')}});
  const tasks:any[]=[];for(const [i,state] of ['READY','READY','RUNNING','COMMIT_PENDING','COMMIT_PENDING','LEASED'].entries()){const q=f.manifest.queries[i],task=await tx.seedExecutionTask.create({data:{queryId:q.queryId,dataSourceId:f.source.id,sourceKey:f.sourceKey,cycleKey:f.suffix,workUnitKey:'unit-'+i,state,publicationRevision:f.manifest.revision,schedulePolicyVersion:f.manifest.schedulePolicyVersion}});tasks.push(task);await tx.seedRuntimeState.update({where:{queryId:q.queryId},data:{executionState:state==='READY'?'IDLE':state}});if(['RUNNING','LEASED','COMMIT_PENDING'].includes(state))await tx.seedTaskAttempt.create({data:{taskId:task.id,dataSourceId:f.source.id,sourceKey:f.sourceKey,attemptNo:1,nodeId:f.nodeId,incarnationId:f.incarnationId,assignmentGeneration:f.generation,leaseVersion:1,tokenHash:createHash('sha256').update(task.id).digest('hex'),leaseExpiresAt:new Date('2099-01-01'),publicationRevision:f.manifest.revision,configHash:f.manifest.contentHash,state}});}
  const bindings=f.manifest.bindings.map((b:OwnerBinding)=>({...b,participationStatus:b.ownerKind==='LEGACY'&&ids.indexOf(b.queryId)%3===0?'ACTIVE' as const:'PAUSED' as const,ownerRevision:2})),qs=f.manifest.queries.map((q:SeedQuerySpec,i:number)=>({...q,desiredEnabled:i%3===0})),next=nextManifest(f.manifest,nextRevision,{queries:qs,bindings});
  const count=await measured(()=>activateManifest(tx,next));expect(count).toBeLessThanOrEqual(60);process.stdout.write('activation_pause_sql_count '+count+'\n');
  expect(await tx.seedQuery.count({where:{id:{in:ids},desiredEnabled:true}})).toBe(300);expect(await tx.seedQuery.count({where:{id:{in:ids},status:'DORMANT'}})).toBe(600);
  const taskRows=await tx.seedExecutionTask.findMany({where:{id:{in:tasks.map(t=>t.id)}}});expect(tasks.map(t=>taskRows.find((row:any)=>row.id===t.id).state)).toEqual(['READY','CANCELED','STOP_REQUESTED','COMMIT_PENDING','COMMIT_PENDING','STOP_REQUESTED']);expect(taskRows.find((row:any)=>row.id===tasks[0].id).publicationRevision).toBe(nextRevision);
  expect((await tx.seedTaskAttempt.findFirst({where:{taskId:tasks[2].id}})).state).toBe('STOP_REQUESTED');expect((await tx.seedTaskAttempt.findFirst({where:{taskId:tasks[4].id}})).state).toBe('COMMIT_PENDING');
  expect(await tx.seedRuntimeState.count({where:{queryId:{in:ids},seenCount:42,checkpointSequence:8,checkpointSha:'a'.repeat(64),checkpointRef:'local-private:retained',pendingManifestRef:'local-private:pending',collectorId:'retained-owner',assignmentGeneration:f.generation,nextAllowedAt:new Date('2026-10-12')}})).toBe(900);
  expect(await tx.seedRuntimeState.findUnique({where:{queryId:ids[2]}})).toMatchObject({executionState:'STOP_REQUESTED'});expect(await tx.seedRuntimeState.findUnique({where:{queryId:ids[4]}})).toMatchObject({executionState:'COMMIT_PENDING'});
 }),30000);
 it('detects an identity conflict on a later page before the caller can commit',()=>isolated(async(tx,f)=>{
  await activateManifest(tx,f.manifest);const bad=nextManifest(f.manifest,f.manifest.revision+1,{queries:f.manifest.queries.map((q:SeedQuerySpec,i:number)=>i===899?{...q,params:{...q.params,keyword:'changed-identity'}}:q)});
  await tx.$executeRawUnsafe('SAVEPOINT activation_failure');await expect(activateManifest(tx,bad)).rejects.toMatchObject({code:'SEED_QUERY_IDENTITY_CONFLICT'});await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT activation_failure');
  expect(await tx.seedRuntimeState.count({where:{queryId:{in:f.manifest.queries.map((q:any)=>q.queryId)},desiredRevision:f.manifest.revision}})).toBe(900);
 }),30000);
 it('requeues a superseded unstarted lease, rejects its real grant, and allows immediate claim after the new APPLIED receipt',()=>isolated(async(tx,f)=>{
  await activateManifest(tx,f.manifest);const now=new Date(),ids=f.manifest.queries.slice(0,2).map((q:any)=>q.queryId);
  await tx.collectorNode.update({where:{nodeId:f.nodeId},data:{lastHeartbeatAt:now,resourceSnapshot:{maxSlots:2}}});
  await tx.dataSource.update({where:{id:f.source.id},data:{status:'ACTIVE'}});await tx.collectorSourceControl.updateMany({where:{sourceKey:f.sourceKey},data:{controlMode:'TASK_CLAIM',manualPause:false,notBefore:new Date(0),retryAfterUntil:null,assignmentGeneration:f.generation}});
  await tx.collectorSourceControl.upsert({where:{sourceKey_channel_scopeKey:{sourceKey:f.sourceKey,channel:'META',scopeKey:'SOURCE'}},create:{dataSourceId:f.source.id,sourceKey:f.sourceKey,channel:'META',scopeKey:'SOURCE',controlMode:'TASK_CLAIM',notBefore:new Date(0),assignmentGeneration:f.generation},update:{controlMode:'TASK_CLAIM',manualPause:false,notBefore:new Date(0),assignmentGeneration:f.generation}});
  await tx.seedQuery.updateMany({where:{id:{in:ids}},data:{controlMode:'TASK_CLAIM'}});
  for(const id of ids)await tx.seedExecutionTask.create({data:{queryId:id,dataSourceId:f.source.id,sourceKey:f.sourceKey,cycleKey:f.suffix,workUnitKey:id,publicationRevision:f.manifest.revision,schedulePolicyVersion:f.manifest.schedulePolicyVersion}});
  const publish=async(m:SeedConfigManifest,sequence:number)=>{
   await tx.seedPublication.create({data:{id:m.publicationId,revision:m.revision,parentRevision:m.parentRevision,manifestHash:m.contentHash,configSnapshot:{manifest:m},reason:'Synthetic grant rollover'}});
   await tx.seedCollectorReceipt.create({data:{publicationId:m.publicationId,publicationRevision:m.revision,manifestHash:m.contentHash,nodeId:f.nodeId,incarnationId:f.incarnationId,sequence,type:'APPLIED',applyStatus:'APPLIED',payloadHash:'c'.repeat(64),nativeJobMappings:m.queries.map(q=>({queryId:q.queryId,nativeJobId:q.nativeJobIds[0]})),payload:{},appliedAt:now}});
  };
  await publish(f.manifest,1);
  const api=new Proxy(tx,{get(target,name){return name==='$transaction'?(body:(tx:any)=>Promise<unknown>)=>body(tx):Reflect.get(target,name);}}),service=createCollectorDispatchService(api,{tokenSecret:'synthetic-bulk-token-secret-32-bytes-minimum',leaseMs:60000,requestBudgetMs:1000,exitMarginMs:1000,cycleMs:60000,requestSpacingMs:0,unknownOutcomeBackoffMs:60000,evidencePrefix:'fixture',evidenceScheme:'local-private',storeForSource:async()=>{throw Error('UNUSED_STORE');},now:()=>now});
  const identity={nodeId:f.nodeId,incarnationId:f.incarnationId,allowedSourceKeys:['meta_ad_library'] as const},claim={requestId:'old-'+f.suffix,sourceKey:'meta_ad_library' as const,availableSlots:2,supportedModes:['KEYWORD'],queryIds:[ids[0]],appliedRevision:f.manifest.revision,configHash:f.manifest.contentHash};
  const old=await service.claimTask(identity,claim);expect(old).toHaveProperty('grantToken');if('idle' in old)throw Error('OLD_CLAIM_FAILED');
  const running=await service.claimTask(identity,{...claim,requestId:'running-'+f.suffix,queryIds:[ids[1]]});if('idle' in running)throw Error('RUNNING_CLAIM_FAILED');await service.startAttempt(identity,{attemptId:running.attemptId,grantToken:running.grantToken});const frozen=await tx.seedTaskAttempt.findUnique({where:{id:running.attemptId}});
  const next=nextManifest(f.manifest,f.manifest.revision+1,{bindings:f.manifest.bindings.map((b:OwnerBinding)=>b.ownerKind==='SEED'?{...b,ownerRevision:2,participationStatus:'PAUSED'}:b)});
  await activateManifest(tx,next);
  expect(await tx.seedTaskAttempt.findUnique({where:{id:old.attemptId}})).toMatchObject({state:'CANCELED',startedAt:null});expect(await tx.seedExecutionTask.findUnique({where:{id:old.taskId}})).toMatchObject({state:'READY',publicationRevision:next.revision});expect(await tx.seedRuntimeState.findUnique({where:{queryId:old.queryId}})).toMatchObject({executionState:'IDLE'});
  await expect(service.startAttempt(identity,{attemptId:old.attemptId,grantToken:old.grantToken})).rejects.toMatchObject({code:'LEASE_LOST'});
  expect(await tx.seedTaskAttempt.findUnique({where:{id:running.attemptId}})).toEqual(frozen);
  await publish(next,2);const fresh=await service.claimTask(identity,{...claim,requestId:'new-'+f.suffix,appliedRevision:next.revision,configHash:next.contentHash});expect(fresh).toHaveProperty('grantToken');if('idle' in fresh)throw Error('NEW_CLAIM_FAILED');expect(fresh).toMatchObject({taskId:old.taskId,queryId:old.queryId,publicationRevision:next.revision});expect(fresh.attemptId).not.toBe(old.attemptId);
 }),30000);
});
