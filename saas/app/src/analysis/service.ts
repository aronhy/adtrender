import { createHash } from 'node:crypto';
import type { PrismaClient, Prisma, AnalysisJob } from '@prisma/client';
import { DomainError,requireWorkspaceRole } from '../team/access';
import { lockOrganization,reserveAnalysis,releaseUsage } from '../billing/quotas';
export const ANALYSIS_PROMPT_VERSION='text-inference-2';
export const ANALYSIS_MAX_ATTEMPTS=3;
export interface AnalysisEvidence {id:string;label:string;text:string;sourceUrl:string}
export interface AnalysisSourceFact {id:string;label:string;value:string|number|null;sourceUrl:string}
export interface AnalysisInput {version:1|2;adId:string;sourceAdId:string;sourceUrl:string;observedAt:string|null;mediaReviewed:false;evidence:AnalysisEvidence[];sourceFacts?:AnalysisSourceFact[];limitations:string[]}
interface Scope{userId:string;workspaceId:string}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export function analysisInputHash(value:unknown):string {
 const canonical=(item:any):any=>Array.isArray(item)?item.map(canonical):item&&typeof item==='object'?Object.fromEntries(Object.keys(item).sort().map(key=>[key,canonical(item[key])])):item;
 return hash(JSON.stringify(canonical(value)));
}
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
function key(value:string){if(typeof value!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(value))throw new DomainError(400,'INVALID_IDEMPOTENCY_KEY');return value;}
export function configuredAnalysisModel(env:NodeJS.ProcessEnv=process.env){const model=env.ANALYSIS_MODEL?.trim();if(!model||!env.OPENAI_API_KEY?.trim())throw new DomainError(503,'ANALYSIS_NOT_CONFIGURED');return model;}
function snapshot(ad:any):AnalysisInput {
 const fields=[['body','广告正文',ad.body],['headline','广告标题',ad.headline],['cta','行动按钮',ad.cta],['source','来源链接',ad.sourceUrl]];
 const sourceFacts:AnalysisSourceFact[]=[
  {id:'sourceStatus',label:'来源报告状态',value:['ACTIVE','INACTIVE'].includes(ad.sourceStatus)?ad.sourceStatus:'UNKNOWN',sourceUrl:ad.sourceUrl},
  {id:'mediaCount',label:'来源素材记录数',value:ad.media.length,sourceUrl:ad.sourceUrl},
  {id:'imageCount',label:'来源图片记录数',value:ad.media.filter((media:{type:string})=>media.type==='IMAGE').length,sourceUrl:ad.sourceUrl},
  {id:'videoCount',label:'来源视频记录数',value:ad.media.filter((media:{type:string})=>media.type==='VIDEO').length,sourceUrl:ad.sourceUrl},
  {id:'unknownMediaCount',label:'类型未知素材记录数',value:ad.media.filter((media:{type:string})=>!['IMAGE','VIDEO'].includes(media.type)).length,sourceUrl:ad.sourceUrl},
  {id:'firstObservedAt',label:'首次观测时间',value:ad.firstObservedAt?.toISOString()??null,sourceUrl:ad.sourceUrl},
  {id:'lastObservedAt',label:'最近观测时间',value:ad.lastObservedAt?.toISOString()??null,sourceUrl:ad.sourceUrl},
 ];
 return {version:2,adId:ad.id,sourceAdId:ad.sourceAdId,sourceUrl:ad.sourceUrl,observedAt:ad.lastObservedAt?.toISOString()??null,mediaReviewed:false,sourceFacts,evidence:fields.filter(([, ,value])=>typeof value==='string'&&value.trim()).map(([id,label,value])=>({id,label,text:value,sourceUrl:ad.sourceUrl})),limitations:['仅分析公开文字，未查看图片或视频；素材数量仅表示来源记录。','首次观测不等于首次投放，观测跨度不等于连续投放时长。','没有点击、转化、花费或收入数据，不能判断广告效果。']};
}
export async function enqueueAnalysis(db:PrismaClient,input:Scope&{adId:string;idempotencyKey:string},env:NodeJS.ProcessEnv=process.env){return db.$transaction(async tx=>{
 const access=await requireWorkspaceRole(tx,input.userId,input.workspaceId,true);await lockOrganization(tx,access.organization.id);await requireWorkspaceRole(tx,input.userId,input.workspaceId,true);key(input.idempotencyKey);
 const prior=await tx.analysisJob.findUnique({where:{workspaceId_idempotencyKey:{workspaceId:input.workspaceId,idempotencyKey:input.idempotencyKey}}});if(prior){if(prior.adId!==input.adId)throw new DomainError(409,'ANALYSIS_IDEMPOTENCY_CONFLICT');return prior;}
 const model=configuredAnalysisModel(env);const ad=await tx.ad.findUnique({where:{id:input.adId},include:{media:{select:{type:true}}}});if(!ad)throw new DomainError(404,'AD_NOT_FOUND');const inputSnapshot=snapshot(ad);
 if(!inputSnapshot.evidence.some(item=>['body','headline','cta'].includes(item.id)))throw new DomainError(422,'ANALYSIS_TEXT_UNAVAILABLE');
 const usage=await reserveAnalysis(tx,access.organization.id,`analysis:${hash(`${input.workspaceId}:${input.idempotencyKey}`)}:initial`);if(usage.status!=='RESERVED')throw new DomainError(409,'ANALYSIS_RESERVATION_NOT_ACTIVE');
 return tx.analysisJob.create({data:{organizationId:access.organization.id,workspaceId:input.workspaceId,requestedByUserId:input.userId,adId:ad.id,usageLedgerId:usage.id,idempotencyKey:input.idempotencyKey,inputSnapshot:json(inputSnapshot),inputSha256:analysisInputHash(inputSnapshot),model,promptVersion:ANALYSIS_PROMPT_VERSION}});
});}
export async function retryAnalysis(db:PrismaClient,input:Scope&{jobId:string;attemptKey:string},env:NodeJS.ProcessEnv=process.env){return db.$transaction(async tx=>{
 const access=await requireWorkspaceRole(tx,input.userId,input.workspaceId,true);await lockOrganization(tx,access.organization.id);await requireWorkspaceRole(tx,input.userId,input.workspaceId,true);key(input.attemptKey);configuredAnalysisModel(env);
 const job=await tx.analysisJob.findFirst({where:{id:input.jobId,workspaceId:input.workspaceId}});if(!job)throw new DomainError(404,'ANALYSIS_NOT_FOUND');
 const ledgerKey=`analysis-retry:${hash(`${job.id}:${input.attemptKey}`)}`;const prior=await tx.usageLedger.findUnique({where:{organizationId_idempotencyKey:{organizationId:access.organization.id,idempotencyKey:ledgerKey}}});
 if(prior){if(prior.status==='RELEASED')throw new DomainError(409,'ANALYSIS_RETRY_KEY_USED');if(prior.id===job.usageLedgerId)return job;throw new DomainError(409,'ANALYSIS_RETRY_KEY_USED');}
 if(job.attempt>=ANALYSIS_MAX_ATTEMPTS)throw new DomainError(409,'ANALYSIS_ATTEMPT_LIMIT');if(job.status!=='FAILED')throw new DomainError(409,'ANALYSIS_NOT_RETRYABLE');
 const usage=await reserveAnalysis(tx,access.organization.id,ledgerKey);if(usage.status!=='RESERVED')throw new DomainError(409,'ANALYSIS_RESERVATION_NOT_ACTIVE');
 return tx.analysisJob.update({where:{id:job.id},data:{status:'QUEUED',usageLedgerId:usage.id,errorCode:null,finishedAt:null,leaseOwner:null,leaseExpiresAt:null,leaseVersion:{increment:1}}});
});}
/** Archive and result settlement share organization -> job lock order. Keep the
 * job history, release its reservation, and fence any provider already running. */
