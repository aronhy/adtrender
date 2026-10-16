import {randomUUID} from 'node:crypto';
import {seedCanonical,seedManifestContentHash,validateSeedManifest,seedSourceKeys,type SeedConfigManifest,type OwnerBinding,type SeedQuerySpec} from '@ad-research/contracts/seeds';
import {compileSeedPlan,type LegacyMapping,type NativeCapability} from './planner';
import {activateManifest,nextPublicationRevision} from './publications';
import {DomainError,requirePlatformAdmin} from '../team/access';
export interface RollingRefreshResult {changed:boolean;utcDay:string;reason:string;publicationId?:string;revision?:number}
type RolledManifest={changed:boolean;reason:string;manifest:SeedConfigManifest};
function bindingKey(b:OwnerBinding){return seedCanonical([b.queryId,b.ownerKind,b.seedId,b.scanPlanId,b.legacyOwnerKey]);}
function utcDay(now:Date){if(!Number.isFinite(now.valueOf()))throw new DomainError(400,'SCAN_REFRESH_TIME_INVALID');return now.toISOString().slice(0,10);}
function profilesValid(value:ReadonlyArray<NativeCapability>){return Array.isArray(value)&&value.every(p=>p&&seedSourceKeys.includes(p.sourceKey as SeedQuerySpec['sourceKey'])&&[p.channel,p.version,p.adapterVersion].every(v=>typeof v==='string'&&v.trim().length>0)&&Array.isArray(p.modes)&&p.modes.every((m:unknown)=>typeof m==='string')&&Array.isArray(p.countries)&&p.countries.every((c:unknown)=>typeof c==='string'&&/^[A-Z]{2}$/.test(c))&&(p.global===undefined||typeof p.global==='boolean'));}
function reference(q:SeedQuerySpec):LegacyMapping{return {sourceKey:q.sourceKey,queryKey:q.queryKey,queryId:q.queryId,nativeJobId:q.nativeJobIds[0],query:q};}
function semantics(m:SeedConfigManifest){return seedCanonical({queries:[...m.queries].sort((a,b)=>a.queryKey.localeCompare(b.queryKey)),bindings:[...m.bindings].sort((a,b)=>bindingKey(a).localeCompare(bindingKey(b))),scanPlans:m.scanPlans,tombstones:[...m.tombstones].sort((a,b)=>a.queryId.localeCompare(b.queryId))});}
/** Recompile only frozen published rolling owners. Registry references carry
 * identity and native IDs; they never introduce catalog intent or permissions. */
