import {publicAdvertiserAvatar} from './advertiser-avatar';
import { adContentState } from '../ads/content';
import type { PrismaClient, MediaObject } from '@prisma/client';
import type { AppState, AdView, MediaView, BillingView, SourceHealth, AdminView } from '../client/types';
import { DomainError,requireActiveUser,requireWorkspaceRole } from '../team/access';
import { S3Storage } from '../media/storage';
import { verifiedSourceProfiles } from '@ad-research/contracts';
import { listOwnAccountSupportRequests } from '../support/account';
import { listOwnOrganizationSupportRequests } from '../support/organization';
import { operationalHealth } from './health';
import { organizationSupportSelect, accountSupportSelect, organizationSupportView, accountSupportView } from './admin-support';
import { availablePlanWhere } from '../billing/plan-management';
import { publicPricingEnabled } from './public-pricing';
import { activeEntitlement, type QuotaKey } from '../billing/quotas';
import { publicSourceAdvertiserId } from './source-advertiser-id';

export function configuredStorage() {
  if(!process.env.S3_BUCKET||!process.env.S3_REGION||!process.env.AWS_ACCESS_KEY_ID||!process.env.AWS_SECRET_ACCESS_KEY)return null;
  return new S3Storage({bucket:process.env.S3_BUCKET,region:process.env.S3_REGION,endpoint:process.env.S3_ENDPOINT||undefined,forcePathStyle:process.env.S3_FORCE_PATH_STYLE==='true'});
}
export async function sourceHealth(db:PrismaClient):Promise<SourceHealth> {
  const source=await db.dataSource.findUnique({where:{key:'meta_ad_library'}});
  if(!source)return {status:'UNCONFIGURED',message:'公共广告数据源尚未配置。',updatedAt:null};
  const latest=await db.collectionRun.findFirst({where:{dataSourceId:source.id,finishedAt:{not:null}},orderBy:{finishedAt:'desc'}});
  const delayed=source.status!=='ACTIVE'||source.lastErrorCode||!source.lastSuccessfulAt||Date.now()-source.lastSuccessfulAt.getTime()>86400000||['FAILED','PARTIAL'].includes(latest?.status??'');
  return {status:delayed?'DEGRADED':'HEALTHY',message:delayed?'数据更新延迟或尚未开始，当前结果仅代表已保存的观测。':'按已保存的来源观测展示。',updatedAt:source.lastSuccessfulAt};
}
export async function mediaView(media:MediaObject):Promise<MediaView> {
  let displayUrl:string|null=null;
  let displayUrlExpiresAt:Date|null=null;
  let status=media.status;
  let errorCode=media.errorCode;
  if(media.expiresAt&&media.expiresAt<=new Date())status='EXPIRED';
  else if(media.storageKey&&status==='READY') {
    const storage=configuredStorage();
    if(!storage){status='UNAVAILABLE';errorCode='STORAGE_NOT_CONFIGURED';}
    else try{const signed=await storage.signGet(media.storageKey,{objectExpiresAt:media.expiresAt,expiresInSeconds:300});displayUrl=signed.url;displayUrlExpiresAt=signed.expiresAt;}catch{status='FAILED';errorCode='STORAGE_SIGN_FAILED';}
  } else if(status==='PENDING'&&!configuredStorage()) {status='UNAVAILABLE';errorCode='STORAGE_NOT_CONFIGURED';}
  return {id:media.id,type:media.type,status,displayUrl,displayUrlExpiresAt,errorCode};
}
export function advertiserName(ad:any):string|null {
  for(const value of [ad?.advertiser?.name,ad?.fieldProvenance?.advertiserName?.value]) {
    if(typeof value==='string'&&value.trim())return value.trim();
  }
  return null;
}
export async function adView(ad:any):Promise<AdView> {
  const provenance=ad.fieldProvenance??{};
  return {id:ad.id,sourceAdId:ad.sourceAdId,advertiserName:advertiserName(ad),advertiserAvatarUrl:publicAdvertiserAvatar(ad),advertiserId:publicSourceAdvertiserId(ad.advertiser?.sourceAdvertiserId,ad.advertiser?.fieldProvenance),contentState:adContentState({...ad,description:typeof provenance.description?.value==='string'?provenance.description.value:null}),dataSourceKey:ad.dataSource?.key??null,reportedCountries:ad.reportedCountries??[],statusObservedAt:ad.statusObservedAt??null,copy:ad.body,headline:ad.headline,description:typeof provenance.description?.value==='string'?provenance.description.value:null,cta:ad.cta,sourceUrl:ad.sourceUrl,landingPageUrl:ad.landingPageUrl,publisherPlatforms:ad.publisherPlatforms,status:ad.sourceStatus?.toLowerCase(),mediaType:ad.mediaType,sourceStartedAt:ad.sourceStartedAt??null,sourceEndedAt:ad.sourceEndedAt??null,firstObservedAt:ad.firstObservedAt,lastObservedAt:ad.lastObservedAt,media:await Promise.all((ad.media??[]).map(mediaView))};
}
const quotaLabels:Record<string,string>={WORKSPACES:'工作区',MEMBERS:'成员席位',SAVED_ADS:'收藏',ANALYSES:'本周期分析'};
export async function billingView(db:PrismaClient,organizationId:string):Promise<BillingView> {
  const mode=process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')?'test':process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_')?'live':'unconfigured';
  const publicCatalogEnabled=publicPricingEnabled(process.env);
  const [subscription,entitlements,plans]=await Promise.all([
    db.subscription.findUnique({where:{organizationId},include:{planVersion:true}}),
    Promise.all((Object.keys(quotaLabels) as QuotaKey[]).map(async (key):Promise<BillingView['entitlements'][number]>=>{
      try {
        const row=await activeEntitlement(db,organizationId,key);
        return {key,label:quotaLabels[key],status:'ACTIVE',used:row.used+row.reserved,limit:row.limit,resetAt:row.validUntil};
      } catch(error) {
        if(!(error instanceof DomainError)||error.code!=='ENTITLEMENT_EXPIRED')throw error;
        return {key,label:quotaLabels[key],status:'UNAVAILABLE',used:null,limit:null,resetAt:null};
      }
    })),
    db.planVersion.findMany({where:availablePlanWhere({mode,publicPricingEnabled:publicCatalogEnabled}),orderBy:[{key:'asc'},{version:'desc'}]}),
  ]);
  return {organizationId,planName:subscription?.planVersion.name??null,status:subscription?.status??'NONE',periodEnd:subscription?.currentPeriodEnd??null,cancelAtPeriodEnd:subscription?.cancelAtPeriodEnd??false,hasProviderSubscription:Boolean(subscription?.providerSubscriptionId)&&!['CANCELED','INCOMPLETE_EXPIRED'].includes(subscription?.status??''),canChangePlan:Boolean(subscription?.providerSubscriptionId)&&subscription?.status==='ACTIVE'&&!subscription?.cancelAtPeriodEnd&&Boolean(subscription?.currentPeriodEnd&&subscription.currentPeriodEnd>new Date()),checkoutEnabled:process.env.BILLING_ENABLED==='true'&&mode!=='unconfigured'&&(mode==='test'||publicCatalogEnabled),providerMode:mode==='test'?'sandbox':mode,entitlements,plans:plans.map(plan=>({id:plan.id,name:plan.name,priceMinor:plan.priceMinor,currency:plan.currency,interval:plan.billingInterval,features:[`${plan.workspaceLimit} 个工作区`,`${plan.memberLimit} 个成员席位`,`${plan.savedAdLimit} 条收藏`,`${plan.monthlyAnalysisLimit} 次分析 / 月`]}))};
}
export async function adminView(db:PrismaClient):Promise<AdminView> {
  const [sources,tasks,runs,organizations,feedback,health,events,users,mediaFailures,accountRequests]=await Promise.all([
    db.dataSource.findMany(),db.collectionTask.findMany({take:100,orderBy:{createdAt:'desc'}}),db.collectionRun.findMany({take:100,orderBy:{queuedAt:'desc'}}),
    db.organization.findMany({take:100,include:{subscription:{include:{planVersion:true}},_count:{select:{members:true}},entitlements:{where:{key:'ANALYSES'},orderBy:{periodStart:'desc'},take:1}}}),
    db.feedback.findMany({take:100,orderBy:{createdAt:'desc'},select:organizationSupportSelect}),operationalHealth(db),db.productEvent.groupBy({by:['name','organizationId'],_count:{_all:true}}),db.user.findMany({take:100,orderBy:{createdAt:'desc'},select:{id:true,email:true,disabledAt:true,isAdmin:true}}),db.mediaObject.findMany({where:{status:'FAILED'},take:100,orderBy:{updatedAt:'desc'},select:{id:true,adId:true,errorCode:true}}),db.accountSupportRequest.findMany({take:100,orderBy:{createdAt:'desc'},select:accountSupportSelect}),
  ]);
  return {users,mediaFailures,sources:sources.map(s=>({id:s.id,name:s.name,status:s.status,verifiedProfiles:verifiedSourceProfiles(s).map(p=>`${p.query.keyword} · ${p.query.country} · ${p.query.mediaType} · 最多 ${p.query.limit} 条 · 有效至 ${p.expiresAt.slice(0,10)}`),lastSuccessAt:s.lastSuccessfulAt})),tasks:tasks.map(t=>{const q=t.query as any;return {id:t.id,name:t.name,dataSourceId:t.dataSourceId,status:t.status,query:q.keyword??'',country:q.country??'ALL',intervalMinutes:t.scheduleCron?Number(t.scheduleCron.match(/\d+/)?.[0])/60:null};}),runs:runs.map(r=>({id:r.id,taskId:r.taskId,status:r.status,startedAt:r.startedAt,finishedAt:r.finishedAt,fetchedCount:r.fetchedCount,createdCount:r.insertedCount,updatedCount:r.updatedCount,coverage:(r.coverage as any)?.outcome??'unknown',restrictedReason:r.restrictionReason,errorCode:r.errorCode})),customers:organizations.map(o=>({id:o.id,name:o.name,status:o.status,planName:o.subscription?.planVersion.name,memberCount:o._count.members,analysisUsed:o.entitlements[0]?.used??0})),feedback:[...feedback.map(organizationSupportView),...accountRequests.map(accountSupportView)].sort((a,b)=>b.createdAt.valueOf()-a.createdAt.valueOf()).slice(0,100),health:Object.entries({database:'数据库',worker:'后台任务',source:'广告来源',email:'邮件队列'}).map(([key,label])=>({key,label,status:health[key as 'database'|'worker'|'source'|'email']==='ok'?'HEALTHY':'DEGRADED',message:health[key as 'database'|'worker'|'source'|'email']})),productEvents:['ad_detail_open','source_link_click','media_play'].map(name=>({name,count:events.filter(e=>e.name===name).reduce((sum,e)=>sum+e._count._all,0),organizationCount:events.filter(e=>e.name===name).length}))};
}
export function analysisResultView(result:any) {
  const rows=(value:unknown):any[]=>Array.isArray(value)?value:[];
  const labels:Record<string,string>={audience:'受众推断',message:'文案解读',cta:'行动号召',tone:'文案语气',selling_point:'卖点',hook:'开头',format:'表现形式推断',test_idea:'测试建议（待验证）'};
  return {
    facts:rows(result.facts).map(item=>`${item.label??item.id}：${item.value??''}`).join('\n'),
    interpretation:rows(result.inferences).map(item=>`${labels[item.kind]??'内容推断'}：${item.text}\n依据：${rows(item.citations).map(c=>`[${c.evidenceId}]「${c.quote}」`).join('；')}`).join('\n\n'),
    evidence:rows(result.evidence).map(item=>`[${item.id}] ${item.label}：${item.text}`),
    limitations:rows(result.limitations).map(String).join('\n'),
  };
}
export async function loadAppState(db:PrismaClient,userId:string,workspaceId?:string,organizationId?:string):Promise<AppState> {
  const user=await requireActiveUser(db,userId);
  const memberships=await db.organizationMember.findMany({where:{userId,organization:{status:'ACTIVE'}},include:{organization:true}});
  const managedIds=memberships.filter(m=>['OWNER','ADMIN'].includes(m.role)).map(m=>m.organizationId);
  const workspaces=await db.workspace.findMany({where:{archivedAt:null,organization:{status:'ACTIVE'},OR:[{organizationId:{in:managedIds}},{members:{some:{userId,organizationId:{in:memberships.map(m=>m.organizationId)}}}}]},orderBy:{createdAt:'asc'}});
  if(organizationId&&!managedIds.includes(organizationId))throw new DomainError(403,'ORGANIZATION_FORBIDDEN');
  const selectedId=workspaceId??workspaces.find(workspace=>!organizationId||workspace.organizationId===organizationId)?.id;
  const access=selectedId?await requireWorkspaceRole(db,userId,selectedId):null;
  if(access&&organizationId&&access.organization.id!==organizationId)throw new DomainError(403,'ORGANIZATION_FORBIDDEN');
  const billingOrganizationId=access?.organization.id??organizationId??managedIds[0];
  const scope=selectedId?{workspaceId:selectedId,organizationId:access!.organization.id}:null;
  const health=await sourceHealth(db);
  const [folders,savedAds,notes,analyses,profile]=await Promise.all([
    scope?db.folder.findMany({where:scope,orderBy:{name:'asc'}}):[],
    scope?db.savedAd.findMany({where:scope,include:{ad:{include:{advertiser:true}}},orderBy:{createdAt:'desc'},take:200}):[],
    scope?db.note.findMany({where:scope,orderBy:{updatedAt:'desc'},take:200}):[],
    scope?db.analysisJob.findMany({where:scope,include:{ad:{include:{advertiser:true}},results:true},orderBy:{createdAt:'desc'},take:100}):[],
    db.user.findUniqueOrThrow({where:{id:user.id}}),
  ]);
  const canManage=access&&['OWNER','ADMIN'].includes(access.membership.role);
  const [members,invitations]=await Promise.all([
    canManage?db.organizationMember.findMany({where:{organizationId:access!.organization.id},include:{user:true,workspaces:{where:{workspaceId:selectedId}}}}):[],
    canManage?db.invitation.findMany({where:{organizationId:access!.organization.id,acceptedAt:null,revokedAt:null},select:{id:true,email:true,role:true,expiresAt:true}}):[],
  ]);
  return {user:{id:user.id,email:user.email??'',displayName:profile.displayName,isAdmin:user.isAdmin,emailVerified:true,emailNotifications:(profile.notificationPreference as any)?.email!==false},organizations:memberships.map(m=>({id:m.organizationId,name:m.organization.name,role:m.role as 'OWNER'|'ADMIN'|'MEMBER'})),workspaces:workspaces.map(w=>({id:w.id,name:w.name,organizationId:w.organizationId})),selectedWorkspace:access?{id:access.workspace.id,name:access.workspace.name,organizationId:access.organization.id}:null,role:access?(access.membership.role==='MEMBER'?access.workspaceMembership!.role:access.membership.role) as AppState['role']:'NONE',overview:{savedCount:scope?await db.savedAd.count({where:scope}):0,analysisCount:scope?await db.analysisJob.count({where:scope}):0,pendingAnalysisCount:scope?await db.analysisJob.count({where:{...scope,status:{in:['QUEUED','RUNNING']}}}):0,dataUpdatedAt:health.updatedAt??null,sourceHealth:health},research:{folders:folders.map(f=>({id:f.id,name:f.name})),savedAds:savedAds.map(s=>({id:s.id,adId:s.adId,advertiserName:advertiserName(s.ad),copy:s.ad.body,folderId:s.folderId,savedAt:s.createdAt})),notes:notes.map(n=>({id:n.id,savedAdId:n.savedAdId,body:n.body,updatedAt:n.updatedAt})),analyses:analyses.map(j=>({id:j.id,adId:j.adId??'',advertiserName:advertiserName(j.ad),status:j.status,attempt:j.attempt,createdAt:j.createdAt,errorCode:j.errorCode,result:j.results[0]?analysisResultView(j.results[0]):null}))},billing:billingOrganizationId?await billingView(db,billingOrganizationId):null,members:members.map(m=>({id:m.id,displayName:m.user.displayName,email:m.user.email??'',organizationRole:m.role,workspaceRole:m.workspaces[0]?.role??null})),invitations:invitations.map(i=>({...i,status:i.expiresAt<=new Date()?'EXPIRED':'INVITED'})),supportRequests:await listOwnAccountSupportRequests(db,{userId}),organizationSupportRequests:await listOwnOrganizationSupportRequests(db,{userId}),...(user.isAdmin?{admin:await adminView(db)}:{})};
}

function publicAvatar(ad:any):string|null {
 for(const value of [ad.advertiser?.fieldProvenance?.avatarUrl?.value,ad.fieldProvenance?.advertiserAvatarUrl?.value]){
  if(typeof value!=='string')continue;try{const u=new URL(value);if(u.protocol==='https:'&&!u.username&&!u.password)return u.href;}catch{}
 }return null;
}
