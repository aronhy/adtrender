import {legacyQueryIdentity} from './legacy-query-key';
export interface LedgerRun {id:string;sourceKey:string;idempotencyKey:string;querySnapshot:unknown;status:string;startedAt:Date|string|null;finishedAt:Date|string|null;createdAt:Date|string;fetchedCount:number;insertedCount:number;updatedCount:number;errorCode?:string|null;restrictionReason?:string|null;coverage:unknown;items?:{status:string;sourceAdId?:string|null}[];managedAttribution?:{queryId:string;queryKey:string;quality:string;bindingSnapshot:any[]}|null}
export type QueryLedgerRow = {queryKey:string;sourceKey:string;channel:string;mode:'DISCOVERY'|'OPERATOR'|'HISTORY'|'APP_WORKER';params:Record<string,unknown>;attributionQuality:'EXACT_QUERY'|'HISTORICAL_QUERY'|'UNATTRIBUTED';seedAttribution:'EXACT_QUERY'|'UNATTRIBUTED';queryIds:string[];seedIds:string[];scanPlanIds:string[];executionCount:number;fetchedCount:number;insertedCount:number;updatedCount:number;itemInsertedCount:number|null;itemUpdatedCount:number|null;hasResultsCount:number;identityFoundCount:number;reliableNoResultsCount:number;unknownEmptyCount:number;partialCount:number;restrictedCount:number;rateLimitedCount:number;timeoutCount:number;failedCount:number;requestCount:null;searchCluesAvailable:boolean;lastExecutedAt:string|null;lastSuccessfulAt:string|null;runIds:string[]}
export type LedgerWindow = {from:string;to:string}
export interface LedgerDatabase {$queryRawUnsafe<T=unknown>(query:string,...params:unknown[]):Promise<T>}
function mode(run:LedgerRun):QueryLedgerRow['mode']{
 const q=run.querySnapshot as Record<string,unknown>|null,coverage=run.coverage as Record<string,unknown>|null;
 if(q?.historyKind||run.idempotencyKey.startsWith('history:')||String(coverage?.mode??'').includes('history'))return 'HISTORY';
 if(run.idempotencyKey.includes('-operator:')||String(coverage?.mode??'').includes('operator'))return 'OPERATOR';
 return run.idempotencyKey.includes('-service:')?'DISCOVERY':'APP_WORKER';
}
export function projectQueryLedger(runs:LedgerRun[]):QueryLedgerRow[]{
 const groups=new Map<string,QueryLedgerRow>(),seen=new Set<string>();
 for(const r of runs){
  if(!r.finishedAt||['QUEUED','RUNNING'].includes(r.status))continue;
  const id=r.sourceKey+':'+r.idempotencyKey;if(seen.has(id))continue;seen.add(id);
  const identity=legacyQueryIdentity(r.sourceKey,r.querySnapshot),path=mode(r),managed=r.managedAttribution?.quality==='EXACT_QUERY'?r.managedAttribution:null,quality=managed?'EXACT_QUERY':identity.quality,key=managed?.queryKey??identity.key,groupKey=key+':'+path+':'+quality;
  let row=groups.get(groupKey);
  if(!row){row={queryKey:key,sourceKey:r.sourceKey,channel:identity.channel,mode:path,params:identity.params,attributionQuality:quality,seedAttribution:managed?'EXACT_QUERY':'UNATTRIBUTED',queryIds:[],seedIds:[],scanPlanIds:[],executionCount:0,fetchedCount:0,insertedCount:0,updatedCount:0,itemInsertedCount:0,itemUpdatedCount:0,hasResultsCount:0,identityFoundCount:0,reliableNoResultsCount:0,unknownEmptyCount:0,partialCount:0,restrictedCount:0,rateLimitedCount:0,timeoutCount:0,failedCount:0,requestCount:null,searchCluesAvailable:false,lastExecutedAt:null,lastSuccessfulAt:null,runIds:[]};groups.set(groupKey,row);}
  if(managed){row.queryIds=[...new Set([...row.queryIds,managed.queryId])].sort();row.seedIds=[...new Set([...row.seedIds,...managed.bindingSnapshot.filter(b=>b.ownerKind==='SEED').map(b=>String(b.seedId))])].sort();row.scanPlanIds=[...new Set([...row.scanPlanIds,...managed.bindingSnapshot.filter(b=>b.ownerKind==='SCAN_PLAN').map(b=>String(b.scanPlanId))])].sort();}
  const error=r.restrictionReason||r.errorCode||'',coverage=(r.coverage??{}) as Record<string,unknown>;
  const restricted=/429|RATE_LIMIT|403|CHALLENGE|LOGIN_REQUIRED|ACCESS_BLOCKED/.test(error),timeout=/TIMEOUT|TIME_BUDGET/.test(error);
  const success=['SUCCEEDED','NO_RESULTS'].includes(r.status),identityFound=Number(coverage.advertisersDiscovered??0)>0;
  const noResult=r.fetchedCount===0&&success&&!restricted&&!timeout&&!identityFound&&['EXPLICIT_NO_RESULTS','SOURCE_EXPLICIT_NO_RESULTS','SOURCE_NO_RESULTS'].includes(String(coverage.reason));
  row.executionCount++;row.fetchedCount+=r.fetchedCount;row.insertedCount+=r.insertedCount;row.updatedCount+=r.updatedCount;row.runIds.push(r.id);
  row.hasResultsCount+=Number(r.fetchedCount>0);row.identityFoundCount+=Number(identityFound);row.reliableNoResultsCount+=Number(noResult);row.unknownEmptyCount+=Number(success&&r.fetchedCount===0&&!noResult&&!identityFound&&!restricted&&!timeout);
  row.partialCount+=Number(r.status==='PARTIAL');row.restrictedCount+=Number(restricted);row.rateLimitedCount+=Number(/429|RATE_LIMIT/.test(error));row.timeoutCount+=Number(timeout);row.failedCount+=Number(r.status==='FAILED');
  if(r.items?.length&&r.items.every(i=>['INSERTED','UPDATED'].includes(i.status))){if(row.itemInsertedCount!==null)row.itemInsertedCount+=r.items.filter(i=>i.status==='INSERTED').length;if(row.itemUpdatedCount!==null)row.itemUpdatedCount+=r.items.filter(i=>i.status==='UPDATED').length;}
  else if(r.fetchedCount>0){row.itemInsertedCount=null;row.itemUpdatedCount=null;}
  const at=new Date(r.startedAt??r.createdAt).toISOString();if(!row.lastExecutedAt||at>row.lastExecutedAt)row.lastExecutedAt=at;
  if(success&&!restricted&&!timeout&&(r.fetchedCount>0||noResult||identityFound)&&(!row.lastSuccessfulAt||at>row.lastSuccessfulAt))row.lastSuccessfulAt=at;
 }
 return [...groups.values()].sort((a,b)=>a.sourceKey.localeCompare(b.sourceKey)||a.queryKey.localeCompare(b.queryKey)||a.mode.localeCompare(b.mode));
}
export async function buildQueryLedger(db:LedgerDatabase,window:LedgerWindow):Promise<QueryLedgerRow[]>{
 const from=new Date(window.from),to=new Date(window.to);if(!Number.isFinite(from.getTime())||!Number.isFinite(to.getTime())||from>=to)throw Error('LEDGER_WINDOW_INVALID');
 const rows:LedgerRun[]=[];let cursorAt='1970-01-01T00:00:00.000Z',cursorId='';
 for(;;){
  const page=await db.$queryRawUnsafe<Array<LedgerRun&{scanAt:Date|string}>>(`SELECT r.id,d.key AS "sourceKey",r."idempotencyKey",r."querySnapshot",r.status,r."startedAt",r."finishedAt",r."createdAt",r."fetchedCount",r."insertedCount",r."updatedCount",r."errorCode",r."restrictionReason",r.coverage,(SELECT jsonb_build_object('queryId',a."queryId",'queryKey',q."queryKey",'quality',a."attributionQuality",'bindingSnapshot',a."bindingSnapshot") FROM "SeedAttempt" a JOIN "SeedQuery" q ON q.id=a."queryId" WHERE a."runId"=r.id AND a."dataSourceId"=r."dataSourceId" AND a."attributionQuality"='EXACT_QUERY' AND a."taskAttemptId" IS NOT NULL LIMIT 1) AS "managedAttribution",COALESCE((SELECT jsonb_agg(jsonb_build_object('status',i.status,'sourceAdId',i."sourceAdId")) FROM "RunItem" i WHERE i."runId"=r.id),'[]'::jsonb) AS items,r."createdAt" AS "scanAt" FROM "CollectionRun" r JOIN "DataSource" d ON d.id=r."dataSourceId" WHERE COALESCE(r."startedAt",r."createdAt") >= $1::timestamp AND COALESCE(r."startedAt",r."createdAt") < $2::timestamp AND r."finishedAt" IS NOT NULL AND (r."createdAt",r.id)>($3::timestamp,$4::text) ORDER BY r."createdAt",r.id LIMIT 500`,from.toISOString(),to.toISOString(),cursorAt,cursorId);
  if(!page.length)break;rows.push(...page);const last=page[page.length-1];cursorAt=new Date(last.scanAt??last.createdAt).toISOString();cursorId=last.id;
 }
 return projectQueryLedger(rows);
}
