import {createHash,randomUUID} from 'node:crypto';
import {DomainError,requirePlatformAdmin} from '../team/access';
import {seedCanonical,type SourceKey} from '@ad-research/contracts/seeds';
import {legacyQueryIdentity} from './legacy-query-key';
import {uuidForQuery} from './planner';
import {idempotentSeedMutation} from './catalog';
import {canonicalNativeParams} from '@ad-research/contracts/seed-native-query';
/** Resolve registry IDs before the server archives the exact checkpoint bytes. */
export async function prepareLegacyInventory(db:any,input:{actorUserId:string;sourceKey:SourceKey;state:any;nodeId:string;jobIds?:string[]}){
 await requirePlatformAdmin(db,input.actorUserId);
 const inventory=inventoryLegacyState(input.sourceKey,input.state),jobs:Array<ReturnType<typeof inventoryLegacyState>['jobs'][number]>=[];
 for(const job of selectedJobs(inventory,input.jobIds))jobs.push(await resolveLegacyQuery(db,input.sourceKey,job));
 return {...inventory,jobs,checkpoints:jobs.map(job=>({nativeJobId:job.nativeJobId,queryId:job.queryId,...buildLegacyCheckpoint(input.sourceKey,input.state,job,input.nodeId)}))};
}
const sha=(raw:string)=>createHash('sha256').update(raw).digest('hex');
type LegacyInventory=ReturnType<typeof inventoryLegacyState>;
type SnapshotBase={actorUserId:string;idempotencyKey:string;reason:string;sourceKey:SourceKey;state:any;nodeId:string;adapterVersion:string};
type EvidenceRef={reference:string;sha256:string};
function requireLegacyStateVersion(inventory:LegacyInventory){const version=Number(inventory.stateSchemaVersion);if(!Number.isSafeInteger(version)||version<1)throw new DomainError(409,'LEGACY_STATE_VERSION_UNKNOWN');}
function selectedJobs(inventory:LegacyInventory,jobIds?:string[]){
 if(jobIds===undefined)return inventory.jobs;
 if(!Array.isArray(jobIds)||!jobIds.length||jobIds.length>500||new Set(jobIds).size!==jobIds.length)throw new DomainError(400,'LEGACY_PAGE_INVALID');
 const ids=new Set(jobIds),jobs=inventory.jobs.filter(j=>ids.has(j.nativeJobId));if(jobs.length!==ids.size)throw new DomainError(400,'LEGACY_PAGE_INVALID');return jobs;
}
/** Auxiliary work remains in the original native file and is not an execution query. */
export function legacyUnmappedEvidence(sourceKey:SourceKey,state:any){
 const inventory=inventoryLegacyState(sourceKey,state),jobs=new Map(state.jobs.map((j:any)=>[j.id,j]));
 return {schemaVersion:1,sourceKey,stateDigest:inventory.stateDigest,jobs:inventory.unmappedJobs.map(j=>({...j,classification:j.reason==='LEGACY_MEDIA_REFRESH_REQUIRES_MAPPING'?'AUXILIARY_UNMANAGED':'UNREVIEWED',job:jobs.get(j.nativeJobId)}))};
}
async function snapshotRecord(tx:any,input:{snapshotId:string;sourceKey:SourceKey;state:any;nodeId:string;adapterVersion:string}){
 const row=await tx.auditEvent.findFirst({where:{action:'SEED_LEGACY_IMPORT_STARTED',targetId:input.snapshotId}}),snapshot=row?.metadata?.result;
 if(!snapshot||snapshot.sourceKey!==input.sourceKey||snapshot.nodeId!==input.nodeId||snapshot.adapterVersion!==input.adapterVersion||snapshot.stateDigest!==inventoryLegacyState(input.sourceKey,input.state).stateDigest)throw new DomainError(409,'LEGACY_SNAPSHOT_CONFLICT');
 if(snapshot.incarnationId){const node=await tx.collectorNode.findUnique({where:{nodeId:input.nodeId}});if(node?.incarnationId!==snapshot.incarnationId)throw new DomainError(409,'LEGACY_SNAPSHOT_INCARNATION_CONFLICT');}
 return snapshot;
}
/** Freeze once; every subsequent page names this same full-state evidence and epoch. */
export async function beginLegacyInventorySnapshot(db:any,input:SnapshotBase&{stateRaw:string;stateEvidence:EvidenceRef;unmappedRaw:string;unmappedEvidence:EvidenceRef;allowPreservedUnmapped?:boolean;pendingRawSha?:string}){
 const inventory=inventoryLegacyState(input.sourceKey,input.state),unmapped=legacyUnmappedEvidence(input.sourceKey,input.state);
 requireLegacyStateVersion(inventory);
 if(inventory.unmappedJobs.length&&(!input.allowPreservedUnmapped||unmapped.jobs.some(j=>j.classification!=='AUXILIARY_UNMANAGED')))throw new DomainError(409,'LEGACY_UNMAPPED_JOBS_REQUIRE_REVIEW');
 let parsed:any,aux:any;try{parsed=JSON.parse(input.stateRaw);aux=JSON.parse(input.unmappedRaw);}catch{throw new DomainError(400,'LEGACY_SNAPSHOT_BYTES_INVALID');}
 if(seedCanonical(parsed)!==seedCanonical(input.state)||seedCanonical(aux)!==seedCanonical(unmapped)||!input.stateEvidence.reference||input.stateEvidence.sha256!==sha(input.stateRaw)||!input.unmappedEvidence.reference||input.unmappedEvidence.sha256!==sha(input.unmappedRaw))throw new DomainError(409,'LEGACY_SNAPSHOT_EVIDENCE_REQUIRED');
 if(new Set(input.state.jobs.map((j:any)=>j.id)).size!==input.state.jobs.length)throw new DomainError(409,'LEGACY_DUPLICATE_JOB_ID');
 const payload={sourceKey:input.sourceKey,nodeId:input.nodeId,adapterVersion:input.adapterVersion,stateDigest:inventory.stateDigest,stateEvidence:input.stateEvidence,unmappedEvidence:input.unmappedEvidence,allowPreservedUnmapped:input.allowPreservedUnmapped===true,pendingRawSha:input.pendingRawSha??null};
 return idempotentSeedMutation(db,input,'SEED_LEGACY_IMPORT_STARTED',payload,async tx=>{
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','seed-dispatch:source:'+input.sourceKey);
  const source=await tx.dataSource.findUnique({where:{key:input.sourceKey}});if(!source)throw new DomainError(409,'SEED_SOURCE_MISSING');
  if(await tx.collectorSourceAssignment.count({where:{sourceKey:input.sourceKey,state:{in:['ACTIVE','DRAINING']}}}))throw new DomainError(409,'SOURCE_ALREADY_ASSIGNED');
  const node=await tx.collectorNode.findUnique({where:{nodeId:input.nodeId}});
  let pendingRegistrationId:string|null=null;
  if(input.state.pending){const pending=input.pendingRawSha&&await tx.auditEvent.findFirst({where:{action:'SEED_LEGACY_PENDING_REGISTERED',targetId:input.pendingRawSha},orderBy:{createdAt:'desc'}});if(!pending||pending.metadata?.sourceKey!==input.sourceKey||pending.metadata?.nodeId!==input.nodeId||(node&&pending.metadata?.incarnationId!==node.incarnationId))throw new DomainError(409,'LEGACY_PENDING_REGISTRATION_REQUIRED');pendingRegistrationId=pending.id;}
  // Empty and auxiliary-only inventories have no import pages. Preserve their
  // controls atomically with START, before any later COMPLETE can permit takeover.
  await mergeLegacyControls(tx,source,inventory);
  const publication=await tx.seedPublication.findFirst({orderBy:{revision:'desc'}});
  return {targetId:randomUUID(),revision:(publication?.revision??0)+1,...payload,incarnationId:node?.incarnationId??null,rawSha:input.stateEvidence.sha256,rawRef:input.stateEvidence.reference,unmappedSha:input.unmappedEvidence.sha256,unmappedRef:input.unmappedEvidence.reference,mapped:inventory.jobs.length,unmapped:inventory.unmappedJobs.length,mappedJobIds:inventory.jobs.map(j=>j.nativeJobId),pendingRegistrationId,status:'STARTED'};
 });
}
export async function completeLegacyInventorySnapshot(db:any,input:SnapshotBase&{snapshotId:string}){
 const inventory=inventoryLegacyState(input.sourceKey,input.state);
 return idempotentSeedMutation(db,input,'SEED_LEGACY_IMPORT_COMPLETED',{snapshotId:input.snapshotId,sourceKey:input.sourceKey,nodeId:input.nodeId,adapterVersion:input.adapterVersion,stateDigest:inventory.stateDigest},async tx=>{
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','seed-dispatch:source:'+input.sourceKey);const snapshot=await snapshotRecord(tx,input);
  for(let offset=0;offset<inventory.jobs.length;offset+=500){const page=inventory.jobs.slice(offset,offset+500),mappings=await tx.legacyJobMapping.findMany({where:{sourceKey:input.sourceKey,nativeJobId:{in:page.map(j=>j.nativeJobId)}}}),byId=new Map(mappings.map((m:any)=>[m.nativeJobId,m]));for(const job of page)if((byId.get(job.nativeJobId) as any)?.initialCheckpointDigest!==job.checkpointDigest)throw new DomainError(409,'LEGACY_INVENTORY_INCOMPLETE');}
  return {targetId:input.snapshotId,revision:snapshot.revision,sourceKey:input.sourceKey,nodeId:input.nodeId,stateDigest:inventory.stateDigest,rawSha:snapshot.rawSha,rawRef:snapshot.rawRef,unmappedSha:snapshot.unmappedSha,unmappedRef:snapshot.unmappedRef,pendingRegistrationId:snapshot.pendingRegistrationId,mapped:inventory.jobs.length,unmapped:inventory.unmappedJobs.length,status:'COMPLETE'};
 });
}
async function mergeHistoryControl(tx:any,source:any,inventory:LegacyInventory){
 const exists=await tx.$queryRawUnsafe("SELECT to_regclass('history_collector.source_control') IS NOT NULL AS present");let history:any;
 if(exists[0]?.present){const rows=await tx.$queryRawUnsafe('SELECT to_jsonb(c) AS value FROM history_collector.source_control c WHERE source_key=$1',inventory.sourceKey);history=rows[0]?.value;}
 let historyTime=history?.not_before?Date.parse(history.not_before):0;
 if(!Number.isFinite(historyTime))throw new DomainError(409,'LEGACY_HISTORY_CONTROL_INVALID');
 // Native history uses timestamptz microseconds, while central controls use
 // timestamp(3). Round up rather than discarding the remaining cooldown.
 const fraction=typeof history?.not_before==='string'?/\.(\d+)(?:Z|[+-]\d{2}(?::?\d{2})?)$/.exec(history.not_before)?.[1]:undefined;
 if(fraction&&fraction.length>3&&/[1-9]/.test(fraction.slice(3)))historyTime++;
 const historyReason=typeof history?.reason==='string'?history.reason:null;
 const manual=history?.manual_pause===true||history?.manualPause===true;
 const native=inventory.sourceWideControl,nativeReason=native.manualPause?native.reason:null;
 const key={sourceKey_channel_scopeKey:{sourceKey:inventory.sourceKey,channel:'*',scopeKey:'SOURCE'}},current=await tx.collectorSourceControl.findUnique({where:key});
 const notBefore=new Date(Math.max(current?.notBefore.valueOf()??0,historyTime,native.notBefore)),restrictionCount=Math.max(current?.restrictionCount??0,Number.isFinite(history?.restrictions)?history.restrictions:0,native.restrictionCount),manualPause=current?.manualPause||manual||native.manualPause,reason=nativeReason??(manual?historyReason:null)??current?.reason??historyReason??native.reason??null;
 await tx.collectorSourceControl.upsert({where:key,create:{dataSourceId:source.id,sourceKey:inventory.sourceKey,channel:'*',scopeKey:'SOURCE',notBefore,restrictionCount,manualPause,reason,controlMode:'LEGACY_QUEUE'},update:{notBefore,restrictionCount,manualPause,reason,controlVersion:{increment:1}}});
}
async function mergeLegacyControls(tx:any,source:any,inventory:LegacyInventory){
 await mergeHistoryControl(tx,source,inventory);
 for(const c of inventory.sourceControls){
  const key={sourceKey_channel_scopeKey:{sourceKey:inventory.sourceKey,channel:c.channel,scopeKey:'SOURCE'}},current=await tx.collectorSourceControl.findUnique({where:key});
  await tx.collectorSourceControl.upsert({where:key,create:{dataSourceId:source.id,sourceKey:inventory.sourceKey,channel:c.channel,scopeKey:'SOURCE',notBefore:new Date(c.notBefore),restrictionCount:c.restrictionCount,manualPause:c.manualPause,reason:c.reason,controlMode:'LEGACY_QUEUE'},update:{notBefore:new Date(Math.max(current?.notBefore.valueOf()??0,c.notBefore)),restrictionCount:Math.max(current?.restrictionCount??0,c.restrictionCount),manualPause:current?.manualPause||c.manualPause,controlVersion:{increment:1},...(c.reason?{reason:c.reason}:{})}});
 }
}
async function resolveLegacyQuery(db:any,sourceKey:SourceKey,job:ReturnType<typeof inventoryLegacyState>['jobs'][number]){
 const existing=await db.seedQuery.findUnique({where:{sourceKey_channel_queryKey:{sourceKey,channel:job.channel,queryKey:job.queryKey}}});
 if(existing){
  const stored=canonicalNativeParams(sourceKey,existing.mode,{...existing.normalizedParams,channel:existing.channel});
  const incoming=canonicalNativeParams(sourceKey,job.mode,{...job.params,channel:job.channel});
  if(seedCanonical(stored)!==seedCanonical(incoming))throw new DomainError(409,'LEGACY_QUERY_IDENTITY_CONFLICT');
 }
 return {...job,queryId:existing?.id??job.queryId};
}
export function buildLegacyCheckpoint(sourceKey:SourceKey,state:any,job:any,nodeId:string){
 const nativeParams=canonicalNativeParams(sourceKey,job.mode,{...job.params,channel:job.channel});
 const sourceState=Object.fromEntries(Object.entries(state).filter(([key])=>!['jobs','pending','seedConfig','nativeCheckpoints'].includes(key)));
 const appliedBatchHashes=Object.keys(state.appliedBatches??{}).filter(h=>/^[a-f0-9]{64}$/.test(h)).sort();
 const raw=JSON.stringify({schemaVersion:1,sourceKey,queryId:job.queryId,nativeJobId:job.nativeJobId,nativeParams,job:job.checkpoint,sourceState,appliedBatchHashes,legacyStateVersion:String(state.schemaVersion??state.schema??state.version??'unknown')});
 return {raw,sha256:createHash('sha256').update(raw).digest('hex'),stateSchemaVersion:1,appliedBatchHashes,sessionAffinity:['meta_ad_library','google_ads_transparency'].includes(sourceKey)?'node:'+nodeId:null};
}
export function inventoryLegacyState(sourceKey:SourceKey,state:any){
 if(!state||typeof state!=='object'||!Array.isArray(state.jobs))throw new DomainError(400,'LEGACY_STATE_INVALID');
 const jobs:Array<{nativeJobId:string;queryKey:string;queryId:string;channel:string;mode:string;params:any;checkpoint:any;checkpointDigest:string;seenCount:number;nextAllowedAt:number;lastAttemptAt:number}>=[],unmappedJobs:Array<{nativeJobId:string;reason:string}>=[];
 const time=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0;
 for(const j of state.jobs){
  if(!j||typeof j.id!=='string'||!j.id)throw new DomainError(400,'LEGACY_JOB_INVALID');
  if(j.kind==='MEDIA_REFRESH'){unmappedJobs.push({nativeJobId:j.id,reason:'LEGACY_MEDIA_REFRESH_REQUIRES_MAPPING'});continue;}
  const params=sourceKey==='meta_ad_library'?{country:j.country,language:j.language??'und',keyword:j.keyword??'',...(j.pageId?{pageId:j.pageId}:{}),status:'all',mediaType:'all'}:sourceKey==='google_ads_transparency'?{kind:j.kind,country:j.country,language:j.language??'und',term:j.term??'',...(j.advertiserId?{advertiserId:j.advertiserId}:{}),...(j.domain?{domain:j.domain}:{})}:sourceKey==='snapchat_ads_gallery'?{country:j.country,publisher:j.publisher}:sourceKey==='tiktok_commercial_library'?{country:j.country,startDate:j.start,endDate:j.end}:{country:j.country,dateStart:j.start,dateEnd:j.end,keyword:'',category:'ALL'};
  const identity=legacyQueryIdentity(sourceKey,params);if(identity.quality==='UNATTRIBUTED'){unmappedJobs.push({nativeJobId:j.id,reason:'LEGACY_QUERY_UNATTRIBUTED'});continue;}
  const checkpoint=JSON.parse(JSON.stringify(j)),checkpointDigest=createHash('sha256').update(seedCanonical(checkpoint)).digest('hex');
  const mode=sourceKey==='meta_ad_library'?(j.pageId?'NATIVE_ADVERTISER':'KEYWORD'):sourceKey==='google_ads_transparency'?j.kind:sourceKey==='snapchat_ads_gallery'?'NAME':'SWEEP';
  jobs.push({nativeJobId:j.id,queryKey:identity.key,queryId:uuidForQuery(identity.key),channel:identity.channel,mode,params,checkpoint,checkpointDigest,seenCount:Array.isArray(j.seen)?j.seen.length:0,nextAllowedAt:Math.max(time(j.dueAt),time(j.retryAt)),lastAttemptAt:time(j.lastAttemptAt)});
 }
 const channels=sourceKey==='google_ads_transparency'?['ATC','SERP']:[sourceKey==='meta_ad_library'?'META':sourceKey==='snapchat_ads_gallery'?'PUBLISHER':'SWEEP'];
 const manualPauseObject=state.manualPause&&typeof state.manualPause==='object'&&!Array.isArray(state.manualPause)?state.manualPause:null;
 const manualReason=typeof manualPauseObject?.reason==='string'&&manualPauseObject.reason.trim()?manualPauseObject.reason:null;
 const sourceWideControl={notBefore:Math.max(time(state.pauseUntil),time(state.nextBatchAt)),restrictionCount:Math.max(time(state.restrictions),time(state.restrictionCount)),manualPause:state.manualPause===true||manualPauseObject!==null||state.manualIntervention===true,reason:manualReason??state.pauseReason??null};
 const sourceControls=channels.map(channel=>({channel,notBefore:Math.max(sourceWideControl.notBefore,time(state.pauses?.[channel])),restrictionCount:Math.max(sourceWideControl.restrictionCount,time(state.restrictions?.[channel])),manualPause:sourceWideControl.manualPause,reason:manualReason??state.pauseReasons?.[channel]??state.pauseReason??null}));
 return {sourceKey,stateDigest:createHash('sha256').update(seedCanonical(state)).digest('hex'),stateSchemaVersion:String(state.schemaVersion??state.schema??state.version??'legacy-unknown'),jobs,unmappedJobs,sourceControls,sourceWideControl};
}
/** Mirrors an inventoried old queue. It does not grant any new source request. */
export async function importLegacyInventory(db:any,input:SnapshotBase&{checkpointRefs:Record<string,EvidenceRef>;snapshotId?:string;jobIds?:string[]}){
 const inventory=inventoryLegacyState(input.sourceKey,input.state);
 requireLegacyStateVersion(inventory);
 const jobs=selectedJobs(inventory,input.jobIds);if(input.jobIds&&!input.snapshotId)throw new DomainError(409,'LEGACY_SNAPSHOT_REQUIRED');
 return idempotentSeedMutation(db,input,'SEED_LEGACY_INVENTORY_IMPORTED',{sourceKey:input.sourceKey,stateDigest:inventory.stateDigest,nodeId:input.nodeId,adapterVersion:input.adapterVersion,checkpointRefs:input.checkpointRefs,...(input.snapshotId?{snapshotId:input.snapshotId,jobIds:jobs.map(j=>j.nativeJobId)}:{})},async tx=>{
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','seed-dispatch:source:'+input.sourceKey);
  const source=await tx.dataSource.findUnique({where:{key:input.sourceKey}});if(!source)throw new DomainError(409,'SEED_SOURCE_MISSING');
  const snapshot=input.snapshotId?await snapshotRecord(tx,{...input,snapshotId:input.snapshotId}):null,publication=snapshot?null:await tx.seedPublication.findFirst({orderBy:{revision:'desc'}}),epoch=snapshot?.revision??(publication?.revision??0)+1;let mapped=0;
  for(const j of jobs){
   const previous=await tx.legacyJobMapping.findUnique({where:{sourceKey_nativeJobId:{sourceKey:input.sourceKey,nativeJobId:j.nativeJobId}}});
   if(previous){if(previous.initialCheckpointDigest!==j.checkpointDigest)throw new DomainError(409,'LEGACY_INVENTORY_CONFLICT');continue;}
   // Preparation can race a newly registered identity; re-resolve under the head
   // lock and reject stale archived bytes instead of rewriting their query ID.
   const resolved=await resolveLegacyQuery(tx,input.sourceKey,j),checkpoint=buildLegacyCheckpoint(input.sourceKey,input.state,resolved,input.nodeId),ref=input.checkpointRefs[j.nativeJobId];if(!ref||ref.sha256!==checkpoint.sha256||!ref.reference)throw new DomainError(409,'LEGACY_CHECKPOINT_REQUIRED');
   const query=await tx.seedQuery.upsert({where:{sourceKey_channel_queryKey:{sourceKey:input.sourceKey,channel:j.channel,queryKey:j.queryKey}},create:{id:resolved.queryId,dataSourceId:source.id,sourceKey:input.sourceKey,channel:j.channel,mode:j.mode,normalizedParams:j.params,queryCountry:j.params.country,queryLanguage:j.params.language??'und',queryKey:j.queryKey,queryKeyVersion:'legacy-1',adapterVersion:input.adapterVersion,capabilityVersion:'legacy-observed-1',legacyDims:{language:j.params.language??'und'},desiredEnabled:true,status:'READY'},update:{}});
   await tx.legacyJobMapping.create({data:{dataSourceId:source.id,sourceKey:input.sourceKey,queryId:query.id,nativeJobId:j.nativeJobId,legacyKeyVersion:'legacy-1',initialCheckpointDigest:j.checkpointDigest}});
   const existing=await tx.seedRuntimeState.findUnique({where:{queryId:query.id}});
   const runtimeData={collectorId:input.nodeId,nativeJobId:j.nativeJobId,checkpointDigest:checkpoint.sha256,checkpointVersion:1,checkpointSequence:1,checkpointRef:ref.reference,checkpointSha:ref.sha256,stateSchemaVersion:1,lastAppliedBatchHashes:checkpoint.appliedBatchHashes,sessionAffinity:checkpoint.sessionAffinity,seenCount:j.seenCount,nextAllowedAt:j.nextAllowedAt?new Date(j.nextAllowedAt):null,lastAttemptAt:j.lastAttemptAt?new Date(j.lastAttemptAt):null};
   if(existing&&existing.checkpointSequence>0&&existing.checkpointDigest!==checkpoint.sha256)throw new DomainError(409,'LEGACY_SHARED_PROGRESS_CONFLICT');
   if(!existing)await tx.seedRuntimeState.create({data:{queryId:query.id,dataSourceId:source.id,sourceKey:input.sourceKey,...runtimeData}});
   else if(existing.checkpointSequence===0)await tx.seedRuntimeState.update({where:{queryId:query.id},data:runtimeData});
   await tx.seedQueryBinding.create({data:{queryId:query.id,ownerKind:'LEGACY',legacyOwnerKey:`${input.nodeId}:${input.sourceKey}:${j.nativeJobId}`,ownerRevision:1,validFromRevision:epoch}});mapped++;
  }
  await mergeLegacyControls(tx,source,inventory);
  return {targetId:inventory.stateDigest,revision:epoch,mapped,unmappedJobs:inventory.unmappedJobs,message:'旧队列身份、进度引用与冷却已登记；尚未切换调度或发放执行授权。'};
 });
}
