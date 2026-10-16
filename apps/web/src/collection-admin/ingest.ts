import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { ParsedAd, CollectionOutcome } from '@ad-research/contracts';
import { DomainError } from '../team/access';
import { guardLease, type CollectionTransaction, type EvidenceReference, type IngestCounts, type LeaseToken } from './queue';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
function sourcePage(value:string|null):string|null {
  if(!value)return null;
  try {const url=new URL(value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return null;url.hash='';return url.toString();}catch{return null;}
}
function sourceDate(value:string|null):Date|null {if(!value)return null;const result=new Date(`${value}T00:00:00.000Z`);return Number.isNaN(result.getTime())?null:result;}
/** Caller must finish the same lease in this transaction; a failed final fence rolls all writes back. */
export async function ingestCollection(tx:CollectionTransaction,token:LeaseToken,outcome:CollectionOutcome,evidence:EvidenceReference):Promise<IngestCounts> {
  if(!evidence.evidenceReference||evidence.evidenceReference.length>2048||!/^([a-f0-9]{64})$/i.test(evidence.evidenceSha256))throw new DomainError(400,'SOURCE_EVIDENCE_REQUIRED');
  const run=await guardLease(tx,token);const observedAt=new Date(outcome.collectedAt);
  if(Number.isNaN(observedAt.getTime()))throw new DomainError(400,'INVALID_OBSERVATION_TIME');
  // Lock the whole batch in a stable order, including shared advertisers. Opposite
  // source result orders must not deadlock halfway through two transactions.
  const keys=new Set<string>();
  for(const parsed of outcome.ads) {
    if(parsed.source!=='meta'||!/^\d{5,}$/.test(parsed.sourceAdId))continue;
    keys.add(`${run.dataSourceId}:${parsed.sourceAdId}`);
    const page=sourcePage(parsed.advertiserPageUrl);
    if(page)keys.add(`advertiser:${run.dataSourceId}:${digest(page)}`);
  }
  for(const key of [...keys].sort())await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',key);
  const counts:IngestCounts={insertedCount:0,updatedCount:0,quarantinedCount:0};
  for(const [index,parsed] of outcome.ads.entries()) {
    const itemKey=parsed.sourceAdId?`meta:${parsed.sourceAdId}`:`unidentified:${index}`;
    const item=await tx.runItem.findUnique({where:{runId_itemKey:{runId:run.id,itemKey}}});
    if(item?.status==='INGESTED')continue;
    if(parsed.source!=='meta'||!/^\d{5,}$/.test(parsed.sourceAdId)) {
      await tx.runItem.upsert({where:{runId_itemKey:{runId:run.id,itemKey}},create:{runId:run.id,dataSourceId:run.dataSourceId,itemKey,status:'QUARANTINED',errorCode:'MISSING_STABLE_SOURCE_ID',parserVersion:outcome.parserVersion,...evidence},update:{}});counts.quarantinedCount++;continue;
    }
    const existing=await tx.ad.findUnique({where:{dataSourceId_sourceAdId:{dataSourceId:run.dataSourceId,sourceAdId:parsed.sourceAdId}}});
    const isLatest=!existing?.lastObservedAt||existing.lastObservedAt<=observedAt;
    const firstObservedAt=!existing?.firstObservedAt||observedAt<existing.firstObservedAt?observedAt:existing.firstObservedAt;
    const attribution={source:'meta-public-dom',parserVersion:outcome.parserVersion,observedAt:observedAt.toISOString(),evidenceReference:evidence.evidenceReference,evidenceSha256:evidence.evidenceSha256};
    const avatar=sourcePage(parsed.advertiserAvatarUrl??null);
    if(parsed.advertiserAvatarUrl!=null&&(!avatar||!avatar.startsWith('https:')))throw new DomainError(400,'ADVERTISER_LOGO_INVALID');
    const provenance=Object.fromEntries(Object.entries(parsed).map(([key,value])=>[key,{value,...attribution}]));
    // Country is observation context. It must never become reportedCountries.
    provenance.queryCountry={value:parsed.queryCountry,...attribution,meaning:'query-filter'} as typeof provenance[string];
    let advertiserId:string|null=null;const page=sourcePage(parsed.advertiserPageUrl);
    if(page) {
      const sourceAdvertiserId=`page-url-sha256:${digest(page)}`;
      const prior=await tx.advertiser.findUnique({where:{dataSourceId_sourceAdvertiserId:{dataSourceId:run.dataSourceId,sourceAdvertiserId}}});
      const priorProvenance=(prior?.fieldProvenance??{}) as Record<string,any>;
      const fieldProvenance=json({...priorProvenance,identifier:{kind:'observed-page-url-hash',value:page,...attribution},name:{value:parsed.advertiserName,...attribution},...(avatar?{avatarUrl:{value:avatar,...attribution}}:{})});
      const priorTime=Date.parse((prior?.fieldProvenance as {name?:{observedAt?:string}}|null)?.name?.observedAt??'');
      if(!prior)advertiserId=(await tx.advertiser.create({data:{dataSourceId:run.dataSourceId,sourceAdvertiserId,name:parsed.advertiserName,sourceUrl:page,pageDomain:new URL(page).hostname,fieldProvenance}})).id;
      else {
        advertiserId=prior.id;
        if(!Number.isFinite(priorTime)||priorTime<=observedAt.valueOf())await tx.advertiser.update({where:{id:prior.id},data:{name:parsed.advertiserName,fieldProvenance}});
      }
    }
    const aggregateProvenance={...provenance};
    if(!avatar){
      delete aggregateProvenance.advertiserAvatarUrl;
      const priorAvatar=(existing?.fieldProvenance as Record<string,any>|undefined)?.advertiserAvatarUrl;
      if(priorAvatar)aggregateProvenance.advertiserAvatarUrl=priorAvatar;
    }
    const mediaTypes=[...new Set(parsed.media.map(media=>media.type.toUpperCase()))];
    const data={advertiserId,sourceUrl:parsed.sourceUrl,body:parsed.body,headline:parsed.headline,cta:parsed.cta,landingPageUrl:parsed.landingPageUrl,publisherPlatforms:parsed.platforms??[],mediaType:mediaTypes.length>1?'MIXED':mediaTypes[0]??'UNKNOWN',sourceStatus:parsed.status.toUpperCase(),statusObservedAt:observedAt,sourceStartedAt:sourceDate(parsed.startDate),sourceEndedAt:sourceDate(parsed.endDate),lastObservedAt:observedAt,fieldProvenance:json(aggregateProvenance)};
    // The transaction holds the run fence; this unique source key also serializes competing runs.
    const saved=await tx.ad.upsert({where:{dataSourceId_sourceAdId:{dataSourceId:run.dataSourceId,sourceAdId:parsed.sourceAdId}},create:{dataSourceId:run.dataSourceId,sourceAdId:parsed.sourceAdId,firstObservedAt,reportedCountries:[],...data},update:isLatest?{...data,firstObservedAt}:{firstObservedAt}});
    const observation=await tx.adObservation.upsert({where:{adId_collectionRunId:{adId:saved.id,collectionRunId:run.id}},create:{adId:saved.id,dataSourceId:run.dataSourceId,collectionRunId:run.id,observedAt,sourceStatus:data.sourceStatus,queryCountry:parsed.queryCountry,snapshot:json(parsed),fieldProvenance:json(provenance),parserVersion:outcome.parserVersion,...evidence},update:{}});
    for(const [order,media] of parsed.media.entries()) {
      const url=sourcePage(media.url);if(!url)continue;
      // Serialize with the media downloader, whose signature-derived type wins
      // over a DOM label. observationId tracks the source of current metadata.
      await tx.$queryRaw`SELECT id FROM "MediaObject" WHERE "adId"=${saved.id} AND "sourceUrl"=${url} FOR UPDATE`;
      const prior=await tx.mediaObject.findUnique({where:{adId_sourceUrl:{adId:saved.id,sourceUrl:url}},include:{observation:{select:{observedAt:true}}}});
      if(!prior)await tx.mediaObject.create({data:{adId:saved.id,observationId:observation.id,sourceUrl:url,type:media.type.toUpperCase(),displayOrder:order,status:'PENDING'}});
      else if(!prior.observation||prior.observation.observedAt<=observedAt) {
        const type=prior.downloadedAt&&prior.mimeType?.startsWith('image/')?'IMAGE':prior.downloadedAt&&prior.mimeType?.startsWith('video/')?'VIDEO':media.type.toUpperCase();
        await tx.mediaObject.update({where:{id:prior.id},data:{type,displayOrder:order,observationId:observation.id}});
      }
    }
    await tx.runItem.upsert({where:{runId_itemKey:{runId:run.id,itemKey}},create:{runId:run.id,dataSourceId:run.dataSourceId,itemKey,sourceAdId:parsed.sourceAdId,adId:saved.id,status:'INGESTED',parserVersion:outcome.parserVersion,...evidence},update:{adId:saved.id,status:'INGESTED',errorCode:null}});
    if(existing)counts.updatedCount++;else counts.insertedCount++;
  }
  await guardLease(tx,token);
  return counts;
}
