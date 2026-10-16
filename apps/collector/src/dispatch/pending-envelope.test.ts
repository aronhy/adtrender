import {afterEach,expect,it} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as meta from '../meta-service/store';
import * as google from '../google-service/store';
import * as snapchat from '../snapchat-service/store';
import * as tiktok from '../tiktok-service/store';
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {atomic,findStagedPending,readLegacyPending,recoverPendingOnly} from './pending-envelope';
import {recoverMetaPending,type MetaRecoveryState} from '../meta-service/recovery';
import {seedJobs as metaJobs} from '../meta-service/queue';
import {recoverGooglePending,type GoogleRecoveryState} from '../google-service/recovery';
import {makeJob as googleJob} from '../google-service/queue';
import {recoverSnapchatPending,type SnapchatRecoveryState} from '../snapchat-service/recovery';
import {makeJob as snapJob} from '../snapchat-service/queue';

const roots:string[]=[];
async function setup(){const root=await mkdtemp(join(tmpdir(),'collector-envelope-'));roots.push(root);return root;}
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

it.each([['meta',meta],['google',google],['snapchat',snapchat],['tiktok',tiktok]] as const)(
 '%s retains a recoverable job binding when the process dies before saving state.pending',async(platform,store)=>{
  const root=await setup();
  const batch={version:'old-version',query:{country:'GB'},ads:[],observedAt:'2026-10-10T00:00:00Z'};
  const pending=await store.savePending(root,'native-job',batch);
  // No state.json is written: a restart must still identify this exact unit.
  const staged=JSON.parse(await readFile(join(root,'archive',platform,pending.hash,'pending.json'),'utf8'));
  expect(staged).toMatchObject({schema:1,platform,pending:{jobId:'native-job',file:pending.file,hash:pending.hash}});
  expect(await readFile(pending.file,'utf8')).toBe(JSON.stringify(batch));
 });
