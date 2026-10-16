import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {buildQueryLedger} from './metrics';
const url=process.env.SAAS_TEST_DATABASE_URL;
describe.skipIf(!url)('seed ledger PostgreSQL facts',()=>{
 it('reads original committed counts and distinguishes identities and item attribution',async()=>{
  const u=new URL(url!);if(!['127.0.0.1','localhost'].includes(u.hostname)||!u.pathname.includes('_test_'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const {PrismaClient}=createRequire(new URL('../../package.json',import.meta.url))('@prisma/client');const db=new PrismaClient({datasources:{db:{url}}});
  try{await db.$transaction(async(tx:any)=>{
   const source=await tx.dataSource.upsert({where:{key:'meta_ad_library'},create:{key:'meta_ad_library',name:'Seed ledger fixture',adapterVersion:'fixture',status:'PAUSED'},update:{}});
   const query={country:'US',language:'en',keyword:'seed-ledger-'+randomUUID()};
   const task=await tx.collectionTask.create({data:{dataSourceId:source.id,name:'Ledger fixture',query,status:'PAUSED'}});
   const r=await tx.collectionRun.create({data:{dataSourceId:source.id,taskId:task.id,idempotencyKey:'meta-service:'+randomUUID(),querySnapshot:query,adapterVersion:'fixture',status:'SUCCEEDED',startedAt:new Date('2040-01-01T00:00:00Z'),finishedAt:new Date(),fetchedCount:3,insertedCount:2,updatedCount:1}});
   await tx.runItem.create({data:{dataSourceId:source.id,runId:r.id,itemKey:'fixture1',sourceAdId:'12345',status:'INGESTED',parserVersion:'fixture'}});
   await tx.collectionRun.create({data:{dataSourceId:source.id,taskId:task.id,idempotencyKey:'meta-service:'+randomUUID(),querySnapshot:{...query,language:'und'},adapterVersion:'fixture',status:'FAILED',startedAt:new Date('2040-01-01T01:00:00Z'),finishedAt:new Date(),fetchedCount:0,errorCode:'META_HTTP_429'}});
   const rows=await buildQueryLedger(tx,{from:'2040-01-01T00:00:00Z',to:'2040-01-02T00:00:00Z'});const own=rows.filter(r=>r.params.keyword===query.keyword);
   expect(own).toHaveLength(2);expect(own.find(r=>r.params.language==='en')).toMatchObject({executionCount:1,insertedCount:2,updatedCount:1,itemInsertedCount:null,seedAttribution:'UNATTRIBUTED'});
   expect(own.find(r=>r.params.language==='und')).toMatchObject({rateLimitedCount:1,reliableNoResultsCount:0});
   const again=await buildQueryLedger(tx,{from:'2040-01-01T00:00:00Z',to:'2040-01-02T00:00:00Z'});expect(again).toEqual(rows);
   throw Error('FIXTURE_ROLLBACK');
  });}catch(e){if(!(e instanceof Error)||e.message!=='FIXTURE_ROLLBACK')throw e;}finally{await db.$disconnect();}
 });
});
