import {DomainError} from '../team/access';
import {idempotentSeedMutation} from './catalog';
/** Draft ownership intent. Execution bindings change only in preview/publish. */
export async function saveLegacyOwnerIntent(db:any,input:{actorUserId:string;sourceKey:string;legacyOwnerKey:string;status:'ACTIVE'|'PAUSED'|'REMOVED';idempotencyKey:string;reason:string}){
 if(!['ACTIVE','PAUSED','REMOVED'].includes(input.status)||!input.legacyOwnerKey||input.legacyOwnerKey.length>2000)throw new DomainError(400,'SEED_LEGACY_OWNER_INVALID');
 return idempotentSeedMutation(db,input,'SEED_LEGACY_OWNER_STATUS_SET',{sourceKey:input.sourceKey,legacyOwnerKey:input.legacyOwnerKey,status:input.status},async tx=>{
  const binding=await tx.seedQueryBinding.findFirst({where:{ownerKind:'LEGACY',legacyOwnerKey:input.legacyOwnerKey,query:{sourceKey:input.sourceKey}}});
  if(!binding)throw new DomainError(404,'SEED_LEGACY_OWNER_NOT_FOUND');
  const history=await tx.auditEvent.findMany({where:{action:'SEED_LEGACY_OWNER_STATUS_SET'},orderBy:[{createdAt:'desc'},{id:'desc'}]});
  const prior=history.find((a:any)=>a.metadata?.result?.sourceKey===input.sourceKey&&a.metadata?.result?.legacyOwnerKey===input.legacyOwnerKey);
  return {targetId:binding.id,sourceKey:input.sourceKey,legacyOwnerKey:input.legacyOwnerKey,status:input.status,ownerRevision:(prior?.metadata?.result?.ownerRevision??binding.ownerRevision)+1,message:'已保存旧队列拥有者修订；预览并发布后生效，原生任务与断点保留。'};
 });
}
