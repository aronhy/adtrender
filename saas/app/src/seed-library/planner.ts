import {createHash} from 'node:crypto';
import {canonicalJson,legacyQueryIdentity} from './legacy-query-key';
import {nativeScanWindows} from '@ad-research/contracts/seed-native-plan';
import type {SeedDefinitionInput,SeedScanPlanInput,SeedQuerySpec,OwnerBinding} from '@ad-research/contracts/seeds';
export type NativeCapability = {sourceKey:string;channel:string;modes:string[];countries:string[];global?:boolean;version:string;adapterVersion:string}
export interface LegacyMapping {sourceKey:string;queryKey:string;queryId:string;nativeJobId:string;query?:SeedQuerySpec;legacyOwnerKey?:string;legacyOwnerStatus?:'ACTIVE'|'PAUSED'|'REMOVED';legacyOwnerRevision?:number;checkpointDigest?:string}
export interface DispatchDecision {ownerId:string;sourceKey:string;country?:string;decision:'READY'|'NEEDS_RESOLUTION'|'UNSUPPORTED_MODE'|'UNVERIFIED_COUNTRY';reason?:string}
export interface SeedCompilation {queries:SeedQuerySpec[];bindings:OwnerBinding[];decisions:DispatchDecision[];diff:{newQueryKeys:string[];reusedQueryKeys:string[];disabledQueryKeys:string[]}}
export function uuidForQuery(key:string):string {const hex=createHash('sha256').update('seed-query:'+key).digest('hex').slice(0,32);return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20)}`;}
function nativeId(source:string,p:any):string{
 if(source==='meta_ad_library')return JSON.stringify([p.country,p.language,p.pageId??'',p.keyword??'']);
 if(source==='google_ads_transparency')return JSON.stringify([p.kind,p.country,p.language,p.term??'',p.advertiserId??'',p.domain??'']);
 if(source==='snapchat_ads_gallery')return p.country+':'+String(p.publisher).trim().toLowerCase();
 return `${p.country}:${p.startDate??p.dateStart}:${p.endDate??p.dateEnd}`;
}
function scopeCountries(scope:any,cap:NativeCapability):string[]{return scope.kind==='SOURCE_GLOBAL'?(cap.global?['ALL']:[]):scope.kind==='EXPLICIT_COUNTRIES'?[...new Set(scope.countries as string[])]:cap.countries;}
export function compileSeedPlan(definitions:ReadonlyArray<SeedDefinitionInput|any>,scanPlans:ReadonlyArray<SeedScanPlanInput|any>,capabilities:ReadonlyArray<NativeCapability>,legacyMappings:ReadonlyArray<LegacyMapping>,now=new Date()):SeedCompilation {
 const queries=new Map<string,SeedQuerySpec>(),bindings:OwnerBinding[]=[],decisions:DispatchDecision[]=[],old=new Map(legacyMappings.map(m=>[m.queryKey,m])),legacyBindingKeys=new Set<string>();
 const add=(cap:NativeCapability,params:Record<string,unknown>,mode:string,owner:any,ownerKind:'SEED'|'SCAN_PLAN',active:boolean)=>{
  const identity=legacyQueryIdentity(cap.sourceKey,params),prior=old.get(identity.key),queryId=prior?.queryId??uuidForQuery(identity.key);
  let q=queries.get(identity.key);
  if(!q){q={queryId,queryKey:identity.key,queryKeyVersion:'legacy-1',sourceKey:cap.sourceKey as SeedQuerySpec['sourceKey'],channel:cap.channel,mode,params:prior?.query?.params??params,legacyDims:prior?.query?.legacyDims??{language:params.language??'und'},adapterVersion:cap.adapterVersion,capabilityVersion:cap.version,desiredEnabled:false,nativeJobIds:prior?[prior.nativeJobId]:[nativeId(cap.sourceKey,params)]};queries.set(identity.key,q);}
  q.desiredEnabled ||= active;
  bindings.push({queryId:q.queryId,ownerKind,seedId:ownerKind==='SEED'?owner.id:null,scanPlanId:ownerKind==='SCAN_PLAN'?owner.id:null,legacyOwnerKey:null,ownerRevision:owner.revision??1,participationStatus:active?'ACTIVE':'PAUSED',purposeSnapshot:ownerKind==='SEED'?owner.purposeTags:[],validFromRevision:0,validToRevision:null});
  decisions.push({ownerId:owner.id,sourceKey:cap.sourceKey,country:String(params.country),decision:'READY'});
 };
 for(const seed of definitions){
  if(['DRAFT','ARCHIVED','MERGED'].includes(seed.status))continue;if(!seed.id)throw Error('SEED_ID_REQUIRED');
  for(const sourceKey of seed.targetPlatforms){
   const caps=capabilities.filter(c=>c.sourceKey===sourceKey);const matching=caps.filter(c=>seed.kind==='KEYWORD'?c.modes.includes('KEYWORD'):seed.kind==='NAME'?c.modes.includes(c.sourceKey==='meta_ad_library'?'KEYWORD':'NAME'):c.modes.includes(seed.kind));
   if(!matching.length){decisions.push({ownerId:seed.id,sourceKey,decision:seed.kind==='DOMAIN'||seed.kind==='APP_REFERENCE'?'NEEDS_RESOLUTION':'UNSUPPORTED_MODE'});continue;}
   for(const cap of matching){
    const countries=scopeCountries(seed.targetScope,cap);if(!countries.length){decisions.push({ownerId:seed.id,sourceKey,decision:'UNVERIFIED_COUNTRY'});continue;}
    for(const country of countries){
     if(country!=='ALL'&&!cap.countries.includes(country)){decisions.push({ownerId:seed.id,sourceKey,country,decision:'UNVERIFIED_COUNTRY'});continue;}
     const language=seed.language||'und',value=seed.rawValue,active=seed.status==='ACTIVE';
     if(seed.kind==='NATIVE_ADVERTISER'&&(seed.namespace!==sourceKey||seed.verificationStatus!=='VERIFIED'||(sourceKey==='meta_ad_library'?!/^\d{5,}$/.test(value):!/^AR\d{5,}$/.test(value)))){decisions.push({ownerId:seed.id,sourceKey,country,decision:'NEEDS_RESOLUTION',reason:'VERIFIED_NATIVE_ID_REQUIRED'});continue;}
     if(sourceKey==='meta_ad_library')add(cap,{country,language,keyword:seed.kind==='NATIVE_ADVERTISER'?'':value,...(seed.kind==='NATIVE_ADVERTISER'?{pageId:value}:{}),status:'all',mediaType:'all'},seed.kind==='NATIVE_ADVERTISER'?'NATIVE_ADVERTISER':'KEYWORD',seed,'SEED',active);
     else if(sourceKey==='google_ads_transparency'){
      if(seed.kind==='DOMAIN'&&!/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(value)){decisions.push({ownerId:seed.id,sourceKey,country,decision:'NEEDS_RESOLUTION',reason:'DOMAIN_INVALID'});continue;}
      if(cap.channel==='SERP')add(cap,{kind:'SERP',country,language,term:value},'SERP',seed,'SEED',active);
      else if(seed.kind==='NAME')add(cap,{kind:'DISCOVER',country,language,term:value},'DISCOVER',seed,'SEED',active);
      else for(const kind of ['SEARCH','YOUTUBE'])add(cap,{kind,country,language,term:'',...(seed.kind==='DOMAIN'?{domain:value}:{advertiserId:value})},kind,seed,'SEED',active);
     }else if(sourceKey==='snapchat_ads_gallery')add(cap,{country,publisher:value},'NAME',seed,'SEED',active);
    }
   }
  }
 }
 for(const plan of scanPlans){
  if(['DRAFT','ARCHIVED'].includes(plan.status))continue;
  const cap=capabilities.find(c=>c.sourceKey===plan.sourceKey&&c.modes.includes('COUNTRY_DATE_SWEEP'));
  if(!cap){decisions.push({ownerId:plan.id,sourceKey:plan.sourceKey,decision:'UNSUPPORTED_MODE'});continue;}
  const wanted=scopeCountries(plan.targetScope,cap),countries=wanted.filter(c=>cap.countries.includes(c));for(const c of wanted)if(!countries.includes(c))decisions.push({ownerId:plan.id,sourceKey:plan.sourceKey,country:c,decision:'UNVERIFIED_COUNTRY'});
  if(!countries.length)continue;
  const end=plan.datePolicy.kind==='FIXED'?plan.datePolicy.end:now.toISOString().slice(0,10),start=plan.datePolicy.kind==='FIXED'?plan.datePolicy.start:new Date(Date.parse(end)-(plan.sourceKey==='tiktok_commercial_library'?plan.datePolicy.windowDays:plan.datePolicy.windowDays-1)*86400000).toISOString().slice(0,10);
  if(plan.sourceKey==='tiktok_commercial_library'&&start===end){decisions.push({ownerId:plan.id,sourceKey:plan.sourceKey,decision:'NEEDS_RESOLUTION',reason:'TIKTOK_NATIVE_RANGE_REQUIRES_BOUNDARIES'});continue;}
  try{for(const j of nativeScanWindows(plan.sourceKey,countries,start,end))add(cap,plan.sourceKey==='pinterest_ads_repository'?{country:j.country,dateStart:j.start,dateEnd:j.end,keyword:'',category:'ALL'}:{country:j.country,startDate:j.start,endDate:j.end},'SWEEP',plan,'SCAN_PLAN',plan.status==='ACTIVE');}
  catch(error){decisions.push({ownerId:plan.id,sourceKey:plan.sourceKey,decision:'NEEDS_RESOLUTION',reason:error instanceof Error?error.message:'SEED_NATIVE_RANGE_INVALID'});}
 }
 for(const mapping of legacyMappings){
  let q=queries.get(mapping.queryKey);if(!q&&mapping.query&&mapping.legacyOwnerKey&&mapping.legacyOwnerStatus!=='REMOVED'){q={...mapping.query,desiredEnabled:false,queryId:mapping.queryId,nativeJobIds:[mapping.nativeJobId]};queries.set(mapping.queryKey,q);}
  if(q&&!q.nativeJobIds.includes(mapping.nativeJobId))q.nativeJobIds.push(mapping.nativeJobId);
  if(!q||!mapping.legacyOwnerKey||mapping.legacyOwnerStatus==='REMOVED')continue;const status=mapping.legacyOwnerStatus??'ACTIVE';q.desiredEnabled ||= status==='ACTIVE';
  const bindingKey=canonicalJson([q.queryId,mapping.legacyOwnerKey]);
  if(!legacyBindingKeys.has(bindingKey)){legacyBindingKeys.add(bindingKey);bindings.push({queryId:q.queryId,ownerKind:'LEGACY',seedId:null,scanPlanId:null,legacyOwnerKey:mapping.legacyOwnerKey,ownerRevision:mapping.legacyOwnerRevision??1,participationStatus:status,purposeSnapshot:[],validFromRevision:0,validToRevision:null});}
 }
 const result=[...queries.values()].sort((a,b)=>a.queryKey.localeCompare(b.queryKey));
 return {queries:result,bindings,decisions,diff:{newQueryKeys:result.filter(q=>!old.has(q.queryKey)).map(q=>q.queryKey),reusedQueryKeys:result.filter(q=>old.has(q.queryKey)).map(q=>q.queryKey),disabledQueryKeys:result.filter(q=>!q.desiredEnabled).map(q=>q.queryKey)}};
}
export function compilationDigest(compilation:SeedCompilation){return createHash('sha256').update(canonicalJson(compilation)).digest('hex');}
