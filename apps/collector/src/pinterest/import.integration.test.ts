import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {beforeAll,beforeEach,afterEach,afterAll,describe,it,expect} from 'vitest';
import {importPinterestBatch} from './import';

const databaseUrl=process.env.SAAS_TEST_DATABASE_URL;
const require=createRequire(new URL('../../../web/package.json',import.meta.url));
const video='https://v.pinimg.com/videos/mc/720p/19/a9/95/19a995a4ff00397bf8f88cbb0b86ffd0.mp4';
const image='https://i.pinimg.com/474x/3c/3e/ea/3c3eea112233445566778899aabbccdd.jpg';
let db:any,ownerDb:any,fixtureTransaction:Promise<void>|undefined,releaseFixture:(()=>void)|undefined;let id=8800000000000000000n+BigInt('0x'+randomBytes(6).toString('hex'));
// Synthetic ad identity and repository evidence; the media URL's public file
// shape was verified independently. This is never imported into a live system.
function fixture(media:Array<{type:'IMAGE'|'VIDEO';url:string}>=[{type:'IMAGE',url:image},{type:'VIDEO',url:video}]){
 const sourceAdId=(++id).toString(),sourceUrl=`https://ads.pinterest.com/ads-repository/${sourceAdId}/`;
 const rawHtml=`<section>${media.map(m=>m.type==='VIDEO'?`<video src="${m.url.replaceAll('&','&amp;')}"></video>`:`<img alt="Ad image" src="${m.url}">`).join('')}</section>`;
 return {version:'pinterest-public-dom-1',sourceKey:'pinterest_ads_repository',platform:'PINTEREST',observedAt:'2026-10-08T00:00:00Z',query:{keyword:'',country:'DE',limit:1},status:'SUCCEEDED',errorCode:null,ads:[{sourceAdId,sourceUrl,advertiserName:'Isolated synthetic advertiser',headline:'Synthetic video import test',body:null,bodyTruncated:false,media,observedAt:'2026-10-08T00:00:00Z',reportedCountries:['DE'],sourceFields:{'Advertiser name':'Isolated synthetic advertiser'},rawText:'Synthetic video import test',rawHtml}],evidence:[{url:sourceUrl,httpStatus:200,text:'Synthetic video import test',html:rawHtml}],diagnostics:[],coverage:{complete:false,observedCards:1,selected:1}};
}


