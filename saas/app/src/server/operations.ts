import {getAdHistoryEvidence,type AdEvidenceQuery,type AdEvidenceResult} from '../ad-history/evidence';
import { HttpError,prisma } from 'wasp/server';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { AppCommand,AppState,CommandResult,SearchFilters,SearchResult,AdDetailResult,RelatedAdsQuery,RelatedAdsResult,AdMediaDownloadQuery,AdMediaDownloadResult,ResearchPageQuery,ResearchPageResult,AdminPageQuery,AdminPageResult } from '../client/types';
import { DomainError,requireActiveUser,requireOrgRole,requirePlatformAdmin,requireWorkspaceRole } from '../team/access';
import { setUserDisabled } from '../team/admin';
import { createTeamService } from '../team/service';
import { initializeTrial,admitQuota,releaseQuota,lockOrganization,activeEntitlement } from '../billing/quotas';
import { trialConfigFromEnvironment } from '../billing/trial-config';
import { billingFromEnvironment } from '../billing/configured';
import { searchAds,getAdDetail } from '../ads/service';
import { getAdvertiserSummary,getRelatedAds,matchesAdvertiserSummary } from '../ads/advertiser';
import { signPublicAdMediaDownload } from '../media/public-download';
import {getAdHistory} from '../ad-history/service';
import type {AdHistoryQuery,AdHistoryResult} from '../ad-history/api-types';
import {sourceDateSpan} from '../ad-history/delivery-summary';
import { createCollectionQueue } from '../collection-admin/queue';
import { validateCollectionQuery } from '@ad-research/contracts';
import { loadAppState,adView,advertiserName,mediaView,configuredStorage,sourceHealth,analysisResultView } from './views';
import { listResearchPage } from '../research/pagination';
import { consumeRateLimit } from './rate-limit';
import { listAdminPage } from './admin-pagination';
import { queueEmail } from './email';
import { createFolder,saveAd,unsaveAd,writeNote,moveSavedAd,deleteNote } from '../research/service';
import { enqueueAnalysis,retryAnalysis,cancelAnalysis } from '../analysis/service';
import { submitAccountSupportRequest,resolveAccountSupportRequest } from '../support/account';
import { resolveOrganizationSupportRequest } from '../support/organization';
import { loadPublicPricing } from './public-pricing';
import { loadGrowthSummary, type GrowthSummary, type GrowthSummaryQuery } from '../growth/summary';

type Context={user?:{id:string}|null};
const text=(value:unknown,max=200)=>z.string().trim().min(1).max(max).parse(value);
const id=(value:unknown)=>z.string().uuid().parse(value);
async function safe<T>(operation:()=>Promise<T>):Promise<T> {
  try{return await operation();}catch(error){
    if(error instanceof DomainError)throw new HttpError(error.status,error.code);
    if(error instanceof z.ZodError)throw new HttpError(400,'INVALID_INPUT');
    if(error instanceof HttpError)throw error;
    // Never expose raw Prisma/provider errors, request bodies or secret links.
    throw new HttpError(500,'REQUEST_FAILED');
  }
}
function actor(context:Context){if(!context.user?.id)throw new DomainError(401,'AUTH_REQUIRED');return context.user.id;}
export const configuredBilling = () => billingFromEnvironment(prisma);

export async function getPublicPricing(_args:Record<string,never>) {
  return safe(()=>loadPublicPricing(prisma));
}

