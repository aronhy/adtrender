import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isAbsolute, resolve, dirname, basename, sep } from 'node:path';
import { mkdir, writeFile, readFile, lstat, realpath } from 'node:fs/promises';
import type { PrismaClient, Prisma } from '@prisma/client';
import { validateCollectionQuery, verifiedSourceProfiles, type CollectionQuery, type VerifiedQueryProfile } from '../../contracts/src/collection';
import { collectMetaAds, configuredMetaBrowserChannel, buildMetaSearchUrl } from '../../collector/src/meta-adapter';
import { META_PARSER_VERSION } from '../../collector/src/meta-parser';
import { DomainError, requirePlatformAdmin } from '../../app/src/team/access';

interface ProbeEvidence {file:string;sha256:string;bytes:number;url:string;httpStatus:number|null;observedAt:string;parserVersion:string}
interface ProbeManifest {version:1;provenance:'live-meta-probe';probeId:string;sourceId:string;sourceKey:string;adapterVersion:string;query:CollectionQuery;startedAt:string;finishedAt:string;evidence:ProbeEvidence[];outcome:{status:string;errorCode:string|null;retryable:boolean;observedCardCount:number;parsedAdCount:number;sourceAdIds:string[]}}
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const encoded=(value:unknown)=>JSON.stringify(canonical(value));
function signingKey(env:NodeJS.ProcessEnv) {if(!/^[a-f0-9]{64}$/i.test(env.SOURCE_PROBE_SIGNING_KEY??''))throw new DomainError(503,'SOURCE_PROBE_SIGNING_KEY_REQUIRED');return Buffer.from(env.SOURCE_PROBE_SIGNING_KEY!,'hex');}
const signature=(key:Buffer,hash:string)=>createHmac('sha256',key).update(`meta-source-probe-v1:${hash}`).digest('hex');
async function privateRoot(path:string) {
 if(!isAbsolute(path))throw new DomainError(400,'SOURCE_PROBE_PATH_INVALID');
 await mkdir(path,{recursive:true,mode:0o700});const info=await lstat(path);
 if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw new DomainError(400,'SOURCE_PROBE_DIRECTORY_NOT_PRIVATE');
 return realpath(path);
}
function checkedQuery(input:unknown) {const query=validateCollectionQuery(input);if(query.limit>3)throw new DomainError(400,'SOURCE_PROBE_LIMIT_EXCEEDED');return query;}
/** Explicit operator action only. It has no schedule, retry, fixture or adapter override. */
export async function runSourceProbe(db:PrismaClient,input:{actorUserId:string;sourceId:string;query:unknown;evidenceRoot:string;signal?:AbortSignal},env:NodeJS.ProcessEnv=process.env) {
 await requirePlatformAdmin(db,input.actorUserId);const key=signingKey(env),query=checkedQuery(input.query),browserChannel=configuredMetaBrowserChannel(env);
 const source=await db.dataSource.findUnique({where:{id:input.sourceId}});if(!source||source.adapterVersion!==META_PARSER_VERSION)throw new DomainError(409,'SOURCE_PROBE_ADAPTER_MISMATCH');
 const root=await privateRoot(input.evidenceRoot),probeId=randomUUID(),directory=resolve(root,'private-source-evidence',probeId);await mkdir(directory,{recursive:true,mode:0o700});
 const evidence:ProbeEvidence[]=[],startedAt=new Date().toISOString();
 const outcome=await collectMetaAds(query,{signal:input.signal,browserChannel,onEvidence:async snapshot=>{
  const bytes=Buffer.from(snapshot.html);if(bytes.length>20*1024*1024)throw new Error('EVIDENCE_TOO_LARGE');
  const sha256=digest(bytes),file=`${String(evidence.length+1).padStart(2,'0')}-${sha256}.html`;
  await writeFile(resolve(directory,file),bytes,{mode:0o600,flag:'wx'});
  evidence.push({file,sha256,bytes:bytes.length,url:snapshot.url,httpStatus:snapshot.httpStatus,observedAt:snapshot.observedAt,parserVersion:snapshot.parserVersion});
 }});
 const manifest:ProbeManifest={version:1,provenance:'live-meta-probe',probeId,sourceId:source.id,sourceKey:source.key,adapterVersion:source.adapterVersion,query,startedAt,finishedAt:new Date().toISOString(),evidence,outcome:{status:outcome.status,errorCode:outcome.errorCode,retryable:outcome.retryable,observedCardCount:outcome.observedCardCount,parsedAdCount:outcome.parsedAdCount,sourceAdIds:outcome.ads.map(ad=>ad.sourceAdId)}};
 const manifestSha256=digest(encoded(manifest)),manifestPath=resolve(directory,'manifest.json');
 await writeFile(manifestPath,JSON.stringify({manifest,manifestSha256,signature:signature(key,manifestSha256)},null,2),{mode:0o600,flag:'wx'});
 await writeFile(resolve(directory,'report.md'),`# Operator Meta source probe\n\nQuery: ${JSON.stringify(query)}\n\nOutcome: ${outcome.status} / ${outcome.errorCode??'none'}; parsed ads: ${outcome.parsedAdCount}; observed cards: ${outcome.observedCardCount}.\n\nParser: ${source.adapterVersion}; completed: ${manifest.finishedAt}.\n\nManifest SHA-256: ${manifestSha256}\n\n${evidence.map(item=>`${item.file}: ${item.sha256} (${item.bytes} bytes, HTTP ${item.httpStatus??'unknown'})`).join('\n')}\n\nThis probe does not activate a source or grant a query profile. Raw HTML remains private.\n`,{mode:0o600,flag:'wx'});
 await db.$transaction(async tx=>{
  await requirePlatformAdmin(tx,input.actorUserId);
  if(outcome.status==='restricted'||/^(META_HTTP_(403|429)|META_SOURCE_(CHALLENGE|LOGIN_REQUIRED))$/.test(outcome.errorCode??''))await tx.dataSource.update({where:{id:source.id},data:{status:'PAUSED',lastErrorCode:outcome.errorCode}});
  await tx.auditEvent.create({data:{actorUserId:input.actorUserId,action:'SOURCE_PROBE_COMPLETED',targetType:'DataSource',targetId:source.id,metadata:{probeId,status:outcome.status,errorCode:outcome.errorCode,manifestSha256}}});
 });
 return {status:outcome.status,errorCode:outcome.errorCode,parsedAdCount:outcome.parsedAdCount,manifestPath,manifestSha256};
}

