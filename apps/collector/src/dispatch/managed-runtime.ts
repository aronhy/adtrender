import {readFile} from 'node:fs/promises';import {join,dirname} from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import type {SeedQuerySpec} from '../../../../packages/contracts/src/seeds';import type {ExecutionGrant} from '../../../../packages/contracts/src/seed-dispatch';
import {atomic,findStagedPending,readLegacyPending,saveArchivedPending,type PendingPlatform,type RecoveryState} from './pending-envelope';
import {applyManifestAtBoundary,enqueueConfigReceipt,isManagedJobEnabled,sourceForPlatform,syncSeedConfig,type ConfigState,type ConfigContext} from './config-sync';
import {createExecutionGuard,type ControlMode,type SourceRequestGuard,type PlatformGrant} from './execution-guard';import {createDispatchHttpClient,type DispatchClient,type SourceStopContext} from './dispatch-client';
import {buildNativeCheckpoint,restoreNativeCheckpoint} from './native-checkpoint';import type {BeforeRecoveryPersist} from './pending-envelope';import {allocateCollectorSequence} from './config-sync';import {createAttemptLifecycle} from './attempt-lifecycle';
export type ManagedState=RecoveryState&ConfigState&{controlMode?:ControlMode};
export function resolveControlMode(env:string|undefined,state:{controlMode?:string}):ControlMode|undefined{if(env!==undefined&&!['LEGACY_QUEUE','CONFIG_QUEUE','TASK_CLAIM'].includes(env)||state.controlMode!==undefined&&!['LEGACY_QUEUE','CONFIG_QUEUE','TASK_CLAIM'].includes(state.controlMode))throw Error('COLLECTOR_CONTROL_MODE_INVALID');if(env&&state.controlMode&&env!==state.controlMode)throw Error('COLLECTOR_CONTROL_MODE_CONFLICT');return (env??state.controlMode) as ControlMode|undefined;}
export const usesManagedDispatch=(state:{controlMode?:string})=>state.controlMode!==undefined;
export function managedJobs<S extends ConfigState&{controlMode?:ControlMode}>(state:S,taskJobId?:string):S['jobs']{if(!state.controlMode)return state.jobs;return state.jobs.filter(job=>isManagedJobEnabled(state,job.id)&&(!taskJobId||job.id===taskJobId));}
const sha=(raw:string)=>createHash('sha256').update(raw).digest('hex');
/** Existing facts need a central recovery registration, not a new source grant. */
export function managedPendingIngest(options:{platform:PendingPlatform;root:string;state:ManagedState;forceManagedRecovery?:boolean;client:Pick<DispatchClient,'recoverSubmit'> & Partial<Pick<DispatchClient,'prepareSubmission'|'submitManagedUnit'>>;legacyIngest:(raw:string)=>Promise<unknown>}){
 return async(raw:string)=>{
  if(!options.state.controlMode&&!options.forceManagedRecovery)return options.legacyIngest(raw);
  const pending=options.state.pending??await findStagedPending(options.root,options.platform,options.state.appliedBatches);if(!pending)throw Error('PENDING_MANIFEST_REQUIRED');
  const envelope=await readLegacyPending(options.platform,options.root,pending),batchHash=sha(raw);if(!envelope.expectedChunks.some(chunk=>chunk.hash===batchHash&&chunk.raw===raw))throw Error('PENDING_HASH_MISMATCH');
  let sidecar:any,sidecarRaw:string;try{sidecarRaw=await readFile(join(dirname(pending.file),'pending.json'),'utf8');sidecar=JSON.parse(sidecarRaw);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;sidecarRaw='';}
  if(!sidecar?.execution)return options.client.recoverSubmit({requestId:randomUUID(),sourceKey:sourceForPlatform[options.platform],rawSha:envelope.rawSha,batchHash,raw});
  if(!options.client.prepareSubmission||!options.client.submitManagedUnit)throw Error('COLLECTOR_MANAGED_SUBMIT_REQUIRED');
  const file=join(dirname(pending.file),'prepared.json');let prepared:any;try{prepared=JSON.parse(await readFile(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const expectedBatchHashes=envelope.expectedChunks.map(chunk=>chunk.hash),sidecarRef='local-private:collector/'+sourceForPlatform[options.platform]+'/'+envelope.rawSha+'/pending.json';
  if(!prepared){prepared={requestId:randomUUID(),sidecarHash:sha(sidecarRaw!),sidecarRef,expectedBatchHashes};await atomic(file,prepared);}
  if(JSON.stringify(prepared.expectedBatchHashes)!==JSON.stringify(expectedBatchHashes)||prepared.sidecarHash!==sha(sidecarRaw!))throw Error('PENDING_PREPARE_CONFLICT');
  if(!prepared.prepareToken){const response=await options.client.prepareSubmission({requestId:prepared.requestId,context:sidecar.execution,rawSha:envelope.rawSha,expectedBatchHashes,sidecarHash:prepared.sidecarHash,sidecarRef});prepared={...prepared,...response};await atomic(file,prepared);}
  // Expired PREPARED facts use the recovery endpoint and a separate fenced checkpoint acknowledgement.
  prepared.submitRequestIds??={};if(!prepared.submitRequestIds[batchHash]){prepared.submitRequestIds[batchHash]=randomUUID();await atomic(file,prepared);}
  try{return await options.client.submitManagedUnit({requestId:prepared.submitRequestIds[batchHash],prepareToken:prepared.prepareToken,sourceKey:sourceForPlatform[options.platform],batchHash,raw});}
  catch(e){if(e instanceof Error&&['COLLECTOR_AUTHORIZATION_REJECTED','COLLECTOR_CONTROL_REJECTED'].includes(e.message)){prepared.recoveryRequired=true;await atomic(file,prepared);return options.client.recoverSubmit({requestId:prepared.submitRequestIds[batchHash],prepareToken:prepared.prepareToken,sourceKey:sourceForPlatform[options.platform],rawSha:envelope.rawSha,batchHash,raw});}throw e;}
 };
}
export function dispatchFromEnvironment(root:string,platform:PendingPlatform,state:{controlMode?:string}={},options:{forControlHandoff?:boolean}={}){const targetMode=options.forControlHandoff?resolveControlMode(process.env.COLLECTOR_CONTROL_MODE,{}):undefined;if(options.forControlHandoff&&!targetMode)throw Error('COLLECTOR_HANDOFF_MODE_REQUIRED');const mode=options.forControlHandoff?(resolveControlMode(undefined,state)??'LEGACY_QUEUE'):resolveControlMode(process.env.COLLECTOR_CONTROL_MODE,state);if(!mode)return;
 const nodeId=process.env.COLLECTOR_NODE_ID,incarnationId=process.env.COLLECTOR_INCARNATION_ID,token=process.env.COLLECTOR_NODE_TOKEN,origin=process.env.COLLECTOR_CONTROL_URL;if(!nodeId||!incarnationId||!token||!origin)throw Error('COLLECTOR_CONTROL_CONFIG_REQUIRED');
 const context:ConfigContext={root,sequenceRoot:process.env.COLLECTOR_RECEIPT_DIR??root,nodeId,incarnationId,protocolVersion:1,sourceKey:sourceForPlatform[platform]},client=createDispatchHttpClient({origin,token,nodeId,incarnationId,sourceKey:sourceForPlatform[platform]});const codeRevision=process.env.COLLECTOR_CODE_REVISION,capabilityDigest=process.env.COLLECTOR_CAPABILITY_DIGEST;if(!codeRevision||!capabilityDigest||!/^[a-f0-9]{64}$/.test(capabilityDigest))throw Error('COLLECTOR_CAPABILITY_CONFIG_REQUIRED');return {mode,context,client,platform,codeRevision,capabilityDigest,...(options.forControlHandoff?{handoff:{fromMode:mode,toMode:targetMode!}}:{})};
}
export async function syncManagedBoundary<S extends ManagedState>(state:S,dispatch:NonNullable<ReturnType<typeof dispatchFromEnvironment>>,persist:(next:S)=>Promise<void>):Promise<S>{
 resolveControlMode(dispatch.mode,state);if(state.pending)throw Error('CONFIG_BOUNDARY_PENDING');
 const manifest=await syncSeedConfig(dispatch.client,dispatch.context);
 // Sync first so a persisted APPLIED receipt can still leave its failed outbox.
 if(state.controlMode===dispatch.mode&&state.seedConfig?.revision===manifest.revision&&state.seedConfig?.contentHash===manifest.contentHash)return state;
 const next=applyManifestAtBoundary({...state,controlMode:dispatch.mode},manifest,dispatch.platform) as S;
 await persist(next);await enqueueConfigReceipt(dispatch.client,dispatch.context,manifest,'APPLIED',next.seedConfig!.mappings);return next;
}
export async function authorizeManagedJob(state:ManagedState,job:any,dispatch:NonNullable<ReturnType<typeof dispatchFromEnvironment>>,signal?:AbortSignal,taskGrant?:ExecutionGrant|PlatformGrant):Promise<SourceRequestGuard>{
 const config=state.seedConfig;if(!config||!isManagedJobEnabled(state,job.id))throw Error('COLLECTOR_QUERY_DISABLED');const query=config.queries.find(q=>q.nativeJobIds.includes(job.id));if(!query)throw Error('COLLECTOR_QUERY_UNMAPPED');
 const grant=taskGrant??await dispatch.client.platformGrant(sourceForPlatform[dispatch.platform],dispatch.mode as 'LEGACY_QUEUE'|'CONFIG_QUEUE');
 const guard=createExecutionGuard({context:{...dispatch.context,sourceKey:query.sourceKey,controlMode:dispatch.mode,appliedRevision:config.revision,configHash:config.contentHash,assignmentGeneration:grant.assignmentGeneration},query,grant,signal,permit:input=>dispatch.client.permit(input)});
 try{guard.executionContext!.nativeJobId=job.id;await guard.beforeRequest('UNIT_START');guard.executionContext!.nativeJobId=job.id;return guard;}catch(error){guard.dispose();throw error;}
}
export async function claimManagedJob(state:ManagedState,dispatch:NonNullable<ReturnType<typeof dispatchFromEnvironment>>):Promise<{job:any;grant:ExecutionGrant}|undefined>{
 const config=state.seedConfig;if(!config)throw Error('CONFIG_CACHE_REQUIRED');let grant=await dispatch.client.claim({requestId:randomUUID(),appliedRevision:config.revision,configHash:config.contentHash,availableSlots:1,supportedModes:[...new Set(config.queries.map(q=>q.mode))],sourceKey:sourceForPlatform[dispatch.platform],queryIds:config.queries.filter(q=>q.nativeJobIds.some(id=>isManagedJobEnabled(state,id))).map(q=>q.queryId)});if(!grant)return;
 const claimed=grant;const query=config.queries.find(q=>q.queryId===claimed.queryId),job=query&&managedJobs(state).find(j=>query.nativeJobIds.includes(j.id));if(!job)throw Error('COLLECTOR_QUERY_UNMAPPED');
 grant=await dispatch.client.start({grantToken:grant.grantToken,attemptId:grant.attemptId});return {job,grant};
}
export async function stageManagedBatch(root:string,platform:PendingPlatform,jobId:string,batch:unknown,guard:SourceRequestGuard){const context=guard.executionContext,g=guard.executionGrant;if(!context?.taskId||!context.attemptId||!g)throw Error('COLLECTOR_PREPARED_CONTEXT_REQUIRED');return saveArchivedPending(root,platform,jobId,batch,{...context,nativeJobId:jobId},{sequence:g.checkpointSequence,reference:g.checkpointRef,nodeId:g.nodeId,incarnationId:g.incarnationId});}
async function acknowledgeNoMoreRequests(root:string,dispatch:NonNullable<ReturnType<typeof dispatchFromEnvironment>>,grant:ExecutionGrant){
 const file=join(root,'dispatch','stopped',grant.attemptId+'.json');let receipt:any;try{receipt=JSON.parse(await readFile(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 if(!receipt){receipt={attemptId:grant.attemptId,grantToken:grant.grantToken,requestId:randomUUID(),sequence:await allocateCollectorSequence(dispatch.context.sequenceRoot,dispatch.context.nodeId,dispatch.context.incarnationId),drained:true,pendingPreserved:true};await atomic(file,receipt);}
 await dispatch.client.stop(receipt);
}
async function cachedPlatformGrant(root:string,dispatch:NonNullable<ReturnType<typeof dispatchFromEnvironment>>):Promise<PlatformGrant|undefined>{
 let grant:PlatformGrant;try{grant=JSON.parse(await readFile(join(root,'dispatch','platform-grant.json'),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 if(grant.scope!=='platform_queue'||grant.nodeId!==dispatch.context.nodeId||grant.incarnationId!==dispatch.context.incarnationId||grant.sourceKey!==sourceForPlatform[dispatch.platform]||grant.controlMode!==dispatch.mode||typeof grant.grantToken!=='string'||grant.grantToken.length<24)throw Error('COLLECTOR_PLATFORM_CACHE_INVALID');return grant;
}
async function preservedPendingHashes(root:string,platform:PendingPlatform,state:ManagedState){const pending=state.pending??await findStagedPending(root,platform,state.appliedBatches),envelope=pending&&await readLegacyPending(platform,root,pending);return envelope?[...new Set(envelope.expectedChunks.map(chunk=>chunk.hash))]:[];}
async function acknowledgePlatformStopped(root:string,dispatch:NonNullable<ReturnType<typeof dispatchFromEnvironment>>,state:ManagedState,grant:PlatformGrant){
 const file=join(root,'dispatch','source-stopped',sha(grant.grantToken)+'.json');let record:any;try{record=JSON.parse(await readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(record?.confirmed)return;
 if(!record){const pendingHashes=await preservedPendingHashes(root,dispatch.platform,state);record={input:{sourceKey:grant.sourceKey,grantToken:grant.grantToken,requestId:randomUUID(),sequence:await allocateCollectorSequence(dispatch.context.sequenceRoot,dispatch.context.nodeId,dispatch.context.incarnationId),pendingPreserved:true,pendingHashes},confirmed:false};await atomic(file,record);}
 const response:any=await dispatch.client.stop(record.input);if(!response?.receiptId)throw Error('COLLECTOR_STOP_UNCONFIRMED');await atomic(file,{...record,confirmed:true,receiptId:response.receiptId});
}
async function refreshPlatformGrant(root:string,dispatch:NonNullable<ReturnType<typeof dispatchFromEnvironment>>,state:ManagedState):Promise<PlatformGrant>{
 let grant:PlatformGrant;try{grant=await dispatch.client.platformGrant(sourceForPlatform[dispatch.platform],dispatch.mode as 'LEGACY_QUEUE'|'CONFIG_QUEUE');}catch(error){if(['PLATFORM_ASSIGNMENT_REQUIRED','PLATFORM_ASSIGNMENT_EXPIRED','STOP_REQUESTED'].includes((error as Error&{code?:string}).code??''))await acknowledgePlatformDrainIfRequested(root,dispatch,state);throw error;}
 const config=state.seedConfig,serverNow=Date.parse(grant.serverNow);if(grant.schemaVersion!==1||grant.protocolVersion!==dispatch.context.protocolVersion||grant.scope!=='platform_queue'||grant.controlMode!==dispatch.mode||grant.nodeId!==dispatch.context.nodeId||grant.incarnationId!==dispatch.context.incarnationId||grant.sourceKey!==sourceForPlatform[dispatch.platform]||!Number.isSafeInteger(grant.assignmentGeneration)||grant.assignmentGeneration<1||grant.publicationRevision!==config?.revision||grant.configHash!==config.contentHash||typeof grant.grantToken!=='string'||grant.grantToken.length<24||!Number.isFinite(serverNow)||Math.abs(Date.now()-serverNow)>120000||!(Date.parse(grant.requestDeadline)>serverNow&&Date.parse(grant.requestDeadline)<=Date.parse(grant.validUntil)))throw Error('COLLECTOR_AUTHORIZATION_INVALID');
 await atomic(join(root,'dispatch','platform-grant.json'),grant);return grant;
}
async function refreshSourceStopContext(root:string,dispatch:NonNullable<ReturnType<typeof dispatchFromEnvironment>>):Promise<SourceStopContext|undefined>{
 let context:SourceStopContext;try{context=await dispatch.client.sourceStopContext(sourceForPlatform[dispatch.platform]);}catch(error){if((error as Error&{code?:string}).code==='TASK_SOURCE_ASSIGNMENT_REQUIRED')return;throw error;}
 if(context.schemaVersion!==1||context.scope!=='source_stop'||context.controlMode!==dispatch.mode||context.nodeId!==dispatch.context.nodeId||context.incarnationId!==dispatch.context.incarnationId||context.sourceKey!==sourceForPlatform[dispatch.platform]||!Number.isSafeInteger(context.assignmentGeneration)||context.assignmentGeneration<1||!['ACTIVE','DRAINING'].includes(context.state)||!Number.isFinite(Date.parse(context.issuedAt)))throw Error('COLLECTOR_STOP_CONTEXT_INVALID');if(dispatch.mode==='TASK_CLAIM')await atomic(join(root,'dispatch','task-source-stop-context.json'),context);return context;
}
async function acknowledgePlatformDrainIfRequested(root:string,dispatch:NonNullable<ReturnType<typeof dispatchFromEnvironment>>,state:ManagedState){
 // SIGTERM also ends ordinary fleet windows. Only the coordinator can drain
 // a platform assignment; an ACTIVE owner must remain usable next window.
 const context=await refreshSourceStopContext(root,dispatch);if(context?.state!=='DRAINING')return;
 const grant=await cachedPlatformGrant(root,dispatch);if(!grant||grant.assignmentGeneration!==context.assignmentGeneration)throw Error('COLLECTOR_STOP_CONTEXT_INVALID');
 await acknowledgePlatformStopped(root,dispatch,state,grant);
}
async function acknowledgeTaskSourceStopped(root:string,dispatch:NonNullable<ReturnType<typeof dispatchFromEnvironment>>,state:ManagedState,context:SourceStopContext){
 if(context.state!=='DRAINING')throw Error('COLLECTOR_STOP_CONTEXT_INVALID');const file=join(root,'dispatch','task-source-stopped',String(context.assignmentGeneration)+'.json');let record:any;try{record=JSON.parse(await readFile(file,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(record?.confirmed)return;if(!record){record={input:{sourceKey:context.sourceKey,assignmentGeneration:context.assignmentGeneration,requestId:randomUUID(),sequence:await allocateCollectorSequence(dispatch.context.sequenceRoot,dispatch.context.nodeId,dispatch.context.incarnationId),pendingPreserved:true,pendingHashes:await preservedPendingHashes(root,dispatch.platform,state)},confirmed:false};await atomic(file,record);}const response:any=await dispatch.client.stop(record.input);if(!response?.receiptId)throw Error('COLLECTOR_STOP_UNCONFIRMED');await atomic(file,{...record,confirmed:true,receiptId:response.receiptId});
}
export function managedCheckpointBarrier(options:{platform:PendingPlatform;root:string;nodeId:string;incarnationId?:string;sequenceRoot?:string;client:Pick<DispatchClient,'submitManagedUnit'> & Partial<Pick<DispatchClient,'stop'>>}):BeforeRecoveryPersist<any>{
 return async(state,envelope)=>{
  const directory=dirname(envelope.pending.file),sidecar=JSON.parse(await readFile(join(directory,'pending.json'),'utf8').catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return '{}';throw e;}));if(!sidecar.execution)return;
  const preparedFile=join(directory,'prepared.json'),prepared=JSON.parse(await readFile(preparedFile,'utf8'));if(!prepared.prepareToken)throw Error('COLLECTOR_PREPARED_CONTEXT_REQUIRED');
  const query=state.seedConfig?.queries.find((q:SeedQuerySpec)=>q.queryId===sidecar.execution.queryId);if(!query)throw Error('COLLECTOR_QUERY_UNMAPPED');
  const built=buildNativeCheckpoint(state,query,envelope.pending.jobId,sidecar.executionCheckpoint?.sequence,envelope.expectedChunks.map(chunk=>chunk.hash),sidecar.executionCheckpoint?.nodeId??options.nodeId);
  const checkpointFile=join(directory,'checkpoint.json'),checkpointRecordFile=join(directory,'checkpoint-submit.json');let record:any;try{record=JSON.parse(await readFile(checkpointRecordFile,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(record&&record.sha256!==built.checkpoint.sha256)throw Error('COLLECTOR_CHECKPOINT_CONFLICT');if(!record){record={requestId:randomUUID(),sha256:built.checkpoint.sha256};await atomic(checkpointFile,JSON.parse(built.checkpointRaw));await atomic(checkpointRecordFile,record);}
  if(!record.confirmed){const last=envelope.expectedChunks.at(-1)!;let result:any;
   try{if(prepared.recoveryRequired)throw Error('COLLECTOR_CONTROL_REJECTED');result=await options.client.submitManagedUnit({requestId:record.requestId,prepareToken:prepared.prepareToken,sourceKey:sourceForPlatform[options.platform],batchHash:last.hash,raw:last.raw,...built});if(!result.complete||result.committedCheckpointSequence!==built.checkpoint.sequence||!envelope.expectedChunks.every(chunk=>result.confirmedBatchHashes?.includes(chunk.hash)))throw Error('COLLECTOR_CHECKPOINT_UNCONFIRMED');}
   catch(e){if(!(e instanceof Error)||!['COLLECTOR_CONTROL_REJECTED','COLLECTOR_AUTHORIZATION_REJECTED'].includes(e.message)||!options.client.stop||!options.incarnationId)throw e;if(!record.stopSequence){record.stopSequence=await allocateCollectorSequence(options.sequenceRoot??options.root,options.nodeId,options.incarnationId);await atomic(checkpointRecordFile,record);}result=await options.client.stop({requestId:record.requestId,sequence:record.stopSequence,attemptId:sidecar.execution.attemptId,grantToken:sidecar.execution.grantToken,drained:true,pendingPreserved:true,...built});if(!result.recovered||result.checkpointSequence!==built.checkpoint.sequence)throw Error('COLLECTOR_CHECKPOINT_UNCONFIRMED');}
   record={...record,confirmed:true,reference:result.checkpointRef??built.checkpoint.reference};await atomic(checkpointRecordFile,record);}
  state.nativeCheckpoints??={};state.nativeCheckpoints[query.queryId]={sequence:built.checkpoint.sequence,reference:record.reference,sha256:built.checkpoint.sha256,sessionAffinity:built.checkpoint.sessionAffinity};
 };
}
/** A managed node uses only the applied manifest. Catalog discovery and local
 * queue expansion never authorize a source request. Native recovery remains first. */
export async function runManagedLoop<S extends ManagedState>(options:{root:string;platform:PendingPlatform;dispatch:NonNullable<ReturnType<typeof dispatchFromEnvironment>>;getState():S;setState(state:S):void;persist(state:S):Promise<void>;commit():Promise<unknown>;next(jobs:any[],now:number):any;prepare?(job:any,now:number):void;collect(job:any,guard:SourceRequestGuard):Promise<unknown>;paused(state:S,now:number):boolean;stopping():boolean;signal?:AbortSignal;wait(ms:number):Promise<void>;once?:boolean;log(code:string):void}){
 try{
 while(!options.stopping()){
  let guard:SourceRequestGuard|undefined,life:ReturnType<typeof createAttemptLifecycle>|undefined;const unitAbort=new AbortController();
  try{
   await options.commit();if(options.stopping())break;await options.dispatch.client.heartbeat({codeRevision:options.dispatch.codeRevision,capabilityDigest:options.dispatch.capabilityDigest,resourceSnapshot:{maxSlots:1,platform:options.platform,sourceCallsActive:false}});
   let state=await syncManagedBoundary(options.getState(),options.dispatch,options.persist);options.setState(state);
   const taskStop=options.dispatch.mode==='TASK_CLAIM'?await refreshSourceStopContext(options.root,options.dispatch):undefined;if(taskStop?.state==='DRAINING'){await acknowledgeTaskSourceStopped(options.root,options.dispatch,state,taskStop);if(options.once)break;await options.wait(15000);continue;}
   const platformGrant=options.dispatch.mode==='TASK_CLAIM'?undefined:await refreshPlatformGrant(options.root,options.dispatch,state);
   if(options.paused(state,Date.now())){if(options.once)break;await options.wait(15000);continue;}
   let selected:any,taskGrant:ExecutionGrant|undefined;
   if(options.dispatch.mode==='TASK_CLAIM'){const task=await claimManagedJob(state,options.dispatch);selected=task?.job;taskGrant=task?.grant;}
   else selected=options.next(managedJobs(state),Date.now());
   if(!selected){if(options.once)break;await options.wait(15000);continue;}
   guard=await authorizeManagedJob(state,selected,options.dispatch,options.signal?AbortSignal.any([options.signal,unitAbort.signal]):unitAbort.signal,taskGrant??platformGrant);
   const g=guard.executionGrant;if(!g)throw Error('COLLECTOR_STARTED_CONTEXT_REQUIRED');
   if(g.checkpointRef!==null){const query=state.seedConfig!.queries.find(q=>q.queryId===g.queryId)!;const downloaded=await options.dispatch.client.checkpoint({grantToken:g.grantToken,attemptId:g.attemptId,queryId:g.queryId});state=restoreNativeCheckpoint(state,query,g,downloaded,options.dispatch.context.nodeId);await options.persist(state);options.setState(state);selected=state.jobs.find(job=>job.id===selected.id);}
   if(options.paused(state,Date.now()))throw Error('COLLECTOR_SOURCE_BLOCKED');life=createAttemptLifecycle({client:options.dispatch.client,context:options.dispatch.context,grant:g,abort:unitAbort,heartbeat:()=>options.dispatch.client.heartbeat({codeRevision:options.dispatch.codeRevision,capabilityDigest:options.dispatch.capabilityDigest,resourceSnapshot:{maxSlots:1,platform:options.platform,sourceCallsActive:true}})});
   options.prepare?.(selected,Date.now());selected.lastAttemptAt=Date.now();await options.persist(state);
   const batch=await options.collect(selected,guard);
   state.pending=await stageManagedBatch(options.root,options.platform,selected.id,batch,guard);await options.persist(state);const result:any=(batch as any)?.batch??batch,error=result?.errorCode;if(typeof error==='string'&&/(?:HTTP_(403|429)|RATE_LIMITED|CHALLENGE|CAPTCHA|LOGIN_REQUIRED|ACCESS_BLOCKED|ACCESS_DENIED)/.test(error)){const n=typeof (state as any).restrictions==='number'?(state as any).restrictions:(state as any).restrictionCount??1;await options.dispatch.client.restriction({grantToken:g.grantToken,attemptId:g.attemptId,expectedControlVersion:guard.executionGrant?.sourceControlVersion??g.sourceControlVersion,reason:error,retryAfterMs:Math.max(result.retryAfterMs??0,Math.min(86400000,3600000*2**Math.min(5,n))),requestId:randomUUID()});}
   life.dispose();life=undefined;guard.dispose();guard=undefined;await options.commit();if(options.once)break;await options.wait(120000);
  }catch(e){unitAbort.abort();life?.dispose();if(guard?.executionGrant)await acknowledgeNoMoreRequests(options.root,options.dispatch,guard.executionGrant).catch(()=>{});options.log(e instanceof Error&&/^[A-Z_0-9]+$/.test(e.message)?e.message:'COLLECTOR_SERVICE_ERROR');if(options.once)throw e;await options.wait(60000);}finally{life?.dispose();guard?.dispose();}
 }
 }finally{if(options.stopping()){try{if(options.dispatch.mode==='TASK_CLAIM'){const context=await refreshSourceStopContext(options.root,options.dispatch);if(context?.state==='DRAINING')await acknowledgeTaskSourceStopped(options.root,options.dispatch,options.getState(),context);}else await acknowledgePlatformDrainIfRequested(options.root,options.dispatch,options.getState());}catch(error){options.log(error instanceof Error&&/^[A-Z_0-9]+$/.test(error.message)?error.message:'COLLECTOR_STOP_UNCONFIRMED');}}}
}
