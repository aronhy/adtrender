import {createHash,randomUUID} from 'node:crypto';
import {seedCanonical,seedManifestContentHash,validateSeedManifest,type SeedConfigManifest} from '@ad-research/contracts/seeds';
import {DomainError} from '../team/access';import {idempotentSeedMutation} from './catalog';import {compileSeedPlan,type NativeCapability} from './planner';
const head=(tx:any)=>tx.seedPublication.findFirst({where:{status:'PUBLISHED'},orderBy:{revision:'desc'}});
async function lockHead(tx:any){await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended('seed-publication-head',0))");}
/** Imported legacy bindings may have a provisional epoch beyond the head.
 * Revisions are increasing identifiers, not an uninterrupted counter. */
export async function nextPublicationRevision(tx:any){
 const [publications,bindings]=await Promise.all([tx.seedPublication.aggregate({_max:{revision:true}}),tx.seedQueryBinding.aggregate({_max:{validFromRevision:true}})]);
 return Math.max(publications._max.revision??0,bindings._max.validFromRevision??0)+1;
}
export function readNativeCapabilities(sources:any[]):NativeCapability[]{
 return sources.flatMap(s=>s.capabilities?.seedDispatch?.verification==='VERIFIED'&&Array.isArray(s.capabilities.seedDispatch.profiles)?s.capabilities.seedDispatch.profiles.filter((p:any)=>p.sourceKey===s.key&&typeof p.version==='string'&&typeof p.adapterVersion==='string'&&Array.isArray(p.countries)&&Array.isArray(p.modes)):[]);
}
async function compileCatalog(tx:any){
 // Relations with compound keys make Prisma generate an OR branch per row.
 // Read bounded keyset pages separately and join them by their immutable IDs.
 async function readPages(model:any,options:any={},key='id'){
  const rows:any[]=[];let cursor:string|undefined;
  for(;;){const page=await model.findMany({...options,orderBy:options.orderBy??{[key]:'asc'},take:500,...(cursor?{cursor:{[key]:cursor},skip:1}:{})});rows.push(...page);if(page.length<500)return rows;cursor=page[page.length-1][key];}
 }
 const [seeds,plans,sources,mappings,existingQueries,legacyBindings,runtimes,intents]=await Promise.all([
  readPages(tx.seedDefinition),readPages(tx.seedScanPlan),readPages(tx.dataSource),readPages(tx.legacyJobMapping),readPages(tx.seedQuery),
  readPages(tx.seedQueryBinding,{where:{ownerKind:'LEGACY'}}),readPages(tx.seedRuntimeState,{},'queryId'),
  readPages(tx.auditEvent,{where:{action:'SEED_LEGACY_OWNER_STATUS_SET'},orderBy:[{createdAt:'desc'},{id:'desc'}]})
 ]);
 const queriesById=new Map<string,any>(existingQueries.map(q=>[q.id,q])),runtimeByQuery=new Map<string,any>(runtimes.map(r=>[r.queryId,r]));
 const ownersByQuery=new Map<string,Map<string,any>>();
 // Ascending epochs preserve the old reverse-then-Map owner ordering while
 // replacing each value with that owner's latest binding, including removals.
 for(const b of legacyBindings.sort((a,b)=>a.validFromRevision-b.validFromRevision||a.id.localeCompare(b.id))){let owners=ownersByQuery.get(b.queryId);if(!owners){owners=new Map();ownersByQuery.set(b.queryId,owners);}owners.set(b.legacyOwnerKey,b);}
 const intentsBySource=new Map<string,Map<unknown,any>>();
 // SQL orders exact timestamps and ID ties; retain the first matching fact.
 for(const event of intents){const result=event.metadata?.result;if(typeof result?.sourceKey!=='string')continue;let owners=intentsBySource.get(result.sourceKey);if(!owners){owners=new Map();intentsBySource.set(result.sourceKey,owners);}if(!owners.has(result.legacyOwnerKey))owners.set(result.legacyOwnerKey,result);}
 const legacy=mappings.flatMap((m:any)=>{
  const query=queriesById.get(m.queryId),owners=[...(ownersByQuery.get(m.queryId)?.values()??[])];
  return (owners.length?owners:[null]).map((b:any)=>{const intent=intentsBySource.get(m.sourceKey)?.get(b?.legacyOwnerKey);
   return {sourceKey:m.sourceKey,queryId:m.queryId,queryKey:query.queryKey,nativeJobId:m.nativeJobId,legacyOwnerKey:b?.legacyOwnerKey,legacyOwnerStatus:intent?.status??(b?.validToRevision?'REMOVED':b?.participationStatus),legacyOwnerRevision:intent?.ownerRevision??b?.ownerRevision,query:{queryId:m.queryId,queryKey:query.queryKey,queryKeyVersion:query.queryKeyVersion,sourceKey:m.sourceKey,channel:query.channel,mode:query.mode,params:query.normalizedParams,legacyDims:query.legacyDims,adapterVersion:query.adapterVersion,capabilityVersion:query.capabilityVersion,desiredEnabled:query.desiredEnabled,nativeJobIds:[m.nativeJobId]}};
  });
 });
 const previousPublication=await head(tx),previousManifest=previousPublication?.configSnapshot?.manifest??previousPublication?.configSnapshot;
 const legacyQueryIds=new Set(legacy.map(l=>l.queryId)),previousByQuery=new Map<string,any>();
 for(const q of previousManifest?.queries??[])if(!previousByQuery.has(q.queryId))previousByQuery.set(q.queryId,q);
 const references=existingQueries.filter(q=>!legacyQueryIds.has(q.id)).flatMap(q=>{const prior=previousByQuery.get(q.id),nativeJobId=runtimeByQuery.get(q.id)?.nativeJobId??prior?.nativeJobIds?.[0];return nativeJobId?[{sourceKey:q.sourceKey,queryId:q.id,queryKey:q.queryKey,nativeJobId,query:{queryId:q.id,queryKey:q.queryKey,queryKeyVersion:q.queryKeyVersion,sourceKey:q.sourceKey,channel:q.channel,mode:q.mode,params:q.normalizedParams,legacyDims:q.legacyDims,adapterVersion:q.adapterVersion,capabilityVersion:q.capabilityVersion,desiredEnabled:q.desiredEnabled,nativeJobIds:prior?.nativeJobIds??[nativeJobId]}}]:[];});
 const compilation=compileSeedPlan(seeds,plans,readNativeCapabilities(sources),[...legacy,...references]);
 const catalogDigest=createHash('sha256').update(seedCanonical({seeds:seeds.map((s:any)=>({id:s.id,revision:s.revision,status:s.status})),plans:plans.map((p:any)=>({id:p.id,revision:p.revision,status:p.status})),capabilities:readNativeCapabilities(sources),legacy:legacy.map((l:any)=>({queryId:l.queryId,nativeJobId:l.nativeJobId,legacyOwnerKey:l.legacyOwnerKey,legacyOwnerStatus:l.legacyOwnerStatus,legacyOwnerRevision:l.legacyOwnerRevision}))})).digest('hex');
 return {compilation,plans:plans.filter((p:any)=>!['DRAFT','ARCHIVED'].includes(p.status)).map((p:any)=>({id:p.id,revision:p.revision,sourceKey:p.sourceKey,targetScope:p.targetScope,datePolicy:p.datePolicy,category:p.category,status:p.status,evidence:p.evidence})),catalogDigest,sources};
}
interface PublicationInput {actorUserId:string;parentRevision:number;idempotencyKey:string;reason:string}
export async function previewPublication(db:any,input:PublicationInput){
 return idempotentSeedMutation(db,input,'SEED_PUBLICATION_PREVIEW',{parentRevision:input.parentRevision},async tx=>{
  await lockHead(tx);const latest=await head(tx);if((latest?.revision??0)!==input.parentRevision)throw new DomainError(409,'SEED_PUBLICATION_CONFLICT');
  const {compilation,plans,catalogDigest,sources}=await compileCatalog(tx);const revision=await nextPublicationRevision(tx);
  const ids=new Set(compilation.queries.map(q=>q.queryId));const previous=(latest?.configSnapshot?.manifest??latest?.configSnapshot) as SeedConfigManifest|undefined;
  const currentBindings=await tx.seedQueryBinding.findMany({where:{validToRevision:null}}),currentByBinding=new Map<string,any>();
  const bindingKey=(b:any)=>seedCanonical([ownerKey(b),b.ownerRevision,b.participationStatus,b.purposeSnapshot]);
  for(const b of currentBindings){const key=bindingKey(b);if(!currentByBinding.has(key))currentByBinding.set(key,b);}
  const bindings=compilation.bindings.map(b=>{const current=currentByBinding.get(bindingKey(b));return {...b,validFromRevision:current?.validFromRevision??revision};});
  const partial={schemaVersion:1 as const,protocolMin:1,protocolMax:1,publicationId:randomUUID(),revision,parentRevision:latest?.revision??null,compilerVersion:'seed-compiler-1',capabilityVersion:'native-capabilities-1',createdAt:new Date().toISOString(),queries:compilation.queries,bindings,scanPlans:plans,tombstones:(previous?.queries??[]).filter(q=>!ids.has(q.queryId)).map(q=>({queryId:q.queryId,reason:'NO_PUBLISHED_OWNER'})),schedulePolicyVersion:'compatibility-fair-1'};
  const manifest=validateSeedManifest({...partial,contentHash:seedManifestContentHash(partial)});
  // A preview is a temporary command artifact. Published rows are immutable facts.
  await tx.seedImportJob.create({data:{id:manifest.publicationId,actorUserId:input.actorUserId,fileHash:manifest.contentHash,status:'PUBLICATION_PREVIEW',previewRevision:input.parentRevision,rowResults:{manifest,catalogDigest,capabilityProfiles:readNativeCapabilities(sources),decisions:compilation.decisions,diff:compilation.diff},counts:{},idempotencyKey:`publication-preview:${input.actorUserId}:${input.idempotencyKey}`,expiresAt:new Date(Date.now()+86400000)}});
  return {targetId:manifest.publicationId,revision,publicationRevision:latest?.revision??0,message:'预览已生成，尚未发布。',diff:compilation.diff,decisions:compilation.decisions};
 });
}
function ownerKey(b:any){return seedCanonical([b.queryId,b.ownerKind,b.seedId,b.scanPlanId,b.legacyOwnerKey]);}
export async function activateManifest(tx:any,manifest:SeedConfigManifest,forceBindingEpoch=false){
 // Bound each SQL message, not the number of brands, owners, or queries.
 const pageSize=500,pageBytes=4*1024*1024;
 function* pages<T>(rows:Iterable<T>){let page:T[]=[],bytes=2;for(const row of rows){const size=Buffer.byteLength(JSON.stringify(row),'utf8')+1;if(size>pageBytes)throw new DomainError(413,'SEED_PUBLICATION_ROW_TOO_LARGE');if(page.length&&(page.length===pageSize||bytes+size>pageBytes)){yield page;page=[];bytes=2;}page.push(row);bytes+=size;}if(page.length)yield page;}
 const [sources,assignments,controls]=await Promise.all([tx.dataSource.findMany(),tx.collectorSourceAssignment.findMany({where:{state:'ACTIVE'}}),tx.collectorSourceControl.findMany()]);
 const sourceIds=new Map<string,string>(sources.map((s:any)=>[s.key,s.id])),controlByChannel=new Map<string,any>(),assignmentByChannel=new Map<string,any>();
 for(const c of controls){const key=c.sourceKey+':'+c.channel;if(!controlByChannel.has(key))controlByChannel.set(key,c);}
 for(const a of assignments){const key=a.sourceKey+':'+a.channel;if(!assignmentByChannel.has(key))assignmentByChannel.set(key,a);}
 // Check every page before writing; canonical comparisons retain the native
 // identity rules, including unordered countries, without one SELECT per row.
 for(const page of pages(manifest.queries)){
  const existing=await tx.seedQuery.findMany({where:{id:{in:page.map(q=>q.queryId)}},select:{id:true,normalizedParams:true}}),byId=new Map<string,any>(existing.map((q:any)=>[q.id,q.normalizedParams]));
  for(const q of page){if(!sourceIds.has(q.sourceKey))throw new DomainError(409,'SEED_SOURCE_MISSING');if(byId.has(q.queryId)&&seedCanonical(byId.get(q.queryId))!==seedCanonical(q.params))throw new DomainError(409,'SEED_QUERY_IDENTITY_CONFLICT');}
 }
 function* queryRows(){for(const q of manifest.queries){const control=controlByChannel.get(q.sourceKey+':'+q.channel)??controlByChannel.get(q.sourceKey+':*'),assignment=assignmentByChannel.get(q.sourceKey+':'+q.channel)??assignmentByChannel.get(q.sourceKey+':*');yield {id:q.queryId,dataSourceId:sourceIds.get(q.sourceKey),sourceKey:q.sourceKey,channel:q.channel,mode:q.mode,queryCountry:String(q.params.country??''),queryLanguage:String(q.params.language??'und'),normalizedParams:q.params,queryKey:q.queryKey,queryKeyVersion:q.queryKeyVersion,adapterVersion:q.adapterVersion,capabilityVersion:q.capabilityVersion,legacyDims:q.legacyDims,status:q.desiredEnabled?'READY':'DORMANT',desiredEnabled:q.desiredEnabled,controlMode:assignment?.controlMode??control?.controlMode??'LEGACY_QUEUE',assignmentGeneration:assignment?.generation??control?.assignmentGeneration??0,nativeJobId:q.nativeJobIds[0]??null,collectorId:assignment?.nodeId??null};}}
 for(const page of pages(queryRows())){
  const raw=JSON.stringify(page);
  await tx.$executeRawUnsafe(`INSERT INTO "SeedQuery" ("id","updatedAt","dataSourceId","sourceKey","channel","mode","queryCountry","queryLanguage","normalizedParams","queryKey","queryKeyVersion","adapterVersion","capabilityVersion","legacyDims","status","desiredEnabled","controlMode","assignmentGeneration")
   SELECT q."id",CURRENT_TIMESTAMP,q."dataSourceId",q."sourceKey",q."channel",q."mode",q."queryCountry",q."queryLanguage",q."normalizedParams",q."queryKey",q."queryKeyVersion",q."adapterVersion",q."capabilityVersion",q."legacyDims",q."status",q."desiredEnabled",q."controlMode",q."assignmentGeneration"
   FROM jsonb_to_recordset($1::jsonb) AS q("id" text,"dataSourceId" text,"sourceKey" text,"channel" text,"mode" text,"queryCountry" text,"queryLanguage" text,"normalizedParams" jsonb,"queryKey" text,"queryKeyVersion" text,"adapterVersion" text,"capabilityVersion" text,"legacyDims" jsonb,"status" text,"desiredEnabled" boolean,"controlMode" text,"assignmentGeneration" integer)
   ON CONFLICT ("id") DO UPDATE SET "updatedAt"=CURRENT_TIMESTAMP,"desiredEnabled"=EXCLUDED."desiredEnabled","status"=EXCLUDED."status","adapterVersion"=EXCLUDED."adapterVersion","capabilityVersion"=EXCLUDED."capabilityVersion"`,raw);
  // Existing progress, native IDs, ownership, and assignment generations are
  // untouched. Defaults initialize only genuinely new runtime rows.
  await tx.$executeRawUnsafe(`INSERT INTO "SeedRuntimeState" ("queryId","updatedAt","dataSourceId","sourceKey","nativeJobId","desiredRevision","assignmentGeneration","collectorId")
   SELECT q."id",CURRENT_TIMESTAMP,q."dataSourceId",q."sourceKey",q."nativeJobId",$2,q."assignmentGeneration",q."collectorId"
   FROM jsonb_to_recordset($1::jsonb) AS q("id" text,"dataSourceId" text,"sourceKey" text,"nativeJobId" text,"assignmentGeneration" integer,"collectorId" text)
   ON CONFLICT ("queryId") DO UPDATE SET "updatedAt"=CURRENT_TIMESTAMP,"desiredRevision"=EXCLUDED."desiredRevision"`,raw,manifest.revision);
  const enabled=page.filter(q=>q.desiredEnabled).map(q=>q.id);
  if(enabled.length){
   await tx.seedExecutionTask.updateMany({where:{queryId:{in:enabled},state:'READY'},data:{publicationRevision:manifest.revision,schedulePolicyVersion:manifest.schedulePolicyVersion}});
   // Starting and cancellation race on the attempt row. The predicate is
   // rechecked after locking; a started unit keeps its frozen owners and lease.
   await tx.$executeRawUnsafe(`WITH stale AS (
    UPDATE "SeedTaskAttempt" a SET "state"='CANCELED',"stopReason"='CONFIG_SUPERSEDED_BEFORE_START'
    FROM "SeedExecutionTask" t WHERE a."taskId"=t."id" AND t."queryId"=ANY($1::text[]) AND t."state"='LEASED'
     AND a."state"='LEASED' AND a."startedAt" IS NULL AND a."publicationRevision"<$2 RETURNING a."taskId"
   ), released AS (
    UPDATE "SeedExecutionTask" t SET "state"='READY',"updatedAt"=CURRENT_TIMESTAMP,"publicationRevision"=$2,"schedulePolicyVersion"=$3
    FROM stale WHERE t."id"=stale."taskId" AND t."state"='LEASED' RETURNING t."queryId"
   ) UPDATE "SeedRuntimeState" r SET "executionState"='IDLE',"updatedAt"=CURRENT_TIMESTAMP
    FROM released WHERE r."queryId"=released."queryId" AND r."executionState"='LEASED'`,enabled,manifest.revision,manifest.schedulePolicyVersion);
  }
 }
 const incoming=new Map(manifest.bindings.map(b=>[ownerKey(b),b]));let cursor:string|undefined;
 for(;;){
  const open=await tx.seedQueryBinding.findMany({where:{validToRevision:null,...(cursor?{id:{gt:cursor}}:{})},orderBy:{id:'asc'},take:pageSize});if(!open.length)break;
  const close:string[]=[];for(const b of open){const next=incoming.get(ownerKey(b));if(!forceBindingEpoch&&next&&next.ownerRevision===b.ownerRevision&&next.participationStatus===b.participationStatus&&seedCanonical(next.purposeSnapshot)===seedCanonical(b.purposeSnapshot))incoming.delete(ownerKey(b));else close.push(b.id);}
  if(close.length)await tx.seedQueryBinding.updateMany({where:{id:{in:close},validToRevision:null},data:{validToRevision:manifest.revision}});
  cursor=open[open.length-1].id;if(open.length<pageSize)break;
 }
 for(const page of pages(incoming.values()))await tx.seedQueryBinding.createMany({data:page.map(b=>({...b,validFromRevision:manifest.revision,validToRevision:null}))});
 const disabled=new Set([...manifest.queries.filter(q=>!q.desiredEnabled).map(q=>q.queryId),...manifest.tombstones.map(t=>t.queryId)]);
 for(const page of pages(disabled)){
  await tx.seedQuery.updateMany({where:{id:{in:page}},data:{desiredEnabled:false,status:'DORMANT'}});
  await tx.seedExecutionTask.updateMany({where:{queryId:{in:page},state:'READY'},data:{state:'CANCELED',cancelReason:'NO_PUBLISHED_OWNER'}});
  await tx.seedExecutionTask.updateMany({where:{queryId:{in:page},state:{in:['LEASED','RUNNING']}},data:{state:'STOP_REQUESTED',cancelReason:'NO_PUBLISHED_OWNER'}});
  await tx.seedTaskAttempt.updateMany({where:{task:{queryId:{in:page}},state:{in:['LEASED','RUNNING']}},data:{state:'STOP_REQUESTED',stopReason:'NO_PUBLISHED_OWNER'}});
  await tx.seedRuntimeState.updateMany({where:{queryId:{in:page},executionState:{in:['LEASED','RUNNING']}},data:{executionState:'STOP_REQUESTED'}});
 }
}
export async function publishSeedConfig(db:any,input:PublicationInput&{previewId:string}){
 return idempotentSeedMutation(db,input,'SEED_CONFIG_PUBLISHED',{parentRevision:input.parentRevision,previewId:input.previewId},async tx=>{
  await lockHead(tx);const latest=await head(tx),pre=await tx.seedImportJob.findUnique({where:{id:input.previewId}});
  if(!pre||pre.actorUserId!==input.actorUserId||pre.status!=='PUBLICATION_PREVIEW'||pre.expiresAt<=new Date()||(latest?.revision??0)!==input.parentRevision||pre.previewRevision!==input.parentRevision)throw new DomainError(409,'SEED_PUBLICATION_CONFLICT');
  const snapshot=pre.rowResults;const catalog=await compileCatalog(tx);if(snapshot.catalogDigest!==catalog.catalogDigest)throw new DomainError(409,'SEED_PREVIEW_STALE');
  const manifest=validateSeedManifest(snapshot.manifest);await activateManifest(tx,manifest);
  await tx.seedPublication.create({data:{id:manifest.publicationId,revision:manifest.revision,parentRevision:manifest.parentRevision,manifestHash:manifest.contentHash,configSnapshot:snapshot,status:'PUBLISHED',reason:input.reason,createdByUserId:input.actorUserId}});
  await tx.seedImportJob.update({where:{id:pre.id},data:{status:'PUBLISHED'}});
  return {targetId:pre.id,revision:manifest.revision,publicationRevision:manifest.revision,message:'配置已发布；下载、应用与执行状态等待各节点回执。'};
 });
}
export async function rollbackSeedConfig(db:any,input:PublicationInput&{targetId:string}){
 return idempotentSeedMutation(db,input,'SEED_CONFIG_ROLLBACK',{parentRevision:input.parentRevision,targetId:input.targetId},async tx=>{
  await lockHead(tx);const latest=await head(tx),previous=await tx.seedPublication.findUnique({where:{id:input.targetId}});if(!previous||previous.status!=='PUBLISHED'||(latest?.revision??0)!==input.parentRevision)throw new DomainError(409,'SEED_PUBLICATION_CONFLICT');
  const revision=await nextPublicationRevision(tx),old=previous.configSnapshot.manifest??previous.configSnapshot;
  const restoredIds=new Set<string>(old.queries.map((q:any)=>q.queryId)),current=latest.configSnapshot.manifest??latest.configSnapshot;
  const tombstones=[...new Map([...old.tombstones,...current.queries.filter((q:any)=>!restoredIds.has(q.queryId)).map((q:any)=>({queryId:q.queryId,reason:'ROLLBACK_REMOVED_OWNER'}))].map((t:any)=>[t.queryId,t])).values()];
  const body={...old,publicationId:randomUUID(),revision,parentRevision:latest.revision,createdAt:new Date().toISOString(),tombstones,bindings:old.bindings.map((b:any)=>({...b,validFromRevision:revision,validToRevision:null}))};const manifest=validateSeedManifest({...body,contentHash:seedManifestContentHash(body)});
  await activateManifest(tx,manifest,true);await tx.seedPublication.create({data:{id:manifest.publicationId,revision,parentRevision:latest.revision,manifestHash:manifest.contentHash,configSnapshot:{manifest,capabilityProfiles:previous.configSnapshot.capabilityProfiles??null,restoresPublicationId:previous.id},status:'PUBLISHED',reason:input.reason,createdByUserId:input.actorUserId}});
  return {targetId:manifest.publicationId,revision,publicationRevision:revision,message:'已用更高版本恢复配置内容，运行断点与冷却保留。'};
 });
}
export function scopeManifest(manifest:SeedConfigManifest,sourceScopes:string[],querySources:ReadonlyMap<string,string>=new Map()):SeedConfigManifest{
 const queries=manifest.queries.filter(q=>sourceScopes.includes(q.sourceKey)),ids=new Set(queries.map(q=>q.queryId));const body={...manifest,queries,bindings:manifest.bindings.filter(b=>ids.has(b.queryId)),scanPlans:manifest.scanPlans.filter(p=>sourceScopes.includes(p.sourceKey)),tombstones:manifest.tombstones.filter(t=>ids.has(t.queryId)||sourceScopes.includes(querySources.get(t.queryId)??''))};return {...body,contentHash:seedManifestContentHash(body)};
}
export async function acceptConfigReceipt(db:any,input:{trustedNodeId:string;sourceScopes:string[];receipt:any}){
 const r=input.receipt;if(r.nodeId!==input.trustedNodeId||!Number.isSafeInteger(r.sequence)||r.sequence<1||!['DOWNLOADED','VALIDATED','APPLIED','REJECTED','NO_NEW_SOURCE_REQUESTS','DRAINED'].includes(r.applyStatus))throw new DomainError(400,'SEED_RECEIPT_INVALID');
 return db.$transaction(async(tx:any)=>{
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','seed-receipt:'+r.nodeId);
  // Serialize the incarnation check with registry changes and execution claims.
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','seed-dispatch:node:'+r.nodeId);
  const node=await tx.collectorNode.findUnique({where:{nodeId:r.nodeId}});if(!node||node.incarnationId!==r.incarnationId)throw new DomainError(409,'SEED_RECEIPT_STALE');
  const publication=await tx.seedPublication.findUnique({where:{id:r.publicationId}});if(!publication||publication.status!=='PUBLISHED'||publication.revision!==r.publicationRevision)throw new DomainError(409,'SEED_RECEIPT_PUBLICATION');
  const full=publication.configSnapshot.manifest??publication.configSnapshot,querySources=new Map<string,string>((await tx.seedQuery.findMany({where:{id:{in:full.tombstones.map((t:any)=>t.queryId)}},select:{id:true,sourceKey:true}})).map((q:any)=>[q.id,q.sourceKey]));
  const scoped=scopeManifest(full,input.sourceScopes,querySources);if(r.manifestHash!==scoped.contentHash)throw new DomainError(409,'SEED_RECEIPT_HASH');
  const payloadHash=createHash('sha256').update(seedCanonical(r)).digest('hex'),key={nodeId_incarnationId_sequence:{nodeId:r.nodeId,incarnationId:r.incarnationId,sequence:r.sequence}},prior=await tx.seedCollectorReceipt.findUnique({where:key});
  if(prior){if(prior.payloadHash!==payloadHash)throw new DomainError(409,'SEED_RECEIPT_CONFLICT');return {receiptId:prior.id,status:prior.applyStatus};}
  // Different source containers may deliver allocated sequence numbers out of order.
  // Append the original fact; monotonic materializations below prevent downgrade.
  if(r.applyStatus==='APPLIED'){
   if(!Array.isArray(r.nativeJobMappings))throw new DomainError(409,'SEED_RECEIPT_MAPPING');
   const nativeByQuery=new Map<string,Set<string>>();
   for(const mapping of r.nativeJobMappings){
    if(!mapping||typeof mapping.queryId!=='string'||typeof mapping.nativeJobId!=='string')throw new DomainError(409,'SEED_RECEIPT_MAPPING');
    let nativeIds=nativeByQuery.get(mapping.queryId);if(!nativeIds){nativeIds=new Set();nativeByQuery.set(mapping.queryId,nativeIds);}nativeIds.add(mapping.nativeJobId);
   }
   if(scoped.queries.some(q=>!q.nativeJobIds.some(id=>nativeByQuery.get(q.queryId)?.has(id))))throw new DomainError(409,'SEED_RECEIPT_MAPPING');
   // Standby downloads/applications never transfer execution ownership.
   // Bound SQL messages, preserving one atomic receipt without a total-query cap.
   const maxIds=500,maxBytes=4*1024*1024,reportedAt=new Date();let ids:string[]=[],bytes=2;
   const applyPage=async()=>{await tx.seedRuntimeState.updateMany({where:{queryId:{in:ids},sourceKey:{in:input.sourceScopes},collectorId:r.nodeId,appliedRevision:{lte:r.publicationRevision}},data:{appliedRevision:r.publicationRevision,lastReportedAt:reportedAt}});ids=[];bytes=2;};
   for(const q of scoped.queries){const size=Buffer.byteLength(JSON.stringify(q.queryId),'utf8')+1;if(size>maxBytes)throw new DomainError(413,'SEED_RECEIPT_QUERY_TOO_LARGE');if(ids.length&&(ids.length===maxIds||bytes+size>maxBytes))await applyPage();ids.push(q.queryId);bytes+=size;}
   if(ids.length)await applyPage();
  }
  const saved=await tx.seedCollectorReceipt.create({data:{publicationId:r.publicationId,publicationRevision:r.publicationRevision,manifestHash:r.manifestHash,nodeId:r.nodeId,incarnationId:r.incarnationId,sequence:r.sequence,type:r.applyStatus,payloadHash,payload:r,applyStatus:['DOWNLOADED','VALIDATED','APPLIED','REJECTED'].includes(r.applyStatus)?r.applyStatus:null,queryCounts:{queryIds:scoped.queries.map(q=>q.queryId),sourceScopes:input.sourceScopes},nativeJobMappings:r.nativeJobMappings??[],appliedAt:r.applyStatus==='APPLIED'?new Date():null,errorCode:r.errorCode??null}});return {receiptId:saved.id,status:saved.applyStatus??saved.type};
 });
}