/** A separate review step verifies signed live evidence and grants only its exact query. */
export async function grantSourceProfile(db:PrismaClient,input:{actorUserId:string;manifestPath:string;evidenceRoot:string},env:NodeJS.ProcessEnv=process.env) {
 await requirePlatformAdmin(db,input.actorUserId);const key=signingKey(env),root=await privateRoot(input.evidenceRoot);
 if(!isAbsolute(input.manifestPath)||basename(input.manifestPath)!=='manifest.json')throw new DomainError(400,'SOURCE_PROBE_PATH_INVALID');
 const manifestInfo=await lstat(input.manifestPath);const manifestPath=await realpath(input.manifestPath);
 if(manifestInfo.isSymbolicLink()||!manifestInfo.isFile()||manifestInfo.size>1024*1024||!manifestPath.startsWith(root+sep))throw new DomainError(400,'SOURCE_PROBE_PATH_INVALID');
 let envelope:any;try{envelope=JSON.parse(await readFile(manifestPath,'utf8'));}catch{throw new DomainError(400,'SOURCE_PROBE_MANIFEST_INVALID');}
 const manifest=envelope.manifest as ProbeManifest,manifestSha256=digest(encoded(manifest));
 if(envelope.manifestSha256!==manifestSha256||!/^[a-f0-9]{64}$/.test(envelope.signature??'')||!timingSafeEqual(Buffer.from(envelope.signature,'hex'),Buffer.from(signature(key,manifestSha256),'hex')))throw new DomainError(409,'SOURCE_PROBE_SIGNATURE_INVALID');
 if(manifest.version!==1||manifest.provenance!=='live-meta-probe'||manifest.adapterVersion!==META_PARSER_VERSION||!/^[-a-z0-9]{36}$/.test(manifest.probeId)||dirname(manifestPath)!==resolve(root,'private-source-evidence',manifest.probeId))throw new DomainError(409,'SOURCE_PROBE_MANIFEST_INVALID');
 const query=checkedQuery(manifest.query),completed=Date.parse(manifest.finishedAt),started=Date.parse(manifest.startedAt);
 if(!Number.isFinite(completed)||!Number.isFinite(started)||started>completed||completed>Date.now()||Date.now()-completed>30*86400000)throw new DomainError(409,'SOURCE_PROBE_EXPIRED');
 if(manifest.outcome.status!=='success'||manifest.outcome.errorCode!==null||manifest.outcome.parsedAdCount<1||manifest.outcome.parsedAdCount>query.limit||!Array.isArray(manifest.outcome.sourceAdIds)||new Set(manifest.outcome.sourceAdIds).size!==manifest.outcome.parsedAdCount||manifest.outcome.sourceAdIds.some(id=>!/^\d+$/.test(id)))throw new DomainError(409,'SOURCE_PROBE_NOT_SUCCESSFUL');
 if(!Array.isArray(manifest.evidence)||!manifest.evidence.length||manifest.evidence.length>6)throw new DomainError(409,'SOURCE_PROBE_EVIDENCE_INVALID');
 let successful:ProbeEvidence|undefined;
 for(const item of manifest.evidence) {
  if(!/^\d{2}-[a-f0-9]{64}\.html$/.test(item.file)||!Number.isSafeInteger(item.bytes)||item.bytes<1||item.bytes>20*1024*1024||item.parserVersion!==manifest.adapterVersion)throw new DomainError(409,'SOURCE_PROBE_EVIDENCE_INVALID');
  const path=resolve(dirname(manifestPath),item.file),info=await lstat(path);
  if(info.isSymbolicLink()||!info.isFile()||info.size!==item.bytes||(await realpath(path))!==path)throw new DomainError(409,'SOURCE_PROBE_EVIDENCE_INVALID');
  const bytes=await readFile(path);if(digest(bytes)!==item.sha256)throw new DomainError(409,'SOURCE_PROBE_EVIDENCE_HASH_MISMATCH');
  const actual=new URL(item.url),expected=new URL(buildMetaSearchUrl(query));
  if(actual.origin!==expected.origin||actual.pathname!==expected.pathname||[...expected.searchParams].some(([name,value])=>actual.searchParams.get(name)!==value))throw new DomainError(409,'SOURCE_PROBE_QUERY_MISMATCH');
  if(item.httpStatus===200)successful=item;
 }
 if(!successful)throw new DomainError(409,'SOURCE_PROBE_EVIDENCE_INVALID');
 const profile:VerifiedQueryProfile={id:manifest.probeId,sourceId:manifest.sourceId,adapterVersion:manifest.adapterVersion,query,verifiedAt:manifest.finishedAt,expiresAt:new Date(completed+30*86400000).toISOString(),provenance:'live-meta-probe',authorization:'operator-signed-probe',evidenceReference:`local-private:private-source-evidence/${manifest.probeId}/${successful.file}`,evidenceSha256:successful.sha256,probeManifestSha256:manifestSha256};
 return db.$transaction(async tx=>{
  await requirePlatformAdmin(tx,input.actorUserId);
  const sources=await tx.$queryRawUnsafe<Array<{id:string;key:string;adapterVersion:string;capabilities:unknown}>>(`SELECT id,key,"adapterVersion",capabilities FROM "DataSource" WHERE id=$1 FOR UPDATE`,manifest.sourceId);const source=sources[0];
  if(!source||source.key!==manifest.sourceKey||source.adapterVersion!==manifest.adapterVersion)throw new DomainError(409,'SOURCE_PROBE_ADAPTER_MISMATCH');
  const profiles=verifiedSourceProfiles(source);const prior=profiles.find(item=>item.id===profile.id);if(prior){if(prior.probeManifestSha256!==manifestSha256)throw new DomainError(409,'SOURCE_PROBE_GRANT_CONFLICT');return prior;}
  const capabilities={version:1,verification:'VERIFIED',verifiedQueryProfiles:[...profiles,profile]};
  await tx.dataSource.update({where:{id:source.id},data:{status:'PAUSED',capabilities:JSON.parse(JSON.stringify(capabilities)) as Prisma.InputJsonValue}});
  await tx.auditEvent.create({data:{actorUserId:input.actorUserId,action:'SOURCE_QUERY_VERIFIED',targetType:'DataSource',targetId:source.id,metadata:{probeId:profile.id,query:JSON.parse(JSON.stringify(query)),manifestSha256,evidenceSha256:profile.evidenceSha256}}});
  return profile;
 });
}
