import {open,rename,mkdir,readFile,unlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';import {createHash} from 'node:crypto';
import type {Result,Target} from './types';
export const hash=(raw:string)=>createHash('sha256').update(raw).digest('hex');
export async function atomic(file:string,raw:string){const f=await open(file+'.tmp','w',0o600);try{await f.writeFile(raw);await f.sync();}finally{await f.close();}await rename(file+'.tmp',file);const d=await open(dirname(file),'r');try{await d.sync();}finally{await d.close();}}
export interface Pending {attemptId:string;leaseToken:string;resultFile:string;sha256:string}
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export async function saveResult(root:string,t:Target,result:Result):Promise<Pending>{
 if(!uuid.test(t.attemptId)||!uuid.test(t.leaseToken))throw Error('HISTORY_ATTEMPT_INVALID');
 const envelope:any={...result};
 if(result.batch){const batchRaw=JSON.stringify(result.batch);const prefix:Record<string,string>={meta_ad_library:'meta',google_ads_transparency:'google',tiktok_commercial_library:'tiktok',pinterest_ads_repository:'pinterest',snapchat_ads_gallery:'snapchat'};const platform=prefix[t.sourceKey];if(!platform)throw Error('HISTORY_SOURCE_INVALID');const dir=join(root,'archive',platform,hash(batchRaw));await mkdir(dir,{recursive:true,mode:0o700});await atomic(join(dir,'batch.json'),batchRaw);envelope.batchRaw=batchRaw;}
 const dir=join(root,'archive','history',t.attemptId);await mkdir(dir,{recursive:true,mode:0o700});const raw=JSON.stringify(envelope),resultFile=join(dir,'result.json');if(Buffer.byteLength(raw)>25000000)throw Error('HISTORY_EVIDENCE_BUDGET');await atomic(resultFile,raw);
 const pending={attemptId:t.attemptId,leaseToken:t.leaseToken,resultFile,sha256:hash(raw)};await atomic(join(root,'pending.json'),JSON.stringify(pending));return pending;
}
export async function loadPending(root:string):Promise<Pending|null>{try{return JSON.parse(await readFile(join(root,'pending.json'),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
export async function pendingRaw(root:string,p:Pending){if(!uuid.test(p.attemptId)||!uuid.test(p.leaseToken)||p.resultFile!==join(root,'archive','history',p.attemptId,'result.json'))throw Error('HISTORY_PENDING_PATH_INVALID');const raw=await readFile(p.resultFile,'utf8');if(hash(raw)!==p.sha256)throw Error('HISTORY_PENDING_HASH_MISMATCH');return raw;}
export async function clearPending(root:string){await unlink(join(root,'pending.json'));}