const team=()=>createTeamService(prisma,{
  initializeOrganization:(tx,organizationId)=>initializeTrial(tx,organizationId,trialConfigFromEnvironment()),admitQuota,releaseQuota,
  onInvitationCreated:async(tx,{invitation,organization,token})=>{
    const origin=new URL(process.env.WASP_WEB_CLIENT_URL??'http://localhost:3000').origin;
    const link=`${origin}/app/settings?invite=${token}`;
    await queueEmail(tx,{to:invitation.email,subject:`邀请加入 ${organization.name}`,text:`您受邀加入 ${organization.name}。请使用此邮箱注册、验证并登录后打开邀请：${link}。此链接一次有效，有效期至 ${invitation.expiresAt.toISOString()}。`},{key:process.env.OUTBOX_ENCRYPTION_KEY??'',dedupeKey:`invite:${invitation.id}`,templateKey:'INVITATION',organizationId:organization.id,expiresAt:invitation.expiresAt});
  },
});
export async function getAppState(args:{workspaceId?:string;organizationId?:string},context:Context):Promise<AppState> {
  return safe(async()=>{
    const state=await loadAppState(prisma,actor(context),args.workspaceId?id(args.workspaceId):undefined,args.organizationId?id(args.organizationId):undefined);
    const organizationId=state.billing?.organizationId;
    if(state.billing&&organizationId&&state.organizations.some(o=>o.id===organizationId&&o.role==='OWNER')&&process.env.BILLING_ENABLED==='true') {
      try { state.billing.invoices=(await configuredBilling().listInvoices({userId:actor(context),organizationId})).map(invoice=>({id:invoice.id??'',status:invoice.status??'unknown',currency:invoice.currency,totalMinor:invoice.amountPaid,issuedAt:invoice.createdAt,invoiceUrl:invoice.invoiceUrl,receiptUrl:invoice.pdfUrl})); }
      catch { state.billing.invoices=[]; state.billing.invoiceStatus='UNAVAILABLE'; }
    }
    return state;
  });
}
export async function searchPublicAds(args:SearchFilters,context:Context):Promise<SearchResult> {
  return safe(async()=>{
    const userId=actor(context);await requireActiveUser(prisma,userId);
    await consumeRateLimit(prisma,'SEARCH',userId,{limit:60,windowMs:60000});
    const result=await searchAds(prisma,{
      userId,workspaceId:id(args.workspaceId),keyword:args.query,advertiser:args.advertiser,country:args.country,
      source:args.source,channel:args.channel,domain:args.domain,business:args.business,category:args.category,contentStatus:args.contentStatus,exact:args.exact,exclude:args.exclude,platform:args.platform,startedFrom:args.startedFrom,startedTo:args.startedTo,cursor:args.cursor,limit:args.limit,
      observedFrom:args.observedFrom&&/^\d{4}-\d{2}-\d{2}$/.test(args.observedFrom)?args.observedFrom+'T00:00:00.000Z':args.observedFrom,
      observedTo:args.observedTo&&/^\d{4}-\d{2}-\d{2}$/.test(args.observedTo)?args.observedTo+'T23:59:59.999Z':args.observedTo,
      mediaType:args.mediaType?.toLowerCase() as any,status:args.status?.toLowerCase() as any,
    });
    const saved=await prisma.savedAd.findMany({where:{workspaceId:args.workspaceId,adId:{in:result.ads.map(a=>a.id)}},select:{id:true,adId:true}});
    return {categoryOptions:result.categoryOptions,ads:await Promise.all(result.ads.map(async ad=>({...await adView(ad),saved:saved.some(s=>s.adId===ad.id),savedAdId:saved.find(s=>s.adId===ad.id)?.id}))),nextCursor:result.nextCursor,summary:result.summary,sourceHealth:await sourceHealth(prisma)};
  });
}
export async function getPublicAd(args:{workspaceId:string;adId:string},context:Context):Promise<AdDetailResult> {
  return safe(async()=>{
    const input={userId:actor(context),workspaceId:id(args.workspaceId),adId:id(args.adId)};
    const [result,advertiserSummary]=await Promise.all([getAdDetail(prisma,input),getAdvertiserSummary(prisma,input)]);
    const scopedAdvertiserSummary=matchesAdvertiserSummary(result.ad,advertiserSummary)?advertiserSummary:null;
    const saved=await prisma.savedAd.findUnique({where:{workspaceId_adId:{workspaceId:args.workspaceId,adId:args.adId}},select:{id:true}});
    const counts=await prisma.$queryRaw<Array<{observedDays:bigint;activeObservedDays:bigint}>>`SELECT count(DISTINCT ("observedAt" + interval '8 hours')::date) AS "observedDays",count(DISTINCT ("observedAt" + interval '8 hours')::date) FILTER(WHERE "sourceStatus"='ACTIVE') AS "activeObservedDays" FROM "AdObservation" WHERE "adId"=${result.ad.id}`;
    return {ad:{...await adView(result.ad),deliverySummary:{...sourceDateSpan(result.ad),observedDays:Number(counts[0].observedDays),activeObservedDays:Number(counts[0].activeObservedDays)},saved:Boolean(saved),savedAdId:saved?.id},media:await Promise.all(result.ad.media.map(mediaView)),observations:result.ad.observations.map(o=>({id:o.id,observedAt:o.observedAt,sourceStatus:o.sourceStatus,queryCountry:o.queryCountry,parserVersion:o.parserVersion})),advertiserSummary:scopedAdvertiserSummary?{...scopedAdvertiserSummary,recentAds:await Promise.all(scopedAdvertiserSummary.recentAds.map(adView))}:null};
  });
}
export async function getPublicRelatedAds(args:RelatedAdsQuery,context:Context):Promise<RelatedAdsResult> {
  return safe(async()=>{
    const workspaceId=id(args.workspaceId);
    const result=await getRelatedAds(prisma,{userId:actor(context),workspaceId,adId:id(args.adId),cursor:args.cursor,limit:args.limit});
    const saved=await prisma.savedAd.findMany({where:{workspaceId,adId:{in:result.ads.map(ad=>ad.id)}},select:{id:true,adId:true}});
    return {...result,ads:await Promise.all(result.ads.map(async ad=>{const entry=saved.find(row=>row.adId===ad.id);return {...await adView(ad),saved:Boolean(entry),savedAdId:entry?.id};}))};
  });
}
export async function getPublicAdMediaDownload(args:AdMediaDownloadQuery,context:Context):Promise<AdMediaDownloadResult> {
  return safe(()=>signPublicAdMediaDownload(prisma,{userId:actor(context),workspaceId:id(args.workspaceId),adId:id(args.adId),mediaId:id(args.mediaId)},configuredStorage()));
}
export async function getPublicAdHistory(args:AdHistoryQuery,context:Context):Promise<AdHistoryResult>{
  return safe(()=>getAdHistory(prisma,{...args,userId:actor(context),workspaceId:id(args.workspaceId),adId:id(args.adId)}));
}
export async function getResearchPage(args:ResearchPageQuery,context:Context):Promise<ResearchPageResult> {
  return safe(async()=>{
    const page=await listResearchPage(prisma,{...args,userId:actor(context)});
    const base={kind:page.kind,total:page.total,asOf:page.asOf,nextCursor:page.nextCursor};
    if(page.kind==='saved')return {...base,analyses:[],savedAds:page.savedAds.map(saved=>({id:saved.id,adId:saved.adId,advertiserName:advertiserName(saved.ad),copy:saved.ad.body,folderId:saved.folderId,savedAt:saved.createdAt,notes:saved.notes.map(note=>({id:note.id,savedAdId:note.savedAdId,body:note.body,updatedAt:note.updatedAt}))}))};
    return {...base,savedAds:[],analyses:page.analyses.map(job=>({id:job.id,adId:job.adId??'',advertiserName:advertiserName(job.ad),status:job.status,attempt:job.attempt,createdAt:job.createdAt,errorCode:job.errorCode,result:job.results[0]?analysisResultView(job.results[0]):null}))};
  });
}
export async function getAdminPage(args:AdminPageQuery,context:Context):Promise<AdminPageResult> {
  return safe(()=>listAdminPage(prisma,{...args,userId:actor(context)}));
}
export async function getGrowthOverview(args:GrowthSummaryQuery,context:Context):Promise<GrowthSummary> {
  return safe(()=>loadGrowthSummary(prisma,{...args,userId:actor(context)}));
}
export async function appCommand(args:AppCommand,context:Context):Promise<CommandResult> {
  return safe(async()=>{
    const userId=actor(context);await requireActiveUser(prisma,userId);
    const type=text(args?.type,60);
    if(type==='PRODUCT_EVENT')await consumeRateLimit(prisma,'EVENT',userId,{limit:120,windowMs:60000});
    else await consumeRateLimit(prisma,'ACTION',userId,{limit:60,windowMs:60000});
    switch(args.type){
      case 'CREATE_ORGANIZATION':{
        await consumeRateLimit(prisma,'CREATE_ORGANIZATION',userId,{limit:3,windowMs:86400000});
        const created=await team().createOrganization({userId,name:text(args.name,80),...(args.workspaceName?{workspaceName:text(args.workspaceName,80)}:{})});
        return {workspaceId:created.workspace.id,message:'团队已创建。'};
      }
      case 'CREATE_WORKSPACE':{const workspace=await team().createWorkspace({userId,organizationId:id(args.organizationId),name:text(args.name,80)});return {workspaceId:workspace.id,message:'工作区已创建。'};}
      case 'ARCHIVE_WORKSPACE':{
        const organizationId=id(args.organizationId);
        await team().archiveWorkspace({userId,organizationId,workspaceId:id(args.workspaceId)});
        return {workspaceId:null,organizationId,message:'工作区已归档，资料保留。该空间已停止访问和写入。'};
      }
      case 'REMOVE_WORKSPACE_MEMBER':{
        const organizationId=id(args.organizationId),workspaceId=id(args.workspaceId);
        await requireOrgRole(prisma,userId,organizationId,['OWNER','ADMIN']);
        const member=await prisma.organizationMember.findFirst({where:{id:id(args.memberId),organizationId},select:{userId:true}});
        if(!member)throw new DomainError(404,'MEMBER_NOT_FOUND');
        await team().removeWorkspaceMember({userId,organizationId,workspaceId,memberUserId:member.userId});
        return {message:'已撤销此成员在该工作区的访问，其他工作区权限保持不变。'};
      }
      case 'CREATE_FOLDER':await createFolder(prisma,{userId,workspaceId:id(args.workspaceId),name:text(args.name,80)});break;
      case 'SAVE_AD':await saveAd(prisma,{userId,workspaceId:id(args.workspaceId),adId:id(args.adId),folderId:args.folderId?id(args.folderId):undefined});break;
      case 'REMOVE_SAVED_AD':await unsaveAd(prisma,{userId,workspaceId:id(args.workspaceId),savedAdId:id(args.savedAdId)});break;
      case 'SAVE_NOTE':await writeNote(prisma,{userId,workspaceId:id(args.workspaceId),savedAdId:id(args.savedAdId),...(args.noteId?{noteId:id(args.noteId)}:{}),body:text(args.body,10000)});break;
      case 'MOVE_SAVED_AD':await moveSavedAd(prisma,{userId,workspaceId:id(args.workspaceId),savedAdId:id(args.savedAdId),folderId:args.folderId?id(args.folderId):null});break;
      case 'DELETE_NOTE':await deleteNote(prisma,{userId,workspaceId:id(args.workspaceId),noteId:id(args.noteId)});break;
      case 'RETRY_ANALYSIS':await consumeRateLimit(prisma,'ANALYSIS',userId,{limit:10,windowMs:60000});await retryAnalysis(prisma,{userId,workspaceId:id(args.workspaceId),jobId:id(args.jobId),attemptKey:text(args.attemptKey,120)});return {message:'分析已重新排队。'};
      case 'CANCEL_ANALYSIS':await cancelAnalysis(prisma,{userId,workspaceId:id(args.workspaceId),jobId:id(args.jobId)});return {message:'已取消分析，不会保存迟到结果。'};
      case 'ANALYZE_AD':
        await consumeRateLimit(prisma,'ANALYSIS',userId,{limit:10,windowMs:60000});
        await enqueueAnalysis(prisma,{userId,workspaceId:id(args.workspaceId),adId:id(args.adId),idempotencyKey:text(args.idempotencyKey,120)});return {message:'分析已排队，可在研究记录查看进度。'};
      case 'INVITE_MEMBER':{
        const access=await requireWorkspaceRole(prisma,userId,id(args.workspaceId));
        const role=z.enum(['ADMIN','EDITOR','VIEWER']).parse(args.role);
        await team().invite({userId,organizationId:access.organization.id,email:z.email().parse(args.email),role:role==='ADMIN'?'ADMIN':'MEMBER',...(role==='ADMIN'?{}:{workspaceId:access.workspace.id,workspaceRole:role})});
        return {message:'邀请已进入邮件发送队列。'};
      }
      case 'ACCEPT_INVITATION':await team().acceptInvitation({userId,token:text(args.token,128)});return {message:'邀请已接受，请切换工作区。'};
      case 'REMOVE_MEMBER':{
        const access=await requireWorkspaceRole(prisma,userId,id(args.workspaceId));
        const member=await prisma.organizationMember.findFirst({where:{id:id(args.memberId),organizationId:access.organization.id}});if(!member)throw new DomainError(404,'MEMBER_NOT_FOUND');
        await team().removeMember({userId,organizationId:access.organization.id,memberUserId:member.userId});break;
      }
      case 'UPDATE_MEMBER':{
        const access=await requireWorkspaceRole(prisma,userId,id(args.workspaceId));
        const member=await prisma.organizationMember.findFirst({where:{id:id(args.memberId),organizationId:access.organization.id}});if(!member)throw new DomainError(404,'MEMBER_NOT_FOUND');
        await prisma.$transaction(async tx=>{
          await lockOrganization(tx,access.organization.id);await requireOrgRole(tx,userId,access.organization.id,['OWNER','ADMIN']);
          const current=await tx.organizationMember.findUniqueOrThrow({where:{id:member.id}});
          if(current.role==='OWNER')throw new DomainError(403,'OWNER_TRANSFER_REQUIRED');
          const role=z.enum(['ADMIN','MEMBER']).parse(args.organizationRole);
          if(role==='ADMIN')await requireOrgRole(tx,userId,access.organization.id,['OWNER']);
          await tx.organizationMember.update({where:{id:current.id},data:{role}});
          if(role==='MEMBER')await tx.workspaceMember.upsert({where:{workspaceId_userId:{workspaceId:access.workspace.id,userId:member.userId}},create:{organizationId:access.organization.id,workspaceId:access.workspace.id,userId:member.userId,role:z.enum(['EDITOR','VIEWER']).parse(args.workspaceRole)},update:{role:z.enum(['EDITOR','VIEWER']).parse(args.workspaceRole)}});
          await tx.auditEvent.create({data:{organizationId:access.organization.id,workspaceId:access.workspace.id,actorUserId:userId,action:'MEMBER_ROLE_CHANGED',targetType:'OrganizationMember',targetId:member.id,metadata:{role}}});
        });break;
      }
      case 'TRANSFER_OWNERSHIP':{
        const orgId=id(args.organizationId);await requireOrgRole(prisma,userId,orgId,['OWNER']);
        const member=await prisma.organizationMember.findFirst({where:{id:id(args.memberId),organizationId:orgId}});if(!member)throw new DomainError(404,'MEMBER_NOT_FOUND');
        await team().transferOwnership({userId,organizationId:orgId,targetUserId:member.userId});break;
      }
      case 'UPDATE_PROFILE':await prisma.user.update({where:{id:userId},data:{displayName:text(args.displayName,80),notificationPreference:{email:z.boolean().parse(args.emailNotifications)}}});break;
      case 'CHECKOUT':{
        const session=await configuredBilling().createCheckout({userId,organizationId:id(args.organizationId),planVersionId:id(args.planVersionId),idempotencyKey:randomUUID()});
        return {redirectUrl:session.url};
      }
      case 'CANCEL_SUBSCRIPTION':await configuredBilling().cancelAtPeriodEnd({userId,organizationId:id(args.organizationId)});return {message:'订阅将在已付周期结束时取消。'};
      case 'CHANGE_PLAN':await configuredBilling().changePlanNextPeriod({userId,organizationId:id(args.organizationId),planVersionId:id(args.planVersionId)});return {message:'套餐变更已预约到下一周期。'};
      case 'SUBMIT_FEEDBACK':case 'REQUEST_DELETION':{
        if(args.type==='REQUEST_DELETION'&&args.scope==='ACCOUNT'||args.type==='SUBMIT_FEEDBACK'&&!args.workspaceId){
          await submitAccountSupportRequest(prisma,{userId,kind:args.type==='REQUEST_DELETION'?'DELETION_REQUEST':'FEEDBACK',body:text(args.type==='REQUEST_DELETION'?args.reason:args.message,10000)});
          return {message:'已提交，可在本页查看处理状态。'};
        }
        const access=args.type==='SUBMIT_FEEDBACK'&&args.workspaceId?await requireWorkspaceRole(prisma,userId,id(args.workspaceId)):null;
        const orgId=access?.organization.id??(args.type==='REQUEST_DELETION'&&args.organizationId?id(args.organizationId):(await prisma.organizationMember.findFirst({where:{userId}}))?.organizationId);
        if(!orgId)throw new DomainError(400,'CREATE_ORGANIZATION_FIRST');
        await requireOrgRole(prisma,userId,orgId,args.type==='REQUEST_DELETION'&&args.scope==='ORGANIZATION'?['OWNER']:undefined);
        await prisma.feedback.create({data:{organizationId:orgId,workspaceId:access?.workspace.id,userId,category:args.type==='REQUEST_DELETION'?'DELETION_REQUEST':z.enum(['GENERAL','DATA_REQUEST','BUG','BILLING']).parse(args.category),subject:args.type==='REQUEST_DELETION'?`删除申请：${args.scope}`:'用户反馈',body:text(args.type==='REQUEST_DELETION'?args.reason:args.message,10000)}});
        return {message:'已提交，可在本页查看处理状态。'};
      }
      case 'PRODUCT_EVENT':{
        const access=await requireWorkspaceRole(prisma,userId,id(args.workspaceId));
        await prisma.productEvent.create({data:{organizationId:access.organization.id,workspaceId:access.workspace.id,userId,adId:id(args.adId),name:z.enum(['ad_detail_open','source_link_click','media_play']).parse(args.name),expiresAt:new Date(Date.now()+90*86400000)}});break;
      }
      case 'CREATE_COLLECTION_TASK':{
        await requirePlatformAdmin(prisma,userId);
        const requestedLimit=z.number().int().min(1).max(3).parse(args.maxItems??3);
        const query=validateCollectionQuery({keyword:text(args.query),country:text(args.country,3),status:'all',mediaType:args.mediaType.toLowerCase(),limit:requestedLimit});
        const interval=args.intervalMinutes===null?null:z.number().int().min(1).max(1440).parse(args.intervalMinutes);
        await prisma.$transaction(async tx=>{const task=await tx.collectionTask.create({data:{dataSourceId:id(args.dataSourceId),createdByUserId:userId,name:text(args.name,100),query:JSON.parse(JSON.stringify(query)),status:'PAUSED',maxItems:requestedLimit,scheduleCron:interval?`@every ${interval*60}s`:null,nextRunAt:interval?new Date(Date.now()+interval*60000):null}});await tx.auditEvent.create({data:{actorUserId:userId,action:'COLLECTION_TASK_CREATED',targetType:'CollectionTask',targetId:task.id}});});break;
      }
      case 'SET_TASK_STATUS':await createCollectionQueue(prisma).setTaskStatus({taskId:id(args.taskId),actorUserId:userId,status:z.enum(['ACTIVE','PAUSED']).parse(args.status)});break;
      case 'RUN_COLLECTION_TASK':await createCollectionQueue(prisma).enqueue({taskId:id(args.taskId),requestedByUserId:userId,idempotencyKey:text(args.idempotencyKey,120)});return {message:'抓取任务已排队。'};
      case 'CANCEL_COLLECTION_RUN':await createCollectionQueue(prisma).requestCancel(id(args.runId),userId);return {message:'已提交取消请求，等待执行者确认。'};
      case 'SET_DATA_SOURCE_STATUS':await createCollectionQueue(prisma).setSourceStatus({sourceId:id(args.dataSourceId),actorUserId:userId,status:z.enum(['ACTIVE','PAUSED']).parse(args.status)});break;
      case 'ADJUST_ENTITLEMENT':{
        await requirePlatformAdmin(prisma,userId);
        const organizationId=id(args.organizationId),key=z.enum(['WORKSPACES','MEMBERS','SAVED_ADS','ANALYSES']).parse(args.key),limit=z.number().int().min(0).max(1000000).parse(args.limit),reason=text(args.reason,500);
        await prisma.$transaction(async tx=>{await lockOrganization(tx,organizationId);const row=await activeEntitlement(tx,organizationId,key);await tx.entitlement.update({where:{id:row.id},data:{limit,source:'MANUAL',version:{increment:1}}});await tx.auditEvent.create({data:{organizationId,actorUserId:userId,action:'ENTITLEMENT_ADJUSTED',targetType:'Entitlement',targetId:row.id,metadata:{before:row.limit,after:limit,reason}}});});break;
      }
      case 'SET_ACCOUNT_STATUS':await setUserDisabled(prisma,{actorUserId:userId,targetUserId:id(args.targetUserId),disabled:z.boolean().parse(args.disabled),reason:text(args.reason,500)});return {message:'账号状态已更新。'};
      case 'RETRY_MEDIA':await requirePlatformAdmin(prisma,userId);await prisma.$transaction(async tx=>{const changed=await tx.mediaObject.updateMany({where:{id:id(args.mediaId),status:'FAILED',storageKey:null},data:{status:'PENDING',errorCode:null}});if(!changed.count)throw new DomainError(409,'MEDIA_NOT_RETRYABLE');await tx.auditEvent.create({data:{actorUserId:userId,action:'MEDIA_REQUEUED',targetType:'MediaObject',targetId:args.mediaId}});});return {message:'素材已重新排队。'};
      case 'RESOLVE_FEEDBACK':{
        if(args.scope==='ACCOUNT'){await resolveAccountSupportRequest(prisma,{actorUserId:userId,requestId:id(args.feedbackId)});break;}
        await resolveOrganizationSupportRequest(prisma,{actorUserId:userId,requestId:id(args.feedbackId)});break;
      }
      default:throw new DomainError(400,'UNKNOWN_COMMAND');
    }
    return {message:'已保存。'};
  });
}

export async function getPublicAdHistoryEvidence(args:AdEvidenceQuery,context:Context):Promise<AdEvidenceResult>{
  return safe(async()=>{const storage=configuredStorage();return getAdHistoryEvidence(prisma,{...args,userId:actor(context),workspaceId:id(args.workspaceId),adId:id(args.adId),observationId:id(args.observationId)},storage?key=>storage.signGet(key,{expiresInSeconds:300}):undefined);});
}