export function rollPublishedScanManifest(manifest:SeedConfigManifest,profiles:ReadonlyArray<NativeCapability>|null,now:Date,revision:number,references:ReadonlyArray<LegacyMapping>=[]):RolledManifest{
 utcDay(now);validateSeedManifest(manifest);
 const unchanged=(reason:string):RolledManifest=>({changed:false,reason,manifest});
 const plans=manifest.scanPlans.filter(p=>p.status==='ACTIVE'&&p.datePolicy.kind==='ROLLING');
 if(!plans.length)return unchanged('NO_ACTIVE_ROLLING_SCANS');
 if(profiles==null)return unchanged('FROZEN_CAPABILITIES_MISSING');
 if(!profilesValid(profiles))return unchanged('FROZEN_CAPABILITIES_INVALID');
 const rollingIds=new Set(plans.map(p=>p.id));
 const refs=[...references.map(r=>({...r,legacyOwnerKey:undefined})),...manifest.queries.filter(q=>q.nativeJobIds.length).map(reference)];
 const compiled=compileSeedPlan([],plans,profiles,refs,now);
 // An unverified country that never had a published query must not block a
 // supported country. Hold the snapshot if compilation loses existing work.
 const losesPublishedWork=compiled.decisions.some(d=>d.decision!=='READY'&&manifest.bindings.some(b=>b.ownerKind==='SCAN_PLAN'&&b.scanPlanId===d.ownerId&&manifest.queries.some(q=>q.queryId===b.queryId&&(d.country===undefined||q.params.country===d.country))));
 if(losesPublishedWork||!compiled.queries.length)return unchanged('PUBLISHED_SCAN_WINDOW_UNSUPPORTED');
 const priorBindings=new Map(manifest.bindings.map(b=>[bindingKey(b),b]));
 const keptBindings=manifest.bindings.filter(b=>!(b.ownerKind==='SCAN_PLAN'&&rollingIds.has(b.scanPlanId!)));
 const bindings=[...keptBindings,...compiled.bindings.map(b=>{
  const prior=priorBindings.get(bindingKey(b));
  const unchanged=prior&&prior.ownerRevision===b.ownerRevision&&prior.participationStatus===b.participationStatus&&seedCanonical(prior.purposeSnapshot)===seedCanonical(b.purposeSnapshot);
  return {...b,validFromRevision:unchanged?prior.validFromRevision:revision,validToRevision:null};
 })];
 const affectedIds=new Set(manifest.bindings.filter(b=>b.ownerKind==='SCAN_PLAN'&&rollingIds.has(b.scanPlanId!)).map(b=>b.queryId));
 const owners=new Map<string,OwnerBinding[]>();for(const b of bindings){const existing=owners.get(b.queryId)??[];existing.push(b);owners.set(b.queryId,existing);}
 const enabled=(id:string)=>owners.get(id)?.some(b=>b.validToRevision===null&&b.participationStatus==='ACTIVE')??false;
 const queries=new Map<string,SeedQuerySpec>();
 for(const q of manifest.queries){if(affectedIds.has(q.queryId)&&!owners.has(q.queryId))continue;queries.set(q.queryId,affectedIds.has(q.queryId)?{...q,desiredEnabled:enabled(q.queryId)}:q);}
 const nativeIds=new Map(refs.map(r=>[r.queryKey,r.query?.nativeJobIds??[r.nativeJobId]]));
 for(const q of compiled.queries){const prior=queries.get(q.queryId);queries.set(q.queryId,{...q,nativeJobIds:[...new Set([...(nativeIds.get(q.queryKey)??q.nativeJobIds),...q.nativeJobIds])],desiredEnabled:enabled(q.queryId),...(prior?{params:prior.params,legacyDims:prior.legacyDims}:{} )});}
 const tombstones=new Map(manifest.tombstones.map(t=>[t.queryId,t]));
 for(const id of affectedIds)if(!queries.has(id))tombstones.set(id,{queryId:id,reason:'SCAN_WINDOW_ROLLED_FORWARD'});
 for(const id of queries.keys())tombstones.delete(id);
 const body={...manifest,publicationId:randomUUID(),revision,parentRevision:manifest.revision,createdAt:now.toISOString(),queries:[...queries.values()].sort((a,b)=>a.queryKey.localeCompare(b.queryKey)),bindings,scanPlans:manifest.scanPlans,tombstones:[...tombstones.values()]};
 if(semantics(body)===semantics(manifest))return unchanged('SCAN_WINDOWS_UNCHANGED');
 const next=validateSeedManifest({...body,contentHash:seedManifestContentHash(body)});
 return {changed:true,reason:'PUBLISHED_SCAN_WINDOW_ROLLOVER',manifest:next};
}
/** The worker must opt into calling this; no wall-clock timer is installed here. */
export async function refreshPublishedScanWindows(db:any,actor:{actorUserId:string},now=new Date()):Promise<RollingRefreshResult>{
 const day=utcDay(now);
 return db.$transaction(async(tx:any)=>{
  await requirePlatformAdmin(tx,actor.actorUserId);
  await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended('seed-publication-head',0))");
  const latest=await tx.seedPublication.findFirst({where:{status:'PUBLISHED'},orderBy:{revision:'desc'}});
  if(!latest)return {changed:false,utcDay:day,reason:'NO_PUBLISHED_MANIFEST'};
  const snapshot=latest.configSnapshot,manifest=validateSeedManifest(snapshot.manifest??snapshot);
  const revision=await nextPublicationRevision(tx);
  const profiles=snapshot.capabilityProfiles??null,proposed=rollPublishedScanManifest(manifest,profiles,now,revision);
  if(!proposed.changed)return {changed:false,utcDay:day,reason:proposed.reason,publicationId:latest.id,revision:latest.revision};
  const sources=[...new Set(manifest.scanPlans.filter(p=>p.status==='ACTIVE'&&p.datePolicy.kind==='ROLLING').map(p=>p.sourceKey))];
  const registered=await tx.seedQuery.findMany({where:{sourceKey:{in:sources}},include:{runtime:true}});
  const refs:LegacyMapping[]=registered.flatMap((q:any)=>{
   const prior=manifest.queries.find(p=>p.queryId===q.id),planned=proposed.manifest.queries.find(p=>p.queryKey===q.queryKey&&p.sourceKey===q.sourceKey&&p.channel===q.channel);
   const ids=prior?.nativeJobIds.length?prior.nativeJobIds:q.runtime?.nativeJobId?[q.runtime.nativeJobId]:planned?.nativeJobIds??[];
   if(!ids.length)return [];
   const query:SeedQuerySpec={queryId:q.id,queryKey:q.queryKey,queryKeyVersion:q.queryKeyVersion,sourceKey:q.sourceKey,channel:q.channel,mode:q.mode,params:q.normalizedParams,legacyDims:q.legacyDims,adapterVersion:q.adapterVersion,capabilityVersion:q.capabilityVersion,desiredEnabled:q.desiredEnabled,nativeJobIds:ids};return [reference(query)];
  });
  const rolled=rollPublishedScanManifest(manifest,profiles,now,revision,refs);
  if(!rolled.changed)return {changed:false,utcDay:day,reason:rolled.reason,publicationId:latest.id,revision:latest.revision};
  const next=rolled.manifest,reason=`UTC ${day}: refresh published rolling scan windows from revision ${latest.revision}`;
  await activateManifest(tx,next);
  await tx.seedPublication.create({data:{id:next.publicationId,revision:next.revision,parentRevision:next.parentRevision,manifestHash:next.contentHash,status:'PUBLISHED',reason,createdByUserId:actor.actorUserId,configSnapshot:{...snapshot,manifest:next,capabilityProfiles:snapshot.capabilityProfiles,rollingUtcDay:day,rolledFromPublicationId:latest.id}}});
  const result:RollingRefreshResult={changed:true,utcDay:day,reason:rolled.reason,publicationId:next.publicationId,revision:next.revision};
  await tx.auditEvent.create({data:{actorUserId:actor.actorUserId,action:'SEED_SCAN_WINDOWS_REFRESHED',targetType:'SeedLibrary',targetId:next.publicationId,requestId:`seed-roll:${latest.id}:${day}`,metadata:{reason,previousPublicationId:latest.id,result}}});
  return result;
 },{timeout:30000});
}
