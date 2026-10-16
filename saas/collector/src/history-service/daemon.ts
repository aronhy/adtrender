import {createRequire} from 'node:module';import {mkdir,statfs} from 'node:fs/promises';import {dirname,join,resolve} from 'node:path';import {setTimeout as sleep} from 'node:timers/promises';
import {collectTarget} from './collector';import {atomic,saveResult,loadPending,pendingRaw,clearPending} from './store';import type {Target} from './types';
const root=resolve(process.env.HISTORY_STATE_DIR??'/data');
// Deployed bundle runs next to the app's existing pinned Prisma client.
const {PrismaClient}=createRequire(process.env.HISTORY_APP_PACKAGE??'/opt/ad-research/app/package.json')('@prisma/client');
const db=new PrismaClient();let stopping=false;const halt=new AbortController();
process.on('SIGTERM',()=>{stopping=true;halt.abort();});process.on('SIGINT',()=>{stopping=true;halt.abort();});
const log=(event:string,data:unknown)=>console.log(JSON.stringify({at:new Date().toISOString(),event,data}));
async function rpc(name:'seed'|'claim'|'status'){return (await db.$queryRawUnsafe(`SELECT history_collector.${name}() AS result`))[0].result;}
async function commit(){const p=await loadPending(root);if(!p)return;try{const report=(await db.$queryRawUnsafe('SELECT history_collector.finish($1::uuid,$2::uuid,$3::text) AS result',p.attemptId,p.leaseToken,await pendingRaw(root,p)))[0].result;await clearPending(root);log('attempt_completed',{attemptId:p.attemptId,...report});}catch(e){const msg=e instanceof Error?e.message:'';if(/(?:BATCH_INVALID|AD_INVALID|AD_EVIDENCE_INVALID|MEDIA_INVALID|STATUS_INVALID|COUNTRIES_INVALID|EVIDENCE_INVALID|TIME_INVALID|STABLE_CREATIVE_REQUIRED)/.test(msg)){
 // A deterministic native validation rejection is an attempt failure. Preserve
 // the original evidence envelope before replacing the pending commit payload.
 await atomic(join(dirname(p.resultFile),'ingest-rejected.json'),await pendingRaw(root,p));
 await saveResult(root,{attemptId:p.attemptId,leaseToken:p.leaseToken} as Target,{outcome:'FAILED',errorCode:'HISTORY_NATIVE_INGEST_REJECTED'});
 log('attempt_rejected',{attemptId:p.attemptId,code:'HISTORY_NATIVE_INGEST_REJECTED'});return commit();
 }if(/HISTORY_LEASE_EXPIRED|HISTORY_ATTEMPT_FINISHED/.test(msg)){await clearPending(root);log('attempt_archive_retained',{attemptId:p.attemptId,code:'LEASE_EXPIRED_OR_ALREADY_FINISHED'});return;}throw e;}}
async function status(){const s=await rpc('status');await atomic(join(root,'status.json'),JSON.stringify(s));return s;}
async function main(){
 await mkdir(root,{recursive:true,mode:0o700});
 if(process.argv.includes('--status')){console.log(JSON.stringify(await rpc('status')));return;}
 if(process.argv.includes('--seed')){console.log(JSON.stringify(await rpc('seed')));return;}
 if(process.argv.includes('--recover-only')){await commit();return;}
 let seedAt=0;
 do{
  try{
   await commit();if(stopping)break;
   if(Date.now()>=seedAt){log('seed',await rpc('seed'));seedAt=Date.now()+3600000;}
   const disk=await statfs(root);if(disk.bavail*disk.bsize<2*1024**3)throw Error('DISK_SPACE_LOW');
   const target=await rpc('claim') as Target|null;
   if(target){const allowed=(await db.$queryRawUnsafe('SELECT history_collector.legacy_source_allowed($1::text) AS result',target.sourceKey))[0].result;log('attempt_started',{attemptId:target.attemptId,sourceKey:target.sourceKey});let result=allowed?await collectTarget(target,{signal:halt.signal,maxMs:90000}):{outcome:'FAILED' as const,errorCode:'HISTORY_MANAGED_SOURCE_BLOCKED'};try{await saveResult(root,target,result);}catch(e){if(!(e instanceof Error)||e.message!=='HISTORY_EVIDENCE_BUDGET')throw e;result={outcome:'FAILED',errorCode:'HISTORY_EVIDENCE_BUDGET'};await saveResult(root,target,result);}await commit();}
   await status();
  }catch(e){const msg=e instanceof Error?e.message:'';log('error',{code:/^[A-Z_0-9]{3,100}$/.test(msg)?msg:'HISTORY_SERVICE_ERROR'});}
  if(process.argv.includes('--once')||stopping)break;
  await sleep(15000,undefined,{signal:halt.signal}).catch(()=>{});
 }while(!stopping);
}
main().catch(()=>{log('fatal',{code:'HISTORY_INITIALIZATION_FAILED'});process.exitCode=1;}).finally(()=>db.$disconnect());
