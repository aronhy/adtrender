import type { PrismaClient, Prisma } from '@prisma/client';
import { DomainError,requireWorkspaceRole } from '../team/access';
import { admitQuota,releaseQuota,lockOrganization } from '../billing/quotas';
import { safelyRecordConversion } from '../growth/conversions';
interface Scope {userId:string;workspaceId:string}
const text=(value:string,max:number)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw new DomainError(400,'INVALID_RESEARCH_TEXT');return value.trim();};
async function folder(tx:Prisma.TransactionClient,workspaceId:string,folderId:string|null|undefined){if(folderId&&!await tx.folder.findFirst({where:{id:folderId,workspaceId}}))throw new DomainError(404,'FOLDER_NOT_FOUND');}
async function saved(tx:Prisma.TransactionClient,workspaceId:string,savedAdId:string){const record=await tx.savedAd.findFirst({where:{id:savedAdId,workspaceId}});if(!record)throw new DomainError(404,'SAVED_AD_NOT_FOUND');return record;}
export async function createFolder(db:PrismaClient,input:Scope&{name:string}){return db.$transaction(async tx=>{const access=await requireWorkspaceRole(tx,input.userId,input.workspaceId,true);const name=text(input.name,100);return tx.folder.upsert({where:{workspaceId_name:{workspaceId:input.workspaceId,name}},create:{workspaceId:input.workspaceId,organizationId:access.organization.id,name},update:{}});});}
export async function saveAd(db:PrismaClient,input:Scope&{adId:string;folderId?:string|null}){return db.$transaction(async tx=>{
 const access=await requireWorkspaceRole(tx,input.userId,input.workspaceId,true);await lockOrganization(tx,access.organization.id);await folder(tx,input.workspaceId,input.folderId);
 const prior=await tx.savedAd.findUnique({where:{workspaceId_adId:{workspaceId:input.workspaceId,adId:input.adId}}});if(prior)return prior;
 if(!await tx.ad.findUnique({where:{id:input.adId},select:{id:true}}))throw new DomainError(404,'AD_NOT_FOUND');
 await admitQuota(tx,access.organization.id,'SAVED_ADS',1);
 const record=await tx.savedAd.create({data:{workspaceId:input.workspaceId,organizationId:access.organization.id,adId:input.adId,savedByUserId:input.userId,folderId:input.folderId??null}});
 // A persisted business milestone survives unsave and consent changes. Its
 // conditional update also serializes simultaneous first saves across teams.
 const first=await tx.user.updateMany({where:{id:input.userId,firstAdSavedAt:null},data:{firstAdSavedAt:record.createdAt}});
 if(first.count)await safelyRecordConversion(tx,input.userId,'FIRST_AD_SAVED');
 return record;
});}
export async function unsaveAd(db:PrismaClient,input:Scope&{savedAdId:string}){return db.$transaction(async tx=>{
 const access=await requireWorkspaceRole(tx,input.userId,input.workspaceId,true);await lockOrganization(tx,access.organization.id);const prior=await tx.savedAd.findFirst({where:{id:input.savedAdId,workspaceId:input.workspaceId}});if(!prior)return {removed:false};
 await tx.note.deleteMany({where:{savedAdId:prior.id,workspaceId:input.workspaceId}});await tx.savedAd.delete({where:{id:prior.id}});await releaseQuota(tx,access.organization.id,'SAVED_ADS',1);return {removed:true};
});}
export async function moveSavedAd(db:PrismaClient,input:Scope&{savedAdId:string;folderId:string|null}){return db.$transaction(async tx=>{await requireWorkspaceRole(tx,input.userId,input.workspaceId,true);await saved(tx,input.workspaceId,input.savedAdId);await folder(tx,input.workspaceId,input.folderId);return tx.savedAd.update({where:{id:input.savedAdId},data:{folderId:input.folderId}});});}
export async function writeNote(db:PrismaClient,input:Scope&{savedAdId:string;noteId?:string;body:string}){return db.$transaction(async tx=>{
 const access=await requireWorkspaceRole(tx,input.userId,input.workspaceId,true);await saved(tx,input.workspaceId,input.savedAdId);const body=text(input.body,10000);
 if(input.noteId){const prior=await tx.note.findFirst({where:{id:input.noteId,savedAdId:input.savedAdId,workspaceId:input.workspaceId}});if(!prior)throw new DomainError(404,'NOTE_NOT_FOUND');return tx.note.update({where:{id:prior.id},data:{body}});}
 return tx.note.create({data:{organizationId:access.organization.id,workspaceId:input.workspaceId,savedAdId:input.savedAdId,authorUserId:input.userId,body}});
});}
export async function deleteNote(db:PrismaClient,input:Scope&{noteId:string}){return db.$transaction(async tx=>{await requireWorkspaceRole(tx,input.userId,input.workspaceId,true);const result=await tx.note.deleteMany({where:{id:input.noteId,workspaceId:input.workspaceId}});return {removed:result.count===1};});}
export async function listResearch(db:PrismaClient,input:Scope&{folderId?:string;limit?:number}) {
 return db.$transaction(async tx=>{
  await requireWorkspaceRole(tx,input.userId,input.workspaceId);
  const limit=input.limit??100;
  if(!Number.isInteger(limit)||limit<1||limit>200)throw new DomainError(400,'INVALID_RESEARCH_LIMIT');
  await folder(tx,input.workspaceId,input.folderId);
  const where={workspaceId:input.workspaceId,...(input.folderId?{folderId:input.folderId}:{})};
  const [folders,savedAds,total]=await Promise.all([
   tx.folder.findMany({where:{workspaceId:input.workspaceId},orderBy:{name:'asc'}}),
   tx.savedAd.findMany({where,take:limit,orderBy:[{createdAt:'desc'},{id:'desc'}],include:{ad:{include:{advertiser:true,media:{orderBy:[{displayOrder:'asc'},{id:'asc'}]}}},notes:{orderBy:{createdAt:'asc'}}}}),
   tx.savedAd.count({where}),
  ]);
  return {folders,savedAds,total};
 });
}
