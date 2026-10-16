import type { CollectionOutcome, CollectionQuery } from '../../contracts/src/collection';
import { collectMetaAds, type MetaCollectionOptions, type MetaSourceEvidence } from './meta-adapter';
import { createCollectionQueue, finishCollection, type CollectionDatabase, type CollectionTransaction, type EvidenceReference } from '../../app/src/collection-admin/queue';
import { ingestCollection } from '../../app/src/collection-admin/ingest';
import { validateCollectionQuery } from '../../contracts/src/collection';
import { DomainError } from '../../app/src/team/access';
import {assertLegacySourceAllowed} from './dispatch/legacy-source-guard';
export interface WorkerTickOptions {
  workerId:string;taskId?:string;leaseMs?:number;signal?:AbortSignal;browserChannel?:'chrome'|'chromium';
  adapter?:(query:CollectionQuery,options:MetaCollectionOptions)=>Promise<CollectionOutcome>;
  persistEvidence?:(input:{runId:string;query:CollectionQuery;outcome?:CollectionOutcome;snapshot?:MetaSourceEvidence;references?:EvidenceReference[]})=>Promise<EvidenceReference>;
}
/** No timer, process entrypoint, environment loading, old schedule or old runtime is imported. */
export async function workerTick(db:CollectionDatabase,options:WorkerTickOptions) {
  if(!options.persistEvidence)return {status:'CONFIGURATION_REQUIRED',errorCode:'SOURCE_EVIDENCE_STORE_REQUIRED'};
  const queue=createCollectionQueue(db);await queue.recoverExpired();
  const claim=await queue.claim({workerId:options.workerId,taskId:options.taskId,leaseMs:options.leaseMs});
  await db.workerHeartbeat.upsert({where:{id:options.workerId},create:{id:options.workerId,status:claim?'BUSY':'IDLE',version:'collector-1',capabilities:['meta-dom'],activeRunId:claim?.run.id??null},update:{lastSeenAt:new Date(),status:claim?'BUSY':'IDLE',activeRunId:claim?.run.id??null}});
  if(!claim)return {status:'IDLE'};
  const controller=new AbortController();const externalAbort=()=>controller.abort();options.signal?.addEventListener('abort',externalAbort,{once:true});if(options.signal?.aborted)controller.abort();
  let renewing=false;let settled=false;let restrictionReason:string|null=null;const leaseMs=options.leaseMs??60_000;
  const pauseSource=async(tx:CollectionTransaction)=>{
    await tx.dataSource.update({where:{id:claim.run.dataSourceId},data:{status:'PAUSED',lastErrorCode:restrictionReason}});
    await tx.auditEvent.create({data:{action:'SOURCE_AUTO_PAUSED',targetType:'DataSource',targetId:claim.run.dataSourceId,metadata:{runId:claim.run.id,taskId:claim.run.taskId,reason:restrictionReason,workerId:options.workerId}}});
  };
  const timer=setInterval(()=>{if(renewing||settled)return;renewing=true;void queue.renew(claim.token,leaseMs).then(async renewed=>{if(!renewed){controller.abort();return;}await db.workerHeartbeat.update({where:{id:options.workerId},data:{lastSeenAt:new Date()}});}).catch(()=>controller.abort()).finally(()=>{renewing=false;});},Math.max(250,Math.floor(leaseMs/3)));
  timer.unref();
  try {
    const query=validateCollectionQuery(claim.run.querySnapshot);const references:EvidenceReference[]=[];
    const source=await db.dataSource.findUnique({where:{id:claim.run.dataSourceId},select:{key:true}});
    const requestGuard=async()=>assertLegacySourceAllowed(db,source!.key,'META');await requestGuard();
    const persist=async(input:Parameters<NonNullable<WorkerTickOptions['persistEvidence']>>[0])=>{try{const saved=await options.persistEvidence!(input);if(!saved?.evidenceReference||!/^([a-f0-9]{64})$/i.test(saved.evidenceSha256))throw new Error('Invalid evidence reference');return saved;}catch{throw new DomainError(502,'EVIDENCE_STORAGE_FAILED');}};
    const outcome=await (options.adapter??collectMetaAds)(query,{signal:controller.signal,browserChannel:options.browserChannel,requestGuard,onEvidence:async snapshot=>{references.push(await persist({runId:claim.run.id,query,snapshot}));}});
    if(outcome.status==='restricted'||/^(META_HTTP_(403|429)|META_SOURCE_(CHALLENGE|LOGIN_REQUIRED))$/.test(outcome.errorCode??''))restrictionReason=outcome.errorCode??'META_SOURCE_RESTRICTED';
    if(outcome.status==='cancelled'){const finished=await queue.finish(claim.token,outcome);return {status:finished?'CANCELED':'LEASE_LOST',runId:claim.run.id};}
    if(!options.adapter && outcome.ads.length && references.length===0)throw new DomainError(502,'EVIDENCE_STORAGE_FAILED');
    const evidence=await persist({runId:claim.run.id,query,outcome,references});
    const result=await db.$transaction(async tx=>{
      const counts=await ingestCollection(tx,claim.token,outcome,evidence);
      if(!await finishCollection(tx,claim.token,outcome,{...counts,evidenceReference:evidence.evidenceReference}))throw new DomainError(409,'LEASE_LOST');
      if(restrictionReason)await pauseSource(tx);
      else {
        // A later success from an already-running batch must not clear a source restriction.
        await tx.dataSource.updateMany({where:{id:claim.run.dataSourceId,status:'ACTIVE'},data:{lastErrorCode:outcome.errorCode,...(['success','no-results'].includes(outcome.status)?{lastSuccessfulAt:new Date(outcome.collectedAt)}:{})}});
      }
      const run=await tx.collectionRun.findUnique({where:{id:claim.run.id},select:{status:true}});return {status:run!.status,runId:claim.run.id,...counts};
    },{timeout:30_000});settled=true;return result;
  } catch(error) {
    if(error instanceof DomainError&&error.code==='LEASE_LOST'){const canceled=await queue.ackCancel(claim.token);return {status:canceled?'CANCELED':'LEASE_LOST',runId:claim.run.id};}
    const failed:CollectionOutcome={status:controller.signal.aborted?'cancelled':'failed',ads:[],errorCode:controller.signal.aborted?'COLLECTION_CANCELLED':error instanceof DomainError&&error.code==='EVIDENCE_STORAGE_FAILED'?'EVIDENCE_STORAGE_FAILED':'COLLECTION_WORKER_FAILED',retryable:false,observedCardCount:0,parsedAdCount:0,parserVersion:claim.run.adapterVersion,collectedAt:new Date().toISOString()};
    const finished=restrictionReason?await db.$transaction(async tx=>{
      if(!await finishCollection(tx,claim.token,failed))return false;
      await tx.collectionRun.update({where:{id:claim.run.id},data:{restrictionReason}});await pauseSource(tx);return true;
    }):await queue.finish(claim.token,failed);return {status:finished?(failed.status==='cancelled'?'CANCELED':'FAILED'):'LEASE_LOST',runId:claim.run.id,errorCode:failed.errorCode};
  } finally {
    settled=true;clearInterval(timer);options.signal?.removeEventListener('abort',externalAbort);
    await db.workerHeartbeat.update({where:{id:options.workerId},data:{status:'IDLE',lastSeenAt:new Date(),activeRunId:null}});
  }
}