const at=Date.parse('2026-10-10T00:00:00Z');
const confirmed={status:'ALREADY_IMPORTED',runId:'original-run',inserted:0,updated:0,originalInserted:3,originalUpdated:2,committedAt:new Date(at).toISOString()};
it('holds original pending and progress until central checkpoint confirmation succeeds',async()=>{
 const root=await setup(),job=metaJobs()[0],pending=await meta.savePending(root,job.id,{ads:[],completedIds:['new-ad'],coverage:{exhausted:false},status:'SUCCEEDED',errorCode:null}),state:any={schema:1,jobs:[job],pending,pauseUntil:0,restrictions:0,updatedAt:new Date(at).toISOString()};
 await expect(recoverMetaPending(state,{root,ingest:async()=>confirmed,beforePersist:async()=>{throw Error('CENTRAL_CHECKPOINT_REJECTED');}} as any)).rejects.toThrow('CENTRAL_CHECKPOINT_REJECTED');
 expect(state.pending).toEqual(pending);expect(state.jobs[0].seen).toEqual([]);expect(state.appliedBatches).toBeUndefined();
});
it('reads old Meta fields through a view without changing the importer bytes or SHA',async()=>{
 const root=await setup(),job=metaJobs()[0],old={version:'meta-service-dom-1',query:{country:job.country},status:'SUCCEEDED',errorCode:null,ads:[],completedIds:[],coverage:{exhausted:false}};
 const pending=await meta.savePending(root,job.id,old),raw=await readFile(pending.file,'utf8');
 const state:MetaRecoveryState={schema:1,jobs:[job],pending,pauseUntil:0,restrictions:0,updatedAt:new Date(at).toISOString()};
 await recoverMetaPending(state,{root,ingest:async sent=>{expect(sent).toBe(raw);return confirmed;}});
 expect(state.lastResult).toMatchObject({observedAdvertisers:0,sourceResultCount:null,report:{originalInserted:3,originalUpdated:2}});
 expect(await readFile(pending.file,'utf8')).toBe(raw);expect(state.appliedBatches?.[pending.hash]).toMatchObject({committedAt:confirmed.committedAt});
});
it('retains pending and stops local progress when old SQL lacks original receipt metadata',async()=>{
 const root=await setup(),job=metaJobs()[0],pending=await meta.savePending(root,job.id,{ads:[],completedIds:[],coverage:{exhausted:false},status:'FAILED',errorCode:'META_HTTP_429'});
 const state:MetaRecoveryState={schema:1,jobs:[job],pending,pauseUntil:0,restrictions:0,updatedAt:new Date(at).toISOString()};
 await expect(recoverMetaPending(state,{root,ingest:async()=>({status:'ALREADY_IMPORTED',runId:'original-run',inserted:0,updated:0})})).rejects.toThrow('PENDING_RECEIPT_UNCONFIRMED');
 expect(state.jobs[0].failures).toBe(0);expect(state.pauseUntil).toBe(0);expect(state.pending).toEqual(pending);
});
it('does not mutate progress before state is durably saved and reuses the committed receipt after that save fails',async()=>{
 const root=await setup(),job=metaJobs()[0],pending=await meta.savePending(root,job.id,{ads:[],completedIds:[],coverage:{exhausted:false},status:'FAILED',errorCode:'META_HTTP_429'});
 const state:MetaRecoveryState={schema:1,jobs:[job],pending,pauseUntil:0,restrictions:0,updatedAt:new Date(at).toISOString()};
 await expect(recoverMetaPending(state,{root,ingest:async()=>confirmed,persist:async()=>{throw Error('STATE_SAVE_CRASH');}})).rejects.toThrow('STATE_SAVE_CRASH');
 expect(state.jobs[0].failures).toBe(0);expect(state.appliedBatches).toBeUndefined();
 await recoverMetaPending(state,{root,now:()=>at+86400000,ingest:async()=>{throw Error('COMMIT_MUST_NOT_BE_REPEATED');}});
 expect(state.jobs[0].failures).toBe(1);expect(state.pauseUntil).toBe(at+3600000);
 state.pending=pending;
 await recoverMetaPending(state,{root,now:()=>at+2*86400000,ingest:async()=>{throw Error('COMMIT_MUST_NOT_BE_REPEATED');}});
 expect(state.jobs[0].failures).toBe(1);expect(state.pauseUntil).toBe(at+3600000);
 const saved=JSON.parse(await readFile(join(root,'state.json'),'utf8'));expect(saved.jobs[0].failures).toBe(1);expect(saved.appliedBatches[pending.hash].committedAt).toBe(confirmed.committedAt);
});
it('preserves Google channel and cursor while failure replay cannot extend ATC restrictions',async()=>{
 const root=await setup(),job=googleJob('DISCOVER','DE','en','name'),pending=await google.savePending(root,job.id,{ads:[],advertisers:[],domains:[],completedIds:['AR123456'],coverage:{exhausted:false},cursor:{page:2,row:3},status:'FAILED',errorCode:'GOOGLE_HTTP_429'});
 const state:GoogleRecoveryState={schema:1,jobs:[job],pending,pauses:{ATC:0,SERP:at+86400000},restrictions:{ATC:0,SERP:1},pauseReasons:{SERP:'EXISTING'},updatedAt:new Date(at).toISOString()};
 await recoverGooglePending(state,{root,ingest:async()=>confirmed});state.pending=pending;
 await recoverGooglePending(state,{root,ingest:async()=>{throw Error('ALREADY_CONFIRMED');}});
 expect(state.jobs[0]).toMatchObject({failures:1,cursor:{page:2,row:3},seen:['AR123456']});expect(state.restrictions).toEqual({ATC:1,SERP:1});expect(state.pauses).toEqual({ATC:at+3600000,SERP:at+86400000});
});
it('retains Snapchat nextUrl and Retry-After when an orphan archive replays twice',async()=>{
 const root=await setup(),job=snapJob('name','DE'),pending=await snapchat.savePending(root,job.id,{ads:[],completedIds:['ad-one'],coverage:{exhausted:false},nextUrl:'https://example.invalid/next',status:'FAILED',errorCode:'SNAP_HTTP_429',retryAfterMs:7200000});
 const state:SnapchatRecoveryState={schema:1,jobs:[job],pauseUntil:0,restrictionCount:0,nextBatchAt:0,updatedAt:new Date(at).toISOString()};
 await recoverSnapchatPending(state,{root,ingest:async()=>confirmed});state.pending=pending;
 await recoverSnapchatPending(state,{root,ingest:async()=>{throw Error('ALREADY_CONFIRMED');}});
 expect(state.jobs[0]).toMatchObject({failures:1,nextUrl:'https://example.invalid/next',seen:['ad-one']});expect(state.restrictionCount).toBe(1);expect(state.pauseUntil).toBe(at+7200000);
});
it('recovers a fully staged directory when a crash precedes the archive directory rename',async()=>{
 const root=await setup(),pending=await meta.savePending(root,'job',{ads:[]});
 await rename(join(root,'archive','meta',pending.hash),join(root,'archive','meta','.stage-interrupted'));
 expect(await findStagedPending(root,'meta')).toEqual(pending);
 expect(await readFile(pending.file,'utf8')).toBe('{"ads":[]}');
});
it('rejects pending bound to a missing native job before any database submission',async()=>{
 const root=await setup(),pending=await meta.savePending(root,'missing-job',{ads:[]});
 await expect(recoverPendingOnly('meta',{jobs:[],pending},{root,ingest:async()=>{throw Error('DATABASE_MUST_NOT_RUN');},persist:async state=>atomic(join(root,'state.json'),state),apply:()=>{throw Error('INVALID_JOB');}})).rejects.toThrow('PENDING_JOB_MISSING');
});
