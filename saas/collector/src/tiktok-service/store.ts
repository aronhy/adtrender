import {open,mkdir,readFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {saveArchivedPending,importArchivedPending} from '../dispatch/pending-envelope';
export {atomic} from '../dispatch/pending-envelope';
export type {Pending} from '../dispatch/pending-envelope';
export const savePending=(root:string,jobId:string,batch:unknown)=>saveArchivedPending(root,'tiktok',jobId,batch);
export async function importPending<B=unknown,R=unknown>(root:string,pending:import('../dispatch/pending-envelope').Pending,ingest:(raw:string)=>Promise<R>){
 try{return await importArchivedPending<B,R>(root,'tiktok',pending,ingest);}catch(error){if(error instanceof Error&&/^PENDING_(?:PATH_INVALID|HASH_MISMATCH)$/.test(error.message))throw Error('TIKTOK_'+error.message);throw error;}
}
/** Fail closed for existing locks. The service launcher may remove a stale lock only after proving its prior container is gone. */
export async function acquireProcessLock(root:string):Promise<()=>Promise<void>>{
 await mkdir(root,{recursive:true,mode:0o700});const file=join(root,'process.lock'),token=randomUUID();let handle;
 try{handle=await open(file,'wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw Error('TIKTOK_PROCESS_LOCKED');throw error;}
 try{await handle.writeFile(JSON.stringify({pid:process.pid,token,createdAt:new Date().toISOString()}));await handle.sync();}finally{await handle.close();}
 let released=false;return async()=>{if(released)return;const owner=JSON.parse(await readFile(file,'utf8'));if(owner.token!==token)throw Error('TIKTOK_LOCK_OWNER_CHANGED');await rm(file);released=true;};
}