// Legacy RPC compatibility is tested in an isolated transaction view. No
// assignment, control/cooldown, fixture ad, or lease mutation is committed.
function fixtureClient(tx:any){
 let sequence=0;let client:any;
 async function savepoint(work:()=>Promise<any>,alwaysRollback=false){const name='legacy_fixture_'+(++sequence);await tx.$executeRawUnsafe('SAVEPOINT '+name);try{const result=await work();if(alwaysRollback)await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT '+name);await tx.$executeRawUnsafe('RELEASE SAVEPOINT '+name);return result;}catch(error){await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT '+name);await tx.$executeRawUnsafe('RELEASE SAVEPOINT '+name);throw error;}}
 client=new Proxy(tx,{get(target,key){if(key==='$transaction')return (work:(nested:any)=>Promise<any>)=>savepoint(()=>work(client),false);if(key==='$queryRawUnsafe'||key==='$executeRawUnsafe')return (...args:any[])=>savepoint(()=>target[key](...args));return target[key];}});return client;
}
async function beginLegacyFixture(){
 const rolledBack=new Error('LEGACY_FIXTURE_ROLLBACK');let ready!:()=>void;const started=new Promise<void>(resolve=>ready=resolve),finished=new Promise<void>(resolve=>releaseFixture=resolve);
 fixtureTransaction=ownerDb.$transaction(async(tx:any)=>{const sourceKeys=['pinterest_ads_repository'];await tx.collectorSourceAssignment.deleteMany({where:{sourceKey:{in:sourceKeys}}});await tx.collectorSourceControl.updateMany({where:{sourceKey:{in:sourceKeys}},data:{controlMode:'LEGACY_QUEUE'}});db=fixtureClient(tx);ready();await finished;throw rolledBack;},{timeout:60000}).catch((error:unknown)=>{if(error!==rolledBack)throw error;});await Promise.race([started,fixtureTransaction]);
}
async function endLegacyFixture(){releaseFixture?.();try{await fixtureTransaction;}finally{db=ownerDb;fixtureTransaction=undefined;releaseFixture=undefined;}}
describe.skipIf(!databaseUrl)('Pinterest video import with real PostgreSQL',()=>{
 it('imports a HEX64 identity through restricted SQL and replays the exact raw once',async()=>{
  const batch=fixture(),hex='Ab'.repeat(30)+randomBytes(2).toString('hex'),url=`https://ads.pinterest.com/ads-repository/${hex}/`;
  batch.ads[0].sourceAdId=hex;batch.ads[0].sourceUrl=url;batch.evidence[0].url=url;
  const raw=JSON.stringify(batch),[first]=await db.$queryRawUnsafe('SELECT pinterest_collector.ingest($1::text) AS result',raw);
  expect(first.result.status).toBe('IMPORTED');expect(first.result.inserted).toBe(1);
  const ad=await db.ad.findFirstOrThrow({where:{sourceAdId:hex}});expect(ad.sourceAdId).toBe(hex);expect(ad.sourceUrl).toBe(url);
  const [again]=await db.$queryRawUnsafe('SELECT pinterest_collector.ingest($1::text) AS result',raw);
  expect(again.result.status).toBe('ALREADY_IMPORTED');expect(again.result.runId).toBe(first.result.runId);
  expect(await db.adObservation.count({where:{adId:ad.id}})).toBe(1);
 });
 it('rejects malformed HEX identities and noncanonical detail URLs in SQL',async()=>{
  for(const [id,suffix] of [['a'.repeat(63),''],['a'.repeat(65),''],['g'.repeat(64),''],['Ab'.repeat(32),'?next=evil'],['Ab'.repeat(32),'#fragment']]){
   const batch=fixture(),url=`https://ads.pinterest.com/ads-repository/${id}/`+suffix;batch.ads[0].sourceAdId=id;batch.ads[0].sourceUrl=url;batch.evidence[0].url=url;
   await expect(db.$queryRawUnsafe('SELECT pinterest_collector.ingest($1::text) AS result',JSON.stringify(batch))).rejects.toThrow('AD_INVALID');
   expect(await db.ad.count({where:{sourceAdId:id}})).toBe(0);
  }
 });
 beforeAll(async()=>{
  const url=new URL(databaseUrl!);
  if(!['127.0.0.1','localhost'].includes(url.hostname)||!url.pathname.includes('_test_'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const {PrismaClient}=require('@prisma/client');ownerDb=db=new PrismaClient({datasources:{db:{url:databaseUrl}}});
  await db.dataSource.upsert({where:{key:'pinterest_ads_repository'},create:{key:'pinterest_ads_repository',name:'Isolated Pinterest media test',status:'PAUSED',adapterVersion:'pinterest-public-dom-1'},update:{}});
  // The deployed function is tested unchanged; deployment role grants are
  // omitted only because this isolated database has no server runtime roles.
  const sql=readFileSync('apps/collector/deploy/pinterest/ingest.sql','utf8').replace(/^GRANT[^\n]*\n/gm,'');
  execFileSync('psql',[databaseUrl!.split('?')[0],'-X','-v','ON_ERROR_STOP=1'],{input:sql,stdio:['pipe','pipe','pipe']});
 });
 beforeEach(beginLegacyFixture);afterEach(endLegacyFixture);
 afterAll(async()=>{await ownerDb?.$disconnect();});

 it('stores VIDEO media and classifies a mixed creative as VIDEO through the operator import',async()=>{
  const batch=fixture(),report=await importPinterestBatch(db,JSON.stringify(batch),true);
  expect(report.status).toBe('IMPORTED');
  const ad=await db.ad.findFirstOrThrow({where:{sourceAdId:batch.ads[0].sourceAdId},include:{media:true}});
  expect(ad.mediaType).toBe('VIDEO');expect(ad.media.map((m:any)=>m.type).sort()).toEqual(['IMAGE','VIDEO']);
 });

 it('stores the same video evidence through the restricted SQL import without changing source identity',async()=>{
  const batch=fixture();
  const [result]=await db.$queryRawUnsafe('SELECT pinterest_collector.ingest($1::text) AS result',JSON.stringify(batch));
  expect(result.result.status).toBe('IMPORTED');
  const ad=await db.ad.findFirstOrThrow({where:{sourceAdId:batch.ads[0].sourceAdId},include:{media:true}});
  expect(ad.sourceUrl).toBe(batch.ads[0].sourceUrl);expect(ad.mediaType).toBe('VIDEO');
  expect(ad.media.map((m:any)=>({type:m.type,url:m.sourceUrl})).sort((a:any,b:any)=>a.type.localeCompare(b.type))).toEqual([{type:'IMAGE',url:image},{type:'VIDEO',url:video}]);
  const observation=await db.adObservation.findFirstOrThrow({where:{adId:ad.id}});expect(observation.snapshot.rawHtml).toContain(video);
  const [replay]=await db.$queryRawUnsafe('SELECT pinterest_collector.ingest($1::text) AS result',JSON.stringify(batch));expect(replay.result.status).toBe('ALREADY_IMPORTED');
  expect(await db.mediaObject.count({where:{adId:ad.id}})).toBe(2);
 });

 it('keeps legacy image-only batches compatible with the same source version',async()=>{
  const batch=fixture([{type:'IMAGE',url:image}]);
  const [result]=await db.$queryRawUnsafe('SELECT pinterest_collector.ingest($1::text) AS result',JSON.stringify(batch));expect(result.result.status).toBe('IMPORTED');
  const ad=await db.ad.findFirstOrThrow({where:{sourceAdId:batch.ads[0].sourceAdId}});expect(ad.mediaType).toBe('IMAGE');
 });

 it('matches an escaped signed video source inside its detail HTML',async()=>{
  const url=video+'?token=synthetic&source=public',batch=fixture([{type:'VIDEO',url}]);
  batch.ads[0].rawHtml=`<video controls><source src='${url.replaceAll('&','&amp;')}' type='video/mp4'></video>`;batch.evidence[0].html=batch.ads[0].rawHtml;
  const [result]=await db.$queryRawUnsafe('SELECT pinterest_collector.ingest($1::text) AS result',JSON.stringify(batch));expect(result.result.status).toBe('IMPORTED');
  const ad=await db.ad.findFirstOrThrow({where:{sourceAdId:batch.ads[0].sourceAdId},include:{media:true}});expect(ad.mediaType).toBe('VIDEO');expect(ad.media[0].sourceUrl).toBe(url);
 });

 it('rolls back unproven or hostile videos rather than retaining an ad without valid media',async()=>{
  for(const url of [video,'https://v.pinimg.com/profile/avatar.mp4','https://v.pinimg.com.evil.test/videos/mc/720p/19/a9/95/19a995a4ff00397bf8f88cbb0b86ffd0.mp4']){
   const batch=fixture([{type:'VIDEO',url}]);
   if(url===video){batch.ads[0].rawHtml='<div>'+video+'</div><img alt="Ad image" src="'+video+'"><video data-src="'+video+'"></video>';batch.evidence[0].html=batch.ads[0].rawHtml;}
   await expect(db.$queryRawUnsafe('SELECT pinterest_collector.ingest($1::text) AS result',JSON.stringify(batch))).rejects.toThrow('MEDIA_INVALID');
   expect(await db.ad.count({where:{sourceAdId:batch.ads[0].sourceAdId}})).toBe(0);
  }
 });
});
