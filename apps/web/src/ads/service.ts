import {withObservedAdvertiserAvatars} from './advertiser-avatar';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { AdPlatform } from '../client/types';
import { DomainError, requireWorkspaceRole } from '../team/access';
export interface AdSearchInput {userId:string;workspaceId:string;keyword?:string;advertiser?:string;country?:string;mediaType?:'text'|'image'|'video'|'all';source?:'google';channel?:'SEARCH'|'YOUTUBE'|'UNKNOWN';domain?:string;business?:'ECOMMERCE'|'GAMES'|'COMICS'|'GENERAL'|'UNCLASSIFIED';category?:string;contentStatus?:'available'|'parsed'|'preview'|'missing';exact?:boolean;exclude?:string;status?:'active'|'inactive'|'unknown'|'all';observedFrom?:string;observedTo?:string;platform?:AdPlatform;startedFrom?:string;startedTo?:string;cursor?:string;limit?:number}
export interface AdSearchSummary {total:number;images:number;videos:number;unknownMedia:number;sourceStatus:{active:number;inactive:number;unknown:number};firstObservedAt:Date|null;lastObservedAt:Date|null;recentNew7Days:number;asOf:string;scope:'matching-ads';mediaCounting:'ads-containing-type'}
interface Cursor {v:1;at:string|null;id:string;asOf:string;filterHash:string}
const pattern=(value:string)=>`%${value.replace(/[\\%_]/g,'\\$&')}%`;
const jsonHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const platformValues:Record<AdPlatform,string[]>={
  facebook:['Facebook','FACEBOOK','facebook'],
  instagram:['Instagram','INSTAGRAM','instagram'],
  messenger:['Messenger','MESSENGER','messenger'],
  audience_network:['Audience Network','AUDIENCE NETWORK','audience network','Audience_Network','AUDIENCE_NETWORK','audience_network'],
  pinterest:['Pinterest','PINTEREST','pinterest'],
  google:['GOOGLE','Google','google','SEARCH','DISPLAY','SHOPPING','MAPS','OTHER'],
  youtube:['YOUTUBE','YouTube','youtube'],
  tiktok:['TIKTOK','TikTok','tiktok'],
  snapchat:['SNAPCHAT','Snapchat','snapchat'],
};
/** Normalize each independent date filter; date-only bounds include the whole UTC day. */
function searchDate(value:unknown,endOfDay=false):string|null {
  if(value===undefined||value==='')return null;
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))throw new DomainError(400,'INVALID_SEARCH_DATE');
  const day=value.slice(0,10);const calendar=new Date(`${day}T00:00:00.000Z`);
  if(!Number.isFinite(calendar.valueOf())||calendar.toISOString().slice(0,10)!==day||day.startsWith('0000'))throw new DomainError(400,'INVALID_SEARCH_DATE');
  const date=new Date(value.length===10?`${day}T${endOfDay?'23:59:59.999':'00:00:00.000'}Z`:value);
  if(!Number.isFinite(date.valueOf()))throw new DomainError(400,'INVALID_SEARCH_DATE');
  return date.toISOString();
}
function filters(input:AdSearchInput) {
  const limit=input.limit??24;if(!Number.isInteger(limit)||limit<1||limit>100)throw new DomainError(400,'INVALID_SEARCH_LIMIT');
  if((input.keyword?.length??0)>200||(input.advertiser?.length??0)>200)throw new DomainError(400,'INVALID_SEARCH_TEXT');
  if(input.country&&!/^(?:[A-Z]{2}|ALL)$/.test(input.country))throw new DomainError(400,'INVALID_SEARCH_COUNTRY');
  if(input.mediaType&&!['text','image','video','all'].includes(input.mediaType))throw new DomainError(400,'INVALID_SEARCH_MEDIA');
  if(input.status&&!['active','inactive','unknown','all'].includes(input.status))throw new DomainError(400,'INVALID_SEARCH_STATUS');
  if(input.platform!==undefined&&(typeof input.platform!=='string'||!Object.hasOwn(platformValues,input.platform)))throw new DomainError(400,'INVALID_SEARCH_PLATFORM');
  if(input.source!==undefined&&input.source!=='google')throw new DomainError(400,'INVALID_SEARCH_SOURCE');
  if(input.channel!==undefined&&!['SEARCH','YOUTUBE','UNKNOWN'].includes(input.channel))throw new DomainError(400,'INVALID_SEARCH_CHANNEL');
  if(input.business!==undefined&&!['ECOMMERCE','GAMES','COMICS','GENERAL','UNCLASSIFIED'].includes(input.business))throw new DomainError(400,'INVALID_SEARCH_BUSINESS');
  if(input.contentStatus!==undefined&&!['available','parsed','preview','missing'].includes(input.contentStatus))throw new DomainError(400,'INVALID_SEARCH_CONTENT');
  if(input.exact!==undefined&&typeof input.exact!=='boolean')throw new DomainError(400,'INVALID_SEARCH_TEXT');
  if([input.keyword,input.advertiser,input.exclude,input.category].some(value=>value!==undefined&&typeof value!=='string'))throw new DomainError(400,'INVALID_SEARCH_TEXT');
  if((input.exclude?.length??0)>200||(input.category?.length??0)>100)throw new DomainError(400,'INVALID_SEARCH_TEXT');
  let domain:string|null=null;
  if(input.domain){try{if(typeof input.domain!=='string')throw new Error();const u=new URL(input.domain.includes('://')?input.domain:'https://'+input.domain);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.port||u.pathname!=='/'||u.search||u.hash||!u.hostname.includes('.')||u.hostname.length>253||u.hostname.split('.').some(part=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part)))throw new Error();domain=u.hostname.toLowerCase().replace(/^www\./,'');}catch{throw new DomainError(400,'INVALID_SEARCH_DOMAIN');}}
  const startedFrom=searchDate(input.startedFrom);const startedTo=searchDate(input.startedTo,true);
  if(startedFrom&&startedTo&&Date.parse(startedFrom)>Date.parse(startedTo))throw new DomainError(400,'INVALID_SEARCH_DATE_RANGE');
  const observedFrom=searchDate(input.observedFrom);const observedTo=searchDate(input.observedTo,true);
  if(observedFrom&&observedTo&&Date.parse(observedFrom)>Date.parse(observedTo))throw new DomainError(400,'INVALID_SEARCH_DATE_RANGE');
  return {limit,source:input.source??null,channel:input.channel??null,domain,business:input.business??null,category:input.category?.trim()||null,contentStatus:input.contentStatus??null,exact:input.exact??false,exclude:input.exclude?.trim()||null,keyword:input.keyword?.trim()||null,advertiser:input.advertiser?.trim()||null,country:input.country??null,mediaType:input.mediaType??'all',status:input.status??'all',observedFrom,observedTo,platform:input.platform??null,startedFrom,startedTo};
}
function decodeCursor(value:string,filterHash:string):Cursor {
  try {if(value.length>2048)throw new Error();const cursor=JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as Cursor;if(cursor.v!==1||typeof cursor.id!=='string'||!cursor.id||cursor.id.length>100||cursor.filterHash!==filterHash||typeof cursor.asOf!=='string'||Number.isNaN(Date.parse(cursor.asOf))||(cursor.at!==null&&(typeof cursor.at!=='string'||Number.isNaN(Date.parse(cursor.at)))))throw new Error();return cursor;}catch{throw new DomainError(400,'INVALID_SEARCH_CURSOR');}
}
/** A country filter means a matching collection-query observation, never inferred targeting. */
export async function searchAds(db:PrismaClient,input:AdSearchInput) {
  return db.$transaction(async tx=>{
    await requireWorkspaceRole(tx,input.userId,input.workspaceId);
    const f=filters(input);const {limit,...fingerprint}=f;const filterHash=jsonHash(fingerprint);const cursor=input.cursor?decodeCursor(input.cursor,filterHash):null;
    const asOf=cursor?.asOf??new Date().toISOString();const values:unknown[]=[];const bind=(value:unknown)=>{values.push(value);return `$${values.length}`;};
    const asOfParameter=bind(asOf);
    const conditions=[`a."createdAt"<=${asOfParameter}::timestamp`,`(a."lastObservedAt" IS NULL OR a."lastObservedAt"<=${asOfParameter}::timestamp)`];
    const name=`COALESCE(v.name,a."fieldProvenance"->'advertiserName'->>'value','')`;
    const matches=(term:string)=>{const p=bind(pattern(term));return `(COALESCE(a.body,'') ILIKE ${p} OR COALESCE(a.headline,'') ILIKE ${p} OR (CASE WHEN jsonb_typeof(a."fieldProvenance"->'description'->'value')='string' THEN a."fieldProvenance"->'description'->>'value' ELSE '' END) ILIKE ${p} OR ${name} ILIKE ${p} OR a."sourceAdId" ILIKE ${p} OR COALESCE(a."landingPageUrl",'') ILIKE ${p})`;};
    if(f.keyword)for(const term of f.exact?[f.keyword]:f.keyword.split(/\s+/).filter(Boolean))conditions.push(matches(term));
    if(f.exclude)conditions.push(`NOT ${matches(f.exclude)}`);
    const hasCopy=`(NULLIF(BTRIM(a.body),'') IS NOT NULL OR NULLIF(BTRIM(a.headline),'') IS NOT NULL OR (jsonb_typeof(a."fieldProvenance"->'description'->'value')='string' AND NULLIF(BTRIM(a."fieldProvenance"->'description'->>'value'),'') IS NOT NULL))`;
    const ready=`EXISTS(SELECT 1 FROM "MediaObject" cm WHERE cm."adId"=a.id AND cm.status IN ('READY','CACHED'))`;
    const parsed=`(${hasCopy} AND (a."mediaType"='TEXT' OR ${ready}))`;
    const complete=`((${hasCopy} AND a."mediaType"='TEXT') OR ${ready})`;
    if(f.contentStatus==='available')conditions.push(complete);
    if(f.contentStatus==='parsed')conditions.push(parsed);
    if(f.contentStatus==='preview')conditions.push(`(${ready} AND NOT ${parsed})`);
    if(f.contentStatus==='missing')conditions.push(`NOT ${complete}`);
    if(f.source==='google')conditions.push(`ds.key=${bind('google_ads_transparency')}`);
    if(f.channel){const channels=f.channel==='YOUTUBE'?platformValues.youtube:['SEARCH','Search','search'];conditions.push(f.channel==='UNKNOWN'?`NOT (a."publisherPlatforms" && ${bind([...channels,...platformValues.youtube])}::text[])`:`a."publisherPlatforms" && ${bind(channels)}::text[]`);}
    if(f.domain){const host=`lower(split_part(split_part(regexp_replace(COALESCE(a."landingPageUrl",v."pageDomain",''),'^https?://',''), '/',1),':',1))`;conditions.push(`(${host}=${bind(f.domain)} OR ${host} LIKE ${bind('%.'+f.domain)})`);}
    if(f.business||f.category){
      const purpose=`FROM "SeedAttemptMatch" sm JOIN "SeedDefinition" sd ON sd.id=sm."seedId" CROSS JOIN LATERAL jsonb_array_elements(sd."purposeTags") tag WHERE sm."adId"=a.id`;
      if(f.business==='UNCLASSIFIED')conditions.push(`NOT EXISTS(SELECT 1 ${purpose} AND tag->>'family' IN ('ECOMMERCE','GAMES','COMICS','GENERAL'))`);
      else conditions.push(`EXISTS(SELECT 1 ${purpose}${f.business?` AND tag->>'family'=${bind(f.business)}`:''}${f.category?` AND tag->>'category'=${bind(f.category)}`:''})`);
    }
    if(f.advertiser)conditions.push(`${name} ILIKE ${bind(pattern(f.advertiser))}`);
    if(f.status!=='all')conditions.push(`a."sourceStatus"=${bind(f.status.toUpperCase())}`);
    if(f.mediaType==='text')conditions.push(`a."mediaType"='TEXT'`);
    else if(f.mediaType!=='all')conditions.push(`(a."mediaType"=${bind(f.mediaType.toUpperCase())} OR (a."mediaType" IN ('UNKNOWN','MIXED') AND EXISTS(SELECT 1 FROM "MediaObject" m WHERE m."adId"=a.id AND m.type=${bind(f.mediaType.toUpperCase())})))`);
    if(f.platform&&!(f.source==='google'&&f.platform==='google'))conditions.push(`a."publisherPlatforms" && ${bind(platformValues[f.platform])}::text[]`);
    if(f.startedFrom)conditions.push(`a."sourceStartedAt">=${bind(f.startedFrom)}::timestamp`);
    if(f.startedTo)conditions.push(`a."sourceStartedAt"<=${bind(f.startedTo)}::timestamp`);
    if(f.country||f.observedFrom||f.observedTo){const observed=[`o."adId"=a.id`];if(f.country)observed.push(`o."queryCountry"=${bind(f.country)}`);if(f.observedFrom)observed.push(`o."observedAt">=${bind(f.observedFrom)}::timestamp`);if(f.observedTo)observed.push(`o."observedAt"<=${bind(f.observedTo)}::timestamp`);conditions.push(`EXISTS(SELECT 1 FROM "AdObservation" o WHERE ${observed.join(' AND ')})`);}
    const base=`FROM "Ad" a LEFT JOIN "Advertiser" v ON v.id=a."advertiserId" LEFT JOIN "DataSource" ds ON ds.id=a."dataSourceId" WHERE ${conditions.join(' AND ')}`;
    const imageExists=`EXISTS(SELECT 1 FROM "MediaObject" m WHERE m."adId"=a.id AND m.type='IMAGE')`;
    const videoExists=`EXISTS(SELECT 1 FROM "MediaObject" m WHERE m."adId"=a.id AND m.type='VIDEO')`;
    const counts=await tx.$queryRawUnsafe<Array<{total:bigint;images:bigint;videos:bigint;unknownMedia:bigint;active:bigint;inactive:bigint;unknown:bigint;firstObservedAt:Date|null;lastObservedAt:Date|null;recentNew7Days:bigint}>>(`SELECT count(*) AS total,count(*) FILTER(WHERE ${imageExists}) AS images,count(*) FILTER(WHERE ${videoExists}) AS videos,count(*) FILTER(WHERE NOT ${imageExists} AND NOT ${videoExists}) AS "unknownMedia",count(*) FILTER(WHERE a."sourceStatus"='ACTIVE') AS active,count(*) FILTER(WHERE a."sourceStatus"='INACTIVE') AS inactive,count(*) FILTER(WHERE a."sourceStatus" IS NULL OR a."sourceStatus" NOT IN ('ACTIVE','INACTIVE')) AS unknown,min(a."firstObservedAt") AS "firstObservedAt",max(a."lastObservedAt") AS "lastObservedAt",count(*) FILTER(WHERE a."firstObservedAt">=${asOfParameter}::timestamp-interval '7 days' AND a."firstObservedAt"<=${asOfParameter}::timestamp) AS "recentNew7Days" ${base}`,...values);
    const aggregate=counts[0];
    const summary:AdSearchSummary={total:Number(aggregate.total),images:Number(aggregate.images),videos:Number(aggregate.videos),unknownMedia:Number(aggregate.unknownMedia),sourceStatus:{active:Number(aggregate.active),inactive:Number(aggregate.inactive),unknown:Number(aggregate.unknown)},firstObservedAt:aggregate.firstObservedAt,lastObservedAt:aggregate.lastObservedAt,recentNew7Days:Number(aggregate.recentNew7Days),asOf,scope:'matching-ads',mediaCounting:'ads-containing-type'};
    let boundary='';
    if(cursor){const id=bind(cursor.id);boundary=cursor.at===null?` AND a."lastObservedAt" IS NULL AND a.id<${id}`:` AND (a."lastObservedAt"<${bind(cursor.at)}::timestamp OR (a."lastObservedAt"=${bind(cursor.at)}::timestamp AND a.id<${id}) OR a."lastObservedAt" IS NULL)`;}
    const rows=await tx.$queryRawUnsafe<{id:string;lastObservedAt:Date|null}[]>(`SELECT a.id,a."lastObservedAt" ${base}${boundary} ORDER BY a."lastObservedAt" DESC NULLS LAST,a.id DESC LIMIT ${bind(limit+1)}`,...values);
    const more=rows.length>limit;const page=rows.slice(0,limit);
    const records=await withObservedAdvertiserAvatars(tx,page.length?await tx.ad.findMany({where:{id:{in:page.map(row=>row.id)}},include:{dataSource:{select:{key:true}},advertiser:true,media:{orderBy:[{displayOrder:'asc'},{id:'asc'}]}}}):[]);
    const facetValues:string[]=[];const facetBind=(value:string)=>{facetValues.push(value);return '$'+facetValues.length;};
    const facetConditions=[`NULLIF(tag->>'category','') IS NOT NULL`];if(f.source==='google')facetConditions.push(`fd.key=${facetBind('google_ads_transparency')}`);if(f.business&&f.business!=='UNCLASSIFIED')facetConditions.push(`tag->>'family'=${facetBind(f.business)}`);
    const categories=f.business==='UNCLASSIFIED'?[]:await tx.$queryRawUnsafe<Array<{category:string}>>(`SELECT DISTINCT tag->>'category' AS category FROM "SeedAttemptMatch" fm JOIN "Ad" fa ON fa.id=fm."adId" JOIN "DataSource" fd ON fd.id=fa."dataSourceId" JOIN "SeedDefinition" fs ON fs.id=fm."seedId" CROSS JOIN LATERAL jsonb_array_elements(fs."purposeTags") tag WHERE ${facetConditions.join(' AND ')} ORDER BY category LIMIT 80`,...facetValues);
    const byId=new Map(records.map(record=>[record.id,record]));const last=page.at(-1);
    const nextCursor=more&&last?Buffer.from(JSON.stringify({v:1,at:last.lastObservedAt?.toISOString()??null,id:last.id,asOf,filterHash} satisfies Cursor)).toString('base64url'):null;
    return {categoryOptions:categories.map(row=>row.category),ads:page.map(row=>byId.get(row.id)!),total:summary.total,summary,nextCursor,countryScope:'query' as const,asOf};
  },{isolationLevel:'RepeatableRead'});
}
export async function getAdDetail(db:PrismaClient,input:{userId:string;workspaceId:string;adId:string}) {
  return db.$transaction(async tx=>{
    await requireWorkspaceRole(tx,input.userId,input.workspaceId);
    const ad=await tx.ad.findUnique({where:{id:input.adId},include:{dataSource:{select:{key:true}},advertiser:true,media:{orderBy:[{displayOrder:'asc'},{id:'asc'}]},observations:{orderBy:[{observedAt:'desc'},{id:'desc'}],take:20,select:{id:true,observedAt:true,sourceStatus:true,queryCountry:true,snapshot:true,fieldProvenance:true,parserVersion:true,evidenceReference:true}}}});
    if(!ad)throw new DomainError(404,'AD_NOT_FOUND');return {ad,countryScope:'query' as const};
  });
}
