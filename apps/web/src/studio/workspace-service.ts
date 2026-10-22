import type {PrismaClient} from '@prisma/client';
import {z} from 'zod';
import {DomainError,requireWorkspaceRole} from '../team/access';
export const defaultStudioPreferences={defaultDays:30,defaultStartPage:'dashboard',brandChanges:true,emailDigest:true,weeklySummary:true,collectionUpdates:false};
const preferencesSchema=z.object({defaultDays:z.union([z.literal(7),z.literal(14),z.literal(30)]).optional(),defaultStartPage:z.enum(['dashboard','ads','advertisers','tracking']).optional(),brandChanges:z.boolean().optional(),emailDigest:z.boolean().optional(),weeklySummary:z.boolean().optional(),collectionUpdates:z.boolean().optional()}).strict();
export type StudioCommand={workspaceId:string;type:'FOLLOW_BRAND'|'UNFOLLOW_BRAND';advertiserId:string}|{workspaceId:string;type:'UPDATE_PREFERENCES';preferences:Record<string,unknown>};
function preferences(value:unknown){const parsed=preferencesSchema.safeParse(value);return {...defaultStudioPreferences,...(parsed.success?parsed.data:{})};}
async function readableFollowIds(db:Pick<PrismaClient,'advertiser'>,ids:string[]){
 if(!ids.length)return [];
 const rows=await db.advertiser.findMany({where:{id:{in:ids}},select:{id:true}});
 const visible=new Set(rows.map(row=>row.id));return [...new Set(ids)].filter(id=>visible.has(id));
}
export async function loadStudioState(db:PrismaClient,userId:string,workspaceId:string){
 const access=await requireWorkspaceRole(db,userId,workspaceId);
 const [state,events]=await Promise.all([db.studioPreference.findUnique({where:{userId_workspaceId:{userId,workspaceId}}}),db.auditEvent.findMany({where:{organizationId:access.organization.id,action:{in:['SUBSCRIPTION_CANCELLATION_SCHEDULED','SUBSCRIPTION_RENEWAL_RESUMED','SUBSCRIPTION_PLAN_CHANGE_SCHEDULED','SUBSCRIPTION_RECONCILED','CHECKOUT_CREATED','TRIAL_INITIALIZED']}},orderBy:{createdAt:'desc'},take:100,select:{id:true,action:true,createdAt:true,metadata:true}})]);
 return {followedAdvertiserIds:await readableFollowIds(db,state?.followedAdvertiserIds||[]),preferences:preferences(state?.preferences),subscriptionEvents:events.map(e=>{const m=e.metadata&&typeof e.metadata==='object'&&!Array.isArray(e.metadata)?e.metadata as Record<string,unknown>:{};return {id:e.id,type:e.action,at:e.createdAt.toISOString(),...(typeof m.planName==='string'?{planName:m.planName}:{}),...(typeof m.status==='string'?{status:m.status}:{}),...(typeof m.periodEnd==='string'?{periodEnd:m.periodEnd}:{})};})};
}
export async function updateStudioState(db:PrismaClient,userId:string,command:StudioCommand){
 const ownPreference=command.type==='UPDATE_PREFERENCES';
 await requireWorkspaceRole(db,userId,command.workspaceId,!ownPreference);
 const patch=ownPreference?preferencesSchema.parse(command.preferences):null;
 await db.$transaction(async tx=>{
  await requireWorkspaceRole(tx,userId,command.workspaceId,!ownPreference);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId+'|'+command.workspaceId},0))`;
  const where={userId_workspaceId:{userId,workspaceId:command.workspaceId}};
  const current=await tx.studioPreference.findUnique({where});
  let ids=current?.followedAdvertiserIds||[];
  if(command.type==='FOLLOW_BRAND'){
   const target=await tx.advertiser.findUnique({where:{id:command.advertiserId},select:{id:true}});
   if(!target)throw new DomainError(404,'ADVERTISER_NOT_FOUND');
   ids=await readableFollowIds(tx,ids);
   if(ids.length>=500&&!ids.includes(target.id))throw new DomainError(409,'FOLLOW_LIMIT_REACHED');
   ids=[...new Set([...ids,target.id])];
  }else if(command.type==='UNFOLLOW_BRAND'){
   // A user may always remove their own stored reference after the advertiser has been removed.
   // This does not reveal whether that advertiser still exists.
   ids=ids.filter(id=>id!==command.advertiserId);
  }
  const merged={...preferences(current?.preferences),...patch};
  await tx.studioPreference.upsert({where,create:{userId,workspaceId:command.workspaceId,followedAdvertiserIds:ids,preferences:merged},update:{followedAdvertiserIds:ids,preferences:merged,version:{increment:1}}});
 });
 return loadStudioState(db,userId,command.workspaceId);
}
