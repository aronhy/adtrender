import {HttpError,prisma} from 'wasp/server';
import {z} from 'zod';
import {DomainError,requirePlatformAdmin} from '../team/access';
import {consumeRateLimit} from './rate-limit';
import {loadPlatformAdminDashboard} from './platform-admin-dashboard';
import {queryPlatformAdminUsers,runPlatformAdminUsersCommand} from './platform-admin-users';
import {loadPlatformAdminAdsStats,listPlatformAdminSources,listPlatformAdminRuns,loadPlatformAdminRunDetail,listPlatformAdminMedia,setPlatformAdminSourceStatusOn,retryPlatformAdminMediaOn,type AdminAdsFilter,type AdminAdsPageQuery} from './platform-admin-ads';
import {getPlatformAdminActivity,exportPlatformAdminActivity,runPlatformAdminActivityCommand,type ActivityQuery,type ActivityCommand} from './platform-admin-activity';
import {listPlatformAdminTasks,applyPlatformAdminTask} from './platform-admin-tasks';
type AdminWire=null|string|number|boolean|AdminWire[]|{[key:string]:AdminWire};
function wire(value:unknown):AdminWire{return JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==='bigint'?Number(item):item)) as AdminWire;}
async function safeWire(operation:()=>Promise<unknown>):Promise<AdminWire>{return safe(async()=>wire(await operation()));}
type Context={user?:{id:string}|null};
const schema=z.object({module:z.enum(['dashboard','users','ads','analytics','operations','email','showcase']),payload:z.record(z.string(),z.unknown()).default({})}).strict();
async function safe<T>(operation:()=>Promise<T>):Promise<T>{try{return await operation();}catch(error){if(error instanceof DomainError)throw new HttpError(error.status,error.code);if(error instanceof z.ZodError)throw new HttpError(400,'INVALID_ADMIN_INPUT');if(error instanceof HttpError)throw error;throw new HttpError(500,'ADMIN_REQUEST_FAILED');}}
function actor(context:Context){if(!context.user?.id)throw new DomainError(401,'AUTH_REQUIRED');return context.user.id;}
export async function getPlatformAdminData(args:unknown,context:Context):Promise<AdminWire>{return safeWire(async()=>{
 const userId=actor(context);await requirePlatformAdmin(prisma,userId);const{module,payload}=schema.parse(args);
 if(module==='dashboard')return loadPlatformAdminDashboard(prisma,userId,payload);
 if(module==='users')return queryPlatformAdminUsers(prisma,userId,payload);
 if(module==='showcase')return {available:false,reason:'首页橱窗需要公开数据合同、审核状态与公开素材通道就绪，当前尚未启用。'};
 if(module==='ads'){
  const{view,detailId,...input}=payload;
  switch(view){case 'stats':return loadPlatformAdminAdsStats(prisma,userId,input as AdminAdsFilter);case 'sources':return listPlatformAdminSources(prisma,userId,input as AdminAdsPageQuery);case 'runs':return detailId?loadPlatformAdminRunDetail(prisma,userId,{runId:String(detailId),cursor:input.cursor as string|undefined,limit:input.limit as number|undefined}):listPlatformAdminRuns(prisma,userId,input as AdminAdsPageQuery);case 'media':return listPlatformAdminMedia(prisma,userId,input as AdminAdsPageQuery);case 'tasks':return listPlatformAdminTasks(prisma,userId,input);default:throw new DomainError(400,'INVALID_ADMIN_VIEW');}
 }
 const{export:exporting,...query}=payload;const allowed=module==='analytics'?['visits','product','usage']:module==='operations'?['feedback','requests','audit']:['email'];if(!allowed.includes(String(query.tab)))throw new DomainError(400,'INVALID_ADMIN_VIEW');
 return exporting?exportPlatformAdminActivity(prisma,{...query as ActivityQuery,userId}):getPlatformAdminActivity(prisma,{...query as ActivityQuery,userId});
 });}
export async function platformAdminCommand(args:unknown,context:Context):Promise<AdminWire>{return safeWire(async()=>{
 const userId=actor(context);await requirePlatformAdmin(prisma,userId);const{module,payload}=schema.parse(args);await consumeRateLimit(prisma,'ACTION',userId,{limit:60,windowMs:60000});
 if(module==='users')return runPlatformAdminUsersCommand(prisma,userId,payload);
 if(module==='ads'){
  if(payload.type==='SET_SOURCE_STATUS'){const{type,...input}=payload;return setPlatformAdminSourceStatusOn(prisma,userId,input as Parameters<typeof setPlatformAdminSourceStatusOn>[2]);}
  if(payload.type==='RETRY_MEDIA'){const{type,...input}=payload;return retryPlatformAdminMediaOn(prisma,userId,input as Parameters<typeof retryPlatformAdminMediaOn>[2]);}
  return applyPlatformAdminTask(prisma,userId,payload as Parameters<typeof applyPlatformAdminTask>[2]);
 }
 if(module==='operations'||module==='email'){const allowed=module==='operations'?['resolve-feedback','resolve-request']:['retry-email'];if(!allowed.includes(String(payload.command)))throw new DomainError(400,'INVALID_ADMIN_COMMAND');return runPlatformAdminActivityCommand(prisma,{...payload as ActivityCommand,userId});}
 throw new DomainError(400,'INVALID_ADMIN_COMMAND');
 });}
