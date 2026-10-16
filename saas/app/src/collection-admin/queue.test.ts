import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createCollectionQueue } from './queue';
import { ingestCollection } from './ingest';
import { searchAds } from '../ads/service';
const require = createRequire(new URL('../../package.json', import.meta.url));
const testUrl=process.env.SAAS_TEST_DATABASE_URL;
const query={keyword:'furniture',country:'US',status:'all',mediaType:'all',limit:3};
let db:any;let admin:any;let source:any;let workspace:any;let viewer:any;const madeTaskIds:string[]=[];
const verifiedTestCapabilities=(id:string)=>({version:1,verification:'VERIFIED',verifiedQueryProfiles:[{id:'explicit-test-profile',sourceId:id,adapterVersion:'fixture-1',query,verifiedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),provenance:'live-meta-probe',authorization:'operator-signed-probe',evidenceReference:'local-private:private-source-evidence/explicit-test-profile/snapshot.html',evidenceSha256:'a'.repeat(64),probeManifestSha256:'b'.repeat(64)}]});
const ad=(id:string)=>({source:'meta' as const,sourceAdId:id,sourceUrl:`https://www.facebook.com/ads/library/?id=${id}`,advertiserName:'Unknown page name',advertiserPageUrl:null,body:'Oak furniture',headline:null,description:null,displayUrl:null,cta:null,landingPageUrl:null,status:'unknown' as const,sourceStatusText:null,startDate:null,endDate:null,platforms:null,queryCountry:'US',media:[{type:'image' as const,url:`https://cdn.example/${id}.jpg`,posterUrl:null}]});
const outcome=(id:string)=>({status:'success' as const,ads:[ad(id)],errorCode:null,retryable:false,observedCardCount:1,parsedAdCount:1,parserVersion:'fixture-1',collectedAt:new Date().toISOString()});
async function task(overrides:Record<string,unknown>={}){const t=await db.collectionTask.create({data:{dataSourceId:source.id,createdByUserId:admin.id,name:'Isolated collector test',query,status:'ACTIVE',maxItems:20,maxAttempts:2,...overrides}});madeTaskIds.push(t.id);return t;}

