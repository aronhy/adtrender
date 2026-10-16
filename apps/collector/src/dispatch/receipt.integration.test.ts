import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
const url=process.env.SAAS_TEST_DATABASE_URL;
const require=createRequire(new URL('../../../web/package.json',import.meta.url));
const sources={meta:['meta_ad_library','meta-service-dom-1'],google:['google_ads_transparency','google-service-dom-1'],snapchat:['snapchat_ads_gallery','snapchat-service-public-1'],tiktok:['tiktok_commercial_library','tiktok-public-dom-1'],pinterest:['pinterest_ads_repository','pinterest-public-dom-1']} as const;
let db:any;
function itemBatch(platform:'meta'|'google'|'snapchat'|'tiktok',id:string,observedAt:string){
 const [sourceKey,version]=sources[platform],query={country:'DE',language:'en',keyword:'synthetic outcome',kind:'SEARCH',term:'synthetic',publisher:'Synthetic outcome '+id,startDate:'2026-10-01',endDate:'2026-10-10'},common={body:'Synthetic outcome '+observedAt,headline:null,cta:null,landingPageUrl:null,media:[]},base={version,sourceKey,platform:platform.toUpperCase(),query,observedAt,status:'SUCCEEDED',errorCode:null,advertisers:[],completedIds:[id],coverage:{completeSourceCoverage:false,exhausted:false,reason:'ISOLATED_OUTCOME_TEST'}};
 if(platform==='meta'){const sourceUrl='https://www.facebook.com/ads/library/?id='+id;return {...base,ads:[{...common,source:'meta',sourceAdId:id,sourceUrl,queryCountry:'DE',status:'active',platforms:[]}],evidence:[{url:sourceUrl,text:'Library ID: '+id}]};}
 if(platform==='google'){const advertiserId='AR'+id.slice(2),sourceUrl='https://adstransparency.google.com/advertiser/'+advertiserId+'/creative/'+id;return {...base,ads:[{...common,sourceAdId:id,sourceUrl,advertiserId,advertiserName:'Synthetic outcome',queryCountry:'DE',publisherPlatform:'SEARCH',sourceStatus:'UNKNOWN',mediaType:'TEXT',reportedCountries:[]}],evidence:[{kind:'detail',url:sourceUrl,adId:id,html:'<div>Synthetic detail</div>'},{kind:'listing',url:'https://adstransparency.google.com/?platform=SEARCH',platformVerified:true,html:id+' Platform filter button: selected Google Search'}]};}
 if(platform==='snapchat'){const raw={id,synthetic:true};return {...base,ads:[{...common,sourceAdId:id,sourceUrl:'https://adsgallery.snap.com/?adId='+id,publisherPlatform:'SNAPCHAT',sourceStatus:'ACTIVE',queryCountry:'DE',mediaType:'UNKNOWN',reportedCountries:['DE'],raw}],evidence:[{kind:'public-response',url:'https://adsapi.snapchat.com/v1/ads_library/ads/'+id,status:200,raw:{request_status:'SUCCESS',ad_preview:raw}},{kind:'public-response',url:'https://adsapi.snapchat.com/v1/ads_library/ads/search?synthetic=true',status:200,request:{paying_advertiser_name:query.publisher,countries:['de']},raw:{request_status:'SUCCESS',ad_previews:[{sub_request_status:'SUCCESS',ad_preview:raw}]}}]};}
 const sourceUrl='https://library.tiktok.com/ads/detail/?ad_id='+id;return {...base,ads:[{...common,sourceAdId:id,sourceUrl,sourceAdvertiserId:null,advertiserName:null,firstShown:null,lastShown:null,reportedCountries:['DE'],sourceFields:{},observedAt}],evidence:[{kind:'detail',url:sourceUrl,adId:id,text:'Ad ID: '+id,html:'<div>Synthetic detail</div>',observedAt,httpStatus:200}]};
}
describe.skipIf(!url)('native importer receipt metadata on isolated PostgreSQL',()=>{
 beforeAll(async()=>{
  const u=new URL(url!);if(!['127.0.0.1','localhost'].includes(u.hostname)||!u.pathname.includes('_test_'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const {PrismaClient}=require('@prisma/client');db=new PrismaClient({datasources:{db:{url}}});
  for(const [platform,[key,version]] of Object.entries(sources)){
   await db.dataSource.upsert({where:{key},create:{key,name:'Isolated receipt '+platform,status:'PAUSED',adapterVersion:version},update:{}});
   // Runtime production grants remain unchanged; this isolated test uses its owner.
   const psqlUrl=new URL(url!);psqlUrl.searchParams.delete('schema');
   execFileSync('psql',[psqlUrl.toString(),'-X','-v','ON_ERROR_STOP=1'],{input:readFileSync('apps/collector/deploy/'+platform+'/ingest.sql','utf8').replace(/^GRANT[^\n]*\n/gm,''),stdio:['pipe','pipe','pipe']});
  }
 });
 afterAll(async()=>{await db?.$disconnect();});
 it.each(Object.keys(sources) as Array<keyof typeof sources>)('%s retains the original time and counts when exact bytes replay',async platform=>{
  const [sourceKey,version]=sources[platform];
  const query={country:'DE',language:'en',keyword:'',kind:'SEARCH',term:'',publisher:'Synthetic receipt '+randomUUID(),startDate:'2026-10-01',endDate:'2026-10-10'};
  const raw=JSON.stringify({version,sourceKey,platform:platform.toUpperCase(),observedAt:'2026-10-10T00:00:00Z',query,status:'NO_RESULTS',errorCode:null,ads:[],advertisers:[],domains:[],evidence:[],completedIds:[],coverage:{completeSourceCoverage:false,exhausted:false,reason:'ISOLATED_RECEIPT_TEST'}});
  const rollback=new Error('ROLLBACK_NATIVE_RECEIPT_FIXTURE');await expect(db.$transaction(async(tx:any)=>{await tx.$executeRawUnsafe('UPDATE public."CollectorSourceControl" SET "controlMode"=\'LEGACY_QUEUE\' WHERE "sourceKey"=$1',sourceKey);await tx.collectorSourceAssignment.deleteMany({where:{sourceKey}});
  const ingest=async()=> (await tx.$queryRawUnsafe('SELECT '+platform+'_collector.ingest($1::text) AS result',raw))[0].result;
  const first=await ingest();expect(first).toMatchObject({status:'IMPORTED',originalInserted:0,originalUpdated:0});
  expect(Number.isFinite(Date.parse(first.committedAt))).toBe(true);
  const original=await tx.collectionRun.findUniqueOrThrow({where:{id:first.runId}});
  expect(Date.parse(first.committedAt)).toBe(original.finishedAt.getTime());
  // Non-zero preexisting run counts make accidental zero overwrite visible.
  await tx.collectionRun.update({where:{id:first.runId},data:{insertedCount:3,updatedCount:2}});
  const replay=await ingest();expect(replay).toMatchObject({status:'ALREADY_IMPORTED',runId:first.runId,inserted:0,updated:0,originalInserted:3,originalUpdated:2,committedAt:first.committedAt});throw rollback;
  },{timeout:15000})).rejects.toBe(rollback);
 });
 it.each(['meta','google','snapchat','tiktok'] as const)('%s records per-item inserted/updated facts and leaves legacy replay outcomes unchanged',async platform=>{
  const numeric=(8800000000000000000n+BigInt('0x'+randomBytes(6).toString('hex'))).toString(),id=platform==='snapchat'?randomUUID():platform==='google'?'CR'+numeric:numeric,sourceKey=sources[platform][0],rollback=new Error('ROLLBACK_NATIVE_OUTCOME_FIXTURE');
  await expect(db.$transaction(async(tx:any)=>{await tx.$executeRawUnsafe('UPDATE public."CollectorSourceControl" SET "controlMode"=\'LEGACY_QUEUE\' WHERE "sourceKey"=$1',sourceKey);await tx.collectorSourceAssignment.deleteMany({where:{sourceKey}});const ingest=async(batch:unknown)=>(await tx.$queryRawUnsafe('SELECT '+platform+'_collector.ingest($1::text) AS result',JSON.stringify(batch)))[0].result;
   const firstBatch=itemBatch(platform,id,'2026-10-10T00:00:00Z'),first=await ingest(firstBatch);expect(first).toMatchObject({inserted:1,updated:0});const firstItems=await tx.runItem.findMany({where:{runId:first.runId}});expect(firstItems.map((item:any)=>item.status)).toEqual(['INSERTED']);
   const second=await ingest(itemBatch(platform,id,'2026-10-10T01:00:00Z'));expect(second).toMatchObject({inserted:0,updated:1});expect((await tx.runItem.findMany({where:{runId:second.runId}})).map((item:any)=>item.status)).toEqual(['UPDATED']);const run=await tx.collectionRun.findUniqueOrThrow({where:{id:second.runId}});expect(run).toMatchObject({insertedCount:0,updatedCount:1});
   // A committed old-format outcome remains an immutable fact on exact-byte replay.
   await tx.runItem.update({where:{id:firstItems[0].id},data:{status:'INGESTED'}});expect(await ingest(firstBatch)).toMatchObject({status:'ALREADY_IMPORTED',runId:first.runId});expect((await tx.runItem.findUniqueOrThrow({where:{id:firstItems[0].id}})).status).toBe('INGESTED');
   if(platform==='tiktok'){const historical=await ingest(itemBatch(platform,id,'2026-10-09T00:00:00Z'));expect(historical).toMatchObject({inserted:0,updated:0,historical:1});expect((await tx.runItem.findMany({where:{runId:historical.runId}})).map((item:any)=>item.status)).toEqual(['INGESTED']);expect((await tx.ad.findFirstOrThrow({where:{sourceAdId:id,dataSource:{key:sourceKey}}})).body).toBe('Synthetic outcome 2026-10-10T01:00:00Z');}
   throw rollback;
  },{timeout:15000})).rejects.toBe(rollback);
 });
});
