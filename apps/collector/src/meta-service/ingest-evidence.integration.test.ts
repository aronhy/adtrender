import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';

const url=process.env.SAAS_TEST_DATABASE_URL;
const require=createRequire(new URL('../../../web/package.json',import.meta.url));
const sql=readFileSync('apps/collector/deploy/meta/ingest.sql','utf8');
const definition=sql.match(/CREATE OR REPLACE FUNCTION meta_collector\.ingest\(raw text\)[\s\S]*?\n\$\$;/)?.[0];
const sha=(raw:string)=>createHash('sha256').update(raw).digest('hex');
let db:any,baseline:any,compiledSHA:string|undefined;
async function snapshot(){
 const [functionRow]=await db.$queryRawUnsafe("SELECT pg_get_functiondef('meta_collector.ingest(text)'::regprocedure) AS definition");
 return {functionSHA:sha(functionRow.definition),ads:await db.ad.count(),observations:await db.adObservation.count(),runs:await db.collectionRun.count(),items:await db.runItem.count(),tasks:await db.collectionTask.count(),audit:await db.auditEvent.count(),migrations:await db.$queryRawUnsafe('SELECT migration_name,checksum FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name')};
}
async function rollback(body:(tx:any)=>Promise<void>){
 const end=Error('ROLLBACK_META_EVIDENCE_FIXTURE');
 try{await db.$transaction(async(tx:any)=>{
  await tx.$executeRawUnsafe(definition!);
  // The complete native importer is exercised in its documented legacy mode.
  // All temporary control changes, imported rows and the function DDL roll back.
  await tx.collectorSourceControl.updateMany({where:{sourceKey:'meta_ad_library'},data:{controlMode:'LEGACY_QUEUE'}});
  await tx.collectorSourceAssignment.deleteMany({where:{sourceKey:'meta_ad_library'}});
  await tx.dataSource.upsert({where:{key:'meta_ad_library'},create:{key:'meta_ad_library',name:'Synthetic exact-span fixture',adapterVersion:'meta-service-dom-1',status:'PAUSED'},update:{}});
  const [row]=await tx.$queryRawUnsafe("SELECT pg_get_functiondef('meta_collector.ingest(text)'::regprocedure) AS definition");
  const digest=sha(row.definition);if(compiledSHA)expect(digest).toBe(compiledSHA);else compiledSHA=digest;
  await body(tx);throw end;
 },{timeout:20000});}catch(error){if(error!==end)throw error;}
}
function batch(count=1){
 const first=9300000000000000n+BigInt('0x'+randomBytes(5).toString('hex'));
 const ids=Array.from({length:count},(_,index)=>(first+BigInt(index)).toString());
 return {version:'meta-service-dom-1',sourceKey:'meta_ad_library',platform:'META',observedAt:'2026-10-10T00:00:00Z',query:{country:'DE',language:'en',keyword:'synthetic span '+randomUUID()},status:'SUCCEEDED',errorCode:null,
  ads:ids.map(id=>({source:'meta',sourceAdId:id,sourceUrl:'https://www.facebook.com/ads/library/?id='+id,queryCountry:'DE',status:'active',platforms:['Facebook'],body:'Synthetic original DOM evidence',headline:null,cta:null,landingPageUrl:null,startDate:null,endDate:null,media:[{type:'image',url:'https://synthetic.fbcdn.net/'+id+'.jpg'}]})),
  evidence:ids.map(id=>({url:'https://www.facebook.com/ads/library/?id='+id,text:'Library ID: '+id+'4 May 2024',html:'<div><span>Library ID: '+id+'</span><div><span>4 May 2024</span></div></div>'})),completedIds:ids,coverage:{completeSourceCoverage:false}};
}
const ingest=async(tx:any,raw:string)=>(await tx.$queryRawUnsafe('SELECT meta_collector.ingest($1::text) AS result',raw))[0].result;
async function rejected(tx:any,value:ReturnType<typeof batch>,code='AD_INVALID'){
 const raw=JSON.stringify(value),hash=sha(raw);
 await tx.$executeRawUnsafe('SAVEPOINT reject_meta_evidence');
 await expect(ingest(tx,raw)).rejects.toThrow(code);
 await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT reject_meta_evidence');
 expect(await tx.collectionRun.count({where:{idempotencyKey:'meta-service:'+hash}})).toBe(0);
 expect(await tx.ad.count({where:{sourceAdId:{in:value.ads.map(ad=>ad.sourceAdId)}}})).toBe(0);
}

