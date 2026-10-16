import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createCollectionQueue } from '../../web/src/collection-admin/queue';
import { workerTick } from './worker';
const require=createRequire(new URL('../../web/package.json',import.meta.url));
const testUrl=process.env.SAAS_TEST_DATABASE_URL;let db:any;let source:any;let admin:any;
const query={keyword:'worker fixture',country:'US',status:'all',mediaType:'all',limit:3};
const verifiedTestCapabilities=(id:string)=>({version:1,verification:'VERIFIED',verifiedQueryProfiles:[{id:'explicit-test-profile',sourceId:id,adapterVersion:'fixture-1',query,verifiedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),provenance:'live-meta-probe',authorization:'operator-signed-probe',evidenceReference:'local-private:private-source-evidence/explicit-test-profile/snapshot.html',evidenceSha256:'a'.repeat(64),probeManifestSha256:'b'.repeat(64)}]});
const outcome=(id:string)=>({status:'success' as const,ads:[{source:'meta' as const,sourceAdId:id,sourceUrl:`https://www.facebook.com/ads/library/?id=${id}`,advertiserName:null,advertiserPageUrl:null,body:'Fixture body',headline:null,description:null,displayUrl:null,cta:null,landingPageUrl:null,status:'unknown' as const,sourceStatusText:null,startDate:null,endDate:null,platforms:null,queryCountry:'US',media:[]}],errorCode:null,retryable:false,observedCardCount:1,parsedAdCount:1,parserVersion:'fixture-1',collectedAt:new Date().toISOString()});
async function task(){return db.collectionTask.create({data:{dataSourceId:source.id,createdByUserId:admin.id,name:'Worker fixture',query,status:'ACTIVE',maxItems:20,maxAttempts:2}});}
describe.skipIf(!testUrl)('PostgreSQL worker evidence and leased commit',()=>{
  beforeAll(async()=>{const {PrismaClient}=require('@prisma/client');db=new PrismaClient({datasources:{db:{url:testUrl}}});const suffix=randomUUID();admin=await db.user.create({data:{email:`worker-${suffix}@example.test`,isAdmin:true}});source=await db.dataSource.create({data:{key:`worker-${suffix}`,name:'Worker test',adapterVersion:'fixture-1',status:'ACTIVE'}});await db.dataSource.update({where:{id:source.id},data:{capabilities:verifiedTestCapabilities(source.id)}});});
  afterAll(async()=>{await db?.$disconnect();});
  it('worker records evidence storage failure without ingesting unsupported facts',async()=>{
    const t=await task();const queue=createCollectionQueue(db);const run=await queue.enqueue({taskId:t.id,requestedByUserId:admin.id,idempotencyKey:'worker-evidence-fail'});
    const result=await workerTick(db,{workerId:'worker-evidence-test',taskId:t.id,adapter:async()=>outcome('9999912345'),persistEvidence:async()=>{throw new Error('provider credential should not leak');}});
    expect(result).toMatchObject({status:'FAILED',errorCode:'EVIDENCE_STORAGE_FAILED'});expect(await db.ad.count({where:{dataSourceId:source.id,sourceAdId:'9999912345'}})).toBe(0);expect((await db.collectionRun.findUnique({where:{id:run.id}})).errorMessage).toBeNull();
  });
  it.each(['META_HTTP_403','META_HTTP_429','META_SOURCE_CHALLENGE','META_SOURCE_LOGIN_REQUIRED'])('pauses a restricted source atomically so future schedules do not retry %s',async errorCode=>{
    await db.dataSource.update({where:{id:source.id},data:{status:'ACTIVE'}});
    const t=await task();await db.collectionTask.update({where:{id:t.id},data:{scheduleCron:'@every 60s',nextRunAt:new Date(Date.now()-1000)}});
    const queue=createCollectionQueue(db);const run=await queue.enqueue({taskId:t.id,requestedByUserId:admin.id,idempotencyKey:errorCode});
    const result=await workerTick(db,{workerId:'restricted-test',taskId:t.id,adapter:async()=>({...outcome('unused'),status:'restricted',ads:[],errorCode}),persistEvidence:async()=>({evidenceReference:'test-evidence://restriction',evidenceSha256:'c'.repeat(64)})});
    expect(result.status).toBe('FAILED');expect(await db.dataSource.findUnique({where:{id:source.id}})).toMatchObject({status:'PAUSED',lastErrorCode:errorCode});
    expect(await db.auditEvent.findFirst({where:{action:'SOURCE_AUTO_PAUSED',targetId:source.id,metadata:{path:['runId'],equals:run.id}}})).not.toBeNull();
    await queue.scheduleDue();expect(await db.collectionRun.count({where:{taskId:t.id}})).toBe(1);
    await expect(queue.enqueue({taskId:t.id,requestedByUserId:admin.id,idempotencyKey:'should-refuse'})).rejects.toMatchObject({code:'COLLECTION_TASK_NOT_ACTIVE'});
    await db.collectionTask.update({where:{id:t.id},data:{status:'PAUSED'}});
  });
  it('preserves partial ads while pausing a rate-limited source',async()=>{
    await db.dataSource.update({where:{id:source.id},data:{status:'ACTIVE'}});const t=await task();await createCollectionQueue(db).enqueue({taskId:t.id,requestedByUserId:admin.id,idempotencyKey:'partial-restricted'});
    const id=`910${Date.now()}`;const result=await workerTick(db,{workerId:'partial-restricted-test',taskId:t.id,adapter:async()=>({...outcome(id),status:'partial',errorCode:'META_HTTP_429'}),persistEvidence:async()=>({evidenceReference:'test-evidence://partial',evidenceSha256:'d'.repeat(64)})});
    expect(result.status).toBe('PARTIAL');expect(await db.ad.count({where:{dataSourceId:source.id,sourceAdId:id}})).toBe(1);expect((await db.dataSource.findUnique({where:{id:source.id}})).status).toBe('PAUSED');
    await db.dataSource.update({where:{id:source.id},data:{status:'ACTIVE'}});
  });
  it('still pauses a known restricted source if final evidence persistence fails',async()=>{
    await db.dataSource.update({where:{id:source.id},data:{status:'ACTIVE'}});const t=await task();const run=await createCollectionQueue(db).enqueue({taskId:t.id,requestedByUserId:admin.id,idempotencyKey:'restricted-storage-fail'});
    const result=await workerTick(db,{workerId:'restricted-storage-test',taskId:t.id,adapter:async()=>({...outcome('unused'),status:'restricted',ads:[],errorCode:'META_HTTP_403'}),persistEvidence:async()=>{throw new Error('PRIVATE_PROVIDER_ERROR');}});
    expect(result).toMatchObject({status:'FAILED',errorCode:'EVIDENCE_STORAGE_FAILED'});expect((await db.dataSource.findUnique({where:{id:source.id}})).status).toBe('PAUSED');expect(await db.collectionRun.findUnique({where:{id:run.id}})).toMatchObject({errorCode:'EVIDENCE_STORAGE_FAILED',restrictionReason:'META_HTTP_403'});
    await db.dataSource.update({where:{id:source.id},data:{status:'ACTIVE'}});
  });
  it('worker runs only an injected adapter and commits outcome with evidence under its lease',async()=>{
    const t=await task();const queue=createCollectionQueue(db);await queue.enqueue({taskId:t.id,requestedByUserId:admin.id,idempotencyKey:'worker'});const id=`900${Date.now()}`;
    const result=await workerTick(db,{workerId:'worker-test',taskId:t.id,adapter:async()=>outcome(id),persistEvidence:async()=>({evidenceReference:'test-evidence://worker',evidenceSha256:'b'.repeat(64)})});expect(result.status).toBe('SUCCEEDED');expect(await db.ad.count({where:{dataSourceId:source.id,sourceAdId:id}})).toBe(1);
  });
  it('keeps old queued runs idle and stops old scheduling when central dispatch owns the source',async()=>{
    await db.dataSource.update({where:{id:source.id},data:{status:'ACTIVE'}});const t=await task(),queue=createCollectionQueue(db),run=await queue.enqueue({taskId:t.id,requestedByUserId:admin.id,idempotencyKey:'central-takeover'});
    const control=await db.collectorSourceControl.create({data:{dataSourceId:source.id,sourceKey:source.key,channel:'*',scopeKey:'SOURCE',controlMode:'TASK_CLAIM'}});let requests=0;
    try{
      const result=await workerTick(db,{workerId:'central-blocks-legacy',taskId:t.id,adapter:async()=>{requests++;return outcome('unused');},persistEvidence:async()=>({evidenceReference:'test-evidence://unused',evidenceSha256:'e'.repeat(64)})});
      expect(result.status).toBe('IDLE');expect(requests).toBe(0);expect((await db.collectionRun.findUnique({where:{id:run.id}})).status).toBe('QUEUED');
      await db.collectionTask.update({where:{id:t.id},data:{scheduleCron:'@every 60s',nextRunAt:new Date(Date.now()-1000)}});expect((await queue.scheduleDue()).enqueued).not.toContain(run.id);expect(await db.collectionRun.count({where:{taskId:t.id}})).toBe(1);
      await expect(queue.enqueue({taskId:t.id,requestedByUserId:admin.id,idempotencyKey:'central-owned-enqueue'})).rejects.toMatchObject({code:'SOURCE_CENTRALLY_MANAGED'});
    }finally{await db.collectorSourceControl.delete({where:{id:control.id}});await db.collectionTask.update({where:{id:t.id},data:{status:'PAUSED'}});}
  });
  it('blocks unmanaged app workers after central LEGACY ownership, including drain and retirement',async()=>{
    await db.dataSource.update({where:{id:source.id},data:{status:'ACTIVE'}});const t=await task(),queue=createCollectionQueue(db),run=await queue.enqueue({taskId:t.id,requestedByUserId:admin.id,idempotencyKey:'central-legacy-takeover'});
    const nodeId='legacy-owner-'+randomUUID(),incarnationId=randomUUID();await db.collectorNode.create({data:{nodeId,incarnationId,registryRevision:1,enabled:true,codeRevision:'fixture',protocolVersions:[1]}});
    const assignment=await db.collectorSourceAssignment.create({data:{dataSourceId:source.id,sourceKey:source.key,channel:'*',nodeId,incarnationId,generation:1,controlMode:'LEGACY_QUEUE',tokenHash:'a'.repeat(64),leaseExpiresAt:new Date(Date.now()+60000)}});let requests=0;
    try{
      for(const state of ['ACTIVE','DRAINING','STOPPED']){
        await db.collectorSourceAssignment.update({where:{id:assignment.id},data:{state}});
        const result=await workerTick(db,{workerId:'legacy-central-owner-block',taskId:t.id,adapter:async()=>{requests++;return outcome('central-legacy-unused');},persistEvidence:async()=>({evidenceReference:'test-evidence://unused',evidenceSha256:'e'.repeat(64)})});
        expect(result.status).toBe('IDLE');expect(requests).toBe(0);expect((await db.collectionRun.findUnique({where:{id:run.id}})).status).toBe('QUEUED');
      }
      await db.collectionTask.update({where:{id:t.id},data:{scheduleCron:'@every 60s',nextRunAt:new Date(Date.now()-1000)}});await queue.scheduleDue();expect(await db.collectionRun.count({where:{taskId:t.id}})).toBe(1);
      await expect(queue.enqueue({taskId:t.id,requestedByUserId:admin.id,idempotencyKey:'central-legacy-enqueue'})).rejects.toMatchObject({code:'SOURCE_CENTRALLY_MANAGED'});
    }finally{await db.collectorSourceAssignment.delete({where:{id:assignment.id}});await db.collectorNode.delete({where:{nodeId}});await db.collectionTask.update({where:{id:t.id},data:{status:'PAUSED'}});}
  });

});
