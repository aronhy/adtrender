import {createHash} from 'node:crypto';
import {discoverCommittedRun} from './seed-discovery';
import {createCollectorEvidenceStore,type ArtifactStore} from './collector-evidence';
import {seedSourceKeys,type SourceKey} from '../../../packages/contracts/src/seeds';
import {configuredCollectorDispatch} from '../../web/src/collector-dispatch/configured';
import {refreshPublishedScanWindows} from '../../web/src/seed-library/rolling-scans';
/** The trusted independent worker creates cycles. A machine claim only claims existing work. */
export async function seedDispatchTick(db:any,options:{actorUserId:string;env?:Record<string,string|undefined>;now?:Date;signal?:AbortSignal}){
 if(options.signal?.aborted)return {created:0,recovering:0,rolling:null};
 const dispatch=configuredCollectorDispatch(db,options.env),rolling=await refreshPublishedScanWindows(db,{actorUserId:options.actorUserId},options.now);
 const recovery=await dispatch.recoverExpiredAttempts({actorUserId:options.actorUserId});
 if(options.signal?.aborted)return {created:0,...recovery,rolling};
 const scheduled=await dispatch.scheduleDueQueries({actorUserId:options.actorUserId});return {...scheduled,...recovery,rolling};
}
/** Reconcile all committed facts in bounded database pages. Page size is not a daily task cap. */
function discoverySources(keys:readonly SourceKey[]|undefined):readonly SourceKey[]{
 if(keys===undefined)return seedSourceKeys;
 if(!Array.isArray(keys)||!keys.length||keys.some(key=>!seedSourceKeys.includes(key)))throw Error('SEED_DISCOVERY_SOURCE_FILTER_INVALID');
 return [...new Set(keys)];
}
export function seedDiscoverySourcesFromEnvironment(env:Record<string,string|undefined>=process.env):SourceKey[]|undefined{
 if(env.SEED_DISCOVERY_SOURCE_KEYS===undefined)return;
 return [...discoverySources(env.SEED_DISCOVERY_SOURCE_KEYS.split(',').map(key=>key.trim()) as SourceKey[])];
}
export async function seedDiscoveryTick(db:any,options:{extractionVersion:string;signal?:AbortSignal;sourceKeys?:readonly SourceKey[];sourceStore?(source:SourceKey):Promise<ArtifactStore>;evidencePrefix?:string}){
 const sources=discoverySources(options.sourceKeys);
 let cursorAt=new Date(0),cursorId='',processed=0,skipped=0,failed=0;
 for(;;){
  if(options.signal?.aborted)break;
  const rows=await db.collectionRun.findMany({where:{finishedAt:{not:null},task:{dataSource:{key:{in:[...sources]}}},OR:[{createdAt:{gt:cursorAt}},{createdAt:cursorAt,id:{gt:cursorId}}]},orderBy:[{createdAt:'asc'},{id:'asc'}],take:100,include:{task:{include:{dataSource:true}},seedAttempts:{select:{batchSha256:true}}}});
  if(!rows.length)break;
  for(const run of rows){
   if(options.signal?.aborted)break;
   const source=run.task.dataSource.key as SourceKey,attempt=run.seedAttempts?.[0],withArchive=!!attempt&&!!options.sourceStore;
   const requestId='seed-discovery:'+createHash('sha256').update(JSON.stringify([run.id,options.extractionVersion,withArchive?attempt.batchSha256:'facts-only'])).digest('hex');
   try{
    const prior=await db.auditEvent.findFirst({where:{action:'SEED_DISCOVERY_RECONCILED',requestId}});if(prior){skipped++;continue;}
    const store=withArchive?await options.sourceStore!(source):undefined;
    const result=await discoverCommittedRun(db,{runId:run.id,sourceKey:source,extractionVersion:options.extractionVersion,...(withArchive?{batchSha256:attempt.batchSha256,archiveKey:`${options.evidencePrefix??'collector-evidence'}/${source}/${attempt.batchSha256}.bin`}:{})},store);
    // Projection writes are independently idempotent. A crash before this marker safely repeats them.
    await db.auditEvent.create({data:{action:'SEED_DISCOVERY_RECONCILED',targetType:'CollectionRun',targetId:run.id,requestId,metadata:{extractionVersion:options.extractionVersion,sourceKey:source,withArchive,...result}}});processed++;
   }catch{failed++;}
  }
  const last=rows.at(-1)!;cursorAt=last.createdAt;cursorId=last.id;
 }
 return {processed,skipped,failed};
}
export function evidenceStoresFromEnvironment(env:Record<string,string|undefined>=process.env){
 const stores=new Map<SourceKey,Promise<ArtifactStore>>(),prefix=env.COLLECTOR_EVIDENCE_PREFIX??'collector-evidence';
 if(!env.COLLECTOR_EVIDENCE_ROOT&&!(env.COLLECTOR_EVIDENCE_BUCKET&&env.COLLECTOR_EVIDENCE_REGION))return undefined;
 return {prefix,evidencePrefix:prefix,sourceStore:(sourceKey:SourceKey)=>{let store=stores.get(sourceKey);if(!store){const namespace={prefix,sourceKey};store=createCollectorEvidenceStore(env.COLLECTOR_EVIDENCE_ROOT?{kind:'local',rootDirectory:env.COLLECTOR_EVIDENCE_ROOT,namespace}:{kind:'s3',bucket:env.COLLECTOR_EVIDENCE_BUCKET!,region:env.COLLECTOR_EVIDENCE_REGION!,endpoint:env.COLLECTOR_EVIDENCE_ENDPOINT,forcePathStyle:env.COLLECTOR_EVIDENCE_PATH_STYLE==='true',namespace});stores.set(sourceKey,store);}return store;}};
}
