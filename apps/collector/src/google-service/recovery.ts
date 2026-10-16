import {join} from 'node:path';
import {recoverPendingOnly,atomic,type RecoveryState,type BeforeRecoveryPersist} from '../dispatch/pending-envelope';
import {applyResult,discover,restrictionDelay,lane,type Job,type Kind,type FamilyTurn} from './queue';
import type {Batch} from './browser';
export interface GoogleRecoveryState extends RecoveryState {schema:1;jobs:Job[];pauses:Record<'SERP'|'ATC',number>;restrictions:Record<'SERP'|'ATC',number>;pauseReasons:Record<string,string>;lastKind?:Kind;nextBatchAt?:number;lastResult?:unknown;updatedAt:string;lastSeedFamily?:FamilyTurn}
export async function recoverGooglePending(state:GoogleRecoveryState,deps:{root:string;ingest:(raw:string)=>Promise<unknown>;now?:()=>number;beforePersist?:BeforeRecoveryPersist<GoogleRecoveryState>;persist?:(state:GoogleRecoveryState)=>Promise<void>}){
 const now=deps.now??Date.now;
 return recoverPendingOnly<GoogleRecoveryState,Batch>('google',state,{...deps,persist:deps.persist??(async draft=>{draft.updatedAt=new Date(now()).toISOString();await atomic(join(deps.root,'state.json'),draft);}),apply:(draft,envelope,reports,committedAt)=>{
  const job=draft.jobs.find(j=>j.id===envelope.pending.jobId);if(!job)throw Error('PENDING_JOB_MISSING');
  const batch=envelope.batchView;
  applyResult(job,{completedIds:batch.completedIds,status:batch.status,errorCode:batch.errorCode,exhausted:batch.coverage.exhausted,cursor:batch.cursor},committedAt);
  discover(draft.jobs,job,batch.advertisers,batch.domains);
  const scope=lane(job),delay=restrictionDelay(batch.errorCode,draft.restrictions[scope]+1);
  if(delay){draft.restrictions[scope]++;draft.pauses[scope]=Math.max(draft.pauses[scope],committedAt+(scope==='SERP'?86400000:delay));draft.pauseReasons[scope]=batch.errorCode!;}
  else if(['SUCCEEDED','NO_RESULTS'].includes(batch.status)&&draft.pauses[scope]<=committedAt){draft.restrictions[scope]=0;draft.pauses[scope]=0;delete draft.pauseReasons[scope];}
  draft.lastKind=job.kind;draft.lastSeedFamily=job.seedFamily??'GENERAL';draft.nextBatchAt=Math.max(draft.nextBatchAt??0,committedAt+120000);
  draft.lastResult={query:batch.query,status:batch.status,errorCode:batch.errorCode,ads:batch.ads.length,advertisers:batch.advertisers.length,coverage:batch.coverage,report:reports[0],at:new Date(committedAt).toISOString()};
 }});
}
