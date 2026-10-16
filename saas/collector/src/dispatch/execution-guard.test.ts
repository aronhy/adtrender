import {expect,it,vi} from 'vitest';
import type {ExecutionGrant,SourceControlSnapshot} from '../../../contracts/src/seed-dispatch';
const at=Date.parse('2026-10-11T00:00:00Z'),uuid=(n:string)=>n.repeat(8)+'-'+n.repeat(4)+'-4'+n.repeat(3)+'-8'+n.repeat(3)+'-'+n.repeat(12);
const query:any={queryId:uuid('1'),queryKey:'a'.repeat(64),queryKeyVersion:'legacy-1',sourceKey:'meta_ad_library',channel:'PUBLIC_DOM',mode:'KEYWORD',params:{country:'DE',language:'en',keyword:'word',status:'all',mediaType:'all'},legacyDims:{},adapterVersion:'meta-service-dom-1',capabilityVersion:'fixture-1',desiredEnabled:true,nativeJobIds:['original']};
const grant:ExecutionGrant={schemaVersion:1,protocolVersion:1,grantToken:'private-grant-'.repeat(3),nodeId:'node',incarnationId:uuid('2'),sourceKey:'meta_ad_library',queryId:uuid('1'),taskId:uuid('3'),attemptId:uuid('4'),assignmentGeneration:2,leaseVersion:1,publicationRevision:1,configHash:'b'.repeat(64),checkpointSequence:0,checkpointRef:null,sourceControlVersion:3,serverNow:new Date(at).toISOString(),validUntil:new Date(at+180000).toISOString(),requestDeadline:new Date(at+175000).toISOString(),nativeParams:{...query.params,mode:query.mode,channel:query.channel}};
const control:SourceControlSnapshot={sourceKey:'meta_ad_library',channel:'PUBLIC_DOM',scopeKey:'source',notBefore:new Date(at-1000).toISOString(),retryAfterUntil:null,manualPause:false,restrictionCount:0,controlVersion:3,reason:null,lastEvidenceAt:null};
async function api(){const path='./execution-'+'guard';return import(path).catch(()=>({})) as Promise<any>;}
const context={nodeId:'node',incarnationId:uuid('2'),sourceKey:'meta_ad_library',controlMode:'TASK_CLAIM',appliedRevision:1,configHash:'b'.repeat(64),assignmentGeneration:2};
it('rejects absent, stale or mismatched grants before any source request',async()=>{
 const {createExecutionGuard}=await api();expect(createExecutionGuard).toBeTypeOf('function');
 const base={context,query,clock:{wallNow:()=>at,monotonicNow:()=>0},permit:async()=>({allowed:true,sourceControl:control})};
 expect(()=>createExecutionGuard({...base})).toThrow('COLLECTOR_AUTHORIZATION_REQUIRED');
 expect(()=>createExecutionGuard({...base,grant:{...grant,assignmentGeneration:1}})).toThrow('COLLECTOR_AUTHORIZATION_STALE');
 expect(()=>createExecutionGuard({...base,grant:{...grant,nativeParams:{...grant.nativeParams,mode:'PAGE_ID'}}})).toThrow('COLLECTOR_NATIVE_PARAMS_MISMATCH');
});
it('retains source cooldown and aborts after central permission becomes unavailable',async()=>{
 const {createExecutionGuard}=await api();expect(createExecutionGuard).toBeTypeOf('function');
 const blocked=createExecutionGuard({context,query,grant,clock:{wallNow:()=>at,monotonicNow:()=>0},permit:async()=>({allowed:false,reason:'COOLDOWN',sourceControl:{...control,notBefore:new Date(at+3600000).toISOString()}})});
 await expect(blocked.beforeRequest('LIST')).rejects.toThrow('COLLECTOR_SOURCE_BLOCKED');expect(blocked.signal.aborted).toBe(true);blocked.dispose();
 const unavailable=createExecutionGuard({context,query,grant,clock:{wallNow:()=>at,monotonicNow:()=>0},permit:async()=>{throw Error('token-secret-should-not-leak');}});
 await expect(unavailable.beforeRequest('LIST')).rejects.toThrow('COLLECTOR_CONTROL_UNAVAILABLE');expect(unavailable.signal.aborted).toBe(true);unavailable.dispose();
});
it('uses a monotonic deadline so clock changes cannot prolong requests',async()=>{
 const {createExecutionGuard}=await api();expect(createExecutionGuard).toBeTypeOf('function');let mono=0,wall=at;
 const guard=createExecutionGuard({context,query,grant,exitMarginMs:5000,clock:{wallNow:()=>wall,monotonicNow:()=>mono},permit:async()=>({allowed:true,sourceControl:control})});
 let sourceCalls=0;await guard.beforeRequest('LIST');sourceCalls++;
 wall-=86400000;mono=180000;await expect(guard.beforeRequest('NEXT_PAGE')).rejects.toThrow('COLLECTOR_AUTHORIZATION_EXPIRED');
 expect(sourceCalls).toBe(1);expect(guard.signal.aborted).toBe(true);guard.dispose();
});
it('cannot turn a TikTok scan into keyword targeting',async()=>{
 const {canonicalNativeParams}=await api();expect(canonicalNativeParams).toBeTypeOf('function');
 expect(()=>canonicalNativeParams('tiktok_commercial_library','KEYWORD',{country:'DE',keyword:'word'})).toThrow('COLLECTOR_UNSUPPORTED_MODE');
});
it('waits for short central request spacing within the original monotonic deadline',async()=>{
 const {createExecutionGuard}=await api();expect(createExecutionGuard).toBeTypeOf('function');vi.useFakeTimers();vi.setSystemTime(at);try{let calls=0;const guard=createExecutionGuard({context,query,grant,clock:{wallNow:()=>Date.now(),monotonicNow:()=>Date.now()-at},permit:async()=>{calls++;return calls===1?{allowed:false,reason:'SOURCE_COOLDOWN',sourceControl:{...control,notBefore:new Date(at+1000).toISOString()}}:{allowed:true,sourceControl:control};}});const waiting=guard.beforeRequest('DETAIL');await vi.advanceTimersByTimeAsync(1000);await waiting;expect(calls).toBe(2);expect(guard.signal.aborted).toBe(false);guard.dispose();}finally{vi.useRealTimers();}
});
it('waits through a configured 15 second spacing using only its remaining grant budget',async()=>{
 const {createExecutionGuard}=await api();let mono=0,calls=0;const waits:number[]=[];const guard=createExecutionGuard({context,query,grant,clock:{wallNow:()=>at,monotonicNow:()=>mono},wait:async(ms:number)=>{waits.push(ms);mono+=ms;},permit:async()=>{calls++;return mono<15000?{allowed:false,reason:'SOURCE_COOLDOWN',sourceControl:{...control,notBefore:new Date(at+15000).toISOString()}}:{allowed:true,sourceControl:control};}});try{await guard.beforeRequest('DETAIL');expect(waits).toEqual([15000]);expect(calls).toBe(2);expect(guard.remainingMs()).toBe(155000);}finally{guard.dispose();}
});
