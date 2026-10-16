import {join} from 'node:path';
import {recoverPendingOnly,atomic,type RecoveryState,type BeforeRecoveryPersist} from '../dispatch/pending-envelope';
import {applyBatch,discoverJobs,jobLane,restrictionDelay,type Job,type Lane} from './queue';
import type {Batch} from './browser';
export interface MetaRecoveryState extends RecoveryState {schema:1;jobs:Job[];pauseUntil:number;restrictions:number;pauseReason?:string;lastResult?:unknown;updatedAt:string;lastLane?:Lane}
export async function recoverMetaPending(state:MetaRecoveryState,deps:{root:string;ingest:(raw:string)=>Promise<unknown>;now?:()=>number;beforePersist?:BeforeRecoveryPersist<MetaRecoveryState>;persist?:(state:MetaRecoveryState)=>Promise<void>}){
 const now=deps.now??Date.now;
 return recoverPendingOnly<MetaRecoveryState,Batch>('meta',state,{...deps,persist:deps.persist??(async draft=>{draft.updatedAt=new Date(now()).toISOString();await atomic(join(deps.root,'state.json'),draft);}),apply:(draft,envelope,reports,committedAt)=>{
  const job=draft.jobs.find(j=>j.id===envelope.pending.jobId);if(!job)throw Error('PENDING_JOB_MISSING');
  const batch=envelope.batchView as Batch & {advertisers?:unknown[];resultCount?:number|null};
  applyBatch(job,{ids:batch.completedIds,status:batch.status,errorCode:batch.errorCode,exhausted:batch.coverage.exhausted},committedAt);
  discoverJobs(draft.jobs,job,batch.ads);draft.lastLane=jobLane(job);
  const delay=restrictionDelay(batch.errorCode,draft.restrictions+1);
  if(delay){draft.restrictions++;draft.pauseUntil=Math.max(draft.pauseUntil,committedAt+delay);draft.pauseReason=batch.errorCode??'META_SOURCE_RESTRICTED';}
  else if((batch.status==='SUCCEEDED'||batch.status==='NO_RESULTS')&&draft.pauseUntil<=committedAt){draft.restrictions=0;draft.pauseUntil=0;delete draft.pauseReason;}
  draft.lastResult={query:batch.query,status:batch.status,errorCode:batch.errorCode,count:batch.ads.length,observedAdvertisers:(batch.advertisers??[]).length,sourceResultCount:batch.resultCount??null,coverage:batch.coverage,report:reports[0],at:new Date(committedAt).toISOString()};
 }});
}
