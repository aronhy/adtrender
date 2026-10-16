import {createHash} from 'node:crypto';
import {DomainError,requirePlatformAdmin} from '../team/access';
import {seedCanonical,seedSourceKeys} from '@ad-research/contracts/seeds';
import {buildQueryLedger,type LedgerWindow} from './metrics';
import {readNativeCapabilities} from './publications';
export interface SeedPageInput {userId:string;view?:string;query?:string;status?:string;seedKind?:string;sourceKey?:string;country?:string;cursor?:string;limit?:number}
function filters(input:SeedPageInput){
 const limit=input.limit??50;if(!Number.isSafeInteger(limit)||limit<1||limit>100||input.query&&input.query.length>200||input.sourceKey&&!seedSourceKeys.includes(input.sourceKey as any)||input.country&&!/^[A-Z]{2}$/.test(input.country))throw new DomainError(400,'SEED_PAGE_INVALID');
 return {limit,query:input.query?.trim(),status:input.status,kind:input.seedKind,source:input.sourceKey,country:input.country};
}
type Cursor={v:1;scope:string;asOf:string;at:string;id:string};
function pagination(input:SeedPageInput,view:string){
 const f=filters(input),scope=createHash('sha256').update(seedCanonical({userId:input.userId,view,...f,limit:undefined})).digest('hex');let cursor:Cursor|null=null;
 if(input.cursor){try{cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString());}catch{throw new DomainError(400,'SEED_CURSOR_INVALID');}if(!cursor||cursor.v!==1||cursor.scope!==scope||!Number.isFinite(Date.parse(cursor.asOf))||!Number.isFinite(Date.parse(cursor.at))||cursor.at>cursor.asOf||!/^[\w-]{1,100}$/.test(cursor.id))throw new DomainError(400,'SEED_CURSOR_INVALID');}
 const asOf=cursor?.asOf??new Date().toISOString(),base={createdAt:{lte:new Date(asOf)}},boundary=cursor?{OR:[{createdAt:{lt:new Date(cursor.at)}},{createdAt:new Date(cursor.at),id:{lt:cursor.id}}]}:{};
 const result=(rows:any[],total:number)=>{const last=rows[f.limit-1];return {items:rows.slice(0,f.limit),total,asOf,nextCursor:rows.length>f.limit&&last?Buffer.from(JSON.stringify({v:1,scope,asOf,at:last.createdAt.toISOString(),id:last.id})).toString('base64url'):null};};
 return {f,base,boundary,asOf,result,take:f.limit+1,orderBy:[{createdAt:'desc'},{id:'desc'}]};
}
const attemptSelect={id:true,taskId:true,attemptNo:true,nodeId:true,incarnationId:true,assignmentGeneration:true,leaseVersion:true,leaseExpiresAt:true,heartbeatAt:true,startedAt:true,requestDeadline:true,stopReason:true,publicationRevision:true,checkpointSequence:true,state:true};
export async function listSeedPage(db:any,input:SeedPageInput){
 return db.$transaction(async(tx:any)=>{
  await requirePlatformAdmin(tx,input.userId);const view=input.view??'seeds',p=pagination(input,view),{f}=p;
  let model:any,base:any={...p.base},include:any;
  if(['seeds','discoveries'].includes(view)){
   model=tx.seedDefinition;if(f.query)base.normalizedValue={contains:f.query.normalize('NFKC').toLowerCase(),mode:'insensitive'};if(f.status)base.status=f.status;if(f.kind)base.kind=f.kind;if(f.source)base.targetPlatforms={has:f.source};
   if(f.country)base.targetScope={path:['countries'],array_contains:[f.country]};if(view==='discoveries'){base.verificationStatus='CANDIDATE';base.evidence={some:{originKind:{not:'DIRECTORY_ONLY'}}};}include={_count:{select:{evidence:true,bindings:true}}};
  }else if(view==='relations'){model=tx.seedRelation;if(f.status)base.status=f.status;include={fromSeed:{select:{id:true,rawValue:true,namespace:true}},toSeed:{select:{id:true,rawValue:true,namespace:true}}};}
  else if(view==='publications'){model=tx.seedPublication;include={receipts:{orderBy:{lastSeenAt:'desc'},select:{nodeId:true,incarnationId:true,publicationRevision:true,type:true,applyStatus:true,appliedAt:true,errorCode:true,lastSeenAt:true}}};}
  else if(view==='audits'){model=tx.auditEvent;base.targetType='SeedLibrary';}
  else if(view==='scanPlans'){model=tx.seedScanPlan;if(f.source)base.sourceKey=f.source;if(f.status)base.status=f.status;}
  else throw new DomainError(400,'SEED_PAGE_INVALID');
  const [rows,total]=await Promise.all([model.findMany({where:{AND:[base,p.boundary]},orderBy:p.orderBy,take:p.take,...(include?{include}:{})}),model.count({where:base})]);
  return p.result(rows,total);
 },{isolationLevel:'RepeatableRead'});
}
export async function listSeedImportPreview(db:any,input:{userId:string;importId:string;cursor?:string;limit?:number}){
 await requirePlatformAdmin(db,input.userId);const job=await db.seedImportJob.findUnique({where:{id:input.importId}});if(!job||job.actorUserId!==input.userId||!['PREVIEWED','COMMITTED'].includes(job.status))throw new DomainError(404,'SEED_IMPORT_NOT_FOUND');
 const limit=input.limit??50;if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new DomainError(400,'SEED_PAGE_INVALID');
 let offset=0;if(input.cursor){try{const c=JSON.parse(Buffer.from(input.cursor,'base64url').toString());if(c.jobId!==job.id||c.fileHash!==job.fileHash||!Number.isSafeInteger(c.offset)||c.offset<0)throw Error();offset=c.offset;}catch{throw new DomainError(400,'SEED_CURSOR_INVALID');}}
 const all=job.rowResults.items as any[],next=offset+limit;return {items:all.slice(offset,next),total:all.length,asOf:job.createdAt.toISOString(),nextCursor:next<all.length?Buffer.from(JSON.stringify({jobId:job.id,fileHash:job.fileHash,offset:next})).toString('base64url'):null,counts:job.counts,status:job.expiresAt<new Date()&&job.status==='PREVIEWED'?'EXPIRED':job.status};
}
export async function getSeedDetailView(db:any,input:{userId:string;seedId:string}){
 await requirePlatformAdmin(db,input.userId);const seed=await db.seedDefinition.findUnique({where:{id:input.seedId}});if(!seed)throw new DomainError(404,'SEED_NOT_FOUND');
 const [evidence,relations,bindings,attempts]=await Promise.all([
  db.seedEvidence.findMany({where:{seedId:seed.id},include:{source:{select:{key:true}}},orderBy:{createdAt:'desc'},take:100}),
  db.seedRelation.findMany({where:{OR:[{fromSeedId:seed.id},{toSeedId:seed.id}]},include:{fromSeed:true,toSeed:true},orderBy:{createdAt:'desc'},take:100}),
  db.seedQueryBinding.findMany({where:{seedId:seed.id,validToRevision:null},orderBy:{createdAt:'desc'}}),
  db.seedAttempt.findMany({where:{OR:[{primarySeedId:seed.id},{bindingSnapshot:{array_contains:[{seedId:seed.id}]}}]},orderBy:{finishedAt:'desc'},take:100})
 ]);return {seed,evidence,relations,bindings,attempts:attempts.map((a:any)=>({...a,commitStatus:'COMMITTED'}))};
}
export async function listSeedDispatchPage(db:any,input:SeedPageInput){
 return db.$transaction(async(tx:any)=>{
  await requirePlatformAdmin(tx,input.userId);const p=pagination(input,'dispatch'),base:any={...p.base};if(p.f.source)base.sourceKey=p.f.source;if(p.f.country)base.queryCountry=p.f.country;if(p.f.status)base.status=p.f.status;
  if(p.f.query)base.bindings={some:{seed:{normalizedValue:{contains:p.f.query.toLowerCase(),mode:'insensitive'}}}};
  const [rows,total,pubs]=await Promise.all([
   tx.seedQuery.findMany({where:{AND:[base,p.boundary]},orderBy:p.orderBy,take:p.take,include:{bindings:{where:{validToRevision:null}},runtime:true,tasks:{orderBy:{createdAt:'desc'},take:10,include:{attempts:{orderBy:{attemptNo:'desc'},select:attemptSelect}}}}}),
   tx.seedQuery.count({where:base}),tx.seedPublication.findMany({orderBy:{revision:'desc'},take:1,include:{receipts:{select:{nodeId:true,publicationRevision:true,applyStatus:true,type:true,errorCode:true,lastSeenAt:true,queryCounts:true,nativeJobMappings:true}}}})
  ]);
  const committed=await tx.seedAttempt.findMany({where:{queryId:{in:rows.map((q:any)=>q.id)},taskAttemptId:{not:null}},orderBy:{finishedAt:'desc'},select:{queryId:true,taskAttemptId:true,insertedCount:true,updatedCount:true,outcome:true,attributionQuality:true}});
  return p.result(rows.map((q:any)=>({...q,runtime:q.runtime?[q.runtime]:[],attempts:q.tasks.flatMap((t:any)=>t.attempts).map((a:any)=>{const facts=committed.filter((f:any)=>f.taskAttemptId===a.id);return {...a,...(facts.length?{commitStatus:'COMMITTED',insertedCount:facts.reduce((n:number,f:any)=>n+f.insertedCount,0),updatedCount:facts.reduce((n:number,f:any)=>n+f.updatedCount,0),outcome:facts[0].outcome,attributionQuality:facts[0].attributionQuality}:{})};}),publication:pubs[0]??null,receipts:(pubs[0]?.receipts??[]).filter((r:any)=>r.queryCounts?.queryIds?.includes(q.id)||r.nativeJobMappings?.some((m:any)=>m.queryId===q.id))})),total);
 },{isolationLevel:'RepeatableRead'});
}
export function ledgerWindow(input:{from?:string;to?:string}={}):LedgerWindow{
 const to=input.to?new Date(/^\d{4}-\d{2}-\d{2}$/.test(input.to)?input.to+'T00:00:00.000Z':input.to):new Date(),from=input.from?new Date(/^\d{4}-\d{2}-\d{2}$/.test(input.from)?input.from+'T00:00:00.000Z':input.from):new Date(to.getTime()-7*86400000);
 if(input.to&&/^\d{4}-\d{2}-\d{2}$/.test(input.to))to.setUTCDate(to.getUTCDate()+1);if(!Number.isFinite(from.getTime())||!Number.isFinite(to.getTime())||from>=to)throw new DomainError(400,'SEED_WINDOW_INVALID');return {from:from.toISOString(),to:to.toISOString()};
}
export async function getSeedOverviewView(db:any,input:{userId:string;from?:string;to?:string}){
 await requirePlatformAdmin(db,input.userId);const window=ledgerWindow(input);
 const [counts,ledger,publications,nodes]=await Promise.all([db.seedDefinition.groupBy({by:['status'],_count:{_all:true}}),buildQueryLedger(db,window),db.seedPublication.findMany({orderBy:{revision:'desc'},take:20}),db.collectorNode.findMany({orderBy:{nodeId:'asc'}})]);
 const now=Date.now(),leaseMs=Number(process.env.COLLECTOR_LEASE_MS),heartbeatWindow=Number.isSafeInteger(leaseMs)&&leaseMs>0?leaseMs:null;
 const displayedNodes=nodes.map((n:any)=>({...n,registryStatus:n.status,status:!n.enabled?'DISABLED':n.expiresAt&&n.expiresAt.valueOf()<=now?'EXPIRED':!n.lastHeartbeatAt?'NO_HEARTBEAT':heartbeatWindow&&now-n.lastHeartbeatAt.valueOf()>heartbeatWindow?'STALE':n.status}));
 return {seedCounts:Object.fromEntries(counts.map((c:any)=>[c.status,c._count._all])),ledger,publications,nodes:displayedNodes,window};
}
export async function getSeedCoverageView(db:any,input:{userId:string;from?:string;to?:string;sourceKey?:string}){
 await requirePlatformAdmin(db,input.userId);const window=ledgerWindow(input);let rows=await buildQueryLedger(db,window);if(input.sourceKey){if(!seedSourceKeys.includes(input.sourceKey as any))throw new DomainError(400,'SEED_SOURCE_INVALID');rows=rows.filter(r=>r.sourceKey===input.sourceKey);}
 return {rows,window,scopeLabel:'实际查询地域与所选执行时间；共享查询总量不可按绑定数量相加。'};
}
export async function getSeedRulesView(db:any,input:{userId:string}){
 await requirePlatformAdmin(db,input.userId);const include={receipts:{select:{nodeId:true,publicationRevision:true,type:true,applyStatus:true,errorCode:true,lastSeenAt:true}}};
 const [sources,sourceControls,recentPublications,publishedHead,scanPlans]=await Promise.all([db.dataSource.findMany(),db.collectorSourceControl.findMany({orderBy:{sourceKey:'asc'}}),db.seedPublication.findMany({orderBy:{revision:'desc'},take:20,include}),db.seedPublication.findFirst({where:{status:'PUBLISHED'},orderBy:{revision:'desc'},include}),db.seedScanPlan.findMany({orderBy:{createdAt:'desc'}})]);
 const publications=publishedHead&&!recentPublications.some((publication:any)=>publication.id===publishedHead.id)?[...recentPublications,publishedHead].sort((a:any,b:any)=>b.revision-a.revision):recentPublications;
 return {capabilities:readNativeCapabilities(sources),sourceControls,publications,scanPlans};
}
