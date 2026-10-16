import {join} from 'node:path';
import {recoverPendingOnly,atomic,type RecoveryState,type BeforeRecoveryPersist} from '../dispatch/pending-envelope';
import {advanceShard,type Shard} from './sweep';
import type {SweepResult} from './sweep-adapter';
import type {PinterestBatch} from './adapter';
export interface PinterestRecoveryState extends RecoveryState {schema:1;jobs:Shard[];catalog:SweepResult['catalog'];lastDaily:string;pauseUntil?:number;lastResult?:unknown;updatedAt:string}
export async function recoverPinterestPending(state:PinterestRecoveryState,deps:{root:string;ingest:(raw:string)=>Promise<unknown>;now?:()=>number;beforePersist?:BeforeRecoveryPersist<PinterestRecoveryState>;persist?:(state:PinterestRecoveryState)=>Promise<void>}){
 const now=deps.now??Date.now;
 return recoverPendingOnly<PinterestRecoveryState,PinterestBatch>('pinterest',state,{...deps,persist:deps.persist??(async draft=>{draft.updatedAt=new Date(now()).toISOString();await atomic(join(deps.root,'state.json'),draft);}),apply:(draft,envelope,reports,committedAt)=>{
  const job=draft.jobs.find(j=>j.id===envelope.pending.jobId);if(!job)throw Error('PENDING_JOB_MISSING');
  const batch=envelope.batchView,result=envelope.legacyResult as SweepResult;
  advanceShard(job,{status:batch.status,errorCode:batch.errorCode,nextPage:result.nextPage,exhausted:result.exhausted},committedAt);
  if(['ACCESS_BLOCKED','RATE_LIMITED','CHALLENGE','LOGIN_REQUIRED'].includes(job.error??''))draft.pauseUntil=Math.max(draft.pauseUntil??0,committedAt+3600000);
  draft.lastResult={job:job.id,page:job.page,status:batch.status,errorCode:batch.errorCode,count:batch.ads.length,reports,at:new Date(committedAt).toISOString()};
 }});
}
