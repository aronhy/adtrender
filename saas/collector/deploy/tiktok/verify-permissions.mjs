import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';

const {PrismaClient}=createRequire(process.env.TIKTOK_APP_PACKAGE ?? '/opt/ad-research/app/package.json')('@prisma/client');
const report={};
const rollback=Symbol('rollback');
const raw=readFileSync(process.env.TIKTOK_VALIDATION_BATCH ?? '/validation/batch.json','utf8');
const fixture=JSON.parse(raw);
if(!Array.isArray(fixture.ads)||fixture.ads.length<1)throw Error('DETAIL_FIXTURE_REQUIRED');
const db=new PrismaClient();
const invoke=async(tx,batch)=>(await tx.$queryRawUnsafe('SELECT tiktok_collector.ingest($1::text) AS result',typeof batch==='string'?batch:JSON.stringify(batch)))[0].result;
const clone=()=>structuredClone(fixture);

async function rolledBack(client,fn){
 let completed=false;
 try{await client.$transaction(async tx=>{await fn(tx);completed=true;throw rollback;},{timeout:30000});}
 catch(error){if(error!==rollback)throw error;}
 assert.ok(completed,'ROLLBACK_PROBE_NOT_COMPLETED');
}
async function denied(name,sql){
 try{
  await rolledBack(db,async tx=>{await tx.$executeRawUnsafe(sql);throw Error('UNEXPECTED_PERMISSION');});
  throw Error('DENY_NOT_EXECUTED');
 }catch(error){
  assert.equal(error.meta?.code,'42501',`DENY_FAILED_${name}`);
  report[name]='DENIED';
 }
}
async function rejected(name,change){
 const candidate=clone();change(candidate);
 let rejectedCode;
 try{await rolledBack(db,async tx=>{await invoke(tx,candidate);});}
 catch(error){rejectedCode=error.meta?.code;}
 assert.ok(['P0001','22007','22008','22P02'].includes(rejectedCode),`INVALID_BATCH_ACCEPTED_${name}`);
 report[name]='REJECTED';
}
function observationAt(batch,value){
 batch.observedAt=value;
 for(const ad of batch.ads)ad.observedAt=value;
 for(const evidence of batch.evidence)evidence.observedAt=value;
}
async function replayProof(tx){
 // Timestamp changes are deliberate rollback-only test cases; no manufactured
 // observation is persisted or presented as a real collection.
 const current=clone();observationAt(current,new Date().toISOString());
 const first=await invoke(tx,current);
 assert.equal(first.status,'IMPORTED');
 const repeated=await invoke(tx,current);
 assert.equal(repeated.status,'ALREADY_IMPORTED');assert.equal(repeated.runId,first.runId);
 const older=structuredClone(current);observationAt(older,new Date(Date.now()-86400000).toISOString());
 for(const ad of older.ads)ad.body='ROLLBACK_ONLY_OLDER_OBSERVATION';
 const stale=await invoke(tx,older);
 assert.equal(stale.inserted,0);assert.equal(stale.updated,0);assert.equal(stale.historical,older.ads.length);
 return {first,repeated,older,stale};
}

async function ownerProof(){
 if(!process.env.TIKTOK_OWNER_DATABASE_URL)return;
 // Run only in a separate owner validation process. Never add this URL to the
 // service env file or browser environment.
 const owner=new PrismaClient({datasources:{db:{url:process.env.TIKTOK_OWNER_DATABASE_URL}}});
 const ids=fixture.ads.map(ad=>ad.sourceAdId);
 const query='SELECT to_jsonb(a) AS row FROM public."Ad" a JOIN public."DataSource" s ON s.id=a."dataSourceId" WHERE s.key=\'tiktok_commercial_library\' AND a."sourceAdId"=ANY($1::text[]) ORDER BY a."sourceAdId"';
 const advertiserQuery='SELECT a."sourceAdId", to_jsonb(av) AS advertiser FROM public."Ad" a JOIN public."DataSource" s ON s.id=a."dataSourceId" LEFT JOIN public."Advertiser" av ON av.id=a."advertiserId" WHERE s.key=\'tiktok_commercial_library\' AND a."sourceAdId"=ANY($1::text[]) ORDER BY a."sourceAdId"';
 try{
  const before=await owner.$queryRawUnsafe(query,ids);
  await rolledBack(owner,async tx=>{
   await tx.$executeRawUnsafe('SET LOCAL ROLE tiktok_collector_runtime');
   const current=clone();observationAt(current,new Date().toISOString());
   const first=await invoke(tx,current);
   const repeated=await invoke(tx,current);assert.equal(repeated.status,'ALREADY_IMPORTED');
   await tx.$executeRawUnsafe('RESET ROLE');
   const latest=await tx.$queryRawUnsafe(query,ids);
   const advertisers=await tx.$queryRawUnsafe(advertiserQuery,ids);
   for(const {sourceAdId,advertiser} of advertisers){
    const input=current.ads.find(ad=>ad.sourceAdId===sourceAdId);
    if(input.sourceAdvertiserId!==null||input.advertiserName!==null){
     assert.equal(advertiser.sourceAdvertiserId,input.sourceAdvertiserId??`ad-local:${sourceAdId}`,'ADVERTISER_IDENTITY_NOT_SOURCE_SCOPED');
    }
   }
   const older=structuredClone(current);observationAt(older,new Date(Date.now()-86400000).toISOString());
   for(const ad of older.ads){ad.body='ROLLBACK_ONLY_OLDER_OBSERVATION';ad.advertiserName='ROLLBACK_ONLY_OLDER_NAME';}
   await tx.$executeRawUnsafe('SET LOCAL ROLE tiktok_collector_runtime');
   const stale=await invoke(tx,older);assert.equal(stale.historical,older.ads.length);
   await tx.$executeRawUnsafe('RESET ROLE');
   const after=await tx.$queryRawUnsafe(query,ids);
   assert.deepEqual(await tx.$queryRawUnsafe(advertiserQuery,ids),advertisers,'STALE_OBSERVATION_OVERWROTE_ADVERTISER');
   const omitFirst=(rows)=>rows.map(({row})=>{const {firstObservedAt,...facts}=row;return facts;});
   assert.deepEqual(omitFirst(after),omitFirst(latest),'STALE_OBSERVATION_OVERWROTE_LATEST');
   for(const {row} of after){assert.equal(row.sourceStatus,'UNKNOWN');assert.equal(row.sourceStartedAt,null);assert.equal(row.sourceEndedAt,null);}
   const [{count}]=await tx.$queryRawUnsafe('SELECT count(*)::int AS count FROM public."AdObservation" WHERE "collectionRunId"=ANY($1::text[])',[first.runId,stale.runId]);
   assert.equal(count,fixture.ads.length*2,'HISTORY_NOT_RETAINED');
   const [{invalid}]=await tx.$queryRawUnsafe('SELECT count(*)::int AS invalid FROM public."MediaObject" WHERE "observationId" IN (SELECT id FROM public."AdObservation" WHERE "collectionRunId"=ANY($1::text[])) AND (status<>\'UNAVAILABLE\' OR "errorCode" IS DISTINCT FROM \'PLATFORM_MEDIA_ADAPTER_PENDING\')',[first.runId,stale.runId]);
   assert.equal(invalid,0,'MEDIA_ROUTED_TO_DOWNLOADER');
  });
  assert.deepEqual(await owner.$queryRawUnsafe(query,ids),before,'OWNER_PROBE_DID_NOT_ROLL_BACK');
  report.ownerDatabaseProof='PASSED_AND_ROLLED_BACK';
 }finally{await owner.$disconnect();}
}

