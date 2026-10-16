import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {loadPlatformAdminDashboard,type DashboardDistribution,type DashboardOverview,type DashboardTrends,type DashboardHealth} from './platform-admin-dashboard';
const url=process.env.SAAS_TEST_DATABASE_URL;
if(url){const parsed=new URL(url);if(!['localhost','127.0.0.1'].includes(parsed.hostname)||!/_test(?:_|$)/.test(parsed.pathname))throw new Error('LOCAL_ISOLATED_DATABASE_REQUIRED');}
const db=new PrismaClient({datasources:{db:{url:url??'postgresql://unused@127.0.0.1:1/not_run'}}});
const admin=randomUUID(),owner=randomUUID(),source=randomUUID(),task=randomUUID(),ad=randomUUID(),org=randomUUID(),run=randomUUID();
const now=new Date(),date=new Date(now.getTime()+8*3600000).toISOString().slice(0,10);const filters={from:new Date(now.getTime()+8*3600000-6*86400000).toISOString().slice(0,10),to:date};
afterAll(async()=>{if(url)await db.$transaction(async tx=>{
 await tx.collectionRun.deleteMany({where:{id:run}});await tx.collectionTask.deleteMany({where:{id:task}});await tx.ad.deleteMany({where:{dataSourceId:source}});await tx.dataSource.deleteMany({where:{id:source}});
 await tx.emailDelivery.deleteMany({where:{organizationId:org}});await tx.organizationMember.deleteMany({where:{organizationId:org}});await tx.organization.deleteMany({where:{id:org}});await tx.user.deleteMany({where:{id:{in:[admin,owner]}}});
 });await db.$disconnect();});
describe.skipIf(!url)('dashboard live aggregations on isolated PostgreSQL',()=>{
 beforeAll(async()=>{await db.$transaction(async tx=>{
  await tx.user.createMany({data:[{id:admin,isAdmin:true},{id:owner}]});
  await tx.organization.create({data:{id:org,name:'Dashboard fixture',slug:org,members:{create:{userId:owner,role:'OWNER'}}}});
  await tx.dataSource.create({data:{id:source,key:source,name:'Dashboard fixture',adapterVersion:'native-fixture',configuration:{token:'must-not-return'}}});
  await tx.ad.createMany({data:Array.from({length:125},(_,i)=>({dataSourceId:source,sourceAdId:`${ad}-${i}`,sourceUrl:'https://example.test/ad',publisherPlatforms:[]}))});
  await tx.collectionTask.create({data:{id:task,dataSourceId:source,name:'Archive',query:{},status:'PAUSED'}});
  await tx.collectionRun.create({data:{id:run,taskId:task,dataSourceId:source,idempotencyKey:run,querySnapshot:{secret:'must-not-return'},adapterVersion:'native-fixture',status:'SUCCEEDED',coverage:{outcome:'no-results'}}});
 });});
 it('reads uncapped totals and honestly omits unavailable comparisons',async()=>{const result=await loadPlatformAdminDashboard(db,admin,{view:'overview',...filters}) as DashboardOverview;expect(result.kpis.users).toBeGreaterThanOrEqual(2);expect(result.kpis.ads).toBeGreaterThanOrEqual(125);expect(result.kpis.added24h).toBeGreaterThanOrEqual(125);expect(result).not.toHaveProperty('comparisons.subscriptions');});
 it('fills HK daily dates and classifies only explicit no-results as reliable empty',async()=>{const trends=await loadPlatformAdminDashboard(db,admin,{view:'trends',...filters}) as DashboardTrends;expect(trends.daily).toHaveLength(7);expect(trends.daily.at(-1)).toMatchObject({date,users:expect.any(Number)});expect(trends.daily.at(-1)!.ads).toBeGreaterThanOrEqual(1);const composition=await loadPlatformAdminDashboard(db,admin,{view:'distribution',...filters}) as DashboardDistribution;expect(composition.results.at(-1)!.empty).toBeGreaterThanOrEqual(1);expect(composition.platforms.some(p=>p.label==='未知')).toBe(true);expect(JSON.stringify(composition)).not.toContain('must-not-return');});
 it('separates heartbeat and writes from live service health and never leaks source configuration',async()=>{const health=await loadPlatformAdminDashboard(db,admin,{view:'health',...filters}) as DashboardHealth;expect(health.services.find(s=>s.name==='数据库')?.status).toBe('HEALTHY');expect(health.services.find(s=>s.name==='对象存储')?.status).not.toBe('HEALTHY');expect(JSON.stringify(health)).not.toContain('must-not-return');});
 it('uses the effective failed-mail status for pending counts without losing old records',async()=>{
 const before=await loadPlatformAdminDashboard(db,admin,{view:'overview',...filters}) as DashboardOverview;
 await db.emailDelivery.createMany({data:[{organizationId:org,recipientEmail:'active@example.test',templateKey:'NOTICE',dedupeKey:org+'active',status:'FAILED',createdAt:new Date(now.getTime()-30*86400000),expiresAt:new Date(now.getTime()+86400000),payloadExpiresAt:new Date(now.getTime()+86400000)},{organizationId:org,recipientEmail:'expired@example.test',templateKey:'NOTICE',dedupeKey:org+'expired',status:'FAILED',expiresAt:new Date(now.getTime()-1000),payloadExpiresAt:new Date(now.getTime()+86400000)}]});
 const after=await loadPlatformAdminDashboard(db,admin,{view:'overview',...filters}) as DashboardOverview;expect(after.pending.email-before.pending.email).toBe(1);
 });
 it('rechecks persisted privilege for every request after revocation',async()=>{await db.user.update({where:{id:admin},data:{isAdmin:false}});for(const view of ['overview','trends','distribution','health'])await expect(loadPlatformAdminDashboard(db,admin,{view,...filters})).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});});
});
