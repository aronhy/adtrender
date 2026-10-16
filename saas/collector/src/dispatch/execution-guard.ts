import {performance} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';
import {seedCanonical,type SeedQuerySpec,type SourceKey} from '../../../contracts/src/seeds';
import {validateExecutionGrant,validateSourceControlSnapshot,type ExecutionGrant,type SourceControlSnapshot} from '../../../contracts/src/seed-dispatch';
export type ControlMode='LEGACY_QUEUE'|'CONFIG_QUEUE'|'TASK_CLAIM';
export interface PlatformGrant {schemaVersion:1;protocolVersion:number;scope:'platform_queue';controlMode:'LEGACY_QUEUE'|'CONFIG_QUEUE';nodeId:string;incarnationId:string;sourceKey:SourceKey;assignmentGeneration:number;publicationRevision:number;configHash:string;serverNow:string;validUntil:string;requestDeadline:string;grantToken:string;sourceControlVersion:number}
export interface ExecutionContext {grantToken:string;sourceKey:SourceKey;queryId:string;taskId?:string;attemptId?:string;assignmentGeneration:number;leaseVersion?:number;publicationRevision:number;configHash:string;nativeJobId?:string;mode:string;channel:string;nativeParams:Record<string,unknown>}
export interface PermitResult {allowed:boolean;reason?:string;sourceControl:SourceControlSnapshot;grant?:ExecutionGrant;context?:ExecutionContext}
export interface GuardContext {nodeId:string;incarnationId:string;sourceKey:SourceKey;controlMode:ControlMode;appliedRevision:number;configHash:string;assignmentGeneration:number;protocolVersion?:number}
export interface SourceRequestGuard {signal:AbortSignal;beforeRequest(kind:string):Promise<void>;remainingMs():number;dispose():void;executionContext?:ExecutionContext;executionGrant?:ExecutionGrant}
import {canonicalNativeParams} from '../../../contracts/src/seed-native-query';
export {canonicalNativeParams} from '../../../contracts/src/seed-native-query';
export function createExecutionGuard(options:{context:GuardContext;query:SeedQuerySpec;grant?:ExecutionGrant|PlatformGrant;clock?:{wallNow():number;monotonicNow():number};permit:(input:{grantToken:string;queryId:string;nativeParams:Record<string,unknown>;requestKind:string;context:ExecutionContext})=>Promise<PermitResult>;exitMarginMs?:number;signal?:AbortSignal;wait?:(ms:number,signal:AbortSignal)=>Promise<void>}):SourceRequestGuard{
 const {context,query}=options,g=options.grant;if(!g)throw Error('COLLECTOR_AUTHORIZATION_REQUIRED');
 try{if(context.controlMode==='TASK_CLAIM')validateExecutionGrant(g);else if((g as PlatformGrant).scope!=='platform_queue'||(g as PlatformGrant).controlMode!==context.controlMode||g.grantToken.length<24||!Number.isFinite(Date.parse(g.requestDeadline))||Date.parse(g.serverNow)>=Date.parse(g.requestDeadline)||Date.parse(g.requestDeadline)>Date.parse(g.validUntil))throw Error();}catch{throw Error('COLLECTOR_AUTHORIZATION_INVALID');}
 if(g.nodeId!==context.nodeId||g.incarnationId!==context.incarnationId||g.sourceKey!==context.sourceKey||query.sourceKey!==context.sourceKey||g.assignmentGeneration!==context.assignmentGeneration||g.publicationRevision!==context.appliedRevision||g.configHash!==context.configHash||g.protocolVersion!==(context.protocolVersion??1))throw Error('COLLECTOR_AUTHORIZATION_STALE');
 const expected=canonicalNativeParams(query.sourceKey,query.mode,{...query.params,channel:query.channel});
 if(context.controlMode==='TASK_CLAIM'){
  const task=g as ExecutionGrant;if(task.queryId!==query.queryId)throw Error('COLLECTOR_AUTHORIZATION_STALE');
  let actual;try{actual=canonicalNativeParams(task.sourceKey,String(task.nativeParams.mode),task.nativeParams);}catch{throw Error('COLLECTOR_NATIVE_PARAMS_MISMATCH');}
  if(seedCanonical(actual)!==seedCanonical(expected))throw Error('COLLECTOR_NATIVE_PARAMS_MISMATCH');
 }
 const clock=options.clock??{wallNow:Date.now,monotonicNow:()=>performance.now()},started=clock.monotonicNow();
 // Server timestamps define the budget; monotonic elapsed time cannot extend it.
 const skew=Math.abs(clock.wallNow()-Date.parse(g.serverNow));if(skew>120000)throw Error('COLLECTOR_CLOCK_SKEW');
 let budget=Date.parse(g.requestDeadline)-Date.parse(g.serverNow)-(options.exitMarginMs??5000)-Math.min(skew,5000);
 const abort=new AbortController();let stopped=false;
 const fail=(code:string):never=>{abort.abort(Error(code));throw Error(code);};
 const remaining=()=>Math.max(0,budget-(clock.monotonicNow()-started));
 let timer=setTimeout(()=>abort.abort(Error('COLLECTOR_AUTHORIZATION_EXPIRED')),Math.max(1,budget));timer.unref?.();
 const onStop=()=>abort.abort(Error('COLLECTOR_STOP_REQUESTED'));options.signal?.addEventListener('abort',onStop,{once:true});if(options.signal?.aborted)onStop();
 const result:SourceRequestGuard={signal:abort.signal,remainingMs:remaining,...(context.controlMode==='TASK_CLAIM'?{executionGrant:g as ExecutionGrant}:{}),dispose(){stopped=true;clearTimeout(timer);options.signal?.removeEventListener('abort',onStop);},executionContext:{grantToken:g.grantToken,sourceKey:query.sourceKey,queryId:query.queryId,...(context.controlMode==='TASK_CLAIM'?{taskId:(g as ExecutionGrant).taskId,attemptId:(g as ExecutionGrant).attemptId,leaseVersion:(g as ExecutionGrant).leaseVersion}:{}),assignmentGeneration:g.assignmentGeneration,publicationRevision:g.publicationRevision,configHash:g.configHash,mode:query.mode,channel:query.channel,nativeParams:expected},async beforeRequest(requestKind){
  if(stopped||options.signal?.aborted)fail('COLLECTOR_STOP_REQUESTED');if(remaining()<=0||abort.signal.aborted)fail('COLLECTOR_AUTHORIZATION_EXPIRED');
  let permit:PermitResult;try{permit=await options.permit({grantToken:result.executionContext!.grantToken,queryId:query.queryId,nativeParams:expected,requestKind,context:result.executionContext!});}catch{fail('COLLECTOR_CONTROL_UNAVAILABLE');}
  if(remaining()<=0)fail('COLLECTOR_AUTHORIZATION_EXPIRED');
  let control:SourceControlSnapshot;try{control=validateSourceControlSnapshot(permit!.sourceControl);}catch{fail('COLLECTOR_CONTROL_INVALID');}
  const serverElapsed=Date.parse(g.serverNow)+(clock.monotonicNow()-started);
  const spacing=Date.parse(control!.notBefore)-serverElapsed;
  if(!permit!.allowed&&permit!.reason==='SOURCE_COOLDOWN'&&!control!.manualPause&&spacing>0&&spacing<remaining()){
   try{await (options.wait?options.wait(spacing,abort.signal):sleep(spacing,undefined,{signal:abort.signal}));}catch{fail(options.signal?.aborted?'COLLECTOR_STOP_REQUESTED':'COLLECTOR_AUTHORIZATION_EXPIRED');}return result.beforeRequest(requestKind);
  }
  if(!permit!.allowed||control!.sourceKey!==query.sourceKey||control!.channel!==query.channel||control!.controlVersion<g.sourceControlVersion||control!.manualPause||Date.parse(control!.notBefore)>serverElapsed||(control!.retryAfterUntil!==null&&Date.parse(control!.retryAfterUntil)>serverElapsed))fail('COLLECTOR_SOURCE_BLOCKED');
  if(permit!.context){const c=permit!.context;if(c.queryId!==query.queryId||c.sourceKey!==query.sourceKey||c.assignmentGeneration!==g.assignmentGeneration||c.publicationRevision!==g.publicationRevision||c.configHash!==g.configHash||seedCanonical(canonicalNativeParams(c.sourceKey,c.mode,{...c.nativeParams,channel:c.channel}))!==seedCanonical(expected))fail('COLLECTOR_CONTROL_INVALID');result.executionContext=c;}
  if(permit!.grant){let child:ExecutionGrant;try{child=validateExecutionGrant(permit!.grant);}catch{fail('COLLECTOR_CONTROL_INVALID');}if(child!.nodeId!==g.nodeId||child!.incarnationId!==g.incarnationId||child!.queryId!==query.queryId||child!.assignmentGeneration!==g.assignmentGeneration||child!.attemptId!==result.executionContext?.attemptId||child!.taskId!==result.executionContext.taskId||seedCanonical(canonicalNativeParams(child!.sourceKey,String(child!.nativeParams.mode),child!.nativeParams))!==seedCanonical(expected))fail('COLLECTOR_CONTROL_INVALID');result.executionGrant=child!;budget=Math.min(budget,Date.parse(child!.requestDeadline)-Date.parse(g.serverNow)-(options.exitMarginMs??5000));clearTimeout(timer);timer=setTimeout(()=>abort.abort(Error('COLLECTOR_AUTHORIZATION_EXPIRED')),Math.max(1,remaining()));timer.unref?.();}
  if(!result.executionContext?.taskId||!result.executionContext.attemptId)fail('COLLECTOR_STARTED_CONTEXT_REQUIRED');
 }};return result;
}
