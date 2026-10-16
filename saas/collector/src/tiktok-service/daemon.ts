import {applyControlModeHandoff} from '../dispatch/control-handoff';
import {dispatchFromEnvironment,managedPendingIngest,managedCheckpointBarrier,runManagedLoop,type ManagedState} from '../dispatch/managed-runtime';
import {nextJob} from './queue';
import { readFile, mkdir, chmod, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { collectBatch, discoverCountries } from './browser';
import { planJobs,type MediaRefreshCandidate } from './queue';
import { runOnce, recoverTikTokPending, saveState, recordServiceError, type RuntimeState } from './runtime';
import { acquireProcessLock, atomic } from './store';

const {values}=parseArgs({options:{once:{type:'boolean'},resume:{type:'boolean'},'recover-only':{type:'boolean'},'apply-control-mode':{type:'boolean'},help:{type:'boolean'}}});
if(values.resume&&(values['recover-only']||values['apply-control-mode'])||values['recover-only']&&values['apply-control-mode'])throw Error('RECOVERY_MODE_CONFLICT');
if(values.help){console.log('TikTok independent collector [--once] [--resume] [--recover-only] [--apply-control-mode]\nEnvironment: TIKTOK_STATE_DIR, DATABASE_URL; optional TIKTOK_INTERVAL_MS (120000), TIKTOK_LOOKBACK_DAYS (30), TIKTOK_BROWSER_CHANNEL (chromium), TIKTOK_PRISMA_PACKAGE. --resume clears a manually resolved source restriction; use only while service is stopped.');process.exit(0);}
const root=resolve(process.env.TIKTOK_STATE_DIR??'/data');
const interval=Number(process.env.TIKTOK_INTERVAL_MS??120000),lookbackDays=Number(process.env.TIKTOK_LOOKBACK_DAYS??30),refreshScanInterval=Number(process.env.TIKTOK_MEDIA_REFRESH_SCAN_MS??3600000);
if(!Number.isInteger(interval)||interval<30000||interval>86400000||!Number.isInteger(lookbackDays)||lookbackDays<2||lookbackDays>365||!Number.isInteger(refreshScanInterval)||refreshScanInterval<3600000||refreshScanInterval>86400000)throw Error('TIKTOK_CONFIG_INVALID');
// The daemon owns graceful shutdown; Playwright must not close a live batch first.
const options={channel:process.env.TIKTOK_BROWSER_CHANNEL??'chromium',handleSignals:false};
const log=(event:string,data:unknown)=>console.log(JSON.stringify({at:new Date().toISOString(),event,data}));
const safeCode=(error:unknown)=>error instanceof Error&&/^[A-Z_0-9]+$/.test(error.message)?error.message:'TIKTOK_SERVICE_ERROR';
type State=RuntimeState&ManagedState&{catalogAt?:string;catalog?:string[];catalogError?:string};
let stopping=false;
const waitController=new AbortController();
process.on('SIGTERM',()=>{stopping=true;waitController.abort();});process.on('SIGINT',()=>{stopping=true;waitController.abort();});
const wait=async(ms:number)=>{await sleep(ms,undefined,{signal:waitController.signal}).catch(()=>{});};
async function main(){
 await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);
 const unlock=await acquireProcessLock(root);
 const {PrismaClient}=createRequire(process.env.TIKTOK_PRISMA_PACKAGE??'/opt/ad-research/app/package.json')('@prisma/client');
 const db=new PrismaClient();let state:State;
 try{
  try{state=JSON.parse(await readFile(join(root,'state.json'),'utf8'));if(state.schema!==1||!Array.isArray(state.jobs)||!Number.isFinite(state.pauseUntil))throw Error('TIKTOK_STATE_INVALID');}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;if(values['recover-only']||values['apply-control-mode'])throw Error('RECOVERY_STATE_REQUIRED');state={schema:1,jobs:[],pauseUntil:0,updatedAt:new Date().toISOString()};}
  if(values.resume){delete state.manualPause;state.pauseUntil=0;await saveState(root,state);log('restriction_resumed',{});}
  const dispatch=dispatchFromEnvironment(root,'tiktok',state,{forControlHandoff:values['apply-control-mode']});if(dispatch&&!values['apply-control-mode'])state.controlMode=dispatch.mode;
  const legacyIngest=async(raw:string)=>{const rows=await db.$queryRawUnsafe('SELECT tiktok_collector.ingest($1::text) AS result',raw);return rows[0].result;};
  const ingest=dispatch?managedPendingIngest({platform:'tiktok',root,state,forceManagedRecovery:!!dispatch.handoff,client:dispatch.client,legacyIngest}):legacyIngest;
  const refreshCandidates=async():Promise<MediaRefreshCandidate[]>=>{const rows=await db.$queryRawUnsafe('SELECT tiktok_collector.media_refresh_candidates(2) AS result');return rows[0].result;};
  if(values['apply-control-mode']){if(!dispatch?.handoff)throw Error('COLLECTOR_HANDOFF_MODE_REQUIRED');state=await applyControlModeHandoff(state,{root,platform:'tiktok',nodeId:dispatch.context.nodeId,incarnationId:dispatch.context.incarnationId,toMode:dispatch.handoff.toMode,context:dispatch.context,client:dispatch.client,recover:async()=>{while((await recoverTikTokPending(state,{root,ingest,beforePersist:managedCheckpointBarrier({root,platform:'tiktok',nodeId:dispatch.context.nodeId,incarnationId:dispatch.context.incarnationId,sequenceRoot:dispatch.context.sequenceRoot,client:dispatch.client})})).status==='COMMITTED'){}},heartbeat:()=>dispatch.client.heartbeat({codeRevision:dispatch.codeRevision,capabilityDigest:dispatch.capabilityDigest,resourceSnapshot:{maxSlots:1,platform:'tiktok',sourceCallsActive:false}}),persist:next=>atomic(join(root,'state.json'),next)});return;}
  if(values['recover-only']){while((await recoverTikTokPending(state,{root,ingest,beforePersist:dispatch?managedCheckpointBarrier({root,platform:'tiktok',nodeId:dispatch.context.nodeId,incarnationId:dispatch.context.incarnationId,sequenceRoot:dispatch.context.sequenceRoot,client:dispatch.client}):undefined})).status==='COMMITTED'){}return;}
  if(dispatch){await runManagedLoop({root,platform:'tiktok',dispatch,getState:()=>state,setState:next=>{state=next;},persist:async next=>{state=next;await saveState(root,state);},commit:()=>recoverTikTokPending(state,{root,beforePersist:managedCheckpointBarrier({root,platform:'tiktok',nodeId:dispatch.context.nodeId,incarnationId:dispatch.context.incarnationId,sequenceRoot:dispatch.context.sequenceRoot,client:dispatch.client}),ingest:raw=>managedPendingIngest({platform:'tiktok',root,state,forceManagedRecovery:!!dispatch.handoff,client:dispatch.client,legacyIngest})(raw)}),next:nextJob,collect:(job,guard)=>collectBatch(job,{...options,guard,signal:guard.signal,maxMs:Math.max(1000,Math.min(240000,guard.remainingMs()))}),paused:(s,now)=>!!s.manualPause||s.pauseUntil>now,stopping:()=>stopping,signal:waitController.signal,wait,once:values.once,log:code=>log('error',{code})});return;}
  while(!stopping){
   try{
    // Orphan staging and unconfirmed legacy receipts block catalog discovery too.
    const recovered=await recoverTikTokPending(state,{root,ingest});
    if(recovered.status==='COMMITTED'){log('batch',state.lastResult);if(values.once)break;await wait(interval);continue;}
    const today=new Date().toISOString().slice(0,10);
    // A durable pending commit takes priority over all source access and discovery.
    if(!state.pending&&!state.manualPause&&state.pauseUntil<=Date.now()){
     const disk=await statfs(root);if(disk.bavail*disk.bsize<2*1024**3)throw Error('TIKTOK_DISK_SPACE_LOW');
     if(state.catalogAt!==today){
      const countries=await discoverCountries(options),previous=new Set(state.catalog??[]),existing=new Set(state.jobs.map(j=>j.id));
      for(const country of countries)for(const job of planJobs([country],{lookbackDays:previous.has(country)?2:lookbackDays}))if(!existing.has(job.id)){state.jobs.push(job);existing.add(job.id);}
      state.catalog=countries;state.catalogAt=today;delete state.catalogError;await saveState(root,state);log('catalog',{countries:countries.length,jobs:state.jobs.length});
     }
    }
    const result=await runOnce(state,{root,collect:job=>collectBatch(job,options),ingest,refreshCandidates,refreshScanIntervalMs:refreshScanInterval});
    if(result.status==='COMMITTED')log('batch',state.lastResult);
    if(values.once)break;
    await wait(result.status==='COMMITTED'?interval:15000);
   }catch(error){recordServiceError(state,error);const code=state.serviceError!.code;state.catalogError=code;await saveState(root,state).catch(()=>{});log('error',{code});if(values.once){process.exitCode=2;break;}await wait(60000);}
  }
 }finally{await db.$disconnect();await unlock();}
}
main().catch(e=>{log('fatal',{code:safeCode(e)});process.exitCode=1;});
