import {applyControlModeHandoff} from '../dispatch/control-handoff';
import {dispatchFromEnvironment,managedPendingIngest,managedCheckpointBarrier,runManagedLoop,type ManagedState} from '../dispatch/managed-runtime';
import {readFile,mkdir,statfs} from 'node:fs/promises';import {join} from 'node:path';import {createRequire} from 'node:module';import {setTimeout as sleep} from 'node:timers/promises';
import {seedJobs,mergeSeedJobs,seedQueueSummary,jobLane,nextJob,prepareCycle} from './queue';
import {collectBatch} from './browser';
import {atomic,savePending} from './store';
import {recoverMetaPending,type MetaRecoveryState} from './recovery';
type State=MetaRecoveryState&ManagedState;
let dispatch:ReturnType<typeof dispatchFromEnvironment>;
const root=process.env.META_STATE_DIR??'/data',profile=join(root,'browser-profile');
const {PrismaClient}=createRequire('/opt/ad-research/app/package.json')('@prisma/client');const db=new PrismaClient();let state:State;let stopping=false;const halt=new AbortController();const wait=async(ms:number)=>sleep(ms,undefined,{signal:halt.signal}).catch(()=>{});
process.on('SIGTERM',()=>{stopping=true;halt.abort();});process.on('SIGINT',()=>{stopping=true;halt.abort();});
const log=(event:string,data:unknown)=>console.log(JSON.stringify({at:new Date().toISOString(),event,data}));
async function save(){state.updatedAt=new Date().toISOString();await atomic(join(root,'state.json'),state);await atomic(join(root,'status.json'),{updatedAt:state.updatedAt,state:state.pauseUntil>Date.now()?'COOLDOWN':state.pending?'COMMIT_PENDING':'RUNNING',...seedQueueSummary(state.jobs),countries:new Set(state.jobs.map(j=>j.country)).size,languages:new Set(state.jobs.filter(j=>!j.pageId).map(j=>j.language)).size,jobs:state.jobs.length,visitedJobs:state.jobs.filter(j=>j.lastAttemptAt>0).length,exhaustedJobs:state.jobs.filter(j=>j.exhaustedAt!==null).length,failedJobs:state.jobs.filter(j=>j.failures>0).length,pauseUntil:state.pauseUntil?new Date(state.pauseUntil).toISOString():null,pauseReason:state.pauseReason,pending:state.pending?.jobId,lastResult:state.lastResult});}
async function commit(){
 const result=await recoverMetaPending(state,{root,beforePersist:dispatch?managedCheckpointBarrier({root,platform:'meta',nodeId:dispatch.context.nodeId,incarnationId:dispatch.context.incarnationId,sequenceRoot:dispatch.context.sequenceRoot,client:dispatch.client}):undefined,ingest:async raw=>{const legacyIngest=async(raw:string)=>(await db.$queryRawUnsafe('SELECT meta_collector.ingest($1::text) AS result',raw))[0].result;return dispatch?managedPendingIngest({platform:'meta',root,state,forceManagedRecovery:!!dispatch.handoff,client:dispatch.client,legacyIngest})(raw):legacyIngest(raw);}});
 if(result.status==='IDLE')return false;
 await save();log('batch',state.lastResult);if((state.lastResult as {errorCode?:string})?.errorCode==='META_PROFILE_LOCKED')stopping=true;
 return true;
}
async function main(){const controlHandoff=process.argv.includes('--apply-control-mode');if(controlHandoff&&process.argv.includes('--recover-only'))throw Error('RECOVERY_MODE_CONFLICT');await mkdir(root,{recursive:true,mode:0o700});try{state=JSON.parse(await readFile(join(root,'state.json'),'utf8'));if(state.schema!==1)throw Error('STATE_VERSION');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;if(process.argv.includes('--recover-only')||process.argv.includes('--apply-control-mode'))throw Error('RECOVERY_STATE_REQUIRED');state={schema:1,jobs:process.env.COLLECTOR_CONTROL_MODE?[]:seedJobs(),pauseUntil:0,restrictions:0,updatedAt:new Date().toISOString()};await save();}
 dispatch=dispatchFromEnvironment(root,'meta',state,{forControlHandoff:controlHandoff});if(dispatch&&!controlHandoff)state.controlMode=dispatch.mode;
 while(await commit()){}
 if(controlHandoff){if(!dispatch?.handoff)throw Error('COLLECTOR_HANDOFF_MODE_REQUIRED');state=await applyControlModeHandoff(state,{root,platform:'meta',nodeId:dispatch.context.nodeId,incarnationId:dispatch.context.incarnationId,toMode:dispatch.handoff.toMode,context:dispatch.context,client:dispatch.client,recover:async()=>{while(await commit()){}},heartbeat:()=>dispatch!.client.heartbeat({codeRevision:dispatch!.codeRevision,capabilityDigest:dispatch!.capabilityDigest,resourceSnapshot:{maxSlots:1,platform:'meta',sourceCallsActive:false}}),persist:next=>atomic(join(root,'state.json'),next)});await db.$disconnect();return;}
 if(process.argv.includes('--recover-only')){await db.$disconnect();return;}
 if(dispatch){await runManagedLoop({root,platform:'meta',dispatch,getState:()=>state,setState:next=>{state=next;},persist:async next=>{state=next;await save();},next:(jobs,now)=>nextJob(jobs,now,state.lastLane),prepare:(job)=>prepareCycle(job),collect:(job,guard)=>collectBatch(job,profile,{guard,signal:guard.signal,maxMs:Math.max(1000,Math.min(180000,guard.remainingMs()))}),paused:(s,now)=>s.pauseUntil>now,commit,stopping:()=>stopping,signal:halt.signal,wait,once:process.argv.includes('--once'),log:code=>log('error',{code})});await db.$disconnect();return;}
 // Merge newly released keyword seeds without destroying checkpoints.
 mergeSeedJobs(state.jobs);state.lastLane??='ADVERTISER';await save();
 while(!stopping){try{await commit();if(stopping)break;if(state.pauseUntil>Date.now()){await save();await sleep(15000);continue;}const disk=await statfs(root);if(disk.bavail*disk.bsize<2*1024**3)throw Error('DISK_SPACE_LOW');const job=nextJob(state.jobs,Date.now(),state.lastLane);if(!job){await sleep(15000);continue;}prepareCycle(job);job.lastAttemptAt=Date.now();await save();log('collecting',{country:job.country,language:job.language,keyword:job.keyword,pageId:job.pageId,lane:jobLane(job),seen:job.seen.length});const batch=await collectBatch(job,profile);state.pending=await savePending(root,job.id,batch);await save();await commit();await sleep(120000);}catch(e){log('error',{code:e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'SERVICE_ERROR'});await sleep(60000);}}
 await db.$disconnect();}
main().catch(()=>{log('fatal',{code:'INITIALIZATION_FAILED'});process.exitCode=1;});