describe.skipIf(!url)('Meta native ingest exact visible Library ID span on owned PostgreSQL',()=>{
 beforeAll(async()=>{
  const target=new URL(url!);if(!['localhost','127.0.0.1'].includes(target.hostname)||!target.pathname.includes('_test_'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  if(!definition)throw Error('META_INGEST_FUNCTION_DEFINITION_REQUIRED');
  const {PrismaClient}=require('@prisma/client');db=new PrismaClient({datasources:{db:{url}}});
  const [owner]=await db.$queryRawUnsafe('SELECT pg_has_role(current_user,datdba,\'MEMBER\') AS owned FROM pg_database WHERE datname=current_database()');
  expect(owner.owned).toBe(true);baseline=await snapshot();
 });
 afterAll(async()=>{if(db){try{expect(await snapshot()).toEqual(baseline);console.log(JSON.stringify({metaIngestSQLSHA256:sha(sql),compiledFunctionSHA256:compiledSHA,allFixtureRowsAndFunctionDDLRolledBack:true,migrationsUnchanged:true}));}finally{await db.$disconnect();}}});
 it('imports all twenty legacy merged-text fixture rows using exact flat spans and replays unchanged bytes once',async()=>rollback(async tx=>{
  const value=batch(20),raw=JSON.stringify(value,null,2)+'\n',original=Buffer.from(raw),hash=sha(raw);
  const first=await ingest(tx,raw);expect(first).toMatchObject({status:'IMPORTED',inserted:20,updated:0,originalInserted:20,originalUpdated:0});
  expect(await tx.runItem.count({where:{runId:first.runId}})).toBe(20);
  expect(await tx.adObservation.count({where:{collectionRunId:first.runId,evidenceSha256:hash}})).toBe(20);
  expect(await tx.collectionRun.findUniqueOrThrow({where:{id:first.runId}})).toMatchObject({idempotencyKey:'meta-service:'+hash,fetchedCount:20,insertedCount:20});
  const replay=await ingest(tx,raw);expect(replay).toMatchObject({status:'ALREADY_IMPORTED',runId:first.runId,inserted:0,updated:0,originalInserted:20,originalUpdated:0,committedAt:first.committedAt});
  expect(await tx.runItem.count({where:{runId:first.runId}})).toBe(20);expect(Buffer.from(raw)).toEqual(original);
 }));
 it('keeps exact text evidence and its numeric boundary compatible',async()=>rollback(async tx=>{
  const value=batch();value.evidence[0].text='Library ID: '+value.ads[0].sourceAdId+' end';value.evidence[0].html='';expect(await ingest(tx,JSON.stringify(value))).toMatchObject({inserted:1});
  const wrong=batch();wrong.evidence[0].html='';await rejected(tx,wrong);
 }));
 it('accepts surrounding whitespace and the original supported localized label',async()=>rollback(async tx=>{
  const value=batch();value.evidence[0].html='<span> \n资料库编号 ： '+value.ads[0].sourceAdId+' \t</span>';expect(await ingest(tx,JSON.stringify(value))).toMatchObject({inserted:1});
 }));
 it.each([
  ['longer ID',(id:string)=>'<span>Library ID: '+id+'6</span>'],
  ['missing label',(id:string)=>'<span>'+id+'</span>'],
  ['missing opening span',(id:string)=>'Library ID: '+id+'</span>'],
  ['missing closing span',(id:string)=>'<span>Library ID: '+id],
  ['label in attribute',(id:string)=>'<span data-label="Library ID: '+id+'"></span>'],
  ['nested digits',(id:string)=>'<span>Library ID: '+id+'<span>6</span></span>'],
  ['div instead of span',(id:string)=>'<div>Library ID: '+id+'</div>'],
  ['attributed opening span',(id:string)=>'<span class="label">Library ID: '+id+'</span>'],
  ['extra visible content',(id:string)=>'<span>Library ID: '+id+' suffix</span>'],
  ['attribute-only span markup',(id:string)=>'<div data-label="<span>Library ID: '+id+'</span>"></div>'],
 ] as const)('rejects %s instead of silently dropping the invalid row',async(_name,html)=>rollback(async tx=>{
  const value=batch(2);value.evidence[1].html=html(value.ads[1].sourceAdId);await rejected(tx,value);
 }));
 it.each(['https://www.facebook.com.attacker.invalid/ads/library/','https://attacker.invalid/ads/library/','http://www.facebook.com/ads/library/'])('rejects an exact HTML span from untrusted URL %s',async evidenceURL=>rollback(async tx=>{
  const value=batch();value.evidence[0].url=evidenceURL;await rejected(tx,value);
 }));
 it.each(['source','sourceAdId','sourceUrl','queryCountry','media'] as const)('retains the existing %s validation even with an exact span',async field=>rollback(async tx=>{
  const value=batch();const ad:any=value.ads[0];ad[field]=field==='sourceAdId'?'not-numeric':field==='media'?{}:'invalid';await rejected(tx,value);
 }));
 it('retains media item validation after the ad evidence passes',async()=>rollback(async tx=>{
  const value=batch();value.ads[0].media[0].type='invalid';await rejected(tx,value,'MEDIA_INVALID');
 }));
});
