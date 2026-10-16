import {createHash} from 'node:crypto';import {z} from 'zod';
import {seedSourceKeys,seedCanonical} from '@ad-research/contracts/seeds';
import {DomainError} from '../team/access';
import {idempotentSeedMutation,normalizeSeedValue} from './catalog';
import {mergeImportedDefinitions} from './admin';
const feedSchema=z.object({schema:z.literal(1),generatedAt:z.string().datetime({offset:true}),candidates:z.array(z.object({publisher:z.string().min(1).max(200),sources:z.array(z.enum([...seedSourceKeys,'research_seed_catalog'])).min(1)}).passthrough()),truncated:z.literal(false).optional()}).passthrough();
export async function importAdvertiserDirectory(db:any,input:{actorUserId:string;idempotencyKey:string;reason:string;json:string}){
 if(Buffer.byteLength(input.json)>16*1024*1024)throw new DomainError(400,'SEED_DIRECTORY_TOO_LARGE');
 let feed:z.infer<typeof feedSchema>;try{feed=feedSchema.parse(JSON.parse(input.json));}catch{throw new DomainError(400,'SEED_DIRECTORY_INVALID');}
 const fileHash=createHash('sha256').update(input.json).digest('hex');
 return idempotentSeedMutation(db,input,'SEED_DIRECTORY_IMPORTED',{fileHash},async tx=>{
  const definitions=new Map<string,any>(),sourcesByName=new Map<string,Set<string>>();
  for(const entry of feed.candidates){
   const normalizedValue=normalizeSeedValue('NAME',entry.publisher);if(!definitions.has(normalizedValue))definitions.set(normalizedValue,{kind:'NAME',namespace:'advertiser_name_directory',rawValue:entry.publisher.trim(),normalizedValue,language:'und',purposeTags:[],targetScope:{kind:'CONFIGURED_MARKETS'},targetPlatforms:['meta_ad_library','google_ads_transparency','snapchat_ads_gallery'],status:'DRAFT',priority:0});
   const sources=sourcesByName.get(normalizedValue)??new Set<string>();entry.sources.forEach(s=>sources.add(s));sourcesByName.set(normalizedValue,sources);
  }
  const report=await mergeImportedDefinitions(tx,input.actorUserId,[...definitions.values()]),sourceRows=await tx.dataSource.findMany();let evidence=0;
  for(const [normalizedValue,namespaces] of sourcesByName){
   const seed=await tx.seedDefinition.findUnique({where:{kind_namespace_language_normalizedValue:{kind:'NAME',namespace:'advertiser_name_directory',language:'und',normalizedValue}}});
   for(const namespace of namespaces){
    const dedupeKey=createHash('sha256').update(seedCanonical(['directory-name-1',seed.id,namespace,normalizedValue])).digest('hex');
    await tx.seedEvidence.upsert({where:{dedupeKey},create:{seedId:seed.id,dedupeKey,originKind:'DIRECTORY_ONLY',dataSourceId:sourceRows.find((s:any)=>s.key===namespace)?.id??null,extractionVersion:'directory-name-1',rawValue:seed.rawValue,normalizedValue,fieldPath:`${namespace}:candidates[].publisher`,role:'NAME_CLUE'},update:{}});evidence++;
   }
  }
  return {targetId:fileHash,revision:1,...report,evidence,message:'名称目录已合并到同一主库，来源仅为目录线索；新增草稿需核验并发布。'};
 });
}
