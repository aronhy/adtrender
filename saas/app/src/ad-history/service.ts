import {createHash} from 'node:crypto';
import type {PrismaClient} from '@prisma/client';
import {DomainError,requireWorkspaceRole} from '../team/access';
import {dayWindow,normalizeHistoryFact} from './normalize';
import {sourceDateSpan} from './delivery-summary';
import type {AdHistoryQuery,AdHistoryResult} from './api-types';
import type {AdHistoryDayView,HistoryScopeView,HistoryChange} from './types';

function range(from:string,to:string){
  try{const a=dayWindow(from),b=dayWindow(to);const count=(b.to.valueOf()-a.from.valueOf())/86400000;
    if(count<1||count>366)throw Error();return {from:a.from,to:b.to,count};
  }catch{throw new DomainError(400,'INVALID_HISTORY_RANGE');}
}
const dayKey=(value:Date)=>value.toISOString().slice(0,10);
const scopeView=(row:{scopeHash:string;scopeKind:string;sourceKey:string;queryCountry:string|null;queryLanguage:string|null}):HistoryScopeView=>({hash:row.scopeHash,kind:row.scopeKind as HistoryScopeView['kind'],sourceKey:row.sourceKey,queryCountry:row.queryCountry,queryLanguage:row.queryLanguage});
interface Cursor {v:1;generation:string;fingerprint:string;observedAt:string;id:string;asOf:string}
function decodeCursor(value:string,fingerprint:string):Cursor{
  try{if(value.length>2048)throw Error();const c=JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as Cursor;
    if(c.v!==1||!(/^[a-f0-9]{64}$/.test(c.generation??''))||c.fingerprint!==fingerprint||typeof c.id!=='string'||!c.id||c.id.length>200||!Number.isFinite(Date.parse(c.observedAt))||!Number.isFinite(Date.parse(c.asOf)))throw Error();return c;
  }catch{throw new DomainError(400,'INVALID_HISTORY_CURSOR');}
}
/** Shared public facts require the same account/workspace access as the ad library. */
export async function getAdHistory(db:PrismaClient,input:AdHistoryQuery&{userId:string}):Promise<AdHistoryResult>{
  const window=range(input.from,input.to);
  if(input.scopeHash!==undefined&&!/^[a-f0-9]{64}$/.test(input.scopeHash))throw new DomainError(400,'INVALID_HISTORY_SCOPE');
  const fingerprint=createHash('sha256').update(JSON.stringify([input.adId,input.from,input.to,input.scopeHash??null])).digest('hex');
  const cursor=input.eventCursor?decodeCursor(input.eventCursor,fingerprint):null;
  return db.$transaction(async tx=>{
    await requireWorkspaceRole(tx,input.userId,input.workspaceId);
    const ad=await tx.ad.findUnique({where:{id:input.adId},include:{dataSource:{select:{key:true}}}});
    if(!ad)throw new DomainError(404,'AD_NOT_FOUND');
    const asOf=cursor?.asOf??new Date().toISOString();
    const allScopes=await tx.adDailySnapshot.findMany({where:{adId:ad.id},distinct:['scopeHash'],select:{scopeHash:true,scopeKind:true,sourceKey:true,queryCountry:true,queryLanguage:true},orderBy:{scopeHash:'asc'},take:501});
    if(allScopes.length>500)throw new DomainError(422,'HISTORY_SCOPE_LIMIT');
    const rows=await tx.adDailySnapshot.findMany({where:{adId:ad.id,day:{gte:new Date(input.from+'T00:00:00Z'),lte:new Date(input.to+'T00:00:00Z')},...(input.scopeHash?{scopeHash:input.scopeHash}:{})},include:{latestObservation:{include:{run:true}}},orderBy:[{day:'asc'},{lastObservedAt:'desc'},{latestObservationId:'desc'}],take:20001});
    if(rows.length>20000)throw new DomainError(422,'HISTORY_ROW_LIMIT');
    const digest=await tx.$queryRaw<{digest:string}[]>`SELECT md5(coalesce(string_agg(id,',' ORDER BY id),'')) AS digest FROM "AdHistoryEvent" WHERE "adId"=${ad.id} AND "observedAt">=${window.from} AND "observedAt"<${window.to} AND (${input.scopeHash??null}::text IS NULL OR "scopeHash"=${input.scopeHash??null})`;
    const generation=createHash('sha256').update(JSON.stringify([rows.map(r=>[r.id,r.latestObservationId,r.observationCount,r.contentKey,r.latestSourceStatus]),digest[0]?.digest])).digest('hex');
    if(cursor&&cursor.generation!==generation)throw new DomainError(409,'HISTORY_CHANGED_RELOAD');
    const available=await tx.$queryRaw<{present:boolean}[]>`SELECT to_regclass('history_collector.public_daily') IS NOT NULL AS present`;
    const checks=available[0]?.present?await tx.$queryRaw<{day:string;outcome:AdHistoryDayView['checkState'];checkedAt:Date;attemptCount:number}[]>`SELECT day,outcome,checked_at AT TIME ZONE 'UTC' AS "checkedAt",attempt_count AS "attemptCount" FROM history_collector.public_daily WHERE ad_id=${ad.id} AND day>=${input.from} AND day<=${input.to}`:[];
    const checkByDay=new Map(checks.map(c=>[c.day,c]));
    const check=(day:string)=>{const c=checkByDay.get(day);return {checkState:c?.outcome??(available[0]?.present?'NO_ATTEMPT':'UNKNOWN'),checkedAt:c?.checkedAt?.toISOString()??null,checkAttemptCount:c?.attemptCount??0};};
    const byDay=new Map<string,typeof rows>();
    for(const row of rows){const key=dayKey(row.day);const current=byDay.get(key)??[];current.push(row);byDay.set(key,current);}
    const days:AdHistoryDayView[]=[];
    for(let i=0;i<window.count;i++){
      const day=dayKey(new Date(Date.parse(input.from+'T00:00:00Z')+i*86400000));
      const candidates=byDay.get(day)??[];
      if(!candidates.length){days.push({day,scopeHash:input.scopeHash??'',observationState:'NO_OBSERVATION',...check(day),sourceStatus:'UNKNOWN',hasStateConflict:false,observationCount:0,lastObservedAt:null,latestObservationId:null,body:null,headline:null,cta:null});continue;}
      for(const row of candidates){
        const fact=normalizeHistoryFact({observation:row.latestObservation,run:{...row.latestObservation.run,sourceKey:ad.dataSource.key},media:[]});
        days.push({day,scopeHash:row.scopeHash,observationState:'OBSERVED',...check(day),sourceStatus:row.latestSourceStatus as AdHistoryDayView['sourceStatus'],hasStateConflict:row.hasStateConflict,observationCount:row.observationCount,lastObservedAt:row.lastObservedAt.toISOString(),latestObservationId:row.latestObservationId,body:fact.body,headline:fact.headline,cta:fact.cta});
      }
    }
    const events=await tx.adHistoryEvent.findMany({where:{adId:ad.id,observedAt:{gte:window.from,lt:window.to,lte:new Date(asOf)},...(input.scopeHash?{scopeHash:input.scopeHash}:{}),...(cursor?{OR:[{observedAt:{lt:new Date(cursor.observedAt)}},{observedAt:new Date(cursor.observedAt),id:{lt:cursor.id}}]}:{})},orderBy:[{observedAt:'desc'},{id:'desc'}],take:101});
    const page=events.slice(0,100),last=page.at(-1);
    const nextEventCursor=events.length>100&&last?Buffer.from(JSON.stringify({v:1,generation,fingerprint,observedAt:last.observedAt.toISOString(),id:last.id,asOf} satisfies Cursor)).toString('base64url'):null;
    const observed=days.filter(d=>d.observationState==='OBSERVED');
    const first=rows.reduce<Date|null>((v,r)=>!v||r.firstObservedAt<v?r.firstObservedAt:v,null);
    const lastTime=rows.reduce<Date|null>((v,r)=>!v||r.lastObservedAt>v?r.lastObservedAt:v,null);
    const unprojected=await tx.$queryRaw<{pending:boolean}[]>`SELECT EXISTS(SELECT 1 FROM "AdObservation" WHERE "adId"=${ad.id}) AND NOT EXISTS(SELECT 1 FROM "AdDailySnapshot" WHERE "adId"=${ad.id}) AS pending`;
    const pending=await tx.adHistoryProjectionTask.findUnique({where:{adId:ad.id},select:{revision:true,completedRevision:true}});
    return {timezone:'Asia/Shanghai',asOf,from:input.from,to:input.to,scopes:allScopes.map(scopeView),days,events:page.map(e=>({id:e.id,type:e.type as HistoryChange['type'],observedAt:e.observedAt.toISOString(),scopeHash:e.scopeHash,beforeObservationId:e.beforeObservationId,afterObservationId:e.afterObservationId})),nextEventCursor,
      projectionPending:Boolean(unprojected[0]?.pending||pending&&pending.revision>pending.completedRevision),
      summary:{...sourceDateSpan(ad),scope:'selected-window',observedDays:new Set(observed.map(d=>d.day)).size,activeObservedDays:[...byDay.values()].filter(rs=>rs.some(r=>r.activeObservationCount>0)).length,conflictDays:new Set(observed.filter(d=>d.hasStateConflict).map(d=>d.day)).size,firstObservedAt:first?.toISOString()??null,lastObservedAt:lastTime?.toISOString()??null,sourceStartedAt:ad.sourceStartedAt?.toISOString()??null,sourceEndedAt:ad.sourceEndedAt?.toISOString()??null}};
  },{isolationLevel:'RepeatableRead',timeout:15000});
}
