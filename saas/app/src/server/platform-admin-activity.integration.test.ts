import {randomUUID} from 'node:crypto';
import {PrismaClient, type Prisma} from '@prisma/client';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {getPlatformAdminActivity,exportPlatformAdminActivity,runPlatformAdminActivityCommand} from './platform-admin-activity';
const url=process.env.SAAS_TEST_DATABASE_URL;
if(url){const parsed=new URL(url);if(!['localhost','127.0.0.1'].includes(parsed.hostname)||!/_test(?:_|$)/.test(parsed.pathname))throw new Error('LOCAL_ISOLATED_DATABASE_REQUIRED');}
const db=new PrismaClient({datasources:{db:{url:url??'postgresql://unused@127.0.0.1:1/not_run'}}});
const admin=randomUUID(),owner=randomUUID(),organization=randomUUID(),workspace=randomUUID();
const visits:string[]=[],requests:string[]=[],emails:string[]=[],extraUsers:string[]=[];
const marker=`activity-${randomUUID()}`,now=new Date();
const from=new Date(now.getTime()+8*3600000-6*86400000).toISOString().slice(0,10),to=new Date(now.getTime()+8*3600000).toISOString().slice(0,10);
const hkDb={$transaction:(fn:(tx:Prisma.TransactionClient)=>Promise<unknown>,options?:{isolationLevel?:Prisma.TransactionIsolationLevel;timeout?:number})=>db.$transaction(async tx=>{
 await tx.$executeRaw`SET LOCAL TIME ZONE 'Asia/Hong_Kong'`;
 const [zone]=await tx.$queryRaw<Array<{zone:string}>>`SELECT current_setting('TimeZone') AS zone`;expect(zone.zone).toBe('Asia/Hong_Kong');
 return fn(tx);
},options)} as unknown as PrismaClient;
afterAll(async()=>{
 vi.unstubAllEnvs();
 if(url)await db.$transaction(async tx=>{
  await tx.auditEvent.deleteMany({where:{OR:[{actorUserId:admin},{organizationId:organization}]}});
  await tx.emailDelivery.deleteMany({where:{id:{in:emails}}});await tx.accountSupportRequest.deleteMany({where:{id:{in:requests}}});
  await tx.feedback.deleteMany({where:{organizationId:organization}});await tx.usageLedger.deleteMany({where:{organizationId:organization}});await tx.entitlement.deleteMany({where:{organizationId:organization}});
  await tx.productEvent.deleteMany({where:{organizationId:organization}});
  await tx.growthVisit.deleteMany({where:{id:{in:visits}}});await tx.workspace.delete({where:{id:workspace}});
  await tx.organizationMember.deleteMany({where:{organizationId:organization}});await tx.organization.delete({where:{id:organization}});
  await tx.user.deleteMany({where:{id:{in:[admin,owner,...extraUsers]}}});
 });await db.$disconnect();
});
describe.skipIf(!url)('platform activity reads and transactional administration against isolated PostgreSQL',()=>{
 beforeAll(async()=>{
  await db.$transaction(async tx=>{
   await tx.user.createMany({data:[{id:admin,email:`${admin}@example.test`,isAdmin:true},{id:owner,email:`${owner}@example.test`}]});
   await tx.organization.create({data:{id:organization,name:marker,slug:marker}});await tx.organizationMember.create({data:{organizationId:organization,userId:owner,role:'OWNER'}});
   await tx.workspace.create({data:{id:workspace,organizationId:organization,name:marker,slug:marker}});
  });
 });
 it('reads live real rows for all 7 tabs and hides all visit credentials',async()=>{
  for(const isTest of [false,true]){const visit=await db.growthVisit.create({data:{tokenHash:randomUUID(),landingPath:'/',expiresAt:new Date(now.getTime()+86400000),isTest}});visits.push(visit.id);if(!isTest)await db.conversionEvent.create({data:{visitId:visit.id,userId:owner,name:'ACCOUNT_CREATED'}});}
  for(const tab of ['visits','product','usage','feedback','requests','audit','email'] as const){const view=await getPlatformAdminActivity(db,{userId:admin,tab,filters:{from,to}});expect(view.tab).toBe(tab);expect(JSON.stringify(view)).not.toContain('tokenHash');if(tab==='visits'){expect(view.metrics.find(r=>r.key==='consentRate')?.value).toBeNull();expect(view.metrics.find(r=>r.key==='registrationRate')?.value).toBeGreaterThan(0);}}
 });
 it('reads usage and product records with real organizational scope',async()=>{
  const entitlement=await db.entitlement.create({data:{organizationId:organization,key:'ANALYSES',limit:20,periodStart:new Date(now.getTime()-86400000),validFrom:new Date(now.getTime()-86400000)}});
  const old=await db.entitlement.create({data:{organizationId:organization,key:'ANALYSES',limit:99,periodStart:new Date(now.getTime()-2*86400000),validFrom:new Date(now.getTime()-2*86400000)}});
  await db.usageLedger.create({data:{organizationId:organization,entitlementId:old.id,idempotencyKey:`${marker}-previous-cycle`,quantity:99,status:'SETTLED'}});
  await db.usageLedger.create({data:{organizationId:organization,entitlementId:entitlement.id,idempotencyKey:`${marker}-private-full-key`,quantity:2,status:'RELEASED',releaseReason:'ANALYSIS_FAILED'}});
  await db.productEvent.create({data:{organizationId:organization,workspaceId:workspace,userId:owner,name:'ad_detail_open'}});
  const usage=await getPlatformAdminActivity(db,{userId:admin,tab:'usage',filters:{from,to,organizationId:organization}});
  expect(usage.total).toBe(1);expect(usage.metrics.find(r=>r.key==='allocated')?.value).toBe(2);
  expect(usage.rows[0].cells.idempotencyKey).toHaveLength(8);expect(usage.metrics.find(r=>r.key==='releaseRate')?.value).toBe(100);
  const product=await getPlatformAdminActivity(db,{userId:admin,tab:'product',filters:{from,to,organizationId:organization}});expect(product.rows[0].cells.organization).toBe(marker);
  const csv=await exportPlatformAdminActivity(db,{userId:admin,tab:'usage',filters:{from,to,organizationId:organization}});expect(csv.csv).not.toContain('private-full-key');
 });
 it('resolves with identity check and reason then returns conflict on stale confirmation',async()=>{
  const request=await db.accountSupportRequest.create({data:{userId:owner,kind:'DELETION_REQUEST',body:'Review account deletion'}});requests.push(request.id);
  await expect(runPlatformAdminActivityCommand(db,{userId:admin,command:'resolve-request',id:request.id,reason:'Checked',expectedStatus:'OPEN'})).rejects.toMatchObject({code:'IDENTITY_VERIFICATION_REQUIRED'});
  await runPlatformAdminActivityCommand(db,{userId:admin,command:'resolve-request',id:request.id,reason:'Identity verified; retention reviewed',identityVerified:true,expectedStatus:'OPEN'});
  await expect(runPlatformAdminActivityCommand(db,{userId:admin,command:'resolve-request',id:request.id,reason:'Checked again',identityVerified:true,expectedStatus:'OPEN'})).rejects.toMatchObject({code:'ADMIN_ACTIVITY_CONFLICT'});
  expect(await db.user.findUnique({where:{id:owner}})).not.toBeNull();
  const audit=await db.auditEvent.findFirstOrThrow({where:{actorUserId:admin,targetId:request.id}});expect(audit.metadata).toMatchObject({reason:'Identity verified; retention reviewed',before:{status:'OPEN'},after:{status:'RESOLVED'}});
  const detail=await getPlatformAdminActivity(db,{userId:admin,tab:'requests',detailId:request.id,filters:{from,to}});expect(detail.rows[0].metadata?.['处理说明']).toBe('Identity verified; retention reviewed');expect(detail.rows[0].metadata?.['处理时间']).toMatch(/Z$/);
 });
 it('excludes customer workspace audit operations and redacts nested credentials',async()=>{
  await db.auditEvent.create({data:{organizationId:organization,workspaceId:workspace,actorUserId:admin,action:'WORKSPACE_ARCHIVED',targetType:'Workspace',targetId:workspace}});
  await db.auditEvent.create({data:{organizationId:organization,actorUserId:admin,action:'ENTITLEMENT_ADJUSTED',targetType:'Entitlement',targetId:organization,metadata:{reason:'Checked',nested:{accessToken:'hidden-secret',signedUrl:'https://private.test?signature=secret'}}}});
  const audit=await getPlatformAdminActivity(db,{userId:admin,tab:'audit',filters:{from,to,actorUserId:admin}});expect(audit.rows.some(r=>r.cells.action==='WORKSPACE_ARCHIVED')).toBe(false);expect(JSON.stringify(audit)).not.toContain('hidden-secret');expect(JSON.stringify(audit)).not.toContain('signature=secret');
 });
 it('returns safe email projection and queues an eligible retry with atomic audit',async()=>{
  for(const key of ['SMTP_HOST','SMTP_USERNAME','SMTP_PASSWORD','EMAIL_FROM','OUTBOX_ENCRYPTION_KEY'])vi.stubEnv(key,'isolated-fixture-only');
  const row=await db.emailDelivery.create({data:{organizationId:organization,userId:owner,recipientEmail:`${owner}@example.test`,templateKey:'VERIFY',dedupeKey:randomUUID(),status:'FAILED',attempts:1,encryptedPayload:'private-ciphertext',encryptionKeyVersion:'v1',payloadExpiresAt:new Date(Date.now()+3600000),expiresAt:new Date(Date.now()+86400000),metadata:{locale:'zh-CN',token:'hidden',url:'https://private.test/token'}}});emails.push(row.id);
  const view=await getPlatformAdminActivity(db,{userId:admin,tab:'email',filters:{from,to,organizationId:organization}});expect(view.rows[0].cells.status).toBe('FAILED');expect(view.rows[0].retryReason).toBe('');expect(view.rows[0].canRetry).toBe(true);for(const forbidden of ['private-ciphertext','encryptedPayload','dedupeKey','encryptionKeyVersion','hidden','https://private'])expect(JSON.stringify(view)).not.toContain(forbidden);
  const result=await runPlatformAdminActivityCommand(db,{userId:admin,command:'retry-email',id:row.id,reason:'Verified transport recovery',expectedStatus:'FAILED'});expect(result.status).toBe('QUEUED');expect(await db.auditEvent.count({where:{targetId:row.id,action:'EMAIL_RETRY_REQUESTED'}})).toBe(1);
  expect((await db.emailDelivery.findUniqueOrThrow({where:{id:row.id}})).attempts).toBe(1);
 });
 it('filters email by the effective status displayed after payload or retention expiry',async()=>{
  for(const status of ['FAILED','SENT'] as const){
   const row=await db.emailDelivery.create({data:{organizationId:organization,recipientEmail:`${owner}@example.test`,templateKey:'EXPIRED_FILTER',dedupeKey:randomUUID(),status,payloadExpiresAt:new Date(Date.now()-3600000),expiresAt:status==='SENT'?new Date(Date.now()-3600000):new Date(Date.now()+86400000)}});emails.push(row.id);
  }
  const filters={from,to,organizationId:organization,templateKey:'EXPIRED_FILTER'};
  const expired=await getPlatformAdminActivity(db,{userId:admin,tab:'email',filters:{...filters,status:'EXPIRED'}});
  expect(expired.total).toBe(2);expect(expired.rows.every(row=>row.cells.status==='EXPIRED')).toBe(true);
  for(const status of ['FAILED','SENT'])expect((await getPlatformAdminActivity(db,{userId:admin,tab:'email',filters:{...filters,status}})).total).toBe(0);
 });
 it('rejects non-admin reads and exports server-side',async()=>{
  await expect(getPlatformAdminActivity(db,{userId:owner,tab:'audit'})).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});
  await expect(exportPlatformAdminActivity(db,{userId:owner,tab:'visits'})).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});
 });
 it('keeps Hong Kong day boundaries, cursor pages and as-of validity independent of connection timezone',async()=>{
  const date=new Date(now.getTime()+8*3600000-86400000).toISOString().slice(0,10);
  const start=new Date(`${date}T00:00:00+08:00`),end=new Date(start.getTime()+86400000);
  const inside:string[]=[],outside:string[]=[];
  for(const [time,inRange] of [[start.getTime()-1,false],[start.getTime(),true],[end.getTime()-1,true],[end.getTime(),false],...Array.from({length:21},(_,i)=>[start.getTime()+60000+i*1000,true])] as Array<[number,boolean]>){
   const visit=await db.growthVisit.create({data:{tokenHash:randomUUID(),landingPath:'/help',createdAt:new Date(time),lastSeenAt:new Date(time),expiresAt:new Date(now.getTime()+86400000)}});visits.push(visit.id);(inRange?inside:outside).push(visit.id);
  }
  await db.conversionEvent.create({data:{visitId:inside[0],userId:admin,name:'ACCOUNT_CREATED',createdAt:start}});
  const first=await getPlatformAdminActivity(hkDb,{userId:admin,tab:'visits',filters:{from:date,to:date}});expect(first.nextCursor).toBeTruthy();
  expect(first.metrics.find(row=>row.key==='registrations')?.value).toBe(1);expect(first.daily.find(row=>row.day===date)?.registrations).toBe(1);
  const second=await getPlatformAdminActivity(hkDb,{userId:admin,tab:'visits',filters:{from:date,to:date},cursor:first.nextCursor!});
  const ids=[...first.rows,...second.rows].map(row=>row.id);expect(inside.every(id=>ids.includes(id))).toBe(true);expect(outside.some(id=>ids.includes(id))).toBe(false);expect(new Set(ids).size).toBe(ids.length);
  const future=await db.growthVisit.create({data:{tokenHash:randomUUID(),landingPath:'/privacy',createdAt:new Date(Date.now()+3600000),expiresAt:new Date(now.getTime()+86400000)}});visits.push(future.id);
  expect((await getPlatformAdminActivity(hkDb,{userId:admin,tab:'visits',detailId:future.id,filters:{from,to}})).rows).toHaveLength(0);
  const upcoming=await db.entitlement.create({data:{organizationId:organization,key:'ANALYSES',limit:9,validFrom:new Date(Date.now()+3600000),periodStart:new Date(now.getTime()-60000)}});
  await db.usageLedger.create({data:{organizationId:organization,entitlementId:upcoming.id,idempotencyKey:`${marker}-future-entitlement`,quantity:9,status:'SETTLED',createdAt:new Date(now.getTime()-30000),reservedAt:new Date(now.getTime()-30000)}});
  expect((await getPlatformAdminActivity(hkDb,{userId:admin,tab:'usage',filters:{from,to,organizationId:organization}})).metrics.find(row=>row.key==='allocated')?.value).toBe(2);
 });
 it('returns every product event, channel and email template identity above eight categories',async()=>{
  const names=Array.from({length:9},(_,i)=>`${marker}-${i}`);
  for(const name of names){
   const visit=await db.growthVisit.create({data:{tokenHash:randomUUID(),landingPath:['/','/pricing','/help','/terms','/privacy'][names.indexOf(name)%5],source:name,createdAt:new Date(now.getTime()-60000),expiresAt:new Date(now.getTime()+86400000)}});visits.push(visit.id);
   await db.productEvent.create({data:{organizationId:organization,workspaceId:workspace,name,createdAt:new Date(now.getTime()-60000)}});
   const email=await db.emailDelivery.create({data:{organizationId:organization,recipientEmail:`${owner}@example.test`,templateKey:name,dedupeKey:randomUUID(),status:'SENT',createdAt:new Date(now.getTime()-60000)}});emails.push(email.id);
  }
  const product=await getPlatformAdminActivity(hkDb,{userId:admin,tab:'product',filters:{from,to,organizationId:organization}});
  const email=await getPlatformAdminActivity(hkDb,{userId:admin,tab:'email',filters:{from,to,organizationId:organization}});
  const visit=await getPlatformAdminActivity(hkDb,{userId:admin,tab:'visits',filters:{from,to}});
  for(const values of [product.distribution,email.distribution,visit.secondaryDistribution!])expect(names.every(name=>values.some(row=>row.label===name))).toBe(true);
  expect(visit.distribution.map(row=>row.label).sort()).toEqual(['/','/pricing','/help','/terms','/privacy'].sort());expect(visit.distribution.some(row=>row.label==='其他')).toBe(false);
 });
 it('includes old pending support and failed mail in all-date dashboard destinations with matching summaries',async()=>{
  const createdAt=new Date(now.getTime()-14*86400000);
  const feedback=await db.feedback.create({data:{organizationId:organization,userId:owner,category:'GENERAL',subject:marker,body:marker,createdAt}});
  const request=await db.accountSupportRequest.create({data:{userId:owner,kind:'FEEDBACK',body:marker,createdAt}});requests.push(request.id);
  const mail=await db.emailDelivery.create({data:{organizationId:organization,recipientEmail:`${owner}@example.test`,templateKey:`${marker}-old`,dedupeKey:randomUUID(),status:'FAILED',createdAt,payloadExpiresAt:new Date(now.getTime()+86400000),expiresAt:new Date(now.getTime()+86400000)}});emails.push(mail.id);
  for(const [tab,id,filter] of [['feedback',feedback.id,{search:marker,status:'OPEN'}],['requests',request.id,{search:marker,status:'OPEN'}],['email',mail.id,{templateKey:`${marker}-old`,status:'FAILED'}]] as const){
   expect((await getPlatformAdminActivity(hkDb,{userId:admin,tab,filters:{from,to,...filter}})).total).toBe(0);
   const all=await getPlatformAdminActivity(hkDb,{userId:admin,tab,filters:{from,to,...filter,allDates:true}});
   expect(all.total).toBe(1);expect(all.rows[0].id).toBe(id);expect(all.daily.some(row=>row.day===new Date(createdAt.getTime()+8*3600000).toISOString().slice(0,10))).toBe(true);
   expect(all.metrics.find(row=>row.key===(tab==='email'?'total':'submitted'))?.value).toBe(1);
  }
  await expect(getPlatformAdminActivity(hkDb,{userId:admin,tab:'visits',filters:{allDates:true}})).rejects.toMatchObject({code:'ADMIN_ALL_DATES_UNSUPPORTED'});
 });
 it('keeps registration-date charts in the same selected visit cohort as KPIs and CSV across different channels',async()=>{
  const date=new Date(now.getTime()+8*3600000-86400000).toISOString().slice(0,10),start=new Date(`${date}T00:00:00+08:00`);
  const filters={from:date,to:date,channel:'source' as const};
  const before=await getPlatformAdminActivity(hkDb,{userId:admin,tab:'visits',filters});
  const accounts=[randomUUID(),randomUUID()];extraUsers.push(...accounts);
  await db.user.createMany({data:accounts.map(id=>({id,email:`${id}@example.test`}))});
  const sources=[`${marker}-in-cohort`,`${marker}-outside-cohort`];
  for(let i=0;i<2;i++){
   const visit=await db.growthVisit.create({data:{tokenHash:randomUUID(),landingPath:'/help',source:sources[i],createdAt:new Date(start.getTime()+(i===0?60000:-60000)),expiresAt:new Date(now.getTime()+86400000)}});visits.push(visit.id);
   await db.conversionEvent.create({data:{visitId:visit.id,userId:accounts[i],name:'ACCOUNT_CREATED',createdAt:new Date(start.getTime()+120000)}});
  }
  const after=await getPlatformAdminActivity(hkDb,{userId:admin,tab:'visits',filters});
  const registrations=(view:typeof after)=>view.metrics.find(row=>row.key==='registrations')?.value??0;
  const daily=(view:typeof after)=>Number(view.daily.find(row=>row.day===date)?.registrations??0);
  expect(registrations(after)-registrations(before)).toBe(1);expect(daily(after)-daily(before)).toBe(1);expect(after.total-before.total).toBe(1);
  expect(after.secondaryDistribution?.some(row=>row.label===sources[0])).toBe(true);expect(after.secondaryDistribution?.some(row=>row.label===sources[1])).toBe(false);
  const csv=await exportPlatformAdminActivity(hkDb,{userId:admin,tab:'visits',filters});expect(csv.csv).toContain(sources[0]);expect(csv.csv).not.toContain(sources[1]);
 });
});
