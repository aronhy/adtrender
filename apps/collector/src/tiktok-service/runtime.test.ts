import {afterEach,expect,it} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {nextJob,planJobs} from './queue';
import {managedJobs} from '../dispatch/managed-runtime';
import {runOnce,recoverTikTokPending,recordServiceError,saveState,type RuntimeState,type RuntimeBatch} from './runtime';
import {savePending} from './store';
const roots:string[]=[];const now=Date.parse('2026-10-07T00:00:00Z');
async function setup(){const root=await mkdtemp(join(tmpdir(),'tiktok-runtime-'));roots.push(root);const state:RuntimeState={schema:1,jobs:planJobs(['GB'],{now,lookbackDays:1}),pauseUntil:0,updatedAt:new Date(now).toISOString()};return {root,state};}
const batch=(overrides:Partial<RuntimeBatch>={}):RuntimeBatch=>({status:'SUCCEEDED',errorCode:null,completedIds:['123'],coverage:{exhausted:true},...overrides});
it('recovery-only with no pending remains idle without queue refresh or initialization',async()=>{
 const {root,state}=await setup(),before=structuredClone(state);
 expect(await recoverTikTokPending(state,{root,now:()=>now+86400000,ingest:async()=>{throw Error('NO_PENDING');}})).toEqual({status:'IDLE'});
 expect(state).toEqual(before);
});
it('does not increment failures or extend Retry-After when a committed failed batch is replayed twice',async()=>{
 const {root,state}=await setup();
 const pending=await savePending(root,state.jobs[0].id,batch({status:'FAILED',errorCode:'TIKTOK_HTTP_429',completedIds:[],retryAfterMs:7200000,coverage:{exhausted:false}}));
 state.pending=pending;
 let time=now;
 const deps={root,now:()=>time,collect:async()=>{throw Error('RECOVERY_MUST_NOT_COLLECT');},ingest:async()=>({status:'ALREADY_IMPORTED',runId:'original-run',inserted:0,updated:0,originalInserted:3,originalUpdated:2,committedAt:new Date(now).toISOString()})};
 await runOnce(state,deps);
 expect(state.jobs[0].failures).toBe(1);expect(state.pauseUntil).toBe(now+7200000);
 state.pending=pending;time+=86400000;
 await runOnce(state,deps);
 expect(state.jobs[0].failures).toBe(1);expect(state.pauseUntil).toBe(now+7200000);
});
it('recovers a staged archive with no state.pending before media scans or collection',async()=>{
 const {root,state}=await setup();
 await savePending(root,state.jobs[0].id,batch());
 const result=await runOnce(state,{root,now:()=>now,refreshCandidates:async()=>{throw Error('RECOVERY_MUST_NOT_SCAN');},collect:async()=>{throw Error('RECOVERY_MUST_NOT_COLLECT');},ingest:async()=>({status:'IMPORTED',runId:'original-run',originalInserted:0,originalUpdated:0,committedAt:new Date(now).toISOString()})});
 expect(result.status).toBe('COMMITTED');expect(state.jobs[0].seen).toEqual(['123']);
});
afterEach(async()=>{await Promise.all(roots.splice(0).map(r=>rm(r,{recursive:true,force:true})));});
it('persists catalog restrictions and exposes service errors without raw exception text',async()=>{
 const {root,state}=await setup();
 recordServiceError(state,Object.assign(Error('TIKTOK_RATE_LIMITED'),{retryAfterMs:7200000}),now);
 expect(state.pauseUntil).toBe(now+7200000);
 recordServiceError(state,Error('TIKTOK_ACCESS_BLOCKED'),now);
 expect(state.manualPause?.reason).toBe('TIKTOK_ACCESS_BLOCKED');
 delete state.manualPause;state.pauseUntil=0;
 recordServiceError(state,Error('database password=should-never-appear'),now);
 await saveState(root,state,now);
 const status=await readFile(join(root,'status.json'),'utf8');
 expect(JSON.parse(status).state).toBe('ERROR');expect(status).not.toContain('should-never-appear');
});
it('persists archive and pending before ingest, then advances only after commit',async()=>{
 const {root,state}=await setup();
 const result=await runOnce(state,{root,now:()=>now,collect:async()=>batch(),ingest:async raw=>{
  const saved=JSON.parse(await readFile(join(root,'state.json'),'utf8')) as RuntimeState;
  expect(saved.pending).toBeDefined();expect(saved.jobs[0].seen).toEqual([]);expect(saved.jobs[0].complete).toBe(false);
  expect(await readFile(saved.pending!.file,'utf8')).toBe(raw);return {status:'IMPORTED',runId:'original-run',originalInserted:0,originalUpdated:0,committedAt:new Date(now).toISOString()};
 }});
 expect(result.status).toBe('COMMITTED');expect(state.jobs[0]).toMatchObject({seen:['123'],complete:true});expect(state.pending).toBeUndefined();
 const status=JSON.parse(await readFile(join(root,'status.json'),'utf8'));expect(status).toMatchObject({state:'RUNNING',completedJobs:1});
});
it('replays pending after database failure and restart without collecting again',async()=>{
 const {root,state}=await setup();let first='';
 await expect(runOnce(state,{root,now:()=>now,collect:async()=>batch(),ingest:async raw=>{first=raw;throw Error('DATABASE_DOWN');}})).rejects.toThrow('DATABASE_DOWN');
 expect(state.jobs[0].seen).toEqual([]);expect(state.jobs[0].complete).toBe(false);
 const recovered=JSON.parse(await readFile(join(root,'state.json'),'utf8')) as RuntimeState;
 const result=await runOnce(recovered,{root,now:()=>now+1000,collect:async()=>{throw Error('MUST_REPLAY_PENDING');},ingest:async raw=>{expect(raw).toBe(first);return {status:'ALREADY_IMPORTED',runId:'original-run',originalInserted:0,originalUpdated:0,committedAt:new Date(now).toISOString()};}});
 expect(result.status).toBe('COMMITTED');expect(recovered.jobs[0].complete).toBe(true);
});
it('keeps a complete retryable checkpoint when a partial collection is committed',async()=>{
 const {root,state}=await setup();
 await runOnce(state,{root,now:()=>now,collect:async()=>batch({status:'PARTIAL',errorCode:'TIKTOK_TIMEOUT',nextPage:2}),ingest:async()=>({status:'IMPORTED',runId:'original-run',originalInserted:0,originalUpdated:0,committedAt:new Date(now).toISOString()})});
 expect(state.jobs[0]).toMatchObject({seen:['123'],page:0,complete:false,failures:1});
});
it('persists a manual pause after challenge and never collects until explicit resume',async()=>{
 const {root,state}=await setup();
 await runOnce(state,{root,now:()=>now,collect:async()=>batch({status:'FAILED',errorCode:'TIKTOK_SOURCE_CHALLENGE',completedIds:[],coverage:{exhausted:false}}),ingest:async()=>({status:'IMPORTED',runId:'original-run',originalInserted:0,originalUpdated:0,committedAt:new Date(now).toISOString()})});
 expect(state.manualPause).toEqual({reason:'TIKTOK_SOURCE_CHALLENGE',since:now});
 const result=await runOnce(state,{root,now:()=>now+86400000,collect:async()=>{throw Error('MUST_STAY_PAUSED');},ingest:async()=>{throw Error('NOTHING_PENDING');}});
 expect(result.status).toBe('PAUSED');
});
it('pauses every country for Retry-After and publishes a fresh status heartbeat',async()=>{
 const {root,state}=await setup();state.jobs=planJobs(['GB','DE'],{now,lookbackDays:1});
 await runOnce(state,{root,now:()=>now,collect:async()=>batch({status:'FAILED',errorCode:'TIKTOK_HTTP_429',completedIds:[],retryAfterMs:7200000,coverage:{exhausted:false}}),ingest:async()=>({status:'IMPORTED',runId:'original-run',originalInserted:0,originalUpdated:0,committedAt:new Date(now).toISOString()})});
 expect(state.pauseUntil).toBe(now+7200000);
 const result=await runOnce(state,{root,now:()=>now+1000,collect:async()=>{throw Error('MUST_NOT_SWITCH_COUNTRY');},ingest:async()=>{throw Error('NO_PENDING');}});
 expect(result.status).toBe('COOLDOWN');
 const status=JSON.parse(await readFile(join(root,'status.json'),'utf8'));expect(status).toMatchObject({state:'COOLDOWN',updatedAt:'2026-10-07T00:00:01.000Z'});
});
it('backs off unexpected collector exceptions and clears a stale active heartbeat without inventing a successful batch',async()=>{
 const {root,state}=await setup();
 await expect(runOnce(state,{root,now:()=>now,collect:async job=>{job.seen.push('NEVER_COMMITTED');throw Error('transport unavailable');},ingest:async()=>{throw Error('NO_BATCH_TO_IMPORT');}})).rejects.toThrow('transport unavailable');
 expect(state.activeJobId).toBeUndefined();expect(state.pending).toBeUndefined();expect(state.jobs[0]).toMatchObject({seen:[],complete:false,failures:1,retryAt:now+60000});
 const recovered=JSON.parse(await readFile(join(root,'state.json'),'utf8')) as RuntimeState;
 expect(recovered.activeJobId).toBeUndefined();expect(recovered.jobs[0].error).toBe('TIKTOK_COLLECTION_EXCEPTION');
});
it('keeps pending and checkpoint unchanged when ingestion resolves without a committed receipt',async()=>{
 const {root,state}=await setup();
 await expect(runOnce(state,{root,now:()=>now,collect:async()=>batch(),ingest:async()=>({status:'DRY_RUN_ROLLED_BACK'})})).rejects.toThrow('TIKTOK_COMMIT_UNCONFIRMED');
 expect(state.pending).toBeDefined();expect(state.jobs[0]).toMatchObject({seen:[],complete:false});
});
it.each(['TIKTOK_REPLAY_BUDGET','TIKTOK_TIME_BUDGET'])('splits a committed empty %s window into two overlapping country-preserving children',async errorCode=>{
 const {root,state}=await setup();state.jobs=planJobs(['GB'],{now,start:'2026-09-30',end:'2026-10-07'});
 const parent=state.jobs[0];parent.seen=['PREVIOUSLY_COMMITTED'];parent.page=20;
 await runOnce(state,{root,now:()=>now,collect:async()=>batch({status:'PARTIAL',errorCode,completedIds:[],coverage:{exhausted:false}}),ingest:async()=>({status:'IMPORTED',runId:'original-run',originalInserted:0,originalUpdated:0,committedAt:new Date(now).toISOString()})});
 expect(parent).toMatchObject({superseded:true,complete:false,seen:['PREVIOUSLY_COMMITTED'],page:20});
 expect(state.jobs.slice(1).map(j=>({id:j.id,country:j.country,start:j.start,end:j.end,seen:j.seen,complete:j.complete}))).toEqual([
  {id:'GB:2026-09-30:2026-10-03',country:'GB',start:'2026-09-30',end:'2026-10-03',seen:[],complete:false},
  {id:'GB:2026-10-03:2026-10-07',country:'GB',start:'2026-10-03',end:'2026-10-07',seen:[],complete:false},
 ]);
 const status=JSON.parse(await readFile(join(root,'status.json'),'utf8'));expect(status).toMatchObject({supersededJobs:1,completedJobs:0});
});
it.each((['CONFIG_QUEUE','TASK_CLAIM','LEGACY_QUEUE'] as const).flatMap(controlMode=>['TIKTOK_REPLAY_BUDGET','TIKTOK_TIME_BUDGET'].map(errorCode=>({controlMode,errorCode}))))('keeps the published parent retryable after $errorCode commits in $controlMode',async({controlMode,errorCode})=>{
 const {root,state}=await setup();state.jobs=planJobs(['GB'],{now,start:'2026-09-30',end:'2026-10-07'});
 const parent=state.jobs[0],delay=7200000;parent.page=20;parent.seen=['PREVIOUSLY_COMMITTED'];parent.failures=2;parent.retryAt=now+delay;state.pauseUntil=now+delay;
 const managed=Object.assign(state,{controlMode,seedConfig:{revision:1,publicationId:'33333333-3333-4333-8333-333333333333',contentHash:'a'.repeat(64),queries:[],mappings:[],enabledIds:[parent.id]}});
 const pending=await savePending(root,parent.id,batch({status:'PARTIAL',errorCode,completedIds:[],retryAfterMs:delay,coverage:{exhausted:false}}));managed.pending=pending;
 const deps={root,now:()=>now,ingest:async()=>({status:'IMPORTED',runId:'managed-run',originalInserted:0,originalUpdated:0,committedAt:new Date(now).toISOString()})};
 expect((await recoverTikTokPending(managed,deps)).status).toBe('COMMITTED');
 expect(managed.jobs).toHaveLength(1);expect(parent).not.toHaveProperty('superseded');
 expect(parent).toMatchObject({page:20,seen:['PREVIOUSLY_COMMITTED'],complete:false,failures:3,retryAt:now+delay});expect(managed.pauseUntil).toBe(now+delay);
 expect(nextJob(managedJobs(managed),now+delay-1)).toBeUndefined();expect(nextJob(managedJobs(managed),now+delay)?.id).toBe(parent.id);
 const saved=JSON.parse(await readFile(join(root,'state.json'),'utf8'));expect(saved.jobs).toHaveLength(1);expect(saved.jobs[0]).not.toHaveProperty('superseded');
 managed.pending=pending;await recoverTikTokPending(managed,deps);expect(managed.jobs).toHaveLength(1);expect(parent.failures).toBe(3);
});
it('does not split a budget-limited window before database commit or duplicate its children on replay',async()=>{
 const {root,state}=await setup();state.jobs=planJobs(['GB'],{now,start:'2026-10-01',end:'2026-10-07'});
 const deps={root,now:()=>now,collect:async()=>batch({status:'PARTIAL' as const,errorCode:'TIKTOK_REPLAY_BUDGET',completedIds:[],coverage:{exhausted:false}})};
 await expect(runOnce(state,{...deps,ingest:async()=>{throw Error('DATABASE_DOWN');}})).rejects.toThrow('DATABASE_DOWN');
 expect(state.jobs).toHaveLength(1);expect(state.jobs[0]).not.toHaveProperty('superseded');
 const pending=state.pending!;const restarted=JSON.parse(await readFile(join(root,'state.json'),'utf8')) as RuntimeState;
 const replayDeps={...deps,collect:async()=>{throw Error('PENDING_MUST_REPLAY');},ingest:async()=>({status:'ALREADY_IMPORTED',runId:'original-run',originalInserted:0,originalUpdated:0,committedAt:new Date(now).toISOString()})};
 await runOnce(restarted,replayDeps);expect(restarted.jobs).toHaveLength(3);
 const recovered=JSON.parse(await readFile(join(root,'state.json'),'utf8')) as RuntimeState;
 recovered.pending=pending;await runOnce(recovered,replayDeps);
 expect(recovered.jobs).toHaveLength(3);expect(new Set(recovered.jobs.map(j=>j.id)).size).toBe(3);expect(recovered.jobs[0]).toMatchObject({superseded:true,complete:false});
});
it.each([
 {start:'2026-10-06',end:'2026-10-07',completedIds:[],errorCode:'TIKTOK_TIME_BUDGET'},
 {start:'2026-10-01',end:'2026-10-07',completedIds:['123'],errorCode:'TIKTOK_REPLAY_BUDGET'},
 {start:'2026-10-01',end:'2026-10-07',completedIds:[],errorCode:'TIKTOK_TIMEOUT'},
])('retains an unsplit retryable checkpoint for $start/$end with $errorCode and IDs $completedIds',async input=>{
 const {root,state}=await setup();state.jobs=planJobs(['DE'],{now,start:input.start,end:input.end});
 await runOnce(state,{root,now:()=>now,collect:async()=>batch({status:'PARTIAL',errorCode:input.errorCode,completedIds:input.completedIds,coverage:{exhausted:false}}),ingest:async()=>({status:'IMPORTED',runId:'original-run',originalInserted:0,originalUpdated:0,committedAt:new Date(now).toISOString()})});
 expect(state.jobs).toHaveLength(1);expect(state.jobs[0]).not.toHaveProperty('superseded');
 expect(state.jobs[0]).toMatchObject({complete:false,failures:1,retryAt:now+60000,seen:input.completedIds});
});
it('schedules one failed-material detail from a bounded scan through the existing archive and commit path',async()=>{
 const {root,state}=await setup();let scanned=0;
 const result=await runOnce(state,{root,now:()=>now,refreshCandidates:async()=>{scanned++;return [{sourceAdId:'1878345342543026',country:'GB',startDate:'2026-10-06',endDate:'2026-10-07'}];},collect:async(job:any)=>{
  expect(job.kind).toBe('MEDIA_REFRESH');expect(job.sourceAdIds).toEqual(['1878345342543026']);return batch({completedIds:['1878345342543026'],coverage:{exhausted:false}});
 },ingest:async()=>({status:'IMPORTED',runId:'original-run',originalInserted:0,originalUpdated:0,committedAt:new Date(now).toISOString()})} as any);
 expect(result.status).toBe('COMMITTED');expect(scanned).toBe(1);expect(state.jobs.find((j:any)=>j.kind==='MEDIA_REFRESH')?.complete).toBe(true);
});
it.each(['pending','manualPause','pauseUntil'])('never performs a refresh scan or detail fetch while %s takes priority',async field=>{
 const {root,state}=await setup();
 if(field==='pending'){
  await expect(runOnce(state,{root,now:()=>now,collect:async()=>batch(),ingest:async()=>{throw Error('DB_DOWN');}})).rejects.toThrow('DB_DOWN');
 }else if(field==='manualPause')state.manualPause={reason:'TIKTOK_SOURCE_CHALLENGE',since:now};
 else state.pauseUntil=now+3600000;
 const result=await runOnce(state,{root,now:()=>now,refreshCandidates:async()=>{throw Error('REFRESH_MUST_WAIT');},collect:async()=>{throw Error('DETAIL_MUST_WAIT');},ingest:async()=>({status:'ALREADY_IMPORTED',runId:'original-run',originalInserted:0,originalUpdated:0,committedAt:new Date(now).toISOString()})} as any);
 expect(result.status).toBe(field==='pending'?'COMMITTED':field==='manualPause'?'PAUSED':'COOLDOWN');
});
it('bounds repeated scans to an hour and retains the six-hour target interval',async()=>{
 const {root,state}=await setup();let scans=0,details=0,time=now;
 const deps={root,now:()=>time,refreshCandidates:async()=>{scans++;return [{sourceAdId:'1878345342543026',country:'GB',startDate:'2026-10-06',endDate:'2026-10-07'}];},collect:async(job:any)=>{if(job.kind==='MEDIA_REFRESH')details++;return batch({completedIds:job.kind==='MEDIA_REFRESH'?['1878345342543026']:['123'],coverage:{exhausted:job.kind!=='MEDIA_REFRESH'}});},ingest:async()=>({status:'IMPORTED',runId:'original-run',originalInserted:0,originalUpdated:0,committedAt:new Date(now).toISOString()})};
 await runOnce(state,deps);time+=1800000;await runOnce(state,deps);expect(scans).toBe(1);expect(details).toBe(1);
 time=now+3600000;await runOnce(state,deps);expect(scans).toBe(2);expect(details).toBe(1);
 time=now+6*3600000;await runOnce(state,deps);expect(details).toBe(2);
});
