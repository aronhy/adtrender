import { HttpError, prisma } from 'wasp/server';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { DomainError, requireWorkspaceRole } from '../team/access';
import { adView } from '../server/views';
import { publicAdvertiserAvatar } from '../server/advertiser-avatar';
import { aggregateCatalog, catalogAdvertiserDomains, catalogHistoryWhere, dateString, landingDomain, normalizedPlatforms, studioChannels, type CatalogAdvertiser, type CatalogRow, type StudioCatalog, type StudioCatalogArgs } from './catalog-data';

const inputSchema=z.object({snapshotId:z.string().uuid().optional(),workspaceId:z.string().uuid(),kind:z.enum(['overview','ads','advertisers','advertiser','channel','landing','activity','products']),advertiserId:z.string().min(1).max(200).optional(),advertiserIds:z.array(z.string().uuid()).max(500).optional(),sourceKey:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/).optional(),channel:z.enum(studioChannels.map(c=>c[0]) as [string,...string[]]).optional(),domain:z.string().max(253).optional(),query:z.string().trim().max(200).optional(),page:z.number().int().min(1).max(10000).default(1),limit:z.number().int().min(1).max(100).default(24),days:z.number().int().min(1).max(366).optional(),format:z.enum(['all','image','video','text','unknown']).optional(),status:z.enum(['all','active','inactive','unknown']).optional()});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const platformAliases=(channel:string)=>[channel,channel.toUpperCase(),channel[0].toUpperCase()+channel.slice(1),...(channel==='audience_network'?['Audience Network','AUDIENCE_NETWORK']:channel==='youtube'?['YouTube']:channel==='tiktok'?['TikTok']:channel==='google'?['SEARCH','DISPLAY','SHOPPING','MAPS','OTHER']:[])];
export async function getStudioCatalog(raw:StudioCatalogArgs,context:{user?:{id:string}|null}):Promise<StudioCatalog> {
  try {
    if(!context.user?.id)throw new DomainError(401,'AUTH_REQUIRED');
    const args=inputSchema.parse(raw),asOf=new Date().toISOString();
    return await prisma.$transaction(async (tx:Prisma.TransactionClient)=>{
      await requireWorkspaceRole(tx,context.user!.id,args.workspaceId);
      const sourceRows=await tx.dataSource.findMany({select:{key:true,name:true,_count:{select:{ads:{where:{quarantinedAt:null}}}},ads:{where:{quarantinedAt:null,lastObservedAt:{not:null}},select:{lastObservedAt:true},orderBy:{lastObservedAt:'desc'},take:1}},orderBy:{name:'asc'}});
      const sources=sourceRows.map(source=>({key:source.key,name:source.name,ads:source._count.ads,lastObservedAt:dateString(source.ads[0]?.lastObservedAt)}));
      let selectedAdvertiser:string|undefined;
      if(args.advertiserId){
        if(!args.sourceKey&&!uuid.test(args.advertiserId))throw new DomainError(400,'SOURCE_IDENTITY_REQUIRED');
        const advertiser=await tx.advertiser.findFirst({where:args.sourceKey?{sourceAdvertiserId:args.advertiserId,dataSource:{key:args.sourceKey}}:{id:args.advertiserId}});
        if(!advertiser)throw new DomainError(404,'ADVERTISER_NOT_FOUND');selectedAdvertiser=advertiser.id;
      }
      const where:Prisma.AdWhereInput={quarantinedAt:null,...(args.sourceKey?{dataSource:{key:args.sourceKey}}:{}),...(selectedAdvertiser?{advertiserId:selectedAdvertiser}:args.advertiserIds?{advertiserId:{in:args.advertiserIds}}:{}),...(args.channel?{publisherPlatforms:{hasSome:platformAliases(args.channel)}}:{}),...(args.format&&args.format!=='all'?{mediaType:args.format.toUpperCase()}:{}),...(args.status&&args.status!=='all'?{sourceStatus:args.status.toUpperCase()}:{}),...(args.days?{firstObservedAt:{gte:new Date(Date.parse(asOf)-args.days*86400000)}}:{}),...(args.query?{OR:[...(args.kind==='advertisers'?[]:[{headline:{contains:args.query,mode:'insensitive' as const}},{body:{contains:args.query,mode:'insensitive' as const}}]),{advertiser:{name:{contains:args.query,mode:'insensitive'}}},{advertiser:{pageDomain:{contains:args.query,mode:'insensitive'}}},{landingPageUrl:{contains:args.query,mode:'insensitive'}}]}:{})};
      let rows=await tx.ad.findMany({where,select:{id:true,advertiserId:true,publisherPlatforms:true,mediaType:true,sourceStatus:true,firstObservedAt:true,lastObservedAt:true,landingPageUrl:true,createdAt:true}}) as CatalogRow[];
      if(args.domain){const domain=landingDomain(args.domain.includes('://')?args.domain:'https://'+args.domain);if(!domain)throw new DomainError(400,'INVALID_LANDING_DOMAIN');rows=rows.filter(row=>landingDomain(row.landingPageUrl)===domain);}
      const aggregate=aggregateCatalog(rows,new Date(asOf)),advertiserIds=[...new Set(rows.flatMap(row=>row.advertiserId?[row.advertiserId]:[]))];
      const rawAdvertisers=advertiserIds.length?await tx.advertiser.findMany({where:{id:{in:advertiserIds}},include:{dataSource:{select:{key:true}}}}):[];
      const byBrand=new Map<string,CatalogRow[]>();for(const row of rows)if(row.advertiserId){const set=byBrand.get(row.advertiserId)||[];set.push(row);byBrand.set(row.advertiserId,set);}
      const advertisers:CatalogAdvertiser[]=rawAdvertisers.map(b=>{const ads=byBrand.get(b.id)||[],observed=ads.map(a=>a.lastObservedAt).filter(Boolean).map(a=>new Date(a!).getTime());return {id:b.id,name:b.name||b.pageDomain||'广告主名称未提供',sourceKey:b.dataSource.key,sourceAdvertiserId:b.sourceAdvertiserId,...catalogAdvertiserDomains(ads.map(a=>a.landingPageUrl),b.pageDomain,b.sourceUrl),logo:publicAdvertiserAvatar({advertiser:b,dataSource:b.dataSource}),ads:ads.length,active:ads.filter(a=>a.sourceStatus==='ACTIVE').length,channels:[...new Set(ads.flatMap(a=>normalizedPlatforms(a.publisherPlatforms)))],lastObservedAt:observed.length?new Date(Math.max(...observed)).toISOString():null};}).sort((a,b)=>b.ads-a.ads||a.id.localeCompare(b.id));
      const eventWhere=catalogHistoryWhere(where,args.domain?rows.map(row=>row.id):undefined);
      const eventTotal=args.kind==='activity'?await tx.adHistoryEvent.count({where:eventWhere}):0;
      const total=args.kind==='advertisers'?advertisers.length:args.kind==='activity'?eventTotal:rows.length,pageCount=Math.max(1,Math.ceil(total/args.limit)),page=Math.min(args.page,pageCount),offset=(page-1)*args.limit;
      const ordered=rows.sort((a,b)=>new Date(b.lastObservedAt||0).getTime()-new Date(a.lastObservedAt||0).getTime()||b.id.localeCompare(a.id));
      const selected=ordered.slice(offset,offset+(args.kind==='overview'?8:args.limit));
      const records=selected.length?await tx.ad.findMany({where:{quarantinedAt:null,id:{in:selected.map(row=>row.id)}},include:{advertiser:true,dataSource:{select:{key:true}},media:{orderBy:[{displayOrder:'asc'},{id:'asc'}]}}}):[];
      const byId=new Map(records.map(a=>[a.id,a]));
      const saved=selected.length?await tx.savedAd.findMany({where:{workspaceId:args.workspaceId,adId:{in:selected.map(row=>row.id)}},select:{id:true,adId:true}}):[];
      const ads=await Promise.all(selected.map(async row=>{const ad=await adView(byId.get(row.id)!),savedAd=saved.find(s=>s.adId===row.id);return {...ad,advertiserRecordId:row.advertiserId??undefined,saved:Boolean(savedAd),savedAdId:savedAd?.id};}));
      const events=await tx.adHistoryEvent.findMany({where:eventWhere,skip:args.kind==='activity'?offset:0,orderBy:[{observedAt:'desc'},{id:'desc'}],take:args.kind==='activity'?args.limit:6,include:{ad:{select:{advertiserId:true,advertiser:{select:{name:true}}}}}});
      const eventLabels:Record<string,[string,string]>={HEADLINE_CHANGED:['广告标题已更新','查看当前标题，继续研究广告表达。'],BODY_CHANGED:['广告文案已更新','查看广告主最新使用的文案。'],LANDING_PAGE_CHANGED:['广告落地页已更新','查看当前使用的落地页链接。'],STATUS_CHANGED:['投放状态已更新','查看最新来源状态与观测记录。'],MEDIA_CHANGED:['广告素材已更新','查看当前已收录的素材。'],CTA_CHANGED:['行动号召已更新','查看广告当前使用的行动号召。']};
      return {asOf,kind:args.kind,...aggregate,sources,advertisers:args.kind==='advertisers'?advertisers.slice(offset,offset+args.limit):advertisers.slice(0,24),advertiser:selectedAdvertiser?advertisers.find(b=>b.id===selectedAdvertiser)||null:null,ads,total,page,pageCount,activity:events.map(e=>({id:e.id,adId:e.adId,advertiserId:e.ad.advertiserId,advertiserName:e.ad.advertiser?.name||'广告主名称未提供',title:(eventLabels[e.type]||['广告记录已更新','查看当前广告和来源记录。'])[0],description:(eventLabels[e.type]||['广告记录已更新','查看当前广告和来源记录。'])[1],at:dateString(e.observedAt)!})),landingPages:aggregate.landingPages.slice(0,100),products:[]};
    },{isolationLevel:'RepeatableRead',timeout:20000});
  } catch(error) {
    if(error instanceof DomainError)throw new HttpError(error.status,error.code);
    if(error instanceof z.ZodError)throw new HttpError(400,'INVALID_STUDIO_QUERY');
    if(error instanceof HttpError)throw error;
    throw new HttpError(500,'STUDIO_QUERY_FAILED');
  }
}
