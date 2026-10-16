import {afterEach,expect,it} from 'vitest';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireProcessLock,atomic,importPending,savePending} from './store';
const roots:string[]=[];
async function root(){const dir=await mkdtemp(join(tmpdir(),'tiktok-store-'));roots.push(dir);return dir;}
afterEach(async()=>{await Promise.all(roots.splice(0).map(r=>rm(r,{recursive:true,force:true})));});

it('writes private state through atomic replacement',async()=>{
 const dir=await root(),file=join(dir,'state.json');await atomic(file,{value:1});await atomic(file,{value:2});
 expect(JSON.parse(await readFile(file,'utf8'))).toEqual({value:2});
 expect((await stat(file)).mode&0o777).toBe(0o600);
});
it('archives exact batch bytes and replays the same digest after database failure',async()=>{
 const dir=await root();const pending=await savePending(dir,'job-1',{ads:[{sourceAdId:'123'}]});let first='';
 await expect(importPending(dir,pending,async raw=>{first=raw;throw Error('DATABASE_DOWN');})).rejects.toThrow('DATABASE_DOWN');
 const result=await importPending(dir,pending,async raw=>{expect(raw).toBe(first);return {status:'ALREADY_IMPORTED'};});
 expect(result.batch).toEqual({ads:[{sourceAdId:'123'}]});expect(result.report).toEqual({status:'ALREADY_IMPORTED'});
 expect(pending.file).toBe(join(dir,'archive','tiktok',pending.hash,'batch.json'));
});
it('rejects a moved or tampered archive before invoking the database',async()=>{
 const dir=await root(),pending=await savePending(dir,'job-1',{ads:[]});
 const forbidden=async()=>{throw Error('DATABASE_MUST_NOT_BE_CALLED');};
 await expect(importPending(dir,{...pending,file:join(dir,'state.json')},forbidden)).rejects.toThrow('TIKTOK_PENDING_PATH_INVALID');
 await writeFile(pending.file,'{"ads":[1]}');
 await expect(importPending(dir,pending,forbidden)).rejects.toThrow('TIKTOK_PENDING_HASH_MISMATCH');
});
it('allows only one process owner and permits reacquisition after release',async()=>{
 const dir=await root(),release=await acquireProcessLock(dir);
 await expect(acquireProcessLock(dir)).rejects.toThrow('TIKTOK_PROCESS_LOCKED');
 await release();const releaseAgain=await acquireProcessLock(dir);await releaseAgain();
});
