import {z} from 'zod';
import {DomainError} from '../team/access';
import {idempotentSeedMutation} from './catalog';
import {configuredCollectorDispatch} from '../collector-dispatch/configured';
import {seedSourceKeys} from '@ad-research/contracts/seeds';
const nodeId=z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),sourceKey=z.enum(seedSourceKeys),channel=z.string().min(1).max(100),uuid=z.string().uuid();
const assignment=z.object({sourceKey,channel:channel.optional(),nodeId,incarnationId:uuid,publicationRevision:z.number().int().positive(),configHash:z.string().regex(/^[a-f0-9]{64}$/),controlMode:z.enum(['LEGACY_QUEUE','CONFIG_QUEUE','TASK_CLAIM'])}).strict();
export const seedDispatchAdminTypes=['REGISTER_COLLECTOR_NODE','VERIFY_COLLECTOR_NODE','SET_COLLECTOR_NODE_ENABLED','SET_COLLECTOR_SOURCE_PAUSE','ASSIGN_COLLECTOR_SOURCE','SWITCH_COLLECTOR_SOURCE_MODE','STOP_COLLECTOR_EXECUTION','RECONCILE_COLLECTOR_RECOVERY','REGISTER_COLLECTOR_PENDING','RETIRE_COLLECTOR_SOURCE'] as const;
export async function runSeedDispatchAdminCommand(db:any,input:{actorUserId:string;type:string;payload:unknown;idempotencyKey:string;reason:string},env:Record<string,string|undefined>=process.env){
 if(!seedDispatchAdminTypes.includes(input.type as any))throw new DomainError(400,'SEED_DISPATCH_COMMAND_INVALID');
 return idempotentSeedMutation(db,input,'SEED_DISPATCH_ADMIN_COMMAND',{type:input.type,payload:input.payload},async tx=>{
  // Service transactions share the command's transaction, role check and replay audit.
  const nested=new Proxy(tx,{get:(target,key)=>key==='$transaction'?async(fn:any)=>fn(tx):Reflect.get(target,key)}),dispatch=configuredCollectorDispatch(nested,env),base={actorUserId:input.actorUserId};
  let result:any;
  switch(input.type){
   case 'REGISTER_COLLECTOR_NODE':{
    const p=z.object({nodeId,incarnationId:uuid,registryRevision:z.number().int().positive(),enabled:z.boolean(),expiresAt:z.string().datetime().nullable(),codeRevision:z.string().min(1).max(200),protocolVersions:z.array(z.number().int().positive()).min(1)}).strict().parse(input.payload);
    result=await dispatch.registerNode({...base,...p,expiresAt:p.expiresAt?new Date(p.expiresAt):null});break;
   }
   case 'VERIFY_COLLECTOR_NODE':result=await dispatch.verifyNode({...base,...z.object({nodeId,incarnationId:uuid,codeRevision:z.string().min(1).max(200),capabilityDigest:z.string().regex(/^[a-f0-9]{64}$/),maxSlots:z.number().int().positive()}).strict().parse(input.payload)});break;
   case 'SET_COLLECTOR_NODE_ENABLED':result=await dispatch.setNodeEnabled({...base,...z.object({nodeId,enabled:z.boolean()}).strict().parse(input.payload)});break;
   case 'SET_COLLECTOR_SOURCE_PAUSE':result=await dispatch.setSourcePause({...base,...z.object({sourceKey,manualPause:z.boolean(),expectedControlVersion:z.number().int().nonnegative().optional()}).strict().parse(input.payload),reason:input.reason});break;
   case 'ASSIGN_COLLECTOR_SOURCE':result=await dispatch.assignSource({...base,...assignment.parse(input.payload)});break;
   case 'SWITCH_COLLECTOR_SOURCE_MODE':result=await dispatch.switchSourceMode({...base,...assignment.extend({stopReceiptId:uuid}).parse(input.payload)});break;
   case 'STOP_COLLECTOR_EXECUTION':result=await dispatch.requestStop({...base,...z.object({queryId:uuid.optional(),nodeId:nodeId.optional(),sourceKey:sourceKey.optional()}).strict().refine(p=>!!(p.queryId||p.nodeId||p.sourceKey)).parse(input.payload),reason:input.reason});break;
   case 'RECONCILE_COLLECTOR_RECOVERY':result=await dispatch.reconcileRecovery({...base,...z.object({attemptId:uuid,stopReceiptId:uuid,checkpoint:z.record(z.string(),z.unknown()),checkpointRaw:z.string()}).strict().parse(input.payload)} as any);break;
   case 'REGISTER_COLLECTOR_PENDING':result=await dispatch.registerLegacyPending({...base,...z.object({nodeId,incarnationId:uuid,sourceKey,rawSha:z.string().regex(/^[a-f0-9]{64}$/),batchHashes:z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1)}).strict().parse(input.payload),reason:input.reason});break;
   case 'RETIRE_COLLECTOR_SOURCE':result=await dispatch.retireSourceAssignment({...base,...z.object({sourceKey,channel:channel.optional(),stopReceiptId:uuid}).strict().parse(input.payload),reason:input.reason});break;
  }
  // Tokens, secret hashes and large native payloads never enter the admin response/audit.
  if(result&&typeof result==='object'){const {tokenHash,grantToken,...safe}=result;return JSON.parse(JSON.stringify({...safe,targetId:result.id??result.nodeId??(input.payload as any)?.sourceKey??null,message:'中央控制变更已记录；执行与停止状态以节点回执为准。'}));}
  return {targetId:null,result,message:'中央控制变更已记录。'};
 });
}
