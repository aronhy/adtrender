import {afterEach,expect,it} from 'vitest';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import {makeJob as googleJob} from '../google-service/queue';
import {makeJob as snapJob} from '../snapchat-service/queue';
import {planJobs} from '../tiktok-service/queue';
import {planSweep} from '../pinterest/sweep';
import {seedJobs} from '../meta-service/queue';
const roots:string[]=[],at=Date.parse('2026-10-10T00:00:00Z');
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const fixtures={
 meta:{schema:1,jobs:seedJobs().slice(0,1),pauseUntil:0,restrictions:0,updatedAt:new Date(at).toISOString()},
 google:{schema:1,jobs:[googleJob('DISCOVER','DE','en','name')],pauses:{ATC:0,SERP:0},restrictions:{ATC:0,SERP:0},pauseReasons:{},updatedAt:new Date(at).toISOString()},
 snapchat:{schema:1,jobs:[snapJob('name','DE')],pauseUntil:0,restrictionCount:0,nextBatchAt:0,updatedAt:new Date(at).toISOString()},
 tiktok:{schema:1,jobs:planJobs(['DE'],{now:at,lookbackDays:1}),pauseUntil:0,updatedAt:new Date(at).toISOString()},
 pinterest:{schema:1,jobs:planSweep(['DE'],'2026-10-01','2026-10-07'),catalog:{countries:[{code:'DE',name:'Germany'}],categories:['ALL']},lastDaily:'2026-10-10',updatedAt:new Date(at).toISOString()},
};
async function run(platform:keyof typeof fixtures,withState:boolean,managed=false,handoff=false){
 const root=await mkdtemp(join(tmpdir(),'recover-entry-'));roots.push(root);const file=join(root,'daemon.mjs');
 const state=handoff?{...fixtures[platform],controlMode:'LEGACY_QUEUE',seedConfig:{revision:1,contentHash:'a'.repeat(64),queries:[],mappings:[],enabledIds:[]}}:fixtures[platform];if(withState)await writeFile(join(root,'state.json'),JSON.stringify(state));
 // Compile the real daemon, replacing only external database/browser access.
 // No test can contact a platform even if the recovery boundary regresses.
 await build({absWorkingDir:process.cwd(),entryPoints:['apps/collector/src/'+(platform==='pinterest'?'pinterest':platform+'-service')+'/daemon.ts'],outfile:file,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent',
  banner:{js:handoff?"globalThis.fetch=async(url,options)=>{const path=new URL(String(url)).pathname;if(path==='/api/internal/collection/heartbeat')return new Response('{}');if(path!=='/api/internal/collection/control-handoff')throw Error('SOURCE_ACCESS_FORBIDDEN');const b=JSON.parse(options.body);return new Response(JSON.stringify({schemaVersion:1,nodeId:'fixture-node',incarnationId:'55555555-5555-4555-8555-555555555555',sourceKey:b.sourceKey,fromMode:b.fromMode,toMode:b.toMode,assignmentGeneration:2,publicationRevision:b.publicationRevision,configHash:b.configHash,drainedReceiptId:'drained',issuedAt:new Date().toISOString(),handoffId:'handoff'}));};":"globalThis.fetch=()=>{throw Error('SOURCE_ACCESS_FORBIDDEN');};"},
  plugins:[{name:'offline-recovery-dependencies',setup(builder){
   builder.onResolve({filter:/^(playwright|node:module)$/},args=>({path:args.path,namespace:'offline'}));
   builder.onLoad({filter:/.*/,namespace:'offline'},args=>({contents:args.path==='playwright'?
    "const forbidden=()=>{throw Error('SOURCE_ACCESS_FORBIDDEN');};export const chromium={launch:forbidden,launchPersistentContext:forbidden};":
    "export function createRequire(){return ()=>({PrismaClient:class{$queryRawUnsafe(){throw Error('DATABASE_MUST_NOT_RUN');}async $disconnect(){}}});}",loader:'js'}));
  }}]});
 const child=spawn(process.execPath,[file,handoff?'--apply-control-mode':managed?'--once':'--recover-only'],{cwd:resolve('.'),env:{...process.env,[platform.toUpperCase()+'_STATE_DIR']:root,...(managed||handoff?{COLLECTOR_CONTROL_MODE:'CONFIG_QUEUE'}:{}),...(handoff?{COLLECTOR_NODE_ID:'fixture-node',COLLECTOR_INCARNATION_ID:'55555555-5555-4555-8555-555555555555',COLLECTOR_NODE_TOKEN:'private-fixture-token'.repeat(2),COLLECTOR_CONTROL_URL:'http://127.0.0.1:9',COLLECTOR_CODE_REVISION:'fixture',COLLECTOR_CAPABILITY_DIGEST:'b'.repeat(64)}:{})},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',chunk=>{output+=String(chunk);});child.stderr.on('data',chunk=>{output+=String(chunk);});
 const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
 const code=await new Promise<number|null>((done,reject)=>{child.once('error',reject);child.once('exit',done);});clearTimeout(timer);
 return {root,code,output,state};
}
it.each(Object.keys(fixtures) as Array<keyof typeof fixtures>)('%s recovery entry leaves existing jobs unchanged and exits without database or source access',async platform=>{
 const {root,code,output}=await run(platform,true);expect({code,output}).toEqual({code:0,output:''});
 expect(JSON.parse(await readFile(join(root,'state.json'),'utf8'))).toEqual(fixtures[platform]);
});
it.each(Object.keys(fixtures) as Array<keyof typeof fixtures>)('%s recovery entry cannot initialize a missing queue',async platform=>{
 const {root,code}=await run(platform,false);expect(code).toBe(1);
 await expect(access(join(root,'state.json'))).rejects.toMatchObject({code:'ENOENT'});
});
it.each(Object.keys(fixtures) as Array<keyof typeof fixtures>)('%s new managed node cannot bootstrap native catalog seeds',async platform=>{
 const {root,code,output}=await run(platform,false,true);expect(code).toBe(1);expect(output).not.toContain('SOURCE_ACCESS_FORBIDDEN');
 let state:any;try{state=JSON.parse(await readFile(join(root,'state.json'),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 expect(state?.jobs??[]).toEqual([]);
});
it.each(Object.keys(fixtures) as Array<keyof typeof fixtures>)('%s explicit control handoff preserves native state and makes no source or legacy DB request',async platform=>{
 const {root,code,output,state}=await run(platform,true,false,true);expect({code,output}).toEqual({code:0,output:''});expect(JSON.parse(await readFile(join(root,'state.json'),'utf8'))).toEqual({...state,controlMode:'CONFIG_QUEUE'});
});
it.each(Object.keys(fixtures) as Array<keyof typeof fixtures>)('%s control handoff cannot initialize a missing native queue',async platform=>{
 const {root,code}=await run(platform,false,false,true);expect(code).toBe(1);await expect(access(join(root,'state.json'))).rejects.toMatchObject({code:'ENOENT'});
});