export async function cancelWorkspaceAnalysis(tx:Prisma.TransactionClient,organizationId:string,workspaceId:string) {
 await lockOrganization(tx,organizationId);
 const jobs=await tx.$queryRaw<AnalysisJob[]>`SELECT * FROM "AnalysisJob" WHERE "organizationId"=${organizationId} AND "workspaceId"=${workspaceId} AND status IN ('QUEUED','RUNNING') ORDER BY id FOR UPDATE`;
 for(const job of jobs) {
  if(job.usageLedgerId)await releaseUsage(tx,organizationId,job.usageLedgerId,'WORKSPACE_ARCHIVED');
  await tx.analysisJob.update({where:{id:job.id},data:{status:'CANCELED',finishedAt:new Date(),leaseVersion:{increment:1},leaseOwner:null,leaseExpiresAt:null,errorCode:'WORKSPACE_ARCHIVED'}});
 }
 return jobs.length;
}
export async function cancelAnalysis(db:PrismaClient,input:Scope&{jobId:string}){return db.$transaction(async tx=>{
 const access=await requireWorkspaceRole(tx,input.userId,input.workspaceId,true);await lockOrganization(tx,access.organization.id);const rows=await tx.$queryRawUnsafe<any[]>(`SELECT * FROM "AnalysisJob" WHERE id=$1 AND "workspaceId"=$2 FOR UPDATE`,input.jobId,input.workspaceId);const job=rows[0];if(!job)throw new DomainError(404,'ANALYSIS_NOT_FOUND');if(!['QUEUED','RUNNING'].includes(job.status))return job;
 if(job.usageLedgerId)await releaseUsage(tx,access.organization.id,job.usageLedgerId,'ANALYSIS_CANCELED');return tx.analysisJob.update({where:{id:job.id},data:{status:'CANCELED',finishedAt:new Date(),leaseVersion:{increment:1},leaseOwner:null,leaseExpiresAt:null,errorCode:'ANALYSIS_CANCELED'}});
});}
export async function getAnalysisJob(db:PrismaClient,input:Scope&{jobId:string}){return db.$transaction(async tx=>{await requireWorkspaceRole(tx,input.userId,input.workspaceId);const job=await tx.analysisJob.findFirst({where:{id:input.jobId,workspaceId:input.workspaceId},include:{results:true}});if(!job)throw new DomainError(404,'ANALYSIS_NOT_FOUND');return job;});}
export async function listAnalysisJobs(db:PrismaClient,input:Scope&{limit?:number}){return db.$transaction(async tx=>{await requireWorkspaceRole(tx,input.userId,input.workspaceId);const limit=input.limit??50;if(!Number.isInteger(limit)||limit<1||limit>100)throw new DomainError(400,'INVALID_ANALYSIS_LIMIT');return tx.analysisJob.findMany({where:{workspaceId:input.workspaceId},take:limit,orderBy:[{createdAt:'desc'},{id:'desc'}],include:{results:true}});});}
