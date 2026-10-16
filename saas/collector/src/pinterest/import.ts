import {createHash} from 'node:crypto';
import type {PrismaClient,Prisma} from '../../../app/node_modules/@prisma/client';
import type {PinterestBatch} from './adapter';
import {pinterestVideoUrl,isPinterestAdId} from './parser';
function videoEvidence(html:string,url:string){return Array.from(html.matchAll(/<(?:video|source)\b[^>]*>/gi)).some(tag=>tag[0].match(/(?:^|\s)src\s*=\s*["']([^"']+)["']/i)?.[1].replaceAll('&amp;','&')===url);}
export function validatePinterestBatch(value:unknown):asserts value is PinterestBatch {
 const b=value as PinterestBatch;
 if(!b||b.sourceKey!=='pinterest_ads_repository'||b.platform!=='PINTEREST'||b.version!=='pinterest-public-dom-1'||!['SUCCEEDED','PARTIAL'].includes(b.status)||!Array.isArray(b.ads)||b.ads.length<1||b.ads.length>20||!Array.isArray(b.evidence)||!b.query||!/^[A-Z]{2}$/.test(b.query.country))throw Error('PINTEREST_BATCH_INVALID');
 const ids=new Set<string>();
 for(const a of b.ads) {
  if(!isPinterestAdId(a.sourceAdId)||ids.has(a.sourceAdId)||a.sourceUrl!==`https://ads.pinterest.com/ads-repository/${a.sourceAdId}/`||!Number.isFinite(Date.parse(a.observedAt))||(!a.sourceFields?.['Advertiser name']&&a.sourceFields?.['Ad status']!=='Disapproved')||!b.evidence.some(e=>e.url===a.sourceUrl&&e.httpStatus===200&&e.text===a.rawText&&e.html===a.rawHtml))throw Error('PINTEREST_AD_INVALID');
  if(!Array.isArray(a.media)||a.media.some(m=>m.type==='IMAGE'?!/^https:\/\/i\.pinimg\.com\/[^\s\\]+$/.test(m.url):m.type!=='VIDEO'||!pinterestVideoUrl(m.url)||!videoEvidence(a.rawHtml,m.url)))throw Error('PINTEREST_MEDIA_INVALID');
  if(!Array.isArray(a.reportedCountries)||a.reportedCountries.some(c=>!/^[A-Z]{2}$/.test(c)))throw Error('PINTEREST_COUNTRIES_INVALID');
  ids.add(a.sourceAdId);
 }
}
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
/** Explicit operator batch import; never activates the source or creates a schedule. */
export async function importPinterestBatch(db:PrismaClient,raw:string,apply=false) {
 const batch:unknown=JSON.parse(raw);validatePinterestBatch(batch);
 const hash=createHash('sha256').update(raw).digest('hex');const key='pinterest-operator:'+hash;
 const evidenceReference=`local-private:pinterest/${hash}/batch.json`;
 let report={status:'DRY_RUN_ROLLED_BACK',inserted:0,updated:0,runId:'',evidenceSha256:hash};
 try{await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','pinterest-operator-source');
  const priorRun=await tx.collectionRun.findUnique({where:{idempotencyKey:key}});
  if(priorRun){report={...report,status:'ALREADY_IMPORTED',runId:priorRun.id};return;}
  const source=await tx.dataSource.findUniqueOrThrow({where:{key:batch.sourceKey}});
  const task=await tx.collectionTask.create({data:{dataSourceId:source.id,name:'Pinterest native operator batch',query:json(batch.query),status:'PAUSED',maxItems:batch.ads.length,maxAttempts:1}});
  const run=await tx.collectionRun.create({data:{taskId:task.id,dataSourceId:source.id,idempotencyKey:key,querySnapshot:json(batch.query),adapterVersion:batch.version,status:batch.status==='PARTIAL'?'PARTIAL':'SUCCEEDED',startedAt:new Date(batch.observedAt),finishedAt:new Date(),attempt:1,fetchedCount:batch.ads.length,errorCode:batch.errorCode,evidenceReference,coverage:json({...batch.coverage,mode:'operator-native-browser',automatedCollectorVerified:false})}});
  report.runId=run.id;
  for(const a of batch.ads){
   const where={dataSourceId_sourceAdId:{dataSourceId:source.id,sourceAdId:a.sourceAdId}};
   const prior=await tx.ad.findUnique({where});const observedAt=new Date(a.observedAt);
   const provenance=json({source:'pinterest-public-dom',observedAt:a.observedAt,evidenceSha256:hash,bodyTruncated:a.bodyTruncated,advertiserName:a.advertiserName,advertiserIdUnavailable:true,sourceFields:a.sourceFields});
   const data={sourceUrl:a.sourceUrl,body:a.body,headline:a.headline,publisherPlatforms:['PINTEREST'],reportedCountries:a.reportedCountries,mediaType:a.media.some(m=>m.type==='VIDEO')?'VIDEO':a.media.length?'IMAGE':'UNKNOWN',lastObservedAt:observedAt,fieldProvenance:provenance};
   const latest=!prior?.lastObservedAt||prior.lastObservedAt<=observedAt;
   const ad=await tx.ad.upsert({where,create:{dataSourceId:source.id,sourceAdId:a.sourceAdId,firstObservedAt:observedAt,...data},update:{...(latest?data:{}),firstObservedAt:prior?.firstObservedAt&&prior.firstObservedAt<observedAt?prior.firstObservedAt:observedAt}});
   const obs=await tx.adObservation.create({data:{adId:ad.id,dataSourceId:source.id,collectionRunId:run.id,observedAt,queryCountry:batch.query.country,snapshot:json(a),fieldProvenance:provenance,parserVersion:batch.version,evidenceReference,evidenceSha256:hash}});
   for(const [order,m] of a.media.entries())await tx.mediaObject.upsert({where:{adId_sourceUrl:{adId:ad.id,sourceUrl:m.url}},create:{adId:ad.id,observationId:obs.id,sourceUrl:m.url,type:m.type,status:'UNAVAILABLE',errorCode:'PLATFORM_MEDIA_ADAPTER_PENDING',displayOrder:order},update:{}});
   await tx.runItem.create({data:{runId:run.id,dataSourceId:source.id,itemKey:a.sourceAdId,sourceAdId:a.sourceAdId,adId:ad.id,status:prior?'UPDATED':'INSERTED',parserVersion:batch.version,evidenceReference,evidenceSha256:hash}});
   prior?report.updated++:report.inserted++;
  }
  await tx.collectionRun.update({where:{id:run.id},data:{insertedCount:report.inserted,updatedCount:report.updated}});
  await tx.auditEvent.create({data:{action:'PINTEREST_OPERATOR_BATCH_IMPORTED',targetType:'CollectionRun',targetId:run.id,metadata:{evidenceSha256:hash,count:batch.ads.length}}});
  if(!apply)throw Error('PINTEREST_DRY_RUN');report.status='IMPORTED';
 },{timeout:30000});}catch(e){if(!(e instanceof Error)||e.message!=='PINTEREST_DRY_RUN')throw e;}
 return report;
}
