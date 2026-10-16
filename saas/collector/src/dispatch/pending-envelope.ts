import {open,mkdir,readFile,rename,rm,lstat,readdir,link} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,join,resolve,basename} from 'node:path';

export type PendingPlatform='meta'|'google'|'snapchat'|'tiktok'|'pinterest';
export interface PendingRef {jobId:string;file:string;hash?:string}
export interface Pending extends PendingRef {hash:string}
export interface AppliedBatch {committedAt:string;runIds:string[]}
export interface RecoveryState {pending?:PendingRef;appliedBatches?:Record<string,AppliedBatch>;jobs?:Array<{id:string}>}
export interface PendingChunk {raw:string;hash:string;file:string}
export interface PendingEnvelope<B=any> {pending:PendingRef;raw:string;rawSha:string;batchView:B;expectedChunks:PendingChunk[];legacyResult?:any}
export interface CommitReceipt {status:'IMPORTED'|'ALREADY_IMPORTED';runId:string;inserted:number;updated:number;originalInserted:number;originalUpdated:number;committedAt:string;[key:string]:unknown}
export interface RecoveryReport {status:'IDLE'|'COMMITTED';jobId?:string;batchSha?:string;committedAt?:string;reports?:CommitReceipt[];alreadyApplied?:boolean}
export type BeforeRecoveryPersist<S extends RecoveryState>=(state:S,envelope:PendingEnvelope,reports:CommitReceipt[])=>Promise<void>;
const digest=(raw:string)=>createHash('sha256').update(raw).digest('hex');
const validHash=(hash:unknown):hash is string=>typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash);
const missing=(error:unknown)=>(error as NodeJS.ErrnoException)?.code==='ENOENT';

async function syncDirectory(path:string){const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}}
/** The state and its applied marker are replaced in one durable operation. */
export async function atomic(file:string,value:unknown){
 const parent=dirname(file);await mkdir(parent,{recursive:true,mode:0o700});
 const temp=file+'.tmp-'+randomUUID();const handle=await open(temp,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(value));await handle.sync();}catch(error){await rm(temp,{force:true});throw error;}finally{await handle.close();}
 try{await rename(temp,file);await syncDirectory(parent);}finally{await rm(temp,{force:true});}
}
async function writePrivate(file:string,raw:string){const handle=await open(file,'wx',0o600);try{await handle.writeFile(raw);await handle.sync();}finally{await handle.close();}}
async function regular(file:string){if(!(await lstat(file)).isFile())throw Error('PENDING_PATH_INVALID');}
async function archiveParent(root:string,platform:PendingPlatform){
 const parent=join(resolve(root),'archive',platform);await mkdir(parent,{recursive:true,mode:0o700});
 for(const path of [resolve(root),join(resolve(root),'archive'),parent])if(!(await lstat(path)).isDirectory())throw Error('PENDING_PATH_INVALID');
 return parent;
}
/** Publish the original bytes and job-binding sidecar together. A crash before
 * the rename publishes neither; a crash afterwards leaves a recoverable unit. */
