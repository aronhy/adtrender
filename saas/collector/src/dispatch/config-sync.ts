import {readFile,mkdir,open,rm,readdir} from 'node:fs/promises';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {setTimeout as sleep} from 'node:timers/promises';
import {validateSeedManifest,seedCanonical,type SeedConfigManifest,type SeedQuerySpec,type SourceKey} from '../../../contracts/src/seeds';
import {atomic,type PendingPlatform} from './pending-envelope';import {canonicalNativeParams} from './execution-guard';
export const sourceForPlatform:Record<PendingPlatform,SourceKey>={meta:'meta_ad_library',google:'google_ads_transparency',snapchat:'snapchat_ads_gallery',tiktok:'tiktok_commercial_library',pinterest:'pinterest_ads_repository'};
export interface ConfigState {jobs:any[];pending?:unknown;seedConfig?:{revision:number;contentHash:string;publicationId:string;queries:SeedQuerySpec[];mappings:Array<{queryId:string;nativeJobId:string}>;enabledIds:string[]}}
export interface ConfigReceipt {nodeId:string;incarnationId:string;sequence:number;publicationId:string;publicationRevision:number;manifestHash:string;applyStatus:'DOWNLOADED'|'VALIDATED'|'APPLIED'|'REJECTED'|'NO_NEW_SOURCE_REQUESTS'|'DRAINED';sourceKey?:SourceKey;nativeJobMappings:Array<{queryId:string;nativeJobId:string}>;observedAt:string;errorCode?:string}
export interface ConfigClient {fetchConfig(etag?:string):Promise<{status:200;manifest:SeedConfigManifest}|{status:304}>;sendConfigReceipt(receipt:ConfigReceipt):Promise<unknown>}
export interface ConfigContext {root:string;sequenceRoot:string;nodeId:string;incarnationId:string;protocolVersion:number;sourceKey?:SourceKey}
/** One counter shared by config and execution receipts for this node incarnation. */
export async function allocateCollectorSequence(root:string,nodeId:string,incarnationId:string):Promise<number>{
 const directory=join(root,'dispatch','sequence');await mkdir(directory,{recursive:true,mode:0o700});
 if(!/^[a-zA-Z0-9._-]{1,120}$/.test(nodeId)||! /^[a-f0-9-]{36}$/i.test(incarnationId))throw Error('COLLECTOR_IDENTITY_INVALID');
 const file=join(directory,nodeId+'-'+incarnationId+'.json'),lock=file+'.lock';let handle;
 for(let n=0;n<100;n++){try{handle=await open(lock,'wx',0o600);break;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;await sleep(20);}}
 if(!handle)throw Error('COLLECTOR_SEQUENCE_LOCKED');
 try{let last=0;try{last=JSON.parse(await readFile(file,'utf8')).sequence;if(!Number.isSafeInteger(last)||last<0)throw Error('COLLECTOR_SEQUENCE_INVALID');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}const sequence=last+1;if(!Number.isSafeInteger(sequence))throw Error('COLLECTOR_SEQUENCE_INVALID');await atomic(file,{sequence});return sequence;}finally{await handle.close();await rm(lock,{force:true});}
}
function revision(current:{revision:number;contentHash:string}|undefined,next:SeedConfigManifest){if(current&&next.revision<current.revision)throw Error('CONFIG_REVISION_DOWNGRADE');if(current&&next.revision===current.revision&&next.contentHash!==current.contentHash)throw Error('CONFIG_REVISION_CONFLICT');}
function validatedManifest(value:unknown,protocolVersion:number){const manifest=validateSeedManifest(value);if(protocolVersion<manifest.protocolMin||protocolVersion>manifest.protocolMax)throw Error('CONFIG_PROTOCOL_UNSUPPORTED');return manifest;}
export async function readCachedManifest(root:string,protocolVersion:number){return validatedManifest(JSON.parse(await readFile(join(root,'dispatch','manifest.json'),'utf8')),protocolVersion);}
async function cached(root:string,protocolVersion:number){try{return await readCachedManifest(root,protocolVersion);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}}
export async function flushConfigReceipts(client:ConfigClient,context:ConfigContext){const dir=join(context.sequenceRoot,'dispatch','config-receipts');let files:string[];try{files=await readdir(dir);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}for(const file of files.filter(f=>f.endsWith('.json')).sort()){const receipt=JSON.parse(await readFile(join(dir,file),'utf8')) as ConfigReceipt;if(receipt.nodeId!==context.nodeId||receipt.incarnationId!==context.incarnationId||context.sourceKey!==undefined&&receipt.sourceKey!==context.sourceKey)continue;await client.sendConfigReceipt(receipt);await rm(join(dir,file));}}
export async function enqueueConfigReceipt(client:ConfigClient,context:ConfigContext,manifest:SeedConfigManifest,applyStatus:ConfigReceipt['applyStatus'],nativeJobMappings:ConfigReceipt['nativeJobMappings']=[],flush=true){const sequence=await allocateCollectorSequence(context.sequenceRoot,context.nodeId,context.incarnationId);const receipt:ConfigReceipt={nodeId:context.nodeId,incarnationId:context.incarnationId,sequence,publicationId:manifest.publicationId,publicationRevision:manifest.revision,manifestHash:manifest.contentHash,applyStatus,...(context.sourceKey?{sourceKey:context.sourceKey}:{}),nativeJobMappings,observedAt:new Date().toISOString()};await atomic(join(context.sequenceRoot,'dispatch','config-receipts',String(sequence).padStart(16,'0')+'-'+randomUUID()+'.json'),receipt);if(flush)await flushConfigReceipts(client,context);return receipt;}
export async function syncSeedConfig(client:ConfigClient,context:ConfigContext):Promise<SeedConfigManifest>{
 const old=await cached(context.root,context.protocolVersion);let response;try{response=await client.fetchConfig(old?.contentHash);}catch{if(old)return old;throw Error('CONFIG_CONTROL_UNAVAILABLE');}
 if(response.status===304){if(!old)throw Error('CONFIG_CACHE_REQUIRED');await flushConfigReceipts(client,context);return old;}
 const manifest=validatedManifest(response.manifest,context.protocolVersion);revision(old,manifest);
 if(old?.contentHash===manifest.contentHash){await flushConfigReceipts(client,context);return old;}
 await atomic(join(context.root,'dispatch','manifest.json'),manifest);
 await enqueueConfigReceipt(client,context,manifest,'DOWNLOADED',[],false);await enqueueConfigReceipt(client,context,manifest,'VALIDATED',[],false);await flushConfigReceipts(client,context);return manifest;
}
function nativeJob(query:SeedQuerySpec,id:string){const p=canonicalNativeParams(query.sourceKey,query.mode,{...query.params,channel:query.channel}),common={id,country:p.country,lastAttemptAt:0,failures:0};
 if(query.sourceKey==='meta_ad_library')return {...common,language:p.language,keyword:p.keyword,...(p.pageId?{pageId:p.pageId}:{}),seen:[],dueAt:0,exhaustedAt:null};
 if(query.sourceKey==='google_ads_transparency')return {...common,kind:p.kind,language:p.language,term:p.term,...(p.advertiserId?{advertiserId:p.advertiserId}:{}),...(p.domain?{domain:p.domain}:{}),seen:[],dueAt:0,exhaustedAt:null};
 if(query.sourceKey==='snapchat_ads_gallery')return {...common,publisher:p.publisher,kind:'CANDIDATE',seen:[],complete:false,retryAt:0,cycleAt:0};
 return {...common,start:p.startDate,end:p.endDate,page:0,complete:false,retryAt:0,...(query.sourceKey==='pinterest_ads_repository'?{keyword:'',category:'ALL'}:{seen:[],cycleStartedAt:Date.now(),...(query.mode==='MEDIA_REFRESH'?{kind:'MEDIA_REFRESH',sourceAdIds:p.sourceAdIds}:{})})};
}
export function applyManifestAtBoundary<S extends ConfigState>(state:S,input:SeedConfigManifest,platform:PendingPlatform):S{
 if(state.pending)throw Error('CONFIG_BOUNDARY_PENDING');const manifest=validateSeedManifest(input);revision(state.seedConfig,manifest);
 const next=structuredClone(state),queries=manifest.queries.filter(q=>q.sourceKey===sourceForPlatform[platform]),mappings:Array<{queryId:string;nativeJobId:string}>=[],enabledIds:string[]=[];
 for(const query of queries){const ids=query.nativeJobIds;if(!ids.length)throw Error('CONFIG_NATIVE_ID_REQUIRED');const expected=canonicalNativeParams(query.sourceKey,query.mode,{...query.params,channel:query.channel});
  const active=manifest.bindings.some(b=>b.queryId===query.queryId&&b.participationStatus==='ACTIVE'&&b.validFromRevision<=manifest.revision&&(b.validToRevision===null||manifest.revision<b.validToRevision)&&(b.ownerKind!=='SCAN_PLAN'||manifest.scanPlans.some(p=>p.id===b.scanPlanId&&p.status==='ACTIVE')));
  for(const nativeJobId of ids){const old=next.jobs.find(job=>job.id===nativeJobId);
   const previous=state.seedConfig?.queries.find(q=>q.nativeJobIds.includes(nativeJobId));if(previous&&seedCanonical(canonicalNativeParams(previous.sourceKey,previous.mode,{...previous.params,channel:previous.channel}))!==seedCanonical(expected))throw Error('CONFIG_NATIVE_PARAMS_CONFLICT');
   if(mappings.some(mapping=>mapping.nativeJobId===nativeJobId))throw Error('CONFIG_NATIVE_ID_CONFLICT');
   if(old){let actual;try{actual=canonicalNativeParams(query.sourceKey,query.mode,{...old,channel:query.channel});}catch{throw Error('CONFIG_NATIVE_PARAMS_CONFLICT');}if(seedCanonical(actual)!==seedCanonical(expected))throw Error('CONFIG_NATIVE_PARAMS_CONFLICT');}
   else next.jobs.push(nativeJob(query,nativeJobId));mappings.push({queryId:query.queryId,nativeJobId});if(active&&query.desiredEnabled&&!manifest.tombstones.some(t=>t.queryId===query.queryId))enabledIds.push(nativeJobId);
  }
 }
 next.seedConfig={revision:manifest.revision,contentHash:manifest.contentHash,publicationId:manifest.publicationId,queries,mappings,enabledIds};return next;
}
export function isManagedJobEnabled(state:ConfigState,nativeJobId:string){return state.seedConfig?.enabledIds.includes(nativeJobId)??false;}
