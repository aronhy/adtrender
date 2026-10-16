import {join} from 'node:path';
import {advanceJob,nextJob,refreshJobs,restrictionAction,splitBudgetJob,enqueueMediaRefresh,type MediaRefreshCandidate,type BatchProgress,type Job} from './queue';
import {atomic,savePending,type Pending} from './store';
import {recoverPendingOnly as recoverArchivedPending,type RecoveryState,type BeforeRecoveryPersist} from '../dispatch/pending-envelope';
import type {ControlMode} from '../dispatch/execution-guard';
export interface RuntimeBatch extends BatchProgress {}
export interface RuntimeState extends RecoveryState {
 schema:1;jobs:Job[];pending?:Pending;pauseUntil:number;manualPause?:{reason:string;since:number};controlMode?:ControlMode;
 updatedAt:string;lastResult?:unknown;activeJobId?:string;restrictions?:number;serviceError?:{code:string;at:string};mediaRefreshScanAt?:number;
}
export function recordServiceError(state:RuntimeState,error:unknown,now=Date.now()){
 const code=error instanceof Error&&/^TIKTOK_[A-Z_0-9]+$/.test(error.message)?error.message:'TIKTOK_SERVICE_ERROR';
 const retryAfterMs=(error as {retryAfterMs?:number}|null)?.retryAfterMs;
 const restriction=restrictionAction(code,(state.restrictions??0)+1,retryAfterMs);
 state.serviceError={code,at:new Date(now).toISOString()};
 if(restriction.manual)state.manualPause={reason:code,since:now};
 else if(restriction.delayMs){state.restrictions=(state.restrictions??0)+1;state.pauseUntil=Math.max(state.pauseUntil,now+restriction.delayMs);}
}
export interface RuntimeDependencies<B extends RuntimeBatch=RuntimeBatch> {
 root:string;collect:(job:Job)=>Promise<B>;ingest:(raw:string)=>Promise<unknown>;now?:()=>number;refreshCandidates?:()=>Promise<MediaRefreshCandidate[]>;refreshScanIntervalMs?:number;beforePersist?:BeforeRecoveryPersist<RuntimeState>;
}
export async function saveState(root:string,state:RuntimeState,now=Date.now()){
 state.updatedAt=new Date(now).toISOString();await atomic(join(root,'state.json'),state);
 await atomic(join(root,'status.json'),{updatedAt:state.updatedAt,state:state.manualPause?'PAUSED':state.pauseUntil>now?'COOLDOWN':state.pending?'COMMIT_PENDING':state.serviceError?'ERROR':state.activeJobId?'COLLECTING':'RUNNING',serviceError:state.serviceError,
  countries:new Set(state.jobs.map(j=>j.country)).size,jobs:state.jobs.length,completedJobs:state.jobs.filter(j=>j.complete).length,failedJobs:state.jobs.filter(j=>j.failures>0).length,supersededJobs:state.jobs.filter(j=>j.superseded).length,
  visitedJobs:state.jobs.filter(j=>j.lastAttemptAt>0).length,pending:state.pending?.jobId,activeJobId:state.activeJobId,
  mediaRefreshJobs:state.jobs.filter(j=>j.kind==='MEDIA_REFRESH').length,mediaRefreshScanAt:state.mediaRefreshScanAt?new Date(state.mediaRefreshScanAt).toISOString():null,
  pauseUntil:state.pauseUntil?new Date(state.pauseUntil).toISOString():null,manualPause:state.manualPause,lastResult:state.lastResult});
}
export async function recoverTikTokPending<B extends RuntimeBatch>(state:RuntimeState,deps:Pick<RuntimeDependencies<B>,'root'|'ingest'|'now'|'beforePersist'>):Promise<{status:'COMMITTED'|'IDLE';jobId?:string;report?:unknown}>{
 const now=deps.now??Date.now;
  let result;
  try{result=await recoverArchivedPending<RuntimeState,B>('tiktok',state,{root:deps.root,ingest:deps.ingest,beforePersist:deps.beforePersist,persist:async draft=>{draft.updatedAt=new Date(now()).toISOString();await atomic(join(deps.root,'state.json'),draft);},apply:(draft,envelope,reports,committedAt)=>{
   const job=draft.jobs.find(j=>j.id===envelope.pending.jobId);if(!job)throw Error('TIKTOK_PENDING_JOB_MISSING');
   const batch=envelope.batchView,report=reports[0];advanceJob(job,batch,committedAt);
   // Managed children require a published native mapping; keep this parent retryable until central admission.
   const childIds=draft.controlMode?[]:splitBudgetJob(draft.jobs,job,batch,committedAt);
   const restriction=restrictionAction(batch.errorCode,(draft.restrictions??0)+1,batch.retryAfterMs);
   if(restriction.manual)draft.manualPause={reason:batch.errorCode??'TIKTOK_RESTRICTED',since:committedAt};
   else if(restriction.delayMs){draft.restrictions=(draft.restrictions??0)+1;draft.pauseUntil=Math.max(draft.pauseUntil,committedAt+restriction.delayMs);}
   else if((batch.status==='SUCCEEDED'||batch.status==='NO_RESULTS')&&draft.pauseUntil<=committedAt)draft.restrictions=0;
   draft.lastResult={jobId:job.id,...(job.kind?{kind:job.kind}:{}),status:batch.status,errorCode:batch.errorCode,count:batch.completedIds.length,exhausted:batch.coverage.exhausted,...(childIds.length?{superseded:true,childIds}:{}),report,at:new Date(committedAt).toISOString()};
   delete draft.activeJobId;delete draft.serviceError;
  }});}catch(error){if(error instanceof Error&&error.message==='PENDING_RECEIPT_UNCONFIRMED')throw Error('TIKTOK_COMMIT_UNCONFIRMED');throw error;}
  if(result.status==='IDLE')return {status:'IDLE' as const};
  await saveState(deps.root,state,now());return {status:'COMMITTED' as const,jobId:result.jobId,report:result.reports?.[0]};
}
/** One bounded unit. Pending commits always replay before any collection or queue refresh. */
export async function runOnce<B extends RuntimeBatch>(state:RuntimeState,deps:RuntimeDependencies<B>):Promise<{status:'COMMITTED'|'PAUSED'|'COOLDOWN'|'IDLE';jobId?:string;report?:unknown}>{
 const now=deps.now??Date.now;

 const recovery=await recoverTikTokPending(state,deps);if(recovery.status==='COMMITTED')return recovery;
 if(state.manualPause){await saveState(deps.root,state,now());return {status:'PAUSED'};}
 if(state.pauseUntil>now()){await saveState(deps.root,state,now());return {status:'COOLDOWN'};}
 if(deps.refreshCandidates&&(!state.mediaRefreshScanAt||now()-state.mediaRefreshScanAt>=(deps.refreshScanIntervalMs??3600000))){
  const candidates=await deps.refreshCandidates();enqueueMediaRefresh(state.jobs,candidates,now());state.mediaRefreshScanAt=now();await saveState(deps.root,state,now());
 }
 refreshJobs(state.jobs,now());const job=nextJob(state.jobs,now());
 if(!job){delete state.activeJobId;await saveState(deps.root,state,now());return {status:'IDLE'};}
 job.lastAttemptAt=now();state.activeJobId=job.id;delete state.serviceError;await saveState(deps.root,state,now());
 let batch:B;
 try{batch=await deps.collect(structuredClone(job));}
 catch(error){
  const failedAt=now();advanceJob(job,{status:'FAILED',errorCode:'TIKTOK_COLLECTION_EXCEPTION',completedIds:[],coverage:{exhausted:false}},failedAt);
  delete state.activeJobId;state.lastResult={jobId:job.id,status:'FAILED',errorCode:'TIKTOK_COLLECTION_EXCEPTION',at:new Date(failedAt).toISOString()};
  await saveState(deps.root,state,failedAt);throw error;
 }
 state.pending=await savePending(deps.root,job.id,batch);delete state.activeJobId;await saveState(deps.root,state,now());
 return recoverTikTokPending(state,deps);
}
