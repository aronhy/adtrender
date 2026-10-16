import {expect,it,vi} from 'vitest';import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {saveArchivedPending,readLegacyPending} from './pending-envelope';import {seedManifestContentHash} from '../../../contracts/src/seeds';import {recoverMetaPending} from '../meta-service/recovery';
async function api(){const path='./managed-'+'runtime';return import(path).catch(()=>({})) as Promise<any>;}
it('routes CONFIG_QUEUE pending recovery through central HTTP without source requests or legacy DB',async()=>{
 const {managedPendingIngest}=await api();expect(managedPendingIngest).toBeTypeOf('function');const root=await mkdtemp(join(tmpdir(),'managed-recover-'));
 try{const batch={sourceKey:'meta_ad_library',ads:[],evidence:[],status:'NO_RESULTS'},pending=await saveArchivedPending(root,'meta','job',batch);const state={jobs:[{id:'job'}],pending,controlMode:'CONFIG_QUEUE'};const recoverSubmit=vi.fn(async(body:any)=>({status:'ALREADY_IMPORTED',runId:'run',originalInserted:0,originalUpdated:0,committedAt:'2026-10-11T00:00:00Z',inserted:0,updated:0}));
 const ingest=managedPendingIngest({platform:'meta',root,state,client:{recoverSubmit},legacyIngest:()=>{throw Error('LEGACY_DB_FORBIDDEN');}});await ingest(JSON.stringify(batch));expect(recoverSubmit).toHaveBeenCalledWith(expect.objectContaining({sourceKey:'meta_ad_library',rawSha:pending.hash,batchHash:pending.hash,raw:JSON.stringify(batch)}));expect(await readFile(pending.file,'utf8')).toBe(JSON.stringify(batch));
 }finally{await rm(root,{recursive:true,force:true});}
});
it('managed node initialization never returns native seed bootstrap permission',async()=>{
 const {resolveControlMode,usesManagedDispatch}=await api();expect(resolveControlMode).toBeTypeOf('function');expect(resolveControlMode(undefined,{})).toBe(undefined);expect(usesManagedDispatch({controlMode:'CONFIG_QUEUE'})).toBe(true);expect(()=>resolveControlMode('PLATFORM_CONFIG',{})).toThrow('COLLECTOR_CONTROL_MODE_INVALID');expect(()=>resolveControlMode('LEGACY_QUEUE',{controlMode:'TASK_CLAIM'})).toThrow('COLLECTOR_CONTROL_MODE_CONFLICT');
});
it('configured selection excludes discovered local children outside the applied manifest',async()=>{
 const {managedJobs}=await api();expect(managedJobs).toBeTypeOf('function');const one={id:'known'},child={id:'discovered'};expect(managedJobs({controlMode:'CONFIG_QUEUE',jobs:[one,child],seedConfig:{enabledIds:['known']}})).toEqual([one]);expect(managedJobs({controlMode:'TASK_CLAIM',jobs:[one,child],seedConfig:{enabledIds:['known']}},'discovered')).toEqual([]);
});
it('promotes native progress only after all original blocks and the next checkpoint are confirmed',async()=>{
 const {managedPendingIngest,managedCheckpointBarrier}=await api();expect(managedCheckpointBarrier).toBeTypeOf('function');const root=await mkdtemp(join(tmpdir(),'managed-checkpoint-'));
 try{const query:any={queryId:'11111111-1111-4111-8111-111111111111',sourceKey:'meta_ad_library',mode:'KEYWORD',channel:'PUBLIC_DOM',params:{country:'DE',language:'en',keyword:'word'},nativeJobIds:['job'],adapterVersion:'meta-service-dom-1'},context:any={grantToken:'private-token'.repeat(4),sourceKey:query.sourceKey,queryId:query.queryId,taskId:'22222222-2222-4222-8222-222222222222',attemptId:'33333333-3333-4333-8333-333333333333',assignmentGeneration:1,leaseVersion:1,publicationRevision:1,configHash:'b'.repeat(64),mode:query.mode,channel:query.channel,nativeParams:query.params};
 const batch={sourceKey:query.sourceKey,query:query.params,ads:[],advertisers:[],evidence:[],completedIds:['new-ad'],coverage:{exhausted:false},status:'SUCCEEDED',errorCode:null};const pending=await saveArchivedPending(root,'meta','job',batch,context,{sequence:0,nodeId:'node'});
 const state:any={schema:1,controlMode:'CONFIG_QUEUE',jobs:[{id:'job',country:'DE',language:'en',keyword:'word',seen:[],lastAttemptAt:0,dueAt:0,failures:0,exhaustedAt:null}],pending,pauseUntil:0,restrictions:0,updatedAt:'2026-10-11T00:00:00Z',seedConfig:{queries:[query]}};
 let reject=true;const calls:any[]=[];const receipt={status:'IMPORTED',runId:'run',inserted:0,updated:0,originalInserted:0,originalUpdated:0,committedAt:'2026-10-11T00:00:00Z'};
 const client:any={prepareSubmission:async()=>({prepareToken:'prepared-private',context,expectedBatchHashes:[pending.hash]}),submitManagedUnit:async(body:any)=>{calls.push(body);if(body.checkpoint&&reject)throw Error('CENTRAL_CHECKPOINT_REJECTED');return {...receipt,complete:true,confirmedBatchHashes:[pending.hash],committedCheckpointSequence:body.checkpoint?.sequence??null};}};
 const options:any={platform:'meta',root,state,client,legacyIngest:()=>{throw Error('LEGACY_DB_FORBIDDEN');}},ingest=managedPendingIngest(options),beforePersist=managedCheckpointBarrier({...options,nodeId:'node'});
 await expect(recoverMetaPending(state,{root,ingest,beforePersist})).rejects.toThrow('CENTRAL_CHECKPOINT_REJECTED');expect(state.pending).toEqual(pending);expect(state.jobs[0].seen).toEqual([]);
 reject=false;await recoverMetaPending(state,{root,ingest,beforePersist});expect(state.jobs[0].seen).toEqual(['new-ad']);expect(state.jobs[0].dueAt).toBe(Date.parse(receipt.committedAt)+60000);expect(state.nativeCheckpoints[query.queryId].sequence).toBe(1);expect(state.pending).toBeUndefined();expect(calls.filter(body=>!body.checkpoint)).toHaveLength(1);expect(calls.at(-1).checkpoint.appliedBatchHashes).toContain(pending.hash);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('polls the platform grant while idle, preserves ACTIVE ownership on local stop, and drains centrally stopped TASK ownership',async()=>{
 const {runManagedLoop}=await api();const root=await mkdtemp(join(tmpdir(),'managed-idle-stop-'));try{
 const nodeId='idle-node',incarnationId='55555555-5555-4555-8555-555555555555',queryId='11111111-1111-4111-8111-111111111111';const body:any={schemaVersion:1,protocolMin:1,protocolMax:1,publicationId:'33333333-3333-4333-8333-333333333333',revision:1,parentRevision:null,compilerVersion:'fixture',capabilityVersion:'fixture',createdAt:new Date().toISOString(),queries:[{queryId,queryKey:'a'.repeat(64),queryKeyVersion:'legacy-1',sourceKey:'meta_ad_library',mode:'KEYWORD',channel:'META',params:{country:'DE',language:'en',keyword:'word'},nativeJobIds:['job'],adapterVersion:'meta-service-dom-1',capabilityVersion:'fixture',desiredEnabled:true,legacyDims:{}}],bindings:[{queryId,ownerKind:'LEGACY',legacyOwnerKey:'known-owner',seedId:null,scanPlanId:null,ownerRevision:1,participationStatus:'ACTIVE',purposeSnapshot:[],validFromRevision:1,validToRevision:null}],scanPlans:[],tombstones:[],schedulePolicyVersion:'fixture'},manifest={...body,contentHash:seedManifestContentHash(body)};
 const grant:any={schemaVersion:1,protocolVersion:1,scope:'platform_queue',controlMode:'CONFIG_QUEUE',nodeId,incarnationId,sourceKey:'meta_ad_library',assignmentGeneration:1,publicationRevision:1,configHash:manifest.contentHash,serverNow:new Date().toISOString(),validUntil:new Date(Date.now()+300000).toISOString(),requestDeadline:new Date(Date.now()+175000).toISOString(),grantToken:'private-platform-token'.repeat(2),sourceControlVersion:1},stop=vi.fn(async()=>({receiptId:'drained'})),platformGrant=vi.fn(async()=>grant),collect=vi.fn();let stopped=false,state:any={controlMode:'CONFIG_QUEUE',jobs:[]};
 const dispatch:any={mode:'CONFIG_QUEUE',platform:'meta',context:{root,sequenceRoot:root,nodeId,incarnationId,sourceKey:'meta_ad_library',protocolVersion:1},codeRevision:'fixture',capabilityDigest:'b'.repeat(64),client:{fetchConfig:async()=>({status:200,manifest}),sendConfigReceipt:async()=>({}),heartbeat:async()=>({}),platformGrant,stop,sourceStopContext:async()=>({schemaVersion:1,scope:'source_stop',controlMode:'CONFIG_QUEUE',nodeId,incarnationId,sourceKey:'meta_ad_library',assignmentGeneration:1,state:'ACTIVE',issuedAt:new Date().toISOString()})}};
 await runManagedLoop({root,platform:'meta',dispatch,getState:()=>state,setState:s=>{state=s;},persist:async()=>{},commit:async()=>{},next:()=>undefined,collect,paused:()=>false,stopping:()=>stopped,wait:async()=>{stopped=true;},log:()=>{}});
 expect(platformGrant).toHaveBeenCalledOnce();expect(collect).not.toHaveBeenCalled();expect(stop).not.toHaveBeenCalled();
 // TASK_CLAIM stops use metadata only, never a platform execution grant.
 stopped=false;state.controlMode='TASK_CLAIM';dispatch.mode='TASK_CLAIM';stop.mockClear();const claim=vi.fn(async()=>{throw Error('CLAIM_AFTER_STOP_FORBIDDEN');});dispatch.client.claim=claim;dispatch.client.sourceStopContext=async()=>({schemaVersion:1,scope:'source_stop',controlMode:'TASK_CLAIM',nodeId,incarnationId,sourceKey:'meta_ad_library',assignmentGeneration:2,state:'DRAINING',issuedAt:new Date().toISOString()});
 await runManagedLoop({root,platform:'meta',dispatch,getState:()=>state,setState:s=>{state=s;},persist:async()=>{},commit:async()=>{},next:()=>undefined,collect,paused:()=>false,stopping:()=>stopped,wait:async()=>{stopped=true;},once:true,log:()=>{}});expect(claim).not.toHaveBeenCalled();expect(stop).toHaveBeenCalledWith(expect.objectContaining({sourceKey:'meta_ad_library',assignmentGeneration:2,pendingHashes:[]}));expect(stop.mock.calls[0][0]).not.toHaveProperty('grantToken');
 }finally{await rm(root,{recursive:true,force:true});}
});

function boundaryManifest(revision=1,enabled=true){
 const queryId='11111111-1111-4111-8111-111111111111',body:any={schemaVersion:1,protocolMin:1,protocolMax:1,publicationId:revision===1?'33333333-3333-4333-8333-333333333333':'44444444-4444-4444-8444-444444444444',revision,parentRevision:revision===1?null:revision-1,compilerVersion:'fixture',capabilityVersion:'fixture',createdAt:'2026-10-12T00:00:00Z',queries:[{queryId,queryKey:'a'.repeat(64),queryKeyVersion:'legacy-1',sourceKey:'meta_ad_library',mode:'KEYWORD',channel:'META',params:{country:'US',language:'en',keyword:'word'},nativeJobIds:['original-job'],adapterVersion:'meta-service-dom-1',capabilityVersion:'fixture',desiredEnabled:enabled,legacyDims:{}}],bindings:[{queryId,ownerKind:'LEGACY',legacyOwnerKey:'known-owner',seedId:null,scanPlanId:null,ownerRevision:1,participationStatus:enabled?'ACTIVE':'PAUSED',purposeSnapshot:[],validFromRevision:1,validToRevision:null}],scanPlans:[],tombstones:[],schedulePolicyVersion:'fixture'};
 return {...body,contentHash:seedManifestContentHash(body)};
}
function boundaryDispatch(root:string,client:any){return {mode:'CONFIG_QUEUE',platform:'meta',context:{root,sequenceRoot:root,nodeId:'boundary-node',incarnationId:'55555555-5555-4555-8555-555555555555',sourceKey:'meta_ad_library',protocolVersion:1},client};}
function boundaryState():any{return {controlMode:'CONFIG_QUEUE',jobs:[{id:'original-job',country:'US',language:'en',keyword:'word',seen:['saved-ad'],failures:3,dueAt:9000,cursor:{page:2}}],pauseUntil:99999,restrictions:4};}
it('does not persist or enqueue APPLIED again when a downloaded manifest is already applied',async()=>{
 const {syncManagedBoundary}=await api(),root=await mkdtemp(join(tmpdir(),'managed-repeat-config-'));
 try{const manifest=boundaryManifest(),receipts:any[]=[],fetchConfig=vi.fn().mockResolvedValueOnce({status:200,manifest}).mockResolvedValueOnce({status:304}).mockResolvedValue({status:200,manifest}),persist=vi.fn(async()=>{}),dispatch:any=boundaryDispatch(root,{fetchConfig,sendConfigReceipt:async(r:any)=>{receipts.push(r);}});
 const state=await syncManagedBoundary(boundaryState(),dispatch,persist),cached=await syncManagedBoundary(state,dispatch,persist),same=await syncManagedBoundary(cached,dispatch,persist);
 expect(cached).toBe(state);expect(same).toBe(state);expect(persist).toHaveBeenCalledOnce();expect(fetchConfig).toHaveBeenCalledTimes(3);expect(receipts.map(r=>r.applyStatus)).toEqual(['DOWNLOADED','VALIDATED','APPLIED']);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('flushes a failed APPLIED outbox before returning the already persisted state without another receipt',async()=>{
 const {syncManagedBoundary}=await api(),root=await mkdtemp(join(tmpdir(),'managed-applied-retry-'));
 try{const manifest=boundaryManifest();let state=boundaryState(),failed=false;const applied:any[]=[],fetchConfig=vi.fn().mockResolvedValueOnce({status:200,manifest}).mockResolvedValue({status:304}),persist=vi.fn(async(next:any)=>{state=next;}),dispatch:any=boundaryDispatch(root,{fetchConfig,sendConfigReceipt:async(r:any)=>{if(r.applyStatus==='APPLIED'){applied.push(r);if(!failed){failed=true;throw Error('OFFLINE_APPLIED');}}}});
 await expect(syncManagedBoundary(state,dispatch,persist)).rejects.toThrow('OFFLINE_APPLIED');const persisted=state,next=await syncManagedBoundary(state,dispatch,persist);
 expect(next).toBe(persisted);expect(persist).toHaveBeenCalledOnce();expect(applied).toHaveLength(2);expect(applied[1]).toEqual(applied[0]);
 const {readdir}=await import('node:fs/promises');expect(await readdir(join(root,'dispatch','config-receipts'))).toEqual([]);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('applies a cached download that has not yet reached native applied state',async()=>{
 const {syncManagedBoundary}=await api(),{syncSeedConfig}=await import('./config-sync'),root=await mkdtemp(join(tmpdir(),'managed-downloaded-only-'));
 try{const manifest=boundaryManifest(),receipts:any[]=[],dispatch:any=boundaryDispatch(root,{fetchConfig:vi.fn().mockResolvedValueOnce({status:200,manifest}).mockResolvedValue({status:304}),sendConfigReceipt:async(r:any)=>{receipts.push(r);}}),persist=vi.fn(async()=>{});
 await syncSeedConfig(dispatch.client,dispatch.context);const state=boundaryState();expect(state.seedConfig).toBeUndefined();const next=await syncManagedBoundary(state,dispatch,persist);
 expect(next.seedConfig.revision).toBe(1);expect(next.seedConfig.contentHash).toBe(manifest.contentHash);expect(persist).toHaveBeenCalledOnce();expect(receipts.map(r=>r.applyStatus)).toEqual(['DOWNLOADED','VALIDATED','APPLIED']);expect(next.jobs).toEqual(state.jobs);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('applies a new revision once and preserves original progress when its owner pauses',async()=>{
 const {syncManagedBoundary}=await api(),root=await mkdtemp(join(tmpdir(),'managed-new-revision-'));
 try{const receipts:any[]=[],first=boundaryManifest(),second=boundaryManifest(2,false),dispatch:any=boundaryDispatch(root,{fetchConfig:vi.fn().mockResolvedValueOnce({status:200,manifest:first}).mockResolvedValueOnce({status:200,manifest:second}).mockResolvedValue({status:304}),sendConfigReceipt:async(r:any)=>{receipts.push(r);}}),persist=vi.fn(async()=>{}),original=boundaryState();
 const one=await syncManagedBoundary(original,dispatch,persist),two=await syncManagedBoundary(one,dispatch,persist),repeated=await syncManagedBoundary(two,dispatch,persist);
 expect(two.seedConfig).toMatchObject({revision:2,contentHash:second.contentHash,enabledIds:[]});expect(two.jobs).toEqual(original.jobs);expect(two).toMatchObject({pauseUntil:original.pauseUntil,restrictions:original.restrictions});expect(repeated).toBe(two);expect(persist).toHaveBeenCalledTimes(2);expect(receipts.filter(r=>r.applyStatus==='APPLIED').map(r=>r.publicationRevision)).toEqual([1,2]);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('persists an unapplied control mode even when the config revision and hash already match',async()=>{
 const {syncManagedBoundary}=await api(),root=await mkdtemp(join(tmpdir(),'managed-mode-not-persisted-'));
 try{const manifest=boundaryManifest(),receipts:any[]=[],dispatch:any=boundaryDispatch(root,{fetchConfig:vi.fn().mockResolvedValueOnce({status:200,manifest}).mockResolvedValue({status:304}),sendConfigReceipt:async(r:any)=>{receipts.push(r);}}),persist=vi.fn(async()=>{});
 const applied=await syncManagedBoundary(boundaryState(),dispatch,persist);delete applied.controlMode;persist.mockClear();receipts.length=0;
 const next=await syncManagedBoundary(applied,dispatch,persist);expect(next.controlMode).toBe('CONFIG_QUEUE');expect(next).not.toBe(applied);expect(persist).toHaveBeenCalledOnce();expect(receipts.map(r=>r.applyStatus)).toEqual(['APPLIED']);
 }finally{await rm(root,{recursive:true,force:true});}
});
