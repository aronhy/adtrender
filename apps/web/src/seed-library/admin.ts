import {randomUUID} from 'node:crypto';
import {DomainError} from '../team/access';
import {seedCanonical,validateSeedScanPlan} from '@ad-research/contracts/seeds';
import {idempotentSeedMutation,normalizeSeedValue,type SeedMutation} from './catalog';
import {parseSeedCsv} from './imports';

export async function setSeedStatus(db:any,input:Omit<SeedMutation,'payload'>&{targetId:string;status:string}){
 if(!['ACTIVE','PAUSED','ARCHIVED'].includes(input.status))throw new DomainError(400,'SEED_STATUS_INVALID');
 return idempotentSeedMutation(db,input,'SEED_STATUS_CHANGED',{targetId:input.targetId,expectedRevision:input.expectedRevision,status:input.status},async tx=>{
  const seed=await tx.seedDefinition.findUnique({where:{id:input.targetId}});
  if(!seed)throw new DomainError(404,'SEED_NOT_FOUND');if(seed.revision!==input.expectedRevision)throw new DomainError(409,'SEED_REVISION_CONFLICT');
  if(seed.status==='MERGED')throw new DomainError(409,'SEED_ALREADY_MERGED');
  const next=await tx.seedDefinition.update({where:{id:seed.id},data:{status:input.status,revision:{increment:1}}});
  return {targetId:seed.id,revision:next.revision,message:'已保存启停修订；发布后再核对节点停止或应用回执。'};
 });
}
export async function previewSeedImport(db:any,input:{actorUserId:string;idempotencyKey:string;reason:string;csv:string}){
 let parsed:ReturnType<typeof parseSeedCsv>;try{parsed=parseSeedCsv(input.csv);}catch{throw new DomainError(400,'SEED_CSV_INVALID');}
 return idempotentSeedMutation(db,input,'SEED_IMPORT_PREVIEW',{fileHash:parsed.fileHash},async tx=>{
  const targetId=randomUUID(),counts={rows:parsed.rowResults.length,valid:parsed.rowResults.filter(r=>r.status==='VALID').length,merged:parsed.rowResults.filter(r=>r.status==='MERGED').length,invalid:parsed.rowResults.filter(r=>r.status==='INVALID').length,definitions:parsed.definitions.length};
  await tx.seedImportJob.create({data:{id:targetId,actorUserId:input.actorUserId,fileHash:parsed.fileHash,status:'PREVIEWED',previewRevision:1,rowResults:{definitions:parsed.definitions,items:parsed.rowResults},counts,idempotencyKey:`csv:${input.actorUserId}:${input.idempotencyKey}`,expiresAt:new Date(Date.now()+86400000)}});
  return {targetId,revision:1,counts,message:'校验预览已保存，尚未导入或发布。'};
 });
}
export async function mergeImportedDefinitions(tx:any,actorUserId:string,definitions:any[]){
 let inserted=0,existing=0;
 for(const definition of definitions){
  const normalizedValue=normalizeSeedValue(definition.kind,definition.rawValue),identity={kind:definition.kind,namespace:definition.namespace,language:definition.language,normalizedValue};
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','seed-definition:'+seedCanonical(identity));
  const previous=await tx.seedDefinition.findUnique({where:{kind_namespace_language_normalizedValue:identity}});
  if(previous){
   const purposeTags=[...new Map([...(previous.purposeTags as any[]),...definition.purposeTags].map(tag=>[seedCanonical(tag),tag])).values()].sort((a,b)=>seedCanonical(a).localeCompare(seedCanonical(b)));
   const targetPlatforms=[...new Set([...previous.targetPlatforms,...definition.targetPlatforms])].sort();
   // Broaden only explicit country lists. Global/configured scope changes require a reviewed edit.
   const targetScope=previous.targetScope.kind==='EXPLICIT_COUNTRIES'&&definition.targetScope.kind==='EXPLICIT_COUNTRIES'?{kind:'EXPLICIT_COUNTRIES',countries:[...new Set([...previous.targetScope.countries,...definition.targetScope.countries])].sort()}:previous.targetScope;
   const changed=seedCanonical({purposeTags,targetPlatforms,targetScope})!==seedCanonical({purposeTags:previous.purposeTags,targetPlatforms:previous.targetPlatforms,targetScope:previous.targetScope});
   if(changed)await tx.seedDefinition.update({where:{id:previous.id},data:{purposeTags,targetPlatforms,targetScope,revision:{increment:1}}});existing++;
  }else{await tx.seedDefinition.create({data:{...definition,id:randomUUID(),normalizedValue,createdByUserId:actorUserId,status:'DRAFT',verificationStatus:'CANDIDATE'}});inserted++;}
 }
 return {inserted,existing};
}
export async function commitSeedImport(db:any,input:{actorUserId:string;targetId:string;mode:'ALL_OR_NOTHING'|'SKIP_ERRORS';idempotencyKey:string;reason:string}){
 if(!['ALL_OR_NOTHING','SKIP_ERRORS'].includes(input.mode))throw new DomainError(400,'SEED_IMPORT_MODE_INVALID');
 return idempotentSeedMutation(db,input,'SEED_IMPORT_COMMITTED',{targetId:input.targetId,mode:input.mode},async tx=>{
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','seed-import:'+input.targetId);
  const job=await tx.seedImportJob.findUnique({where:{id:input.targetId}});
  if(!job||job.actorUserId!==input.actorUserId)throw new DomainError(404,'SEED_IMPORT_NOT_FOUND');
  if(job.status!=='PREVIEWED'||job.expiresAt<=new Date())throw new DomainError(409,'SEED_IMPORT_NOT_READY');
  if(input.mode==='ALL_OR_NOTHING'&&job.counts.invalid>0)throw new DomainError(409,'SEED_IMPORT_HAS_ERRORS');
  const report=await mergeImportedDefinitions(tx,input.actorUserId,job.rowResults.definitions);
  await tx.seedImportJob.update({where:{id:job.id},data:{status:'COMMITTED',counts:{...job.counts,...report,skipped:job.counts.invalid}}});
  return {targetId:job.id,revision:job.previewRevision,...report,skipped:job.counts.invalid,message:'主库导入完成；新增线索为草稿，需另行预览发布。'};
 });
}
export async function confirmSeedRelation(db:any,input:{actorUserId:string;targetId:string;decision:'CONFIRMED'|'REJECTED';idempotencyKey:string;reason:string}){
 return idempotentSeedMutation(db,input,'SEED_RELATION_DECIDED',{targetId:input.targetId,decision:input.decision},async tx=>{
  if(!['CONFIRMED','REJECTED'].includes(input.decision))throw new DomainError(400,'SEED_RELATION_INVALID');
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','seed-relation:'+input.targetId);
  const relation=await tx.seedRelation.findUnique({where:{id:input.targetId}});if(!relation)throw new DomainError(404,'SEED_RELATION_NOT_FOUND');
  if(relation.status!=='PENDING')throw new DomainError(409,'SEED_RELATION_ALREADY_DECIDED');
  if(input.decision==='CONFIRMED'){
   const evidence=await tx.seedEvidence.findMany({where:{id:{in:relation.evidenceIds},seedId:{in:[relation.fromSeedId,relation.toSeedId]}}});
   if(!evidence.length||evidence.length!==relation.evidenceIds.length)throw new DomainError(409,'SEED_RELATION_EVIDENCE_REQUIRED');
  }
  await tx.seedRelation.update({where:{id:relation.id},data:{status:input.decision,decisionReason:input.reason,decidedByUserId:input.actorUserId}});
  return {targetId:relation.id,revision:1,message:'关系决定已记录，种子与历史广告保留。'};
 });
}
export async function saveSeedScanPlan(db:any,input:SeedMutation){
 return idempotentSeedMutation(db,input,'SEED_SCAN_PLAN_SAVED',{targetId:input.targetId,expectedRevision:input.expectedRevision,payload:input.payload},async tx=>{
  const previous=input.targetId?await tx.seedScanPlan.findUnique({where:{id:input.targetId}}):null;
  if(input.targetId&&!previous)throw new DomainError(404,'SEED_SCAN_PLAN_NOT_FOUND');if(previous&&previous.revision!==input.expectedRevision)throw new DomainError(409,'SEED_REVISION_CONFLICT');
  const raw=input.payload as any;let plan;try{plan=validateSeedScanPlan({...raw,id:input.targetId??randomUUID(),revision:previous?previous.revision+1:1});}catch{throw new DomainError(400,'SEED_SCAN_PLAN_INVALID');}
  const source=await tx.dataSource.findUnique({where:{key:plan.sourceKey}});if(!source)throw new DomainError(409,'SEED_SOURCE_MISSING');
  const data={...plan,dataSourceId:source.id};const saved=previous?await tx.seedScanPlan.update({where:{id:previous.id},data}):await tx.seedScanPlan.create({data});
  return {targetId:saved.id,revision:saved.revision,message:'扫描计划已保存；发布后按国家与日期生成查询。'};
 });
}
export async function verifyNativeSeed(db:any,input:{actorUserId:string;targetId:string;expectedRevision:number;evidenceIds:string[];idempotencyKey:string;reason:string}){
 return idempotentSeedMutation(db,input,'SEED_NATIVE_VERIFIED',{targetId:input.targetId,expectedRevision:input.expectedRevision,evidenceIds:input.evidenceIds},async tx=>{
  const seed=await tx.seedDefinition.findUnique({where:{id:input.targetId}});if(!seed||seed.revision!==input.expectedRevision)throw new DomainError(409,'SEED_REVISION_CONFLICT');
  if(seed.kind!=='NATIVE_ADVERTISER')throw new DomainError(400,'SEED_NATIVE_ONLY');
  const evidence=await tx.seedEvidence.findMany({where:{id:{in:input.evidenceIds},seedId:seed.id},include:{source:true}});
  // Only the trusted committed-run extractor can append this proof kind.
  // Manual directory/import and old parsed Page rows cannot establish identity.
  if(!evidence.length||evidence.length!==input.evidenceIds.length||evidence.some((e:any)=>e.source?.key!==seed.namespace||e.rawValue!==seed.rawValue||!e.runId||!e.evidenceSha256||e.originKind!=='ORIGINAL_SOURCE_IDENTITY'||e.role!=='SOURCE_IDENTITY'))throw new DomainError(409,'SEED_NATIVE_EVIDENCE_REQUIRED');
  const committed=await tx.collectionRun.findMany({where:{id:{in:evidence.map((e:any)=>e.runId)},dataSourceId:{in:evidence.map((e:any)=>e.dataSourceId)},finishedAt:{not:null}}});if(committed.length!==new Set(evidence.map((e:any)=>e.runId)).size)throw new DomainError(409,'SEED_NATIVE_EVIDENCE_REQUIRED');
  const result=await tx.seedDefinition.update({where:{id:seed.id},data:{verificationStatus:'VERIFIED',revision:{increment:1}}});return {targetId:seed.id,revision:result.revision,message:'原生身份已依据来源批次核验。'};
 });
}
