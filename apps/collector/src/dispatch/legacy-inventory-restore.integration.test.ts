import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe,it,expect} from 'vitest';
import {prepareLegacyInventory,importLegacyInventory,inventoryLegacyState} from '../../../web/src/seed-library/legacy-import';
import {createCollectorEvidenceStore,collectorEvidenceKey} from '../../../web/src/collector-dispatch/evidence-store';
import {restoreNativeCheckpoint} from './native-checkpoint';
import type {SeedQuerySpec} from '../../../../packages/contracts/src/seeds';

const url=process.env.SAAS_TEST_DATABASE_URL;
describe.skipIf(!url)('imported legacy checkpoint native restore with PostgreSQL',()=>{
 it('restores exact archived bytes for the registry query ID and original node',async()=>{
  const target=new URL(url!);if(!['localhost','127.0.0.1'].includes(target.hostname)||!target.pathname.includes('_test_'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const {PrismaClient}=createRequire(new URL('../../../web/package.json',import.meta.url))('@prisma/client'),db=new PrismaClient({datasources:{db:{url}}}),stop=Error('TEST_ROLLBACK');
  const root=await mkdtemp(join(tmpdir(),'seed-legacy-restore-'));
  try{await db.$transaction(async(tx:any)=>{
   const suffix=randomUUID(),nodeId='legacy-restore-'+suffix,sourceKey='meta_ad_library' as const,actor=await tx.user.create({data:{email:suffix+'@legacy-restore.example.test',isAdmin:true}});
   const source=await tx.dataSource.upsert({where:{key:sourceKey},create:{key:sourceKey,name:'Synthetic legacy restore',adapterVersion:'fixture'},update:{}});
   const state={schemaVersion:3,jobs:[{id:'original-'+suffix,country:'US',language:'en',keyword:suffix,seen:['historical-ad'],cursor:{page:3,row:4},failures:2,dueAt:9000,lastAttemptAt:200}],pauseUntil:8000,restrictions:4,appliedBatches:{['a'.repeat(64)]:{committedAt:'2026-10-10T01:00:00Z'}}};
   const job=inventoryLegacyState(sourceKey,state).jobs[0],id=randomUUID();expect(id).not.toBe(job.queryId);
   await tx.seedQuery.create({data:{id,dataSourceId:source.id,sourceKey,channel:job.channel,mode:job.mode,normalizedParams:job.params,queryCountry:'US',queryLanguage:'en',queryKey:job.queryKey,queryKeyVersion:'legacy-1',adapterVersion:'fixture',capabilityVersion:'fixture',desiredEnabled:false}});
   const api=new Proxy(tx,{get(target,name){return name==='$transaction'?(body:(tx:any)=>Promise<unknown>)=>body(tx):Reflect.get(target,name);}});
   const checkpoint=(await prepareLegacyInventory(api,{actorUserId:actor.id,sourceKey,state,nodeId})).checkpoints[0];
   expect(checkpoint).toMatchObject({queryId:id,stateSchemaVersion:1,sessionAffinity:'node:'+nodeId});
   const namespace={prefix:'private-legacy-restore',sourceKey},store=await createCollectorEvidenceStore({kind:'local',rootDirectory:root,namespace}),key=collectorEvidenceKey(namespace,checkpoint.sha256),reference='local-private:'+key;
   await store.putIfAbsent(key,Buffer.from(checkpoint.raw,'utf8'),checkpoint.sha256);
   await importLegacyInventory(api,{actorUserId:actor.id,sourceKey,state,nodeId,adapterVersion:'fixture',checkpointRefs:{[job.nativeJobId]:{reference,sha256:checkpoint.sha256}},idempotencyKey:'import',reason:'Synthetic native recovery'});
   const runtime=await tx.seedRuntimeState.findUnique({where:{queryId:id}}),query:SeedQuerySpec={queryId:id,queryKey:job.queryKey,queryKeyVersion:'legacy-1',sourceKey,channel:job.channel,mode:job.mode,params:job.params,legacyDims:{},adapterVersion:'fixture',capabilityVersion:'fixture',desiredEnabled:true,nativeJobIds:[job.nativeJobId]};
   const grant={checkpointSequence:runtime.checkpointSequence,checkpointRef:runtime.checkpointRef} as any,response={checkpointSequence:runtime.checkpointSequence,checkpointRef:runtime.checkpointRef,checkpointSha:runtime.checkpointSha,stateSchemaVersion:runtime.stateSchemaVersion,sessionAffinity:runtime.sessionAffinity,raw:Buffer.from(await store.get(key)).toString('utf8')};
   const restored=restoreNativeCheckpoint({jobs:[{...state.jobs[0],seen:[],cursor:null}],pauseUntil:10000},query,grant,response,nodeId);
   expect(restored.jobs[0]).toMatchObject({seen:['historical-ad'],cursor:{page:3,row:4},failures:2,dueAt:9000});expect(restored.pauseUntil).toBe(10000);
   expect(()=>restoreNativeCheckpoint({jobs:[]},query,grant,response,'different-node')).toThrow('COLLECTOR_SESSION_AFFINITY_REQUIRED');
   throw stop;
  },{timeout:30000});}catch(error){if(error!==stop)throw error;}finally{await db.$disconnect();await rm(root,{recursive:true,force:true});}
 });
});
