import {it,expect} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {savePending,importPending} from './store';
it('keeps a durable batch and unchanged checkpoint across a failed database commit, then replays identical bytes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'meta-pending-'));
 try{
  const batch={ads:[{sourceAdId:'123456'}],evidence:[{text:'public fact'}]};
  const pending=await savePending(root,'query-one',batch);
  let sent='';await expect(importPending(root,pending,async raw=>{sent=raw;throw Error('DB_DOWN');})).rejects.toThrow('DB_DOWN');
  const replay=JSON.parse(await readFile(pending.file,'utf8'));expect(replay).toEqual(batch);
  const result=await importPending(root,pending,async raw=>{expect(raw).toBe(sent);return {status:'ALREADY_IMPORTED'};});
  expect(result.report.status).toBe('ALREADY_IMPORTED');expect(result.batch).toEqual(batch);
 }finally{await rm(root,{recursive:true,force:true});}
});
