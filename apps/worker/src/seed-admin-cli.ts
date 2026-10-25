import {PrismaClient} from '@prisma/client';
import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {DomainError,requirePlatformAdmin} from '../../web/src/team/access';
import {prepareLegacyInventory,importLegacyInventory,inventoryLegacyState,legacyUnmappedEvidence,beginLegacyInventorySnapshot,completeLegacyInventorySnapshot} from '../../web/src/seed-library/legacy-import';
import {runSeedDispatchAdminCommand} from '../../web/src/seed-library/dispatch-admin';
import {importAdvertiserDirectory} from '../../web/src/seed-library/directory';
import {saveLegacyOwnerIntent} from '../../web/src/seed-library/legacy-owners';
import {evidenceStoresFromEnvironment} from './seed-control';
import {readLegacyPending, type PendingPlatform} from './pending-envelope';
import {collectorEvidenceKey} from './collector-evidence';
import {seedSourceKeys,type SourceKey} from '../../../packages/contracts/src/seeds';
const args=process.argv.slice(2),command=args.shift(),flags=new Map<string,string>();
if(!command||command==='--help'||args.includes('--help')){
 console.log('seed-admin control --command-file private.json | directory-import --file catalog.json | legacy-owner --source SOURCE --owner-key KEY --status ACTIVE|PAUSED|REMOVED | legacy-inventory --source SOURCE --state private-state.json --root /private/data --node-id NODE --adapter-version VERSION [--allow-preserved-unmapped] | register-pending --source SOURCE --state private-state.json --root /private/data --node-id NODE --incarnation-id UUID\nEvery command requires --actor-user-id UUID --idempotency-key KEY --reason TEXT. Legacy inventory freezes exact full-state bytes, imports at most 500 mapped job IDs per page, and retains explicitly approved MEDIA_REFRESH work as auxiliary unmanaged evidence. Uses server DATABASE_URL and private evidence configuration. No source requests, deployments or node credentials are created.');process.exit(0);
}
let db:PrismaClient|undefined;
try{
 const common=['actor-user-id','idempotency-key','reason'],extra:Record<string,string[]>={control:['command-file'],'directory-import':['file'],'legacy-owner':['source','owner-key','status'],'legacy-inventory':['source','state','root','node-id','adapter-version','allow-preserved-unmapped'],'register-pending':['source','state','root','node-id','incarnation-id']};
 if(!extra[command])throw new DomainError(400,'SEED_ADMIN_COMMAND_INVALID');
 const allowed=new Set([...common,...extra[command]]);while(args.length){const name=args.shift()!;if(!name.startsWith('--')||!allowed.has(name.slice(2))||flags.has(name.slice(2)))throw new DomainError(400,'SEED_ADMIN_ARGUMENT_INVALID');if(name==='--allow-preserved-unmapped'){flags.set('allow-preserved-unmapped','true');continue;}const value=args.shift();if(!value||value.startsWith('--'))throw new DomainError(400,'SEED_ADMIN_ARGUMENT_INVALID');flags.set(name.slice(2),value);}
 const arg=(key:string)=>{const value=flags.get(key);if(!value)throw new DomainError(400,'SEED_ADMIN_ARGUMENT_REQUIRED');return value;};
 if(!/^postgres(ql)?:\/\//.test(process.env.DATABASE_URL??''))throw new DomainError(503,'DATABASE_NOT_CONFIGURED');
 db=new PrismaClient();const timezone=await db.$queryRaw<Array<{TimeZone:string}>>`SHOW timezone`;if(timezone[0]?.TimeZone!=='UTC')throw new DomainError(503,'DATABASE_TIMEZONE_INVALID');
 const base={actorUserId:arg('actor-user-id'),idempotencyKey:arg('idempotency-key'),reason:arg('reason')};await requirePlatformAdmin(db,base.actorUserId);
 const source=()=>{const key=arg('source');if(!seedSourceKeys.includes(key as SourceKey))throw new DomainError(400,'SEED_SOURCE_INVALID');return key as SourceKey;};
 let result:any;
 if(command==='control'){const input=JSON.parse(await readFile(arg('command-file'),'utf8'));result=await runSeedDispatchAdminCommand(db,{...base,type:input.type,payload:input.payload});}
 else if(command==='directory-import')result=await importAdvertiserDirectory(db,{...base,json:await readFile(arg('file'),'utf8')});
 else if(command==='legacy-owner'){const status=arg('status');if(!['ACTIVE','PAUSED','REMOVED'].includes(status))throw new DomainError(400,'SEED_LEGACY_OWNER_INVALID');result=await saveLegacyOwnerIntent(db,{...base,sourceKey:source(),legacyOwnerKey:arg('owner-key'),status:status as any});}
 else{
  const sourceKey=source(),stateBytes=await readFile(arg('state')),stateRaw=stateBytes.toString('utf8');if(!Buffer.from(stateRaw,'utf8').equals(stateBytes))throw new DomainError(400,'LEGACY_SNAPSHOT_BYTES_INVALID');const state=JSON.parse(stateRaw),platform=({meta_ad_library:'meta',google_ads_transparency:'google',snapchat_ads_gallery:'snapchat',tiktok_commercial_library:'tiktok',pinterest_ads_repository:'pinterest'} as const)[sourceKey],stores=evidenceStoresFromEnvironment();
  if(!stores)throw new DomainError(503,'COLLECTOR_EVIDENCE_NOT_CONFIGURED');const store=await stores.sourceStore(sourceKey),scheme=process.env.COLLECTOR_EVIDENCE_ROOT?'local-private':'s3';
  const persist=async(raw:string,hash:string)=>{const key=collectorEvidenceKey({prefix:stores.prefix,sourceKey},hash),bytes=Buffer.from(raw);await store.putIfAbsent(key,bytes,hash);const stored=Buffer.from(await store.get(key));if(!stored.equals(bytes)||createHash('sha256').update(stored).digest('hex')!==hash)throw new DomainError(409,'RAW_OBJECT_NOT_DURABLE');return {reference:`${scheme}:${key}`,sha256:hash};};
  if(command==='register-pending'){
   if(!state.pending)throw new DomainError(409,'LEGACY_PENDING_MISSING');const pending=await readLegacyPending(platform as PendingPlatform,arg('root'),state.pending);await persist(pending.raw,pending.rawSha);for(const chunk of pending.expectedChunks)await persist(chunk.raw,chunk.hash);
   result=await runSeedDispatchAdminCommand(db,{...base,type:'REGISTER_COLLECTOR_PENDING',payload:{nodeId:arg('node-id'),incarnationId:arg('incarnation-id'),sourceKey,rawSha:pending.rawSha,batchHashes:pending.expectedChunks.map(c=>c.hash)}});
  }else{
   const inventory=inventoryLegacyState(sourceKey,state),allowPreservedUnmapped=flags.get('allow-preserved-unmapped')==='true';if(inventory.unmappedJobs.length&&(!allowPreservedUnmapped||inventory.unmappedJobs.some(j=>j.reason!=='LEGACY_MEDIA_REFRESH_REQUIRES_MAPPING')))throw new DomainError(409,'LEGACY_UNMAPPED_JOBS_REQUIRE_REVIEW');
   const pendingRawSha=state.pending?(await readLegacyPending(platform as PendingPlatform,arg('root'),state.pending)).rawSha:undefined;
   const importBase={...base,sourceKey,state,nodeId:arg('node-id'),adapterVersion:arg('adapter-version')},unmappedRaw=JSON.stringify(legacyUnmappedEvidence(sourceKey,state)),stateEvidence=await persist(stateRaw,createHash('sha256').update(stateRaw).digest('hex')),unmappedEvidence=await persist(unmappedRaw,createHash('sha256').update(unmappedRaw).digest('hex'));
   const keyFor=(phase:string,jobIds:string[]=[])=>base.idempotencyKey.slice(0,60)+'.'+createHash('sha256').update(JSON.stringify({key:base.idempotencyKey,phase,stateDigest:inventory.stateDigest,jobIds})).digest('hex').slice(0,48);
   const snapshot=await beginLegacyInventorySnapshot(db,{...importBase,idempotencyKey:keyFor('start'),stateRaw,stateEvidence,unmappedRaw,unmappedEvidence,allowPreservedUnmapped,pendingRawSha});
   for(let offset=0;offset<inventory.jobs.length;offset+=500){const jobIds=inventory.jobs.slice(offset,offset+500).map(j=>j.nativeJobId),page=await prepareLegacyInventory(db,{actorUserId:base.actorUserId,sourceKey,state,nodeId:arg('node-id'),jobIds}),checkpointRefs:Record<string,{reference:string;sha256:string}>={};for(const cp of page.checkpoints)checkpointRefs[cp.nativeJobId]=await persist(cp.raw,cp.sha256);await importLegacyInventory(db,{...importBase,idempotencyKey:keyFor('page',jobIds),snapshotId:snapshot.targetId,jobIds,checkpointRefs});console.log(JSON.stringify({event:'seed_legacy_page_completed',sourceKey,snapshotId:snapshot.targetId,offset,count:jobIds.length,stateDigest:inventory.stateDigest}));}
   result=await completeLegacyInventorySnapshot(db,{...importBase,idempotencyKey:keyFor('complete'),snapshotId:snapshot.targetId});
  }
 }
 console.log(JSON.stringify({event:'seed_admin_completed',command,...result}));
}catch(error){console.error(JSON.stringify({event:'seed_admin_failed',errorCode:error instanceof DomainError?error.code:'SEED_ADMIN_FAILED'}));process.exitCode=1;}
finally{await db?.$disconnect();}
