import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma, CollectionRun } from '@prisma/client';
import { validateCollectionQuery, assertVerifiedCollectionQuery, verifiedSourceProfiles, type CollectionOutcome } from '@ad-research/contracts';
import { DomainError, requirePlatformAdmin } from '../team/access';
export interface LeaseToken { runId:string; owner:string; version:number }
export interface IngestCounts { insertedCount:number; updatedCount:number; quarantinedCount:number }
export interface EvidenceReference { evidenceReference:string; evidenceSha256:string }
export type CollectionTransaction=Prisma.TransactionClient;
export type CollectionDatabase=PrismaClient;
const requireVerified=(source:{id:string;adapterVersion:string;capabilities:unknown},query:unknown)=>{try{return assertVerifiedCollectionQuery(source,query);}catch{throw new DomainError(409,'SOURCE_CAPABILITY_UNVERIFIED');}};
const leaseDuration=(value=60_000)=>{if(!Number.isInteger(value)||value<1000||value>300_000)throw new DomainError(400,'INVALID_LEASE_DURATION');return value;};
const safeCode=(value:string|null)=>value&&/^[A-Z0-9_:-]{1,120}$/.test(value)?value:value?'COLLECTION_FAILURE':null;
// Existing application jobs have no central seed execution grant. Keep their
// queued facts intact while the centrally managed source controls admission.
const legacySourceAvailable=`NOT EXISTS (SELECT 1 FROM "CollectorSourceAssignment" a WHERE a."sourceKey"=s.key) AND NOT EXISTS (SELECT 1 FROM "CollectorSourceControl" c WHERE c."sourceKey"=s.key AND c.channel IN ('*','META') AND (c."controlMode"<>'LEGACY_QUEUE' OR c."manualPause" OR c."notBefore">timezone('UTC',clock_timestamp())))`;
async function legacyOwnerAvailable(tx:CollectionTransaction,dataSourceId:string){
 const source=await tx.dataSource.findUnique({where:{id:dataSourceId},select:{key:true}});if(!source)return false;
 // Same source lock as central assignment: a legacy claim either becomes visible
 // before takeover, or rechecks after takeover and remains queued.
 await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','seed-dispatch:source:'+source.key);
 const [assignments,controls]=await Promise.all([
  tx.collectorSourceAssignment.count({where:{dataSourceId}}),
  tx.collectorSourceControl.count({where:{dataSourceId,channel:{in:['*','META']},OR:[{controlMode:{not:'LEGACY_QUEUE'}},{manualPause:true},{notBefore:{gt:new Date()}}]}}),
 ]);return !assignments&&!controls;
}
async function requireLegacyOwner(tx:CollectionTransaction,dataSourceId:string){
 if(!await legacyOwnerAvailable(tx,dataSourceId))throw new DomainError(409,'SOURCE_CENTRALLY_MANAGED');
}
export function scheduleIntervalSeconds(value:string|null):number {
  const match=value?.match(/^@every ([1-9]\d*)s$/);const seconds=match?Number(match[1]):NaN;
  if(!Number.isInteger(seconds)||seconds<60||seconds>86400)throw new DomainError(400,'INVALID_COLLECTION_INTERVAL');return seconds;
}
export async function guardLease(tx:CollectionTransaction,token:LeaseToken):Promise<CollectionRun> {
  const rows=await tx.$queryRawUnsafe<CollectionRun[]>(`SELECT * FROM "CollectionRun" WHERE id=$1 AND status='RUNNING' AND "leaseOwner"=$2 AND "leaseVersion"=$3 AND "leaseExpiresAt">timezone('UTC',clock_timestamp()) AND "cancelRequestedAt" IS NULL FOR UPDATE`,token.runId,token.owner,token.version);
  if(!rows.length)throw new DomainError(409,'LEASE_LOST');return rows[0];
}
async function insertRun(tx:CollectionTransaction,task:any,requestedByUserId:string|null,key:string,scheduledFor:Date|null) {
  const query=validateCollectionQuery(task.query);
  query.limit=Math.min(query.limit,Math.max(1,Math.min(task.maxItems,20)));
  if(!Number.isInteger(task.maxAttempts)||task.maxAttempts<1||task.maxAttempts>5)throw new DomainError(400,'INVALID_COLLECTION_ATTEMPTS');
  const rows=await tx.$queryRawUnsafe<CollectionRun[]>(`INSERT INTO "CollectionRun" (id,"createdAt","updatedAt","taskId","dataSourceId","requestedByUserId","idempotencyKey","scheduledFor","querySnapshot","adapterVersion",status,"queuedAt") VALUES ($1,timezone('UTC',clock_timestamp()),timezone('UTC',clock_timestamp()),$2,$3,$4,$5,$6::timestamp,$7::jsonb,$8,'QUEUED',timezone('UTC',clock_timestamp())) ON CONFLICT DO NOTHING RETURNING *`,randomUUID(),task.id,task.dataSourceId,requestedByUserId,key,scheduledFor?.toISOString()??null,JSON.stringify(query),task.adapterVersion??task.dataSource.adapterVersion);
  if(rows[0])return rows[0];
  const existing=await tx.collectionRun.findUnique({where:{idempotencyKey:key}});
  if(!existing||existing.taskId!==task.id)throw new DomainError(409,'COLLECTION_IDEMPOTENCY_CONFLICT');return existing;
}
export async function finishCollection(tx:CollectionTransaction,token:LeaseToken,outcome:CollectionOutcome,details:Partial<IngestCounts>&{evidenceReference?:string}={}) {
  const errorCode=safeCode(outcome.errorCode);
  const restricted=outcome.status==='restricted'||Boolean(errorCode&&/^(META_HTTP_(403|429)|META_SOURCE_(CHALLENGE|LOGIN_REQUIRED))$/.test(errorCode));
  const networkRetry=outcome.status==='failed'&&!restricted&&outcome.retryable&&['META_NETWORK_ERROR','META_TIMEOUT'].includes(errorCode??'');
  const status=outcome.status==='success'?'SUCCEEDED':outcome.status==='no-results'?'SUCCEEDED':outcome.status==='cancelled'?'CANCELED':outcome.status==='partial'?'PARTIAL':'FAILED';
  const counts=[details.insertedCount??0,details.updatedCount??0,details.quarantinedCount??0];
  if(counts.some(count=>!Number.isInteger(count)||count<0))throw new DomainError(400,'INVALID_COLLECTION_COUNTS');
  const rows=await tx.$queryRawUnsafe<{id:string}[]>(`UPDATE "CollectionRun" r SET status=CASE WHEN $5 AND r.attempt<t."maxAttempts" THEN 'QUEUED' ELSE $4 END,"nextAttemptAt"=CASE WHEN $5 AND r.attempt<t."maxAttempts" THEN timezone('UTC',clock_timestamp())+(LEAST(300,POWER(2,r.attempt))::text||' seconds')::interval ELSE NULL END,"finishedAt"=CASE WHEN $5 AND r.attempt<t."maxAttempts" THEN NULL ELSE timezone('UTC',clock_timestamp()) END,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"heartbeatAt"=timezone('UTC',clock_timestamp()),"updatedAt"=timezone('UTC',clock_timestamp()),"errorCode"=$6,"errorMessage"=NULL,"restrictionReason"=CASE WHEN $7 THEN $6 ELSE NULL END,"fetchedCount"=$8,"insertedCount"=$9,"updatedCount"=$10,"quarantinedCount"=$11,coverage=$12::jsonb,"evidenceReference"=COALESCE($13,r."evidenceReference") FROM "CollectionTask" t WHERE r.id=$1 AND r."taskId"=t.id AND r.status='RUNNING' AND r."leaseOwner"=$2 AND r."leaseVersion"=$3 AND r."leaseExpiresAt">timezone('UTC',clock_timestamp()) AND (r."cancelRequestedAt" IS NULL OR $4='CANCELED') RETURNING r.id`,token.runId,token.owner,token.version,status,networkRetry,errorCode,restricted,outcome.ads.length,...counts,JSON.stringify({outcome:outcome.status,observedCardCount:outcome.observedCardCount,parsedAdCount:outcome.ads.length,parserVersion:outcome.parserVersion}),details.evidenceReference??null);
  return rows.length===1;
}
export function createCollectionQueue(db:CollectionDatabase) {
  return {
    async setTaskStatus(input:{taskId:string;actorUserId:string;status:'ACTIVE'|'PAUSED'}) {
      if(!['ACTIVE','PAUSED'].includes(input.status))throw new DomainError(400,'INVALID_TASK_STATUS');
      return db.$transaction(async tx=>{
        await requirePlatformAdmin(tx,input.actorUserId);
        const tasks=await tx.$queryRawUnsafe<any[]>(`SELECT t.*,s."adapterVersion",s.capabilities AS "sourceCapabilities" FROM "CollectionTask" t JOIN "DataSource" s ON s.id=t."dataSourceId" WHERE t.id=$1 FOR UPDATE OF t FOR SHARE OF s`,input.taskId);
        const task=tasks[0];if(!task)throw new DomainError(404,'COLLECTION_TASK_NOT_FOUND');
        if(input.status==='ACTIVE'){await requireLegacyOwner(tx,task.dataSourceId);requireVerified({id:task.dataSourceId,adapterVersion:task.adapterVersion,capabilities:task.sourceCapabilities},task.query);}
        const changed=await tx.collectionTask.update({where:{id:task.id},data:{status:input.status,pausedAt:input.status==='PAUSED'?new Date():null}});
        await tx.auditEvent.create({data:{actorUserId:input.actorUserId,action:'COLLECTION_TASK_STATUS',targetType:'CollectionTask',targetId:task.id,metadata:{status:input.status}}});return changed;
      });
    },
    async setSourceStatus(input:{sourceId:string;actorUserId:string;status:'ACTIVE'|'PAUSED'}) {
      if(!['ACTIVE','PAUSED'].includes(input.status))throw new DomainError(400,'INVALID_SOURCE_STATUS');
      return db.$transaction(async tx=>{
        await requirePlatformAdmin(tx,input.actorUserId);
        const sources=await tx.$queryRawUnsafe<Array<{id:string;adapterVersion:string;capabilities:unknown;status:string}>>(`SELECT id,"adapterVersion",capabilities,status FROM "DataSource" WHERE id=$1 FOR UPDATE`,input.sourceId);
        const source=sources[0];if(!source)throw new DomainError(404,'SOURCE_NOT_FOUND');
        if(input.status==='ACTIVE'&&!verifiedSourceProfiles(source).length)throw new DomainError(409,'SOURCE_CAPABILITY_UNVERIFIED');
        const changed=await tx.dataSource.update({where:{id:source.id},data:{status:input.status}});
        await tx.auditEvent.create({data:{actorUserId:input.actorUserId,action:'SOURCE_STATUS_CHANGED',targetType:'DataSource',targetId:source.id,metadata:{from:source.status,status:input.status}}});return changed;
      });
    },
    async enqueue(input:{taskId:string;requestedByUserId:string;idempotencyKey:string}) {
      if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.idempotencyKey))throw new DomainError(400,'INVALID_IDEMPOTENCY_KEY');
      return db.$transaction(async tx=>{
        await requirePlatformAdmin(tx,input.requestedByUserId);
        const tasks=await tx.$queryRawUnsafe<any[]>(`SELECT t.*,s."adapterVersion",s.capabilities AS "sourceCapabilities",s.status AS "sourceStatus" FROM "CollectionTask" t JOIN "DataSource" s ON s.id=t."dataSourceId" WHERE t.id=$1 FOR UPDATE OF t FOR SHARE OF s`,input.taskId);
        const task=tasks[0];if(!task)throw new DomainError(404,'COLLECTION_TASK_NOT_FOUND');
        if(task.sourceStatus!=='ACTIVE'||task.status!=='ACTIVE')throw new DomainError(409,'COLLECTION_TASK_NOT_ACTIVE');
        await requireLegacyOwner(tx,task.dataSourceId);
        requireVerified({id:task.dataSourceId,adapterVersion:task.adapterVersion,capabilities:task.sourceCapabilities},task.query);
        const run=await insertRun(tx,task,input.requestedByUserId,`manual:${task.id}:${input.idempotencyKey}`,null);
        await tx.auditEvent.create({data:{actorUserId:input.requestedByUserId,action:'COLLECTION_ENQUEUE_REQUEST',targetType:'CollectionRun',targetId:run.id,metadata:{taskId:task.id}}});
        return run;
      });
    },
    async scheduleDue() {
      return db.$transaction(async tx=>{
        const tasks=await tx.$queryRawUnsafe<any[]>(`SELECT t.*,s."adapterVersion",s.capabilities AS "sourceCapabilities" FROM "CollectionTask" t JOIN "DataSource" s ON s.id=t."dataSourceId" WHERE t.status='ACTIVE' AND s.status='ACTIVE' AND ${legacySourceAvailable} AND t."nextRunAt"<=timezone('UTC',clock_timestamp()) AND t."scheduleCron" IS NOT NULL ORDER BY t."nextRunAt",t.id LIMIT 50 FOR UPDATE OF t SKIP LOCKED FOR SHARE OF s`);
        const enqueued:string[]=[];const invalidTaskIds:string[]=[];
        for(const task of tasks) {
          if(!await legacyOwnerAvailable(tx,task.dataSourceId))continue;
          let seconds:number;try{seconds=scheduleIntervalSeconds(task.scheduleCron);requireVerified({id:task.dataSourceId,adapterVersion:task.adapterVersion,capabilities:task.sourceCapabilities},task.query);}catch{invalidTaskIds.push(task.id);await tx.collectionTask.update({where:{id:task.id},data:{status:'PAUSED',pausedAt:new Date()}});await tx.auditEvent.create({data:{action:'COLLECTION_TASK_AUTO_PAUSED',targetType:'CollectionTask',targetId:task.id,metadata:{reason:'INVALID_OR_UNVERIFIED_QUERY'}}});continue;}
          const scheduledFor=new Date(task.nextRunAt);const run=await insertRun(tx,task,null,`schedule:${task.id}:${scheduledFor.toISOString()}`,scheduledFor);enqueued.push(run.id);
          await tx.$executeRawUnsafe(`UPDATE "CollectionTask" SET "nextRunAt"=timezone('UTC',clock_timestamp())+($2::text||' seconds')::interval,"updatedAt"=timezone('UTC',clock_timestamp()) WHERE id=$1`,task.id,seconds);
        }
        return {enqueued,invalidTaskIds};
      });
    },
    async claim(input:{workerId:string;leaseMs?:number;taskId?:string}) {
      if(!/^[A-Za-z0-9_.:-]{1,120}$/.test(input.workerId))throw new DomainError(400,'INVALID_WORKER_ID');
      await db.$executeRawUnsafe(`UPDATE "CollectionRun" r SET status='FAILED',"errorCode"='SOURCE_DISABLED',"finishedAt"=timezone('UTC',clock_timestamp()),"updatedAt"=timezone('UTC',clock_timestamp()) FROM "DataSource" s WHERE r."dataSourceId"=s.id AND r.status='QUEUED' AND s.status<>'ACTIVE' AND ($1::text IS NULL OR r."taskId"=$1)`,input.taskId??null);
      return db.$transaction(async tx=>{
        for(let inspected=0;inspected<50;inspected++) {
          const candidates=await tx.$queryRawUnsafe<Array<CollectionRun&{sourceCapabilities:unknown;sourceAdapterVersion:string}>>(`SELECT r.*,s.capabilities AS "sourceCapabilities",s."adapterVersion" AS "sourceAdapterVersion" FROM "CollectionRun" r JOIN "CollectionTask" t ON t.id=r."taskId" JOIN "DataSource" s ON s.id=r."dataSourceId" WHERE r.status='QUEUED' AND r."cancelRequestedAt" IS NULL AND (r."nextAttemptAt" IS NULL OR r."nextAttemptAt"<=timezone('UTC',clock_timestamp())) AND r.attempt<t."maxAttempts" AND s.status='ACTIVE' AND ${legacySourceAvailable} AND ($1::text IS NULL OR r."taskId"=$1) ORDER BY r."queuedAt",r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED FOR SHARE OF s`,input.taskId??null);
          const candidate=candidates[0];if(!candidate)return null;
          if(!await legacyOwnerAvailable(tx,candidate.dataSourceId))return null;
          try {if(candidate.adapterVersion!==candidate.sourceAdapterVersion)throw new Error('SOURCE_CAPABILITY_UNVERIFIED');requireVerified({id:candidate.dataSourceId,adapterVersion:candidate.sourceAdapterVersion,capabilities:candidate.sourceCapabilities},candidate.querySnapshot);}
          catch {await tx.collectionRun.update({where:{id:candidate.id},data:{status:'FAILED',errorCode:'SOURCE_CAPABILITY_UNVERIFIED',finishedAt:new Date()}});continue;}
          const rows=await tx.$queryRawUnsafe<CollectionRun[]>(`UPDATE "CollectionRun" SET status='RUNNING',"leaseOwner"=$2,"leaseVersion"="leaseVersion"+1,"leaseExpiresAt"=timezone('UTC',clock_timestamp())+($3::text||' milliseconds')::interval,"heartbeatAt"=timezone('UTC',clock_timestamp()),"startedAt"=COALESCE("startedAt",timezone('UTC',clock_timestamp())),attempt=attempt+1,"updatedAt"=timezone('UTC',clock_timestamp()) WHERE id=$1 RETURNING *`,candidate.id,input.workerId,leaseDuration(input.leaseMs));
          const run=rows[0];return {run,token:{runId:run.id,owner:input.workerId,version:run.leaseVersion}};
        }
        return null;
      });
    },
    async renew(token:LeaseToken,leaseMs?:number) {
      const count=await db.$executeRawUnsafe(`UPDATE "CollectionRun" SET "leaseExpiresAt"=timezone('UTC',clock_timestamp())+($4::text||' milliseconds')::interval,"heartbeatAt"=timezone('UTC',clock_timestamp()),"updatedAt"=timezone('UTC',clock_timestamp()) WHERE id=$1 AND status='RUNNING' AND "leaseOwner"=$2 AND "leaseVersion"=$3 AND "leaseExpiresAt">timezone('UTC',clock_timestamp()) AND "cancelRequestedAt" IS NULL`,token.runId,token.owner,token.version,leaseDuration(leaseMs));return count===1;
    },
    async requestCancel(runId:string,adminUserId:string) {
      return db.$transaction(async tx=>{
        await requirePlatformAdmin(tx,adminUserId);
        const rows=await tx.$queryRawUnsafe<CollectionRun[]>(`SELECT * FROM "CollectionRun" WHERE id=$1 FOR UPDATE`,runId);const run=rows[0];
        if(!run||!['QUEUED','RUNNING'].includes(run.status))return false;
        await tx.collectionRun.update({where:{id:runId},data:run.status==='RUNNING'?{cancelRequestedAt:new Date()}:{status:'CANCELED',cancelRequestedAt:new Date(),finishedAt:new Date(),errorCode:'COLLECTION_CANCELED'}});
        await tx.auditEvent.create({data:{actorUserId:adminUserId,action:'COLLECTION_CANCEL_REQUEST',targetType:'CollectionRun',targetId:runId,metadata:{awaitingWorker:run.status==='RUNNING'}}});
        return true;
      });
    },
    async ackCancel(token:LeaseToken) {
      const changed=await db.$executeRawUnsafe(`UPDATE "CollectionRun" SET status='CANCELED',"finishedAt"=timezone('UTC',clock_timestamp()),"updatedAt"=timezone('UTC',clock_timestamp()),"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"errorCode"='COLLECTION_CANCELED' WHERE id=$1 AND status='RUNNING' AND "leaseOwner"=$2 AND "leaseVersion"=$3 AND "leaseExpiresAt">timezone('UTC',clock_timestamp()) AND "cancelRequestedAt" IS NOT NULL`,token.runId,token.owner,token.version);return changed===1;
    },
    async recoverExpired() {
      return db.$executeRawUnsafe(`UPDATE "CollectionRun" r SET status=CASE WHEN r."cancelRequestedAt" IS NOT NULL THEN 'CANCELED' WHEN r.attempt<t."maxAttempts" THEN 'QUEUED' ELSE 'FAILED' END,"leaseVersion"=r."leaseVersion"+1,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"nextAttemptAt"=CASE WHEN r."cancelRequestedAt" IS NULL AND r.attempt<t."maxAttempts" THEN timezone('UTC',clock_timestamp()) ELSE NULL END,"finishedAt"=CASE WHEN r."cancelRequestedAt" IS NOT NULL OR r.attempt>=t."maxAttempts" THEN timezone('UTC',clock_timestamp()) ELSE NULL END,"errorCode"='LEASE_EXPIRED',"updatedAt"=timezone('UTC',clock_timestamp()) FROM "CollectionTask" t WHERE t.id=r."taskId" AND r.status='RUNNING' AND r."leaseExpiresAt"<=timezone('UTC',clock_timestamp())`);
    },
    async finish(token:LeaseToken,outcome:CollectionOutcome,details:Partial<IngestCounts>&{evidenceReference?:string}={}) {
      return db.$transaction(tx=>finishCollection(tx,token,outcome,details));
    },
  };
}
