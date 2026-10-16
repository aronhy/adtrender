import {applyControlModeHandoff} from '../dispatch/control-handoff';
import {dispatchFromEnvironment,managedPendingIngest,managedCheckpointBarrier,runManagedLoop,type ManagedState} from '../dispatch/managed-runtime';
import {readFile,mkdir,statfs} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {collectSweepPage,discoverPinterest} from './sweep-adapter';
import {planSweep,nextShard} from './sweep';
import {atomic,saveArchivedPending} from '../dispatch/pending-envelope';
import {recoverPinterestPending,type PinterestRecoveryState} from './recovery';
const root=process.env.PINTEREST_STATE_DIR??'/data';
const require=createRequire('/opt/ad-research/app/package.json');const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();
type State=PinterestRecoveryState&ManagedState;
let dispatch:ReturnType<typeof dispatchFromEnvironment>;
let stopping=false;const halt=new AbortController();const wait=async(ms:number)=>sleep(ms,undefined,{signal:halt.signal}).catch(()=>{});process.on('SIGTERM',()=>{stopping=true;halt.abort();});process.on('SIGINT',()=>{stopping=true;halt.abort();});
const log=(event:string,data:unknown)=>console.log(JSON.stringify({at:new Date().toISOString(),event,data}));
let state:State;
async function save(){state.updatedAt=new Date().toISOString();await atomic(join(root,'state.json'),state);await atomic(join(root,'status.json'),{updatedAt:state.updatedAt,enabled:true,scope:'all-public-countries-all-categories-no-advertiser-filter',countries:state.catalog.countries.length,categories:state.catalog.categories.length,shards:state.jobs.length,completed:state.jobs.filter(j=>j.complete).length,failed:state.jobs.filter(j=>j.failures>0).length,pending:state.pending?.jobId,pauseUntil:state.pauseUntil,lastResult:state.lastResult});}
async function commitPending(){
 const result=await recoverPinterestPending(state,{root,beforePersist:dispatch?managedCheckpointBarrier({root,platform:'pinterest',nodeId:dispatch.context.nodeId,incarnationId:dispatch.context.incarnationId,sequenceRoot:dispatch.context.sequenceRoot,client:dispatch.client}):undefined,ingest:async raw=>{const legacyIngest=async(raw:string)=>(await db.$queryRawUnsafe('SELECT pinterest_collector.ingest($1::text) AS result',raw))[0].result;return dispatch?managedPendingIngest({platform:'pinterest',root,state,forceManagedRecovery:!!dispatch.handoff,client:dispatch.client,legacyIngest})(raw):legacyIngest(raw);}});
 if(result.status==='IDLE')return false;await save();log('batch',state.lastResult);return true;
}
async function main(){const controlHandoff=process.argv.includes('--apply-control-mode');if(controlHandoff&&process.argv.includes('--recover-only'))throw Error('RECOVERY_MODE_CONFLICT');
 await mkdir(root,{recursive:true,mode:0o700});
 try{state=JSON.parse(await readFile(join(root,'state.json'),'utf8'));if(state.schema!==1)throw Error('STATE_VERSION');}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;if(process.argv.includes('--recover-only')||process.argv.includes('--apply-control-mode'))throw Error('RECOVERY_STATE_REQUIRED');const catalog=process.env.COLLECTOR_CONTROL_MODE?{countries:[],categories:[]}:await discoverPinterest();const today=new Date().toISOString().slice(0,10);const first=new Date(Date.parse(today)-365*86400000).toISOString().slice(0,10);state={schema:1,catalog,jobs:process.env.COLLECTOR_CONTROL_MODE?[]:planSweep(catalog.countries.map(c=>c.code),first,today),lastDaily:today,updatedAt:new Date().toISOString()};await save();log('initialized',{countries:catalog.countries.length,categories:catalog.categories,shards:state.jobs.length,start:first,end:today});}
 dispatch=dispatchFromEnvironment(root,'pinterest',state,{forControlHandoff:controlHandoff});if(dispatch&&!controlHandoff)state.controlMode=dispatch.mode;
 while(await commitPending()){}
 if(controlHandoff){if(!dispatch?.handoff)throw Error('COLLECTOR_HANDOFF_MODE_REQUIRED');state=await applyControlModeHandoff(state,{root,platform:'pinterest',nodeId:dispatch.context.nodeId,incarnationId:dispatch.context.incarnationId,toMode:dispatch.handoff.toMode,context:dispatch.context,client:dispatch.client,recover:async()=>{while(await commitPending()){}},heartbeat:()=>dispatch!.client.heartbeat({codeRevision:dispatch!.codeRevision,capabilityDigest:dispatch!.capabilityDigest,resourceSnapshot:{maxSlots:1,platform:'pinterest',sourceCallsActive:false}}),persist:next=>atomic(join(root,'state.json'),next)});await db.$disconnect();return;}
 if(process.argv.includes('--recover-only')){await db.$disconnect();return;}
 if(dispatch){await runManagedLoop({root,platform:'pinterest',dispatch,getState:()=>state,setState:next=>{state=next;},persist:async next=>{state=next;await save();},next:nextShard,collect:(job,guard)=>collectSweepPage(job,{guard,signal:guard.signal}),paused:(s,now)=>(s.pauseUntil??0)>now,commit:commitPending,stopping:()=>stopping,signal:halt.signal,wait,once:process.argv.includes('--once'),log:code=>log('error',{code})});await db.$disconnect();return;}
 while(!stopping){
  try{
   await commitPending();if(stopping)break;
   if((state.pauseUntil??0)>Date.now()){await sleep(15000);continue;}
   const today=new Date().toISOString().slice(0,10);
   if(today!==state.lastDaily){const catalog=await discoverPinterest();const yesterday=new Date(Date.parse(today)-86400000).toISOString().slice(0,10);const fresh=planSweep(catalog.countries.map(c=>c.code),yesterday,today);const missing=catalog.countries.filter(c=>!state.catalog.countries.some(old=>old.code===c.code));const extra=missing.length?planSweep(missing.map(c=>c.code),new Date(Date.parse(today)-365*86400000).toISOString().slice(0,10),today):[];state.jobs.unshift(...fresh,...extra);state.catalog=catalog;state.lastDaily=today;await save();}
   if((state.pauseUntil??0)>Date.now()){await sleep(15000);continue;}
   const disk=await statfs(root);if(disk.bavail*disk.bsize<2*1024**3)throw Error('DISK_SPACE_LOW');
   const job=nextShard(state.jobs,Date.now());if(!job){await sleep(15000);continue;}
   job.lastAttemptAt=Date.now();await save();log('collecting',{job:job.id,page:job.page});
   const result=await collectSweepPage(job);state.pending=await saveArchivedPending(root,'pinterest',job.id,result);await save();await commitPending();
   await sleep(15000);
  }catch(e){log('error',{code:e instanceof Error&&/^[A-Z_]+$/.test(e.message)?e.message:'SERVICE_ERROR'});await sleep(60000);}
 }
 await db.$disconnect();
}
main().catch((e)=>{log('fatal',{code:'INITIALIZATION_FAILED',kind:e instanceof Error?e.name:'unknown',detail:e instanceof Error&&e.name==='TimeoutError'?'SOURCE_TIMEOUT':undefined});process.exitCode=1;});
