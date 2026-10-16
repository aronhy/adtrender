import {Prisma,type PrismaClient} from '@prisma/client';
import {z} from 'zod';
import {requirePlatformAdmin} from '../team/access';
import {parseGrowthRange} from '../growth/summary';
export type DashboardView='overview'|'trends'|'distribution'|'health';
export type DashboardOverview={asOf:string;kpis:{users:number;organizations:number;subscriptions:number;ads:number;added24h:number;readyRate:number|null};comparisons:{users:number|null;organizations:number|null;ads:number|null};pending:{feedback:number;requests:number;runs:number;media:number;email:number}};
export type DashboardTrends={asOf:string;daily:Array<{date:string;users:number;organizations:number;ads:number}>};
export type DashboardDistribution={asOf:string;platforms:Array<{label:string;value:number}>;results:Array<{date:string;success:number;empty:number;failed:number;restricted:number}>;excludedRuns:number};
export type DashboardHealth={asOf:string;services:Array<{name:string;status:string;at:Date|null;note:string}>;sources:Array<{id:string;name:string;status:string;at:Date|null;errorCode:string|null;retryAt:string|null}>};
export function dashboardComparison(current:number,previous:number|null){return previous&&previous>0?Math.round((current-previous)/previous*1000)/10:null;}
const schema=z.object({view:z.enum(['overview','trends','distribution','health']).default('overview'),from:z.string(),to:z.string()}).strict();
const count=(db:PrismaClient,table:'User'|'Organization'|'Ad',cutoff:Date)=>db.$queryRaw<Array<{n:bigint}>>(Prisma.sql`SELECT COUNT(*) n FROM ${Prisma.raw('"'+table+'"')} WHERE "createdAt"<=${cutoff.toISOString()}::timestamp`).then(rows=>Number(rows[0].n));
export async function loadPlatformAdminDashboard(db:PrismaClient,userId:string,input:unknown):Promise<DashboardOverview|DashboardTrends|DashboardDistribution|DashboardHealth>{
 await requirePlatformAdmin(db,userId);const query=schema.parse(input);const[nowRow]=await db.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AS now`;const now=nowRow.now;const range=parseGrowthRange({from:query.from,to:query.to},now);const asOf=now.toISOString();
 if(query.view==='overview'){
  const prior=new Date(now.getTime()-range.days*86400000);
  const[users,organizations,ads,oldUsers,oldOrgs,oldAds,subscriptions,added24h,media,feedback,requests,runs,failedMedia,email]=await Promise.all([
   count(db,'User',now),count(db,'Organization',now),count(db,'Ad',now),count(db,'User',prior),count(db,'Organization',prior),count(db,'Ad',prior),
   db.subscription.count({where:{status:{in:['ACTIVE','TRIALING']}}}),db.ad.count({where:{createdAt:{gte:new Date(now.getTime()-86400000),lte:now}}}),
   db.$queryRaw<Array<{total:bigint;ready:bigint}>>`SELECT COUNT(*) total,COUNT(*) FILTER(WHERE status='READY') ready FROM "MediaObject"`,
   db.feedback.count({where:{status:'OPEN'}}),db.accountSupportRequest.count({where:{status:'OPEN'}}),db.collectionRun.count({where:{status:'FAILED',createdAt:{gte:range.start,lt:range.end}}}),db.mediaObject.count({where:{status:'FAILED',type:{in:['IMAGE','VIDEO']}}}),db.emailDelivery.count({where:{status:'FAILED',AND:[{OR:[{expiresAt:null},{expiresAt:{gt:now}}]},{OR:[{payloadExpiresAt:null},{payloadExpiresAt:{gt:now}}]}]}}),
  ]);
  return {asOf,kpis:{users,organizations,ads,subscriptions,added24h,readyRate:Number(media[0].total)?Number(media[0].ready)/Number(media[0].total)*100:null},comparisons:{users:dashboardComparison(users,oldUsers),organizations:dashboardComparison(organizations,oldOrgs),ads:dashboardComparison(ads,oldAds)},pending:{feedback,requests,runs,media:failedMedia,email}};
 }
 if(query.view==='trends'){
  const daily=await db.$queryRaw<DashboardTrends['daily']>(Prisma.sql`WITH days AS (SELECT generate_series(${range.start.toISOString()}::timestamp,${new Date(range.end.getTime()-86400000).toISOString()}::timestamp,interval '1 day') d), records AS (SELECT "createdAt",'users' kind FROM "User" UNION ALL SELECT "createdAt",'organizations' FROM "Organization" UNION ALL SELECT "createdAt",'ads' FROM "Ad") SELECT to_char(d+interval '8 hours','YYYY-MM-DD') date,COUNT(*) FILTER(WHERE r.kind='users')::int users,COUNT(*) FILTER(WHERE r.kind='organizations')::int organizations,COUNT(*) FILTER(WHERE r.kind='ads')::int ads FROM days LEFT JOIN records r ON r."createdAt">=d AND r."createdAt"<d+interval '1 day' AND r."createdAt"<=${now.toISOString()}::timestamp GROUP BY d ORDER BY d`);return {asOf,daily};
 }
 if(query.view==='distribution'){
  const[platforms,results,excludedRuns]=await Promise.all([
   db.$queryRaw<DashboardDistribution['platforms']>`SELECT COALESCE(p.platform,'未知') label,COUNT(DISTINCT a.id)::int value FROM "Ad" a LEFT JOIN LATERAL (SELECT DISTINCT unnest(a."publisherPlatforms") platform) p ON true GROUP BY 1 ORDER BY value DESC,label`,
   db.$queryRaw<DashboardDistribution['results']>(Prisma.sql`WITH days AS (SELECT generate_series(${range.start.toISOString()}::timestamp,${new Date(range.end.getTime()-86400000).toISOString()}::timestamp,interval '1 day') d), classified AS (SELECT "createdAt",CASE WHEN coverage->>'outcome'='restricted' OR COALESCE("errorCode",'') ~ '(403|429|RATE_LIMIT|CHALLENGE|LOGIN_REQUIRED)' THEN 'restricted' WHEN status='SUCCEEDED' AND coverage->>'outcome'='no-results' THEN 'empty' WHEN status='SUCCEEDED' THEN 'success' WHEN status IN ('FAILED','PARTIAL') THEN 'failed' ELSE 'other' END result FROM "CollectionRun" WHERE "createdAt">=${range.start.toISOString()}::timestamp AND "createdAt"<${range.end.toISOString()}::timestamp AND "createdAt"<=${now.toISOString()}::timestamp) SELECT to_char(d+interval '8 hours','YYYY-MM-DD') date,COUNT(*) FILTER(WHERE c.result='success')::int success,COUNT(*) FILTER(WHERE c.result='empty')::int empty,COUNT(*) FILTER(WHERE c.result='failed')::int failed,COUNT(*) FILTER(WHERE c.result='restricted')::int restricted FROM days LEFT JOIN classified c ON c."createdAt">=d AND c."createdAt"<d+interval '1 day' GROUP BY d ORDER BY d`),
   db.collectionRun.count({where:{createdAt:{gte:range.start,lt:range.end},status:{in:['QUEUED','RUNNING','CANCELED']}}}),
  ]);return {asOf,platforms,results,excludedRuns};
 }
 const[workers,mail,storage,sources]=await Promise.all([
  db.workerHeartbeat.findFirst({where:{status:{not:'STOPPED'}},orderBy:{lastSeenAt:'desc'},select:{lastSeenAt:true}}),
  db.emailDelivery.findFirst({where:{status:'SENT'},orderBy:{sentAt:'desc'},select:{sentAt:true}}),
  db.mediaObject.findFirst({where:{status:'READY',storageKey:{not:null},downloadedAt:{not:null}},orderBy:{downloadedAt:'desc'},select:{downloadedAt:true}}),
  db.dataSource.findMany({orderBy:{name:'asc'},select:{id:true,name:true,status:true,lastSuccessfulAt:true,lastErrorCode:true,configuration:true}}),
 ]);
 return {asOf,services:[{name:'API',status:'HEALTHY',at:now,note:'本次管理查询已成功返回；接口 /health 可另行探测。'},{name:'数据库',status:'HEALTHY',at:now,note:'本次独立 SELECT clock_timestamp() 成功。'},{name:'Worker',status:workers&&now.getTime()-workers.lastSeenAt.getTime()<90000?'HEALTHY':'UNAVAILABLE',at:workers?.lastSeenAt??null,note:'应用 Worker 最近心跳，阈值 90 秒。'},{name:'邮件',status:mail?.sentAt?'UNKNOWN':'UNAVAILABLE',at:mail?.sentAt??null,note:'仅列最近服务商接收时间，不证明当前传输可用或已到达邮箱。'},{name:'对象存储',status:storage?.downloadedAt?'UNKNOWN':'UNAVAILABLE',at:storage?.downloadedAt??null,note:'仅列最近素材成功写入记录，未进行实时存储探测。'}],sources:sources.map(s=>{const config=s.configuration as Record<string,unknown>|null;const retry=typeof config?.retryAt==='string'&&Number.isFinite(Date.parse(config.retryAt))?new Date(config.retryAt).toISOString():null;return {id:s.id,name:s.name,status:s.status,at:s.lastSuccessfulAt,errorCode:s.lastErrorCode&&/^[A-Z0-9_:-]{1,120}$/.test(s.lastErrorCode)?s.lastErrorCode:null,retryAt:retry};})};
}