try{
 const [{role}]=await db.$queryRawUnsafe('SELECT current_user AS role');
 assert.equal(role,'tiktok_collector_runtime','DEDICATED_RUNTIME_ROLE_REQUIRED');
 for(const [name,sql] of Object.entries({
  userRead:'SELECT id FROM public."User" LIMIT 1',
  credentialRead:'SELECT "credentialReference" FROM public."DataSource" LIMIT 1',
  directAdRead:'SELECT id FROM public."Ad" LIMIT 1',
  directAdWrite:'UPDATE public."Ad" SET headline=headline WHERE false',
  ddl:'CREATE TABLE public.tiktok_must_not_create(id int)',
  temporaryDdl:'CREATE TEMP TABLE tiktok_must_not_create(id int)',
  roleEscalation:'SET ROLE saas_migrator',
  otherCollector:'SELECT meta_collector.ingest(\'{}\')',
 }))await denied(name,sql);
 await rolledBack(db,async tx=>{await replayProof(tx);});
 report.validReplayAndOldObservation='PASSED_AND_ROLLED_BACK';
 await rejected('wrongSource',b=>{b.sourceKey='meta_ad_library';});
 await rejected('wrongPlatform',b=>{b.platform='META';});
 await rejected('wrongVersion',b=>{b.version='future-parser';});
 await rejected('invalidCountry',b=>{b.query.country='united-kingdom';});
 await rejected('invalidDates',b=>{b.query.startDate='2026-99-99';});
 await rejected('forgedCoverage',b=>{b.coverage.completeSourceCoverage=true;});
 await rejected('numericSourceId',b=>{b.ads[0].sourceAdId=Number(b.ads[0].sourceAdId);});
 await rejected('wrongCanonicalUrl',b=>{b.ads[0].sourceUrl='https://example.com/ad';});
 await rejected('missingProof',b=>{b.evidence=[];});
 await rejected('httpForbidden',b=>{for(const e of b.evidence)e.httpStatus=403;});
 await rejected('stringHttpStatus',b=>{for(const e of b.evidence)e.httpStatus='200';});
 await rejected('wrongDetailId',b=>{for(const e of b.evidence)if(e.kind==='detail')e.adId='1000000000000000';});
 await rejected('missingVisibleId',b=>{for(const e of b.evidence)e.text='No ad identity';});
 await rejected('badCountryType',b=>{b.ads[0].reportedCountries=[12];});
 await rejected('badMediaType',b=>{b.ads[0].media=[{url:'https://example.com/test',type:'AUDIO'}];});
 await rejected('badSourceFields',b=>{b.ads[0].sourceFields={views:12};});
 await rejected('badNullableType',b=>{b.ads[0].advertiserName={name:'forged'};});
 await rejected('missingCompletedId',b=>{b.completedIds=[];});
 await rejected('duplicateAds',b=>{b.ads.push(structuredClone(b.ads[0]));});
 await rejected('batchLimit',b=>{while(b.ads.length<21)b.ads.push(structuredClone(b.ads[0]));});
 await rolledBack(db,async tx=>{
  for(const status of ['FAILED','NO_RESULTS']){
   const b=clone();b.ads=[];b.evidence=[];b.completedIds=[];b.status=status;
   b.errorCode=status==='FAILED'?'ROLLBACK_ONLY_TEST':null;
   assert.equal((await invoke(tx,b)).status,'IMPORTED');
  }
 });
 report.emptyRuns='PASSED_AND_ROLLED_BACK';
 await ownerProof();
 console.log(JSON.stringify(report));
}catch(error){
 // No raw Prisma errors: they may contain source URLs or validation input.
 console.error(JSON.stringify({status:'FAILED',sqlState:error.meta?.code??null,completedChecks:Object.keys(report)}));
 process.exitCode=1;
}finally{await db.$disconnect();}
