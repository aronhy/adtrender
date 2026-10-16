import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { assertVerifiedCollectionQuery, verifiedSourceProfiles } from '../../../packages/contracts/src/collection';
import { createCollectionQueue } from '../../web/src/collection-admin/queue';
const require=createRequire(new URL('../../web/package.json',import.meta.url));
const query={keyword:'coffee',country:'US',status:'all',mediaType:'all',limit:3};
const now=new Date();
// Explicit isolated test fixture; operator grants never load this module or test artifacts.
const capabilities=(sourceId:string)=>({version:1,verification:'VERIFIED',verifiedQueryProfiles:[{id:'test-profile',sourceId,adapterVersion:'meta-dom-1',query,verifiedAt:new Date(now.valueOf()-1000).toISOString(),expiresAt:new Date(now.valueOf()+86400000).toISOString(),provenance:'live-meta-probe',authorization:'operator-signed-probe',evidenceReference:'local-private:private-source-evidence/test-profile/snapshot.html',evidenceSha256:'a'.repeat(64),probeManifestSha256:'b'.repeat(64)}]});
describe('source capability authorization',()=>{
 it('fails closed for legacy declarations, absent evidence, expired profiles and parser version changes',()=>{
  const source={id:'source',adapterVersion:'meta-dom-1',capabilities:capabilities('source')};
  expect(assertVerifiedCollectionQuery(source,query)).toEqual(query);
  expect(()=>assertVerifiedCollectionQuery({...source,capabilities:{publicAds:true}},query)).toThrow('SOURCE_CAPABILITY_UNVERIFIED');
  expect(()=>assertVerifiedCollectionQuery({...source,adapterVersion:'meta-dom-2'},query)).toThrow('SOURCE_CAPABILITY_UNVERIFIED');
  expect(verifiedSourceProfiles(source,new Date(now.valueOf()+2*86400000))).toEqual([]);
  source.capabilities.verifiedQueryProfiles[0].evidenceSha256='';expect(verifiedSourceProfiles(source)).toEqual([]);
 });
 it.each([{...query,keyword:'different'},{...query,country:'GB'},{...query,status:'active'},{...query,mediaType:'video'},{...query,limit:4}])('does not expand one verified sample to another query %j',input=>{
  expect(()=>assertVerifiedCollectionQuery({id:'source',adapterVersion:'meta-dom-1',capabilities:capabilities('source')},input)).toThrow('SOURCE_CAPABILITY_UNVERIFIED');
 });
});
const url=process.env.SAAS_TEST_DATABASE_URL;let db:any;afterAll(()=>db?.$disconnect());
describe.skipIf(!url)('PostgreSQL capability gates',()=>{
 it('rejects activation, enqueue, schedules and injected queued runs without a verified profile',async()=>{
  const {PrismaClient}=require('@prisma/client');db=new PrismaClient({datasources:{db:{url}}});
  const admin=await db.user.create({data:{email:`capabilities-${randomUUID()}@example.test`,isAdmin:true}});
  const source=await db.dataSource.create({data:{key:`capabilities-${randomUUID()}`,name:'Isolated capability test',adapterVersion:'meta-dom-1',status:'PAUSED'}});
  const queue=createCollectionQueue(db);await expect(queue.setSourceStatus({sourceId:source.id,actorUserId:admin.id,status:'ACTIVE'})).rejects.toMatchObject({code:'SOURCE_CAPABILITY_UNVERIFIED'});
  await db.dataSource.update({where:{id:source.id},data:{status:'ACTIVE'}});
  const task=await db.collectionTask.create({data:{dataSourceId:source.id,name:'Unverified test',query,status:'ACTIVE',scheduleCron:'@every 60s',nextRunAt:new Date(Date.now()-1000)}});
  await expect(queue.setTaskStatus({taskId:task.id,actorUserId:admin.id,status:'ACTIVE'})).rejects.toMatchObject({code:'SOURCE_CAPABILITY_UNVERIFIED'});
  await expect(queue.enqueue({taskId:task.id,requestedByUserId:admin.id,idempotencyKey:'unverified'})).rejects.toMatchObject({code:'SOURCE_CAPABILITY_UNVERIFIED'});
  await queue.scheduleDue();expect(await db.collectionRun.count({where:{taskId:task.id}})).toBe(0);expect((await db.collectionTask.findUnique({where:{id:task.id}})).status).toBe('PAUSED');
  const run=await db.collectionRun.create({data:{taskId:task.id,dataSourceId:source.id,idempotencyKey:randomUUID(),querySnapshot:query,adapterVersion:'meta-dom-1'}});
  expect(await queue.claim({workerId:'capability-worker',taskId:task.id})).toBeNull();expect(await db.collectionRun.findUnique({where:{id:run.id}})).toMatchObject({status:'FAILED',errorCode:'SOURCE_CAPABILITY_UNVERIFIED'});
  await db.dataSource.update({where:{id:source.id},data:{status:'PAUSED',capabilities:capabilities(source.id)}});
  expect((await queue.setSourceStatus({sourceId:source.id,actorUserId:admin.id,status:'ACTIVE'})).status).toBe('ACTIVE');
  await db.collectionTask.update({where:{id:task.id},data:{status:'ACTIVE',query}});const valid=await queue.enqueue({taskId:task.id,requestedByUserId:admin.id,idempotencyKey:'verified'});
  await db.dataSource.update({where:{id:source.id},data:{capabilities:{version:1,verification:'UNVERIFIED',verifiedQueryProfiles:[]}}});
  expect(await queue.claim({workerId:'revoked-worker',taskId:task.id})).toBeNull();expect((await db.collectionRun.findUnique({where:{id:valid.id}})).errorCode).toBe('SOURCE_CAPABILITY_UNVERIFIED');
 });
});
