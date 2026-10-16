import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recoverPinterestPending,type PinterestRecoveryState} from './recovery';
import {planSweep} from './sweep';
const roots:string[]=[],now=Date.parse('2026-10-10T00:00:00Z');
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function legacy(count=21,status='SUCCEEDED',errorCode:string|null=null){
 const root=await mkdtemp(join(tmpdir(),'pinterest-recovery-'));roots.push(root);
 const state:PinterestRecoveryState={schema:1,jobs:planSweep(['DE'],'2026-10-01','2026-10-07'),catalog:{countries:[{code:'DE',name:'Germany'}],categories:['ALL']},lastDaily:'2026-10-10',updatedAt:new Date(now).toISOString()};
 const result={batch:{version:'pinterest-public-dom-1',sourceKey:'pinterest_ads_repository',platform:'PINTEREST',observedAt:new Date(now).toISOString(),query:{country:'DE',page:0},status,errorCode,ads:Array.from({length:count},(_,i)=>({sourceAdId:String(1000+i)})),evidence:[],coverage:{selected:count}},nextPage:1,exhausted:false,catalog:state.catalog,pageIds:[]};
 const raw=JSON.stringify(result),hash=createHash('sha256').update(raw).digest('hex');
 await mkdir(join(root,'pending'));const file=join(root,'pending',hash+'.json');await writeFile(file,raw);
 state.pending={jobId:state.jobs[0].id,file};return {root,state,raw,file};
}
const receipt=(runId:string,inserted:number)=>({status:'IMPORTED',runId,inserted,updated:0,originalInserted:inserted,originalUpdated:0,committedAt:new Date(now).toISOString()});
it('keeps the old sweep bytes and page when block 2 fails, then resumes only the unconfirmed block',async()=>{
 const {root,state,raw,file}=await legacy();const sent:string[]=[];
 await expect(recoverPinterestPending(state,{root,ingest:async chunk=>{sent.push(chunk);if(sent.length===2)throw Error('SECOND_BLOCK_DATABASE_DOWN');return receipt('first-run',20);}})).rejects.toThrow('SECOND_BLOCK_DATABASE_DOWN');
 expect(sent.map(chunk=>JSON.parse(chunk).ads.length)).toEqual([20,1]);
 expect(state.jobs[0]).toMatchObject({page:0,failures:0});expect(state.pending?.file).toBe(file);expect(await readFile(file,'utf8')).toBe(raw);
 const result=await recoverPinterestPending(state,{root,now:()=>now+86400000,ingest:async chunk=>{expect(chunk).toBe(sent[1]);return receipt('second-run',1);}});
 expect(result.reports?.map(report=>report.runId)).toEqual(['first-run','second-run']);expect(state.jobs[0]).toMatchObject({page:1,failures:0,lastAttemptAt:now});expect(state.pending).toBeUndefined();
 expect(JSON.parse(await readFile(join(root,'state.json'),'utf8')).appliedBatches).toBeDefined();
});
it('never advances a page on an unconfirmed importer response',async()=>{
 const {root,state}=await legacy(1);
 await expect(recoverPinterestPending(state,{root,ingest:async()=>({status:'DRY_RUN_ROLLED_BACK'})})).rejects.toThrow('PENDING_RECEIPT_UNCONFIRMED');
 expect(state.pending).toBeDefined();expect(state.jobs[0].page).toBe(0);
});
it('applies a failed old page once and keeps its original cooldown on later replay',async()=>{
 const {root,state}=await legacy(0,'FAILED','RATE_LIMITED'),pending=state.pending!;
 await recoverPinterestPending(state,{root,ingest:async()=>receipt('failed-run',0)});
 expect(state.jobs[0].failures).toBe(1);expect(state.pauseUntil).toBe(now+3600000);
 state.pending=pending;
 await recoverPinterestPending(state,{root,now:()=>now+86400000,ingest:async()=>{throw Error('ALREADY_CONFIRMED');}});
 expect(state.jobs[0].failures).toBe(1);expect(state.pauseUntil).toBe(now+3600000);
});
