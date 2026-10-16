import type {PrismaClient} from '@prisma/client';
import {DomainError,requireWorkspaceRole} from '../team/access';
import {normalizeHistoryFact} from './normalize';
import {lookupArchivedMedia} from './media-archive';
import {publicSourceAdvertiserId} from '../server/source-advertiser-id';
export type AdEvidenceQuery={workspaceId:string;adId:string;observationId:string};
export type ArchivePreview={id:string;sha256:string;type:string;mimeType:string;sizeBytes:string;downloadedAt:string|null;recordedAt:string;association:'SOURCE_URL_MATCH';displayUrl:string|null;displayUrlExpiresAt:string|null};
export type AdEvidenceResult={observationId:string;observedAt:string;advertiserName:string|null;advertiserId:string|null;body:string|null;headline:string|null;cta:string|null;landingPageUrl:string|null;reportedCountries:string[];publisherPlatforms:string[];adLanguages:string[];sourceStartedAt:string|null;sourceEndedAt:string|null;media:ArchivePreview[]};
type Signer=(key:string)=>Promise<{url:string;expiresAt:Date}>;
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const value=(...vs:unknown[])=>vs.find(v=>typeof v==='string'&&v.trim()) as string|undefined;
/** A saved source URL can locate captured bytes; download time is separate from ad observation time. */
export async function getAdHistoryEvidence(db:PrismaClient,input:AdEvidenceQuery&{userId:string},sign?:Signer):Promise<AdEvidenceResult>{
  const saved=await db.$transaction(async tx=>{
    await requireWorkspaceRole(tx,input.userId,input.workspaceId);
    const observation=await tx.adObservation.findFirst({where:{id:input.observationId,adId:input.adId},include:{run:true,ad:{select:{dataSource:{select:{key:true}}}}}});
    if(!observation)throw new DomainError(404,'HISTORY_EVIDENCE_NOT_FOUND');
    const fact=normalizeHistoryFact({observation,run:{...observation.run,sourceKey:observation.ad.dataSource.key},media:[]});
    const snapshot=obj(observation.snapshot),provenance=obj(observation.fieldProvenance);
    const media=await lookupArchivedMedia(tx,{adId:input.adId,snapshot});
    return {fact,media,advertiserName:value(snapshot.advertiserName,obj(provenance.advertiserName).value)??null,advertiserId:publicSourceAdvertiserId(snapshot.sourceAdvertiserId,obj(provenance.sourceAdvertiserId))??publicSourceAdvertiserId(snapshot.advertiserId,obj(provenance.advertiserId))??publicSourceAdvertiserId(obj(provenance.sourceAdvertiserId).value,obj(provenance.sourceAdvertiserId))};
  },{isolationLevel:'RepeatableRead',timeout:15000});
  const f=saved.fact;
  return {observationId:f.observationId,observedAt:f.observedAt.toISOString(),advertiserName:saved.advertiserName,advertiserId:saved.advertiserId,body:f.body,headline:f.headline,cta:f.cta,landingPageUrl:f.landingPageUrl,reportedCountries:f.reportedCountries??[],publisherPlatforms:f.publisherPlatforms??[],adLanguages:f.adLanguages??[],sourceStartedAt:f.sourceStartedAt??null,sourceEndedAt:f.sourceEndedAt??null,
    media:await Promise.all(saved.media.map(async m=>{let signed:{url:string;expiresAt:Date}|undefined;try{signed=await sign?.(m.objectKey);}catch{/* Preserve metadata when storage is unavailable. */}
      return {id:m.id,sha256:m.sha256,type:m.type,mimeType:m.mimeType,sizeBytes:m.sizeBytes.toString(),downloadedAt:m.downloadedAt?.toISOString()??null,recordedAt:m.recordedAt.toISOString(),association:m.association,displayUrl:signed?.url??null,displayUrlExpiresAt:signed?.expiresAt.toISOString()??null};}))};
}