describe.skipIf(!testUrl)('PostgreSQL leased collection, ingestion and search',()=>{
  beforeAll(async()=>{
    const {PrismaClient}=require('@prisma/client');db=new PrismaClient({datasources:{db:{url:testUrl}}});
    const suffix=randomUUID();admin=await db.user.create({data:{email:`collector-admin-${suffix}@example.test`,isAdmin:true}});viewer=await db.user.create({data:{email:`collector-viewer-${suffix}@example.test`}});
    const organization=await db.organization.create({data:{name:'Collector test',slug:`collector-${suffix}`,members:{create:{userId:admin.id,role:'OWNER'}}}});
    await db.organizationMember.create({data:{organizationId:organization.id,userId:viewer.id,role:'MEMBER'}});
    workspace=await db.workspace.create({data:{organizationId:organization.id,name:'Collector workspace',slug:'test'}});
    await db.workspaceMember.create({data:{workspaceId:workspace.id,organizationId:organization.id,userId:viewer.id,role:'VIEWER'}});
    source=await db.dataSource.create({data:{key:`meta-collector-test-${suffix}`,name:'Test source',status:'ACTIVE',adapterVersion:'fixture-1'}});await db.dataSource.update({where:{id:source.id},data:{capabilities:verifiedTestCapabilities(source.id)}});
  });
  afterAll(async()=>{await db?.$disconnect();});
  it('deduplicates concurrent manual enqueue and stores an immutable query snapshot',async()=>{
    const t=await task();const queue=createCollectionQueue(db);
    const input={taskId:t.id,requestedByUserId:admin.id,idempotencyKey:'double-click'};
    const [a,b]=await Promise.all([queue.enqueue(input),queue.enqueue(input)]);expect(a.id).toBe(b.id);
    await db.collectionTask.update({where:{id:t.id},data:{query:{...query,keyword:'changed'}}});
    expect((await db.collectionRun.findUnique({where:{id:a.id}})).querySnapshot.keyword).toBe('furniture');
    await expect(queue.enqueue({...input,requestedByUserId:viewer.id,idempotencyKey:'forbidden'})).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});
    await queue.requestCancel(a.id,admin.id);
  });
  it('claims once across workers and rejects an expired or replaced lease',async()=>{
    const t=await task();const queue=createCollectionQueue(db);await queue.enqueue({taskId:t.id,requestedByUserId:admin.id,idempotencyKey:'claim'});
    const leases=await Promise.all([queue.claim({workerId:'a',taskId:t.id}),queue.claim({workerId:'b',taskId:t.id})]);const claimed=leases.filter(Boolean);expect(claimed).toHaveLength(1);
    const old=claimed[0]!.token;await db.collectionRun.update({where:{id:old.runId},data:{leaseExpiresAt:new Date(Date.now()-1000)}});
    expect(await queue.renew(old)).toBe(false);expect(await queue.finish(old,{status:'success',ads:[],errorCode:null,retryable:false,observedCardCount:0,parsedAdCount:0,parserVersion:'test',collectedAt:new Date().toISOString()})).toBe(false);
    await queue.recoverExpired();const next=await queue.claim({workerId:'c',taskId:t.id});expect(next!.token.version).toBeGreaterThan(old.version);expect(await queue.renew(old)).toBe(false);await queue.requestCancel(old.runId,admin.id);expect(await queue.renew(next!.token)).toBe(false);expect((await db.collectionRun.findUnique({where:{id:old.runId}})).status).toBe('RUNNING');expect(await queue.ackCancel(next!.token)).toBe(true);expect((await db.collectionRun.findUnique({where:{id:old.runId}})).status).toBe('CANCELED');
  });
  it('queues each due schedule once and pause leaves the current run running',async()=>{
    const scheduledFor=new Date(Date.now()-5000);const t=await task({scheduleCron:'@every 60s',nextRunAt:scheduledFor});const queue=createCollectionQueue(db);
    await Promise.all([queue.scheduleDue(),queue.scheduleDue()]);expect(await db.collectionRun.count({where:{taskId:t.id}})).toBe(1);
    const run=await queue.claim({workerId:'scheduled',taskId:t.id});await db.collectionTask.update({where:{id:t.id},data:{status:'PAUSED',nextRunAt:new Date(Date.now()-1000)}});await queue.scheduleDue();expect(await db.collectionRun.count({where:{taskId:t.id}})).toBe(1);expect(await queue.renew(run!.token)).toBe(true);await queue.requestCancel(run!.token.runId,admin.id);await queue.ackCancel(run!.token);
  });
  it('claims an already queued task after a pause and fails a disabled source explicitly',async()=>{
    const t=await task();const queue=createCollectionQueue(db);await queue.enqueue({taskId:t.id,requestedByUserId:admin.id,idempotencyKey:'pause-existing'});await db.collectionTask.update({where:{id:t.id},data:{status:'PAUSED'}});const claim=await queue.claim({workerId:'paused-existing',taskId:t.id});expect(claim).not.toBeNull();await queue.requestCancel(claim!.token.runId,admin.id);await queue.ackCancel(claim!.token);
    await db.collectionTask.update({where:{id:t.id},data:{status:'ACTIVE'}});const run=await queue.enqueue({taskId:t.id,requestedByUserId:admin.id,idempotencyKey:'disabled-source'});await db.dataSource.update({where:{id:source.id},data:{status:'DISABLED'}});expect(await queue.claim({workerId:'disabled',taskId:t.id})).toBeNull();expect((await db.collectionRun.findUnique({where:{id:run.id}}))).toMatchObject({status:'FAILED',errorCode:'SOURCE_DISABLED'});await db.dataSource.update({where:{id:source.id},data:{status:'ACTIVE'}});
  });
  it('does not retry source restrictions and bounds network retries by attempts',async()=>{
    const t=await task();const queue=createCollectionQueue(db);await queue.enqueue({taskId:t.id,requestedByUserId:admin.id,idempotencyKey:'restriction'});const first=await queue.claim({workerId:'retry',taskId:t.id});
    await queue.finish(first!.token,{...outcome('unused'),status:'restricted',ads:[],errorCode:'META_HTTP_429',retryable:true});expect((await db.collectionRun.findUnique({where:{id:first!.token.runId}})).status).toBe('FAILED');expect(await queue.claim({workerId:'retry',taskId:t.id})).toBeNull();
    await queue.enqueue({taskId:t.id,requestedByUserId:admin.id,idempotencyKey:'network'});let run=await queue.claim({workerId:'retry',taskId:t.id});await queue.finish(run!.token,{...outcome('unused'),status:'failed',ads:[],errorCode:'META_NETWORK_ERROR',retryable:true});await db.collectionRun.update({where:{id:run!.token.runId},data:{nextAttemptAt:new Date(Date.now()-1000)}});run=await queue.claim({workerId:'retry',taskId:t.id});await queue.finish(run!.token,{...outcome('unused'),status:'failed',ads:[],errorCode:'META_NETWORK_ERROR',retryable:true});expect((await db.collectionRun.findUnique({where:{id:run!.token.runId}})).status).toBe('FAILED');
  });
  it('ingests once per source ad and run with separate media and auditable unknowns',async()=>{
    const t=await task();const queue=createCollectionQueue(db);await queue.enqueue({taskId:t.id,requestedByUserId:admin.id,idempotencyKey:'ingest'});const claimed=await queue.claim({workerId:'ingest',taskId:t.id});const parsed=outcome(`100${Date.now()}`);
    const save=()=>db.$transaction((tx:any)=>ingestCollection(tx,claimed!.token,parsed,{evidenceReference:'test-evidence://snapshot-1',evidenceSha256:'a'.repeat(64)}));await save();await save();
    const saved=await db.ad.findUnique({where:{dataSourceId_sourceAdId:{dataSourceId:source.id,sourceAdId:parsed.ads[0].sourceAdId}},include:{observations:true,media:true}});expect(saved.observations).toHaveLength(1);expect(saved.media).toHaveLength(1);expect(saved.advertiserId).toBeNull();expect(saved.reportedCountries).toEqual([]);expect(saved.publisherPlatforms).toEqual([]);expect(saved.observations[0]).toMatchObject({queryCountry:'US',evidenceReference:'test-evidence://snapshot-1'});expect(saved.fieldProvenance.advertiserName.value).toBe('Unknown page name');
    await queue.requestCancel(claimed!.token.runId,admin.id);await expect(save()).rejects.toMatchObject({code:'LEASE_LOST'});await queue.ackCancel(claimed!.token);
  });
  it('keeps the latest facts when an older observation finishes later',async()=>{
    const t=await task();const queue=createCollectionQueue(db);const sourceId=`800${Date.now()}`;
    const latest={...outcome(sourceId),collectedAt:'2026-10-04T12:00:00.000Z'};latest.ads[0].body='Newest source copy';
    const older={...outcome(sourceId),collectedAt:'2026-10-03T12:00:00.000Z'};older.ads[0].body='Old source copy';
    for(const [key,result] of [['latest',latest],['older',older]] as const){await queue.enqueue({taskId:t.id,requestedByUserId:admin.id,idempotencyKey:key});const claim=await queue.claim({workerId:key,taskId:t.id});await db.$transaction((tx:any)=>ingestCollection(tx,claim!.token,result,{evidenceReference:`test-evidence://${key}`,evidenceSha256:'c'.repeat(64)}));await queue.finish(claim!.token,result);}
    const saved=await db.ad.findUnique({where:{dataSourceId_sourceAdId:{dataSourceId:source.id,sourceAdId:sourceId}},include:{observations:true}});expect(saved.body).toBe('Newest source copy');expect(saved.lastObservedAt.toISOString()).toBe('2026-10-04T12:00:00.000Z');expect(saved.firstObservedAt.toISOString()).toBe('2026-10-03T12:00:00.000Z');expect(saved.observations).toHaveLength(2);
  });
  it('searches observed country and unknown advertiser without duplicated rows; authorizes every request',async()=>{
    const result=await searchAds(db,{userId:viewer.id,workspaceId:workspace.id,keyword:'Oak furniture',advertiser:'Unknown page name',country:'US',limit:1});expect(result.ads).toHaveLength(1);expect(result.countryScope).toBe('query');expect(result.ads[0].reportedCountries).toEqual([]);expect(result.total).toBeGreaterThanOrEqual(1);
    await expect(searchAds(db,{userId:viewer.id,workspaceId:'unrelated',limit:10})).rejects.toMatchObject({status:403});await db.user.update({where:{id:viewer.id},data:{disabledAt:new Date()}});await expect(searchAds(db,{userId:viewer.id,workspaceId:workspace.id})).rejects.toMatchObject({code:'ACCOUNT_DISABLED'});await db.user.update({where:{id:viewer.id},data:{disabledAt:null}});
  });

});
