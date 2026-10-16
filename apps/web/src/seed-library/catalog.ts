import {createHash,randomUUID} from 'node:crypto';
import {DomainError,requirePlatformAdmin} from '../team/access';
import {validateSeedDefinition,seedCanonical,type SeedDefinitionInput} from '@ad-research/contracts/seeds';
export interface SeedMutation {actorUserId:string;targetId?:string;expectedRevision?:number;payload:unknown;idempotencyKey:string;reason:string}
export function normalizeSeedValue(kind:string,value:string):string {
 const text=value.normalize('NFKC').trim().replace(/\s+/g,' '),max=kind==='APP_REFERENCE'?2000:kind==='DOMAIN'?253:200;if(!text||text.length>max||/[\u0000-\u001f\u007f]/.test(text))throw new DomainError(400,'SEED_VALUE_INVALID');
 if(kind==='DOMAIN'){if(!/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(text))throw new DomainError(400,'SEED_DOMAIN_INVALID');return text.toLowerCase();}
 return kind==='NATIVE_ADVERTISER'?text:text.toLowerCase();
}
export function mutationIdentity(input:{actorUserId:string;idempotencyKey:string;reason:string},action:string,payload:unknown){
 if(!/^[a-zA-Z0-9_.:-]{1,128}$/.test(input.idempotencyKey)||!input.reason?.trim()||input.reason.length>1000)throw new DomainError(400,'SEED_MUTATION_INVALID');
 return {requestId:`seed:${input.actorUserId}:${input.idempotencyKey}`,digest:createHash('sha256').update(seedCanonical({action,payload,reason:input.reason})).digest('hex')};
}
export async function idempotentSeedMutation(db:any,input:{actorUserId:string;idempotencyKey:string;reason:string},action:string,payload:unknown,execute:(tx:any)=>Promise<any>){
 const identity=mutationIdentity(input,action,payload);
 return db.$transaction(async(tx:any)=>{
  await requirePlatformAdmin(tx,input.actorUserId);await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',identity.requestId);
  const prior=await tx.auditEvent.findFirst({where:{actorUserId:input.actorUserId,requestId:identity.requestId}});
  if(prior){if(prior.action!==action||prior.metadata?.digest!==identity.digest)throw new DomainError(409,'SEED_IDEMPOTENCY_CONFLICT');return prior.metadata.result;}
  await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended('seed-publication-head',0))");
  const result=await execute(tx);
  await tx.auditEvent.create({data:{actorUserId:input.actorUserId,action,targetType:'SeedLibrary',targetId:result.targetId??null,requestId:identity.requestId,metadata:{digest:identity.digest,reason:input.reason,result}}});return result;
 },{timeout:30000});
}
export async function saveSeedDefinition(db:any,input:SeedMutation){
 return idempotentSeedMutation(db,input,'SEED_SAVE',{targetId:input.targetId,expectedRevision:input.expectedRevision,payload:input.payload},async tx=>{
  const raw=input.payload as Record<string,unknown>;if(!raw||typeof raw!=='object')throw new DomainError(400,'SEED_VALUE_INVALID');
  if(raw.verificationStatus!==undefined||raw.createdByUserId!==undefined||raw.revision!==undefined||raw.id!==undefined||raw.mergedIntoSeedId!==undefined||raw.status==='MERGED')throw new DomainError(400,'SEED_VERIFICATION_SERVER_ONLY');
  const prior=input.targetId?await tx.seedDefinition.findUnique({where:{id:input.targetId}}):null;
  if(input.targetId&&!prior)throw new DomainError(404,'SEED_NOT_FOUND');
  if(prior&&prior.revision!==input.expectedRevision)throw new DomainError(409,'SEED_REVISION_CONFLICT');
  const payload:Record<string,any>={kind:'KEYWORD',namespace:'public',language:'und',purposeTags:[],targetScope:{kind:'CONFIGURED_MARKETS'},targetPlatforms:[],status:prior?.status??'DRAFT',priority:0,...raw};
  const normalizedValue=normalizeSeedValue(String(payload.kind),String(payload.rawValue??''));
  let validated:SeedDefinitionInput;try{validated=validateSeedDefinition({...payload,normalizedValue});}catch{throw new DomainError(400,'SEED_DEFINITION_INVALID');}
  if(validated.kind==='NATIVE_ADVERTISER'&&!(validated.namespace==='meta_ad_library'?/^\d{5,}$/.test(validated.rawValue):validated.namespace==='google_ads_transparency'&&/^AR\d{5,}$/.test(validated.rawValue)))throw new DomainError(400,'SEED_NATIVE_ID_INVALID');
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','seed-definition:'+seedCanonical({kind:validated.kind,namespace:validated.namespace,language:validated.language,normalizedValue}));
  const duplicate=await tx.seedDefinition.findUnique({where:{kind_namespace_language_normalizedValue:{kind:validated.kind,namespace:validated.namespace,language:validated.language,normalizedValue}}});
  if(duplicate&&duplicate.id!==prior?.id){if(prior)throw new DomainError(409,'SEED_DUPLICATE_IDENTITY');return {targetId:duplicate.id,revision:duplicate.revision,message:'种子已存在，原配置保留。'};}
  const data={...validated,normalizedValue,rawValue:validated.rawValue.trim(),verificationStatus:prior?.rawValue===validated.rawValue&&prior.kind===validated.kind&&prior.namespace===validated.namespace&&prior.language===validated.language?prior.verificationStatus:'CANDIDATE'};
  const saved=prior?await tx.seedDefinition.update({where:{id:prior.id},data:{...data,revision:{increment:1}}}):await tx.seedDefinition.create({data:{...data,createdByUserId:input.actorUserId}});
  return {targetId:saved.id,revision:saved.revision,message:'已保存种子修订；发布后采集配置才变化。'};
 });
}
export async function importSeedBaseline(db:any,input:{actorUserId:string;definitions:unknown[];evidence?:any[];idempotencyKey:string;reason:string}){
 return idempotentSeedMutation(db,input,'SEED_BASELINE_IMPORT',{definitions:input.definitions,evidence:input.evidence??[]},async tx=>{
  const report={targetId:randomUUID(),inserted:0,existing:0,revision:1,message:'主库导入完成，默认草稿；未改变采集执行。'};
  for(const value of input.definitions){
   const raw=value as SeedDefinitionInput;if(raw.verificationStatus==='VERIFIED')throw new DomainError(400,'SEED_VERIFICATION_SERVER_ONLY');
   const normalizedValue=normalizeSeedValue(raw.kind,raw.rawValue),s=validateSeedDefinition({...raw,normalizedValue});
   await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','seed-definition:'+seedCanonical({kind:s.kind,namespace:s.namespace,language:s.language,normalizedValue}));
   const where={kind_namespace_language_normalizedValue:{kind:s.kind,namespace:s.namespace,language:s.language,normalizedValue}};
   const existing=await tx.seedDefinition.findUnique({where});
   if(existing){
    const tags=[...new Map([...(existing.purposeTags as any[]),...s.purposeTags].map(t=>[seedCanonical(t),t])).values()];
    const targetScope=existing.targetScope.kind==='EXPLICIT_COUNTRIES'&&s.targetScope.kind==='EXPLICIT_COUNTRIES'?{kind:'EXPLICIT_COUNTRIES',countries:[...new Set([...existing.targetScope.countries,...s.targetScope.countries])].sort()}:existing.targetScope;
    const targetPlatforms=[...new Set([...existing.targetPlatforms,...s.targetPlatforms])].sort();
    if(seedCanonical({tags,targetScope,targetPlatforms})!==seedCanonical({tags:existing.purposeTags,targetScope:existing.targetScope,targetPlatforms:existing.targetPlatforms}))await tx.seedDefinition.update({where:{id:existing.id},data:{purposeTags:tags,targetScope,targetPlatforms,revision:{increment:1}}});report.existing++;
   }else{await tx.seedDefinition.create({data:{...s,id:s.id??randomUUID(),createdByUserId:input.actorUserId,status:'DRAFT',verificationStatus:'CANDIDATE'}});report.inserted++;}
  }
  for(const e of input.evidence??[]){
   if(e.originKind!=='OFFICIAL_PRODUCT')throw new DomainError(400,'SEED_BASELINE_EVIDENCE_INVALID');
   let sourceUrl:URL;try{sourceUrl=new URL(e.sourceUrl);if(sourceUrl.protocol!=='https:'||sourceUrl.username||sourceUrl.password)throw Error();}catch{throw new DomainError(400,'SEED_BASELINE_EVIDENCE_INVALID');}
   const seed=await tx.seedDefinition.findUnique({where:{kind_namespace_language_normalizedValue:{kind:e.kind,namespace:e.namespace,language:e.language,normalizedValue:e.normalizedValue}}});if(!seed)throw new DomainError(400,'SEED_BASELINE_EVIDENCE_INVALID');
   const dedupeKey=createHash('sha256').update(seedCanonical({seedId:seed.id,sourceUrl:sourceUrl.href,observedAt:e.observedAt,originKind:e.originKind})).digest('hex');
   await tx.seedEvidence.upsert({where:{dedupeKey},create:{seedId:seed.id,dedupeKey,originKind:'OFFICIAL_PRODUCT',sourceUrl:sourceUrl.href,observedAt:new Date(e.observedAt),extractionVersion:'static-catalog-1',rawValue:seed.rawValue,normalizedValue:seed.normalizedValue,role:'PRODUCT_DIRECTORY'},update:{}});
  }
  return report;
 });
}
