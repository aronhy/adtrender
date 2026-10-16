import {createRequire} from 'node:module';import {readFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';import {randomBytes} from 'node:crypto';
import {beforeAll,beforeEach,afterEach,afterAll,it,describe,expect} from 'vitest';
const url=process.env.SAAS_TEST_DATABASE_URL,require=createRequire(new URL('../../../app/package.json',import.meta.url));let db:any,ownerDb:any,fixtureTransaction:Promise<void>|undefined,releaseFixture:(()=>void)|undefined;
let id=8800000000000000000n+BigInt('0x'+randomBytes(6).toString('hex'));
const media='https://library.tiktok.com/api/v1/cdn/1791367179/video/Ynl0ZXM=/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function batch(sourceAdId:string,sourceUrl:string,observedAt:string,refresh=false,type:'IMAGE'|'VIDEO'='VIDEO'){return {version:'tiktok-public-dom-1',sourceKey:'tiktok_commercial_library',platform:'TIKTOK',observedAt,query:{country:'DE',startDate:'2026-09-30',endDate:'2026-10-07'},status:'SUCCEEDED',errorCode:null,ads:[{sourceAdId,sourceUrl:'https://library.tiktok.com/ads/detail/?ad_id='+sourceAdId,sourceAdvertiserId:null,advertiserName:'Isolated synthetic advertiser',body:'Synthetic refresh test',headline:null,cta:null,landingPageUrl:null,firstShown:'2026-10-01',lastShown:'2026-10-07',reportedCountries:['DE'],media:[{url:sourceUrl,type}],sourceFields:{Advertiser:'Isolated synthetic advertiser'},observedAt}],evidence:[{kind:'detail',url:'https://library.tiktok.com/ads/detail/?ad_id='+sourceAdId,httpStatus:200,adId:sourceAdId,text:'Ad ID: '+sourceAdId,html:'<video src="'+sourceUrl+'"></video>',observedAt}],completedIds:[sourceAdId],coverage:{completeSourceCoverage:false,exhausted:false,reason:refresh?'MEDIA_REFRESH_DETAIL':'BATCH_BUDGET',observedCards:1},nextPage:0,diagnostics:[]};}
async function ingest(b:unknown){return (await db.$queryRawUnsafe('SELECT tiktok_collector.ingest($1::text) AS result',JSON.stringify(b)))[0].result;}
const image='https://p16-common-sign.tiktokcdn.com/tos-no1a-i-photomode-no/'+ 'a'.repeat(32)+'~tplv-tiktokx-origin.jpeg?x-expires=1790000000';
async function failedAd(type:'VIDEO'|'IMAGE'='VIDEO'){const sourceAdId=(++id).toString(),at=new Date(Date.now()-86400000).toISOString();await ingest(batch(sourceAdId,type==='VIDEO'?media:image,at,false,type));const ad=await db.ad.findFirstOrThrow({where:{sourceAdId},include:{media:true}});await db.$executeRawUnsafe('UPDATE public."MediaObject" SET status=\'FAILED\', "errorCode"=\'MEDIA_HTTP_FAILED\', "downloadAttempts"=5 WHERE id=$1',ad.media[0].id);return ad;}
async function cleanup(){const rows=await db.ad.findMany({where:{body:'Synthetic refresh test',dataSource:{key:'tiktok_commercial_library'}},select:{id:true}});const ids=rows.map((r:any)=>r.id);if(!ids.length)return;await db.runItem.deleteMany({where:{adId:{in:ids}}});await db.mediaObject.deleteMany({where:{adId:{in:ids}}});await db.adObservation.deleteMany({where:{adId:{in:ids}}});await db.ad.deleteMany({where:{id:{in:ids}}});}

// Legacy RPC compatibility is tested in an isolated transaction view. No
// assignment, control/cooldown, fixture ad, or lease mutation is committed.
function fixtureClient(tx:any){
 let sequence=0;let client:any;
 async function savepoint(work:()=>Promise<any>,alwaysRollback=false){const name='legacy_fixture_'+(++sequence);await tx.$executeRawUnsafe('SAVEPOINT '+name);try{const result=await work();if(alwaysRollback)await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT '+name);await tx.$executeRawUnsafe('RELEASE SAVEPOINT '+name);return result;}catch(error){await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT '+name);await tx.$executeRawUnsafe('RELEASE SAVEPOINT '+name);throw error;}}
 client=new Proxy(tx,{get(target,key){if(key==='$transaction')return (work:(nested:any)=>Promise<any>)=>savepoint(()=>work(client),false);if(key==='$queryRawUnsafe'||key==='$executeRawUnsafe')return (...args:any[])=>savepoint(()=>target[key](...args));return target[key];}});return client;
}
async function beginLegacyFixture(){
 const rolledBack=new Error('LEGACY_FIXTURE_ROLLBACK');let ready!:()=>void;const started=new Promise<void>(resolve=>ready=resolve),finished=new Promise<void>(resolve=>releaseFixture=resolve);
 fixtureTransaction=ownerDb.$transaction(async(tx:any)=>{const sourceKeys=['tiktok_commercial_library'];await tx.collectorSourceAssignment.deleteMany({where:{sourceKey:{in:sourceKeys}}});await tx.collectorSourceControl.updateMany({where:{sourceKey:{in:sourceKeys}},data:{controlMode:'LEGACY_QUEUE'}});db=fixtureClient(tx);ready();await finished;throw rolledBack;},{timeout:60000}).catch((error:unknown)=>{if(error!==rolledBack)throw error;});await Promise.race([started,fixtureTransaction]);
}
async function endLegacyFixture(){releaseFixture?.();try{await fixtureTransaction;}finally{db=ownerDb;fixtureTransaction=undefined;releaseFixture=undefined;}}
describe.skipIf(!url)('bounded TikTok material refresh with real PostgreSQL',()=>{
 beforeAll(async()=>{const u=new URL(url!);if(!['127.0.0.1','localhost'].includes(u.hostname)||!u.pathname.includes('_test_'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');const {PrismaClient}=require('@prisma/client');ownerDb=db=new PrismaClient({datasources:{db:{url}}});await db.dataSource.upsert({where:{key:'tiktok_commercial_library'},create:{key:'tiktok_commercial_library',name:'Isolated TikTok refresh test',status:'PAUSED',adapterVersion:'tiktok-public-dom-1'},update:{}});const sql=readFileSync('saas/collector/deploy/tiktok/ingest.sql','utf8').replace(/^GRANT[^\n]*\n/gm,'');execFileSync('psql',[url!.split('?')[0],'-X','-v','ON_ERROR_STOP=1'],{input:sql,stdio:['pipe','pipe','pipe']});});
 beforeEach(async()=>{await beginLegacyFixture();await cleanup();});afterEach(endLegacyFixture);
 afterAll(async()=>{await ownerDb?.$disconnect();});
 it('returns only bounded ad identities and original discovery context, without material URLs or credentials',async()=>{
  const ad=await failedAd(),[result]=await db.$queryRawUnsafe('SELECT tiktok_collector.media_refresh_candidates(2) AS result');
  expect(result.result).toContainEqual({sourceAdId:ad.sourceAdId,country:'DE',startDate:'2026-09-30',endDate:'2026-10-07'});expect(result.result.length).toBeLessThanOrEqual(2);expect(JSON.stringify(result.result)).not.toContain('/api/v1/cdn/');
 });
 it('adds refreshed source evidence and a new media row without overwriting the old URL or its exhausted download budget',async()=>{
  const ad=await failedAd(),old=await db.mediaObject.findUniqueOrThrow({where:{id:ad.media[0].id}});await ingest(batch(ad.sourceAdId,media+'?fresh=synthetic',new Date().toISOString(),true));
  const prior=await db.mediaObject.findUniqueOrThrow({where:{id:old.id}});expect(prior).toMatchObject({sourceUrl:media,status:'FAILED',errorCode:'MEDIA_HTTP_FAILED'});expect((await db.$queryRawUnsafe('SELECT "downloadAttempts" FROM public."MediaObject" WHERE id=$1',old.id))[0].downloadAttempts).toBe(5);expect(await db.mediaObject.count({where:{adId:ad.id}})).toBe(2);
  const fresh=await db.mediaObject.findFirstOrThrow({where:{adId:ad.id,sourceUrl:media+'?fresh=synthetic'}});expect(fresh).toMatchObject({status:'UNAVAILABLE',errorCode:'PLATFORM_MEDIA_ADAPTER_PENDING'});expect((await db.$queryRawUnsafe('SELECT "downloadAttempts" FROM public."MediaObject" WHERE id=$1',fresh.id))[0].downloadAttempts).toBe(0);
  expect(await db.adObservation.count({where:{adId:ad.id}})).toBe(2);const [result]=await db.$queryRawUnsafe('SELECT tiktok_collector.media_refresh_candidates(2) AS result');expect(result.result.some((r:any)=>r.sourceAdId===ad.sourceAdId)).toBe(false);
 });
 it('does not refresh an ad whose actual video is already stored',async()=>{
  const ad=await failedAd();await db.mediaObject.update({where:{id:ad.media[0].id},data:{status:'READY',errorCode:null,storageKey:'public-media/synthetic-test'}});
  const [result]=await db.$queryRawUnsafe('SELECT tiktok_collector.media_refresh_candidates(2) AS result');expect(result.result.some((r:any)=>r.sourceAdId===ad.sourceAdId)).toBe(false);
 });
 it('selects a failed photomode IMAGE despite an unsupported avatar pending or a stored VIDEO',async()=>{
  const ad=await failedAd('IMAGE');await db.mediaObject.create({data:{adId:ad.id,sourceUrl:'https://p16-common-sign.tiktokcdn.com/tos-alisg-avt-0068/avatar~tplv-tiktokx-cropcenter:168:168.jpeg',type:'IMAGE',status:'UNAVAILABLE',errorCode:'PLATFORM_MEDIA_ADAPTER_PENDING'}});await db.mediaObject.create({data:{adId:ad.id,sourceUrl:media,type:'VIDEO',status:'READY',storageKey:'public-media/synthetic-stored-video'}});
  const [result]=await db.$queryRawUnsafe('SELECT tiktok_collector.media_refresh_candidates(2) AS result');expect(result.result.map((r:any)=>r.sourceAdId)).toEqual([ad.sourceAdId]);
 });
 it('lets a supported pending IMAGE finish before requesting another source observation',async()=>{
  const ad=await failedAd('IMAGE');await db.mediaObject.create({data:{adId:ad.id,sourceUrl:image+'&pending=synthetic',type:'IMAGE',status:'UNAVAILABLE',errorCode:'PLATFORM_MEDIA_ADAPTER_PENDING'}});
  const [result]=await db.$queryRawUnsafe('SELECT tiktok_collector.media_refresh_candidates(2) AS result');expect(result.result).toEqual([]);
 });
 it('refreshes a missing carousel image even when a different image is already saved',async()=>{
  const ad=await failedAd('IMAGE');await db.mediaObject.create({data:{adId:ad.id,sourceUrl:image.replace('a'.repeat(32),'b'.repeat(32)),type:'IMAGE',status:'READY',storageKey:'public-media/synthetic-other-carousel-image'}});
  const [result]=await db.$queryRawUnsafe('SELECT tiktok_collector.media_refresh_candidates(2) AS result');expect(result.result.map((r:any)=>r.sourceAdId)).toEqual([ad.sourceAdId]);
 });
 it('does not reobserve an image whose same file path is saved with a refreshed signature',async()=>{
  const ad=await failedAd('IMAGE');await db.mediaObject.create({data:{adId:ad.id,sourceUrl:image+'&signature=refreshed-synthetic',type:'IMAGE',status:'READY',storageKey:'public-media/synthetic-refreshed-image'}});
  const [result]=await db.$queryRawUnsafe('SELECT tiktok_collector.media_refresh_candidates(2) AS result');expect(result.result).toEqual([]);
 });
 it('rejects larger scans instead of expanding the collector runtime data access',async()=>{
  for(const limit of [0,3,100])await expect(db.$queryRawUnsafe('SELECT tiktok_collector.media_refresh_candidates($1::int)',limit)).rejects.toThrow('MEDIA_REFRESH_LIMIT');
 });
});
