import express,{type Request,type Response} from 'express';
import {createHash} from 'node:crypto';
import type {MiddlewareConfigFn} from 'wasp/server/middleware';
import {prisma} from 'wasp/server';
import {DomainError} from '../team/access';
import {authenticateCollector,parseCollectorCredentials} from '../collector-dispatch/auth';
import {configuredCollectorDispatch} from '../collector-dispatch/configured';
import {scopeManifest,acceptConfigReceipt} from '../seed-library/publications';
import {seedSourceKeys,seedCanonical,SEED_MANIFEST_CHUNK_BYTES,type SeedConfigManifest,type SeedManifestDescriptor,type SeedManifestChunk,type SourceKey} from '@ad-research/contracts/seeds';
function identity(req:Request){
 const machine=authenticateCollector(req.headers,parseCollectorCredentials(process.env.COLLECTOR_NODE_CREDENTIALS_JSON)),requested=req.headers['x-collector-source'];
 if(requested!==undefined){if(typeof requested!=='string'||!machine.allowedSourceKeys.includes(requested as SourceKey))throw new DomainError(403,'MACHINE_SOURCE_FORBIDDEN');return {...machine,allowedSourceKeys:[requested as SourceKey]};}return machine;
}
const respond=async(res:Response,run:()=>Promise<unknown>)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
 try{const result=await run();if(!res.headersSent)res.json(result);}catch(error){if(!res.headersSent)res.status(error instanceof DomainError?error.status:400).json({error:error instanceof DomainError?error.code:'COLLECTOR_REQUEST_REJECTED'});}
};
export const collectorMiddleware:MiddlewareConfigFn=config=>{
 config.delete('express.json');config.delete('express.urlencoded');
 config.set('collector.auth',(req,res,next)=>{try{identity(req);next();}catch(error){res.setHeader('Cache-Control','no-store');res.status(error instanceof DomainError?error.status:401).json({error:error instanceof DomainError?error.code:'COLLECTOR_AUTH_REJECTED'});}});
 config.set('collector.json',express.json({limit:'32mb'}));return config;
};
export async function collectorConfig(req:Request,res:Response){
 return respond(res,async()=>{
  const machine=identity(req),node=await prisma.collectorNode.findUnique({where:{nodeId:machine.nodeId}});
  if(!node||node.incarnationId!==machine.incarnationId)throw new DomainError(409,'MACHINE_IDENTITY_REJECTED');
  const pageRequested=['publicationId','manifestHash','chunkIndex'].some(key=>req.query[key]!==undefined);
  let publicationId:string|undefined,chunkIndex:number|undefined;
  if(pageRequested){
   if(typeof req.query.publicationId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(req.query.publicationId)||typeof req.query.manifestHash!=='string'||!/^[a-f0-9]{64}$/.test(req.query.manifestHash)||typeof req.query.chunkIndex!=='string'||!/^(0|[1-9]\d*)$/.test(req.query.chunkIndex)||!Number.isSafeInteger(Number(req.query.chunkIndex)))throw new DomainError(400,'SEED_CONFIG_CHUNK_INVALID');
   publicationId=req.query.publicationId;chunkIndex=Number(req.query.chunkIndex);
  }
  // Every page reads this immutable publication and rechecks the authenticated
  // source scopes. A new head cannot change bytes halfway through a download.
  const publication=publicationId?await prisma.seedPublication.findUnique({where:{id:publicationId}}):await prisma.seedPublication.findFirst({where:{status:'PUBLISHED'},orderBy:{revision:'desc'}});if(!publication||publication.status!=='PUBLISHED')throw new DomainError(404,'SEED_PUBLICATION_NOT_FOUND');
  const snapshot=publication.configSnapshot as any,manifest=(snapshot.manifest??snapshot) as SeedConfigManifest;
  const tombstoneSources=new Map<string,string>((await prisma.seedQuery.findMany({where:{id:{in:manifest.tombstones.map(t=>t.queryId)}},select:{id:true,sourceKey:true}})).map((q:{id:string;sourceKey:string})=>[q.id,q.sourceKey] as [string,string]));
  const scoped=scopeManifest(manifest,[...machine.allowedSourceKeys],tombstoneSources),etag='"'+scoped.contentHash+'"';res.setHeader('ETag',etag);
  if(!pageRequested&&req.headers['if-none-match']===etag){res.status(304).end();return;}
  if(pageRequested&&req.query.manifestHash!==scoped.contentHash)throw new DomainError(409,'SEED_CONFIG_SCOPE_MISMATCH');
  if(pageRequested||req.query.chunked==='1'){
   const bytes=Buffer.from(seedCanonical(scoped),'utf8'),totalChunks=Math.ceil(bytes.length/SEED_MANIFEST_CHUNK_BYTES);
   const common={schemaVersion:1 as const,publicationId:publication.id,publicationRevision:publication.revision,manifestHash:scoped.contentHash};
   if(pageRequested){
    if(chunkIndex!>=totalChunks)throw new DomainError(400,'SEED_CONFIG_CHUNK_INVALID');
    const part=bytes.subarray(chunkIndex!*SEED_MANIFEST_CHUNK_BYTES,(chunkIndex!+1)*SEED_MANIFEST_CHUNK_BYTES);
    const chunk:SeedManifestChunk={...common,type:'SEED_MANIFEST_CHUNK',chunkIndex:chunkIndex!,byteSha256:createHash('sha256').update(part).digest('hex'),byteLength:part.length,dataBase64:part.toString('base64')};return chunk;
   }
   const descriptor:SeedManifestDescriptor={...common,type:'SEED_MANIFEST_DESCRIPTOR',byteSha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,chunkBytes:SEED_MANIFEST_CHUNK_BYTES,totalChunks};return descriptor;
  }
  return scoped;
 });
}
export async function collectorConfigReceipt(req:Request,res:Response){return respond(res,async()=>{const machine=identity(req);return acceptConfigReceipt(prisma,{trustedNodeId:machine.nodeId,sourceScopes:[...machine.allowedSourceKeys],receipt:req.body});});}
function source(value:unknown):SourceKey{if(typeof value!=='string'||!seedSourceKeys.includes(value as SourceKey))throw new DomainError(400,'COLLECTOR_SOURCE_INVALID');return value as SourceKey;}
function service(){return configuredCollectorDispatch(prisma);}
export const collectorPlatformGrant=(req:Request,res:Response)=>respond(res,()=>service().getPlatformGrant(identity(req),{sourceKey:source(req.query.sourceKey),...(typeof req.query.channel==='string'?{channel:req.query.channel}:{})}));
export const collectorClaim=(req:Request,res:Response)=>respond(res,()=>service().claimTask(identity(req),req.body));
export const collectorPermit=(req:Request,res:Response)=>respond(res,async()=>{
 const dispatch=service(),machine=identity(req),body=req.body,context=body?.context;
 if(!context||typeof context!=='object'||context.queryId!==body.queryId)throw new DomainError(400,'COLLECTOR_CONTEXT_REQUIRED');
 if(context.attemptId){
  const attemptInput={attemptId:context.attemptId,grantToken:context.grantToken};
  if(body.requestKind==='UNIT_START')await dispatch.startAttempt(machine,attemptInput);
  return dispatch.acquireSourcePermit(machine,{...attemptInput,requestKind:body.requestKind});
 }
 return dispatch.platformPermit(machine,{...context,requestKind:body.requestKind,nativeParams:body.nativeParams});
});
export const collectorPrepare=(req:Request,res:Response)=>respond(res,()=>service().prepareSubmission(identity(req),req.body));
export const collectorSubmit=(req:Request,res:Response)=>respond(res,()=>service().submitManagedUnit(identity(req),req.body));
export const collectorRecover=(req:Request,res:Response)=>respond(res,()=>service().recoverSubmit(identity(req),req.body));
export const collectorHeartbeat=(req:Request,res:Response)=>respond(res,()=>service().heartbeat(identity(req),req.body));
export const collectorStart=(req:Request,res:Response)=>respond(res,()=>service().startAttempt(identity(req),req.body));
export const collectorRenew=(req:Request,res:Response)=>respond(res,()=>service().renewAttempt(identity(req),req.body));
export const collectorStopped=(req:Request,res:Response)=>respond(res,()=>req.body?.attemptId?service().acknowledgeStop(identity(req),req.body):service().acknowledgeSourceStop(identity(req),req.body));
export const collectorRestriction=(req:Request,res:Response)=>respond(res,()=>service().recordRestriction(identity(req),req.body));
export const collectorCheckpoint=(req:Request,res:Response)=>respond(res,()=>service().readCheckpoint(identity(req),req.body));
export const collectorControlHandoff=(req:Request,res:Response)=>respond(res,()=>service().readControlHandoff(identity(req),req.body));

export const collectorSourceStopContext=(req:Request,res:Response)=>respond(res,()=>service().readSourceStopContext(identity(req),{sourceKey:source(req.query.sourceKey)}));
