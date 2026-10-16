import {join} from 'node:path';
import {recoverPendingOnly,atomic,type RecoveryState,type BeforeRecoveryPersist} from '../dispatch/pending-envelope';
import {recordDiscovery,advance,restrictionDelay,type Job,type JobKind} from './queue';
import type {Batch} from './collector';
export interface SnapchatRecoveryState extends RecoveryState {schema:1;jobs:Job[];pauseUntil:number;restrictionCount:number;nextBatchAt:number;updatedAt:string;lastResult?:unknown;lastKind?:JobKind;candidateFeed?:{state:string;checkedAt:string;generatedAt?:string;candidates?:number;added?:number}}
export async function recoverSnapchatPending(state:SnapchatRecoveryState,deps:{root:string;ingest:(raw:string)=>Promise<unknown>;now?:()=>number;beforePersist?:BeforeRecoveryPersist<SnapchatRecoveryState>;persist?:(state:SnapchatRecoveryState)=>Promise<void>}){
 const now=deps.now??Date.now;
 return recoverPendingOnly<SnapchatRecoveryState,Batch>('snapchat',state,{...deps,persist:deps.persist??(async draft=>{draft.updatedAt=new Date(now()).toISOString();await atomic(join(deps.root,'state.json'),draft);}),apply:(draft,envelope,reports,committedAt)=>{
  const job=draft.jobs.find(j=>j.id===envelope.pending.jobId);if(!job)throw Error('PENDING_JOB_MISSING');
  const batch=envelope.batchView;draft.lastKind=job.kind??'WATCH';recordDiscovery(draft.jobs,job,batch.ads,committedAt);
  advance(job,{completedIds:batch.completedIds,status:batch.status,errorCode:batch.errorCode,exhausted:batch.coverage.exhausted,nextUrl:batch.nextUrl},committedAt);
  const delay=restrictionDelay(batch.errorCode,draft.restrictionCount+1);
  if(delay){draft.restrictionCount++;draft.pauseUntil=Math.max(draft.pauseUntil,committedAt+Math.max(delay,batch.retryAfterMs??0));}
  else if(['SUCCEEDED','NO_RESULTS'].includes(batch.status)&&draft.pauseUntil<=committedAt){draft.restrictionCount=0;draft.pauseUntil=0;}
  draft.nextBatchAt=Math.max(draft.nextBatchAt,committedAt+600000);
  draft.lastResult={query:batch.query,status:batch.status,errorCode:batch.errorCode,ads:batch.ads.length,coverage:batch.coverage,report:reports[0],at:new Date(committedAt).toISOString()};
 }});
}