export async function saveArchivedPending(root:string,platform:PendingPlatform,jobId:string,batch:unknown,execution?:unknown,executionCheckpoint?:unknown):Promise<Pending>{
 const raw=JSON.stringify(batch),hash=digest(raw),parent=await archiveParent(root,platform);
 const directory=join(parent,hash),file=join(directory,'batch.json'),pending={jobId,file,hash};
 const manifest={schema:1,platform,pending,...(execution?{execution}:{}),...(executionCheckpoint?{executionCheckpoint}:{})};
 try{
  const info=await lstat(directory);if(!info.isDirectory())throw Error('PENDING_PATH_INVALID');
  try{await regular(file);}catch(error){if(missing(error))throw Error('PENDING_ARCHIVE_INCOMPLETE');throw error;}
  if(await readFile(file,'utf8')!==raw)throw Error('PENDING_ARCHIVE_CONFLICT');
  try{const old=JSON.parse(await readFile(join(directory,'pending.json'),'utf8'));if(JSON.stringify(old)!==JSON.stringify(manifest))throw Error('PENDING_BINDING_CONFLICT');}
  catch(error){if(!missing(error))throw error;await atomic(join(directory,'pending.json'),manifest);}
  return pending;
 }catch(error){if(!missing(error))throw error;}
 const stage=join(parent,'.stage-'+randomUUID());await mkdir(stage,{mode:0o700});
 try{
  await writePrivate(join(stage,'batch.json'),raw);await writePrivate(join(stage,'pending.json'),JSON.stringify(manifest));await syncDirectory(stage);
  try{await rename(stage,directory);}catch(error){
   if(!['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code??''))throw error;
   return saveArchivedPending(root,platform,jobId,batch,execution,executionCheckpoint);
  }
  await syncDirectory(parent);return pending;
 }finally{await rm(stage,{recursive:true,force:true});}
}
async function readPendingRaw(root:string,platform:PendingPlatform,pending:PendingRef){
 let expected:string,hash=pending.hash;
 if(platform==='pinterest'&&hash===undefined){hash=basename(pending.file,'.json');expected=join(resolve(root),'pending',hash+'.json');}
 else expected=join(resolve(root),'archive',platform,String(hash),'batch.json');
 if(!validHash(hash)||pending.file!==expected)throw Error('PENDING_PATH_INVALID');
 for(const path of platform==='pinterest'&&pending.hash===undefined?[dirname(expected)]:[join(resolve(root),'archive'),join(resolve(root),'archive',platform),dirname(expected)])
  if(!(await lstat(path)).isDirectory())throw Error('PENDING_PATH_INVALID');
 await regular(expected);const raw=await readFile(expected,'utf8');if(digest(raw)!==hash)throw Error('PENDING_HASH_MISMATCH');
 return {raw,hash};
}
/** Parse a compatibility view; never write it back over the evidence bytes. */
export async function readLegacyPending<B=any>(platform:PendingPlatform,root:string,pending:PendingRef):Promise<PendingEnvelope<B>>{
 const {raw,hash}=await readPendingRaw(root,platform,pending),parsed=JSON.parse(raw);
 if(platform!=='pinterest'){
  const batchView=platform==='meta'?{...parsed,advertisers:Array.isArray(parsed.advertisers)?parsed.advertisers:[],resultCount:typeof parsed.resultCount==='number'?parsed.resultCount:null}:parsed;
  return {pending,raw,rawSha:hash,batchView,expectedChunks:[{raw,hash,file:pending.file}]};
 }
 if(!parsed.batch||!Array.isArray(parsed.batch.ads))throw Error('PENDING_SWEEP_INVALID');
 const batch=parsed.batch,parts=[];for(let i=0;i<batch.ads.length;i+=20)parts.push(batch.ads.slice(i,i+20));if(!parts.length)parts.push([]);
 const expectedChunks=parts.map(ads=>{const raw=JSON.stringify({...batch,ads,coverage:{...batch.coverage,selected:ads.length}}),hash=digest(raw);return {raw,hash,file:join(resolve(root),'archive','pinterest',hash,'batch.json')};});
 return {pending,raw,rawSha:hash,batchView:batch,expectedChunks,legacyResult:parsed};
}
/** Preserve the importer helper contract used by probes and existing tests. */
export async function importArchivedPending<B=unknown,R=unknown>(root:string,platform:PendingPlatform,pending:PendingRef,ingest:(raw:string)=>Promise<R>):Promise<{batch:B;report:R}>{
 const {raw}=await readPendingRaw(root,platform,pending);return {batch:JSON.parse(raw),report:await ingest(raw)};
}
export async function findStagedPending(root:string,platform:PendingPlatform,appliedBatches:RecoveryState['appliedBatches']={}):Promise<Pending|undefined>{
 const parent=join(resolve(root),'archive',platform);let names:string[];try{names=await readdir(parent);}catch(error){if(missing(error))return;throw error;}
 // If publication itself was interrupted, restore only a complete unit whose
 // binding and byte digest agree. Incomplete staging blocks source access.
 for(const name of names.filter(name=>name.startsWith('.stage-')).sort()){
  const stage=join(parent,name);if(!(await lstat(stage)).isDirectory())throw Error('PENDING_PATH_INVALID');
  let manifest:any,raw:string;
  try{await regular(join(stage,'pending.json'));await regular(join(stage,'batch.json'));manifest=JSON.parse(await readFile(join(stage,'pending.json'),'utf8'));raw=await readFile(join(stage,'batch.json'),'utf8');}
  catch(error){if(missing(error)||error instanceof SyntaxError)throw Error('PENDING_STAGE_INCOMPLETE');throw error;}
  const hash=manifest.pending?.hash,directory=join(parent,String(hash));
  if(manifest.schema!==1||manifest.platform!==platform||!validHash(hash)||typeof manifest.pending.jobId!=='string'||manifest.pending.file!==join(directory,'batch.json')||digest(raw)!==hash)throw Error('PENDING_STAGE_INCOMPLETE');
  try{await rename(stage,directory);}catch(error){
   if(!['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code??''))throw error;
   const existing=await readPendingRaw(root,platform,manifest.pending);if(existing.raw!==raw)throw Error('PENDING_ARCHIVE_CONFLICT');
   try{await regular(join(directory,'pending.json'));}catch(error){if(!missing(error))throw error;await atomic(join(directory,'pending.json'),manifest);}
   await rm(stage,{recursive:true,force:true});
  }
  await syncDirectory(parent);if(!names.includes(hash))names.push(hash);
 }
 for(const hash of names.filter(validHash).sort()){
  let manifest:any;try{const file=join(parent,hash,'pending.json');await regular(file);manifest=JSON.parse(await readFile(file,'utf8'));}catch(error){if(missing(error))continue;throw error;}
  if(manifest.schema!==1||manifest.platform!==platform||manifest.pending?.hash!==hash||typeof manifest.pending.jobId!=='string')throw Error('PENDING_MANIFEST_INVALID');
  await readPendingRaw(root,platform,manifest.pending);
  if(appliedBatches?.[hash]){await finishStage(root,platform,hash);continue;}
  return manifest.pending;
 }
}
async function finishStage(root:string,platform:PendingPlatform,hash:string){
 const directory=join(resolve(root),'archive',platform,hash);
 try{await rename(join(directory,'pending.json'),join(directory,'submitted.json'));await syncDirectory(directory);}catch(error){if(!missing(error))throw error;}
}
export function applyCommittedBatchOnce<S extends RecoveryState>(state:S,batchSha:string,originalCommittedAt:string,apply:(draft:S)=>void,runIds:string[]=[]):S{
 const draft=structuredClone(state);
 if(!draft.appliedBatches?.[batchSha]){
  apply(draft);draft.appliedBatches??={};draft.appliedBatches[batchSha]={committedAt:originalCommittedAt,runIds};
 }
 return draft;
}
function receipt(report:unknown):CommitReceipt{
 const r=report as CommitReceipt;
 if(!r||!['IMPORTED','ALREADY_IMPORTED'].includes(r.status)||typeof r.runId!=='string'||typeof r.committedAt!=='string'||!Number.isFinite(Date.parse(r.committedAt))
  ||!Number.isInteger(r.originalInserted)||r.originalInserted<0||!Number.isInteger(r.originalUpdated)||r.originalUpdated<0)throw Error('PENDING_RECEIPT_UNCONFIRMED');
 return r;
}
async function archiveChunk(root:string,platform:PendingPlatform,chunk:PendingChunk){
 const parent=await archiveParent(root,platform),directory=join(parent,chunk.hash);await mkdir(directory,{recursive:true,mode:0o700});
 if(!(await lstat(directory)).isDirectory())throw Error('PENDING_PATH_INVALID');
 const temp=chunk.file+'.tmp-'+randomUUID();
 try{
  await writePrivate(temp,chunk.raw);
  try{await link(temp,chunk.file);}catch(error){
   if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await regular(chunk.file);if(await readFile(chunk.file,'utf8')!==chunk.raw)throw Error('PENDING_ARCHIVE_CONFLICT');
  }
  await syncDirectory(directory);await syncDirectory(parent);
 }finally{await rm(temp,{force:true});}
}
// Retain existing job object references after an atomic commit (native callers
// may hold the selected job), while adopting deleted fields and new children.
function adopt<S extends RecoveryState>(state:S,next:S){
 const oldJobs=(state as any).jobs as Array<{id:string}>|undefined;
 for(const key of Object.keys(state))if(!(key in next))delete (state as any)[key];
 Object.assign(state,next);
 if(oldJobs&&Array.isArray((next as any).jobs)){
  const index=new Map(oldJobs.map(job=>[job.id,job]));(state as any).jobs=(next as any).jobs.map((job:any)=>{
   const previous=index.get(job.id);if(!previous)return job;
   for(const key of Object.keys(previous))if(!(key in job))delete (previous as any)[key];Object.assign(previous,job);return previous;
  });
 }
}
/** Recovery dependencies intentionally contain no browser, discovery or queue
 * initialization callback. Missing legacy receipt metadata fails closed. */
export async function recoverPendingOnly<S extends RecoveryState,B=any>(platform:PendingPlatform,state:S,deps:{
 root:string;ingest:(raw:string)=>Promise<unknown>;persist:(state:S)=>Promise<void>;
 apply:(state:S,envelope:PendingEnvelope<B>,reports:CommitReceipt[],committedAt:number)=>void;scanOrphans?:boolean;beforePersist?:BeforeRecoveryPersist<S>;
}):Promise<RecoveryReport>{
 const pending=state.pending??(deps.scanOrphans===false?undefined:await findStagedPending(deps.root,platform,state.appliedBatches));
 if(!pending)return {status:'IDLE'};
 if(state.jobs&&!state.jobs.some(job=>job.id===pending.jobId))throw Error('PENDING_JOB_MISSING');
 const envelope=await readLegacyPending<B>(platform,deps.root,pending),alreadyApplied=!!state.appliedBatches?.[envelope.rawSha];
 const journalDir=join(resolve(deps.root),'recovery',platform,envelope.rawSha);await mkdir(journalDir,{recursive:true,mode:0o700});
 const reports:CommitReceipt[]=[];
 for(const chunk of envelope.expectedChunks){
  await archiveChunk(deps.root,platform,chunk);
  const file=join(journalDir,chunk.hash+'.json');let confirmed:CommitReceipt;
  try{await regular(file);confirmed=receipt(JSON.parse(await readFile(file,'utf8')));}catch(error){
   if(!missing(error))throw error;confirmed=receipt(await deps.ingest(chunk.raw));await atomic(file,confirmed);
  }
  reports.push(confirmed);
 }
 const committedAt=new Date(Math.max(...reports.map(r=>Date.parse(r.committedAt)))).toISOString();
 const next=applyCommittedBatchOnce(state,envelope.rawSha,committedAt,draft=>deps.apply(draft,envelope,reports,Date.parse(committedAt)),reports.map(r=>r.runId));
 delete next.pending;await deps.beforePersist?.(next,envelope,reports);await deps.persist(next);adopt(state,next);await finishStage(deps.root,platform,envelope.rawSha);
 return {status:'COMMITTED',jobId:pending.jobId,batchSha:envelope.rawSha,committedAt,reports,alreadyApplied};
}
