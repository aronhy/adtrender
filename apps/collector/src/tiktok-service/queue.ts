const DAY=86400000;
const REFRESH_MS=6*3600000;
export interface Job {
 id:string;country:string;start:string;end:string;page:number;seen:string[];
 complete:boolean;lastAttemptAt:number;retryAt:number;failures:number;cycleStartedAt:number;error?:string;superseded?:boolean;
 kind?:'MEDIA_REFRESH';sourceAdIds?:string[];
}
export interface MediaRefreshCandidate {sourceAdId:string;country:string;startDate:string;endDate:string}
/** At most two details per scan. Existing pending retries keep their own backoff. */
export function enqueueMediaRefresh(jobs:Job[],candidates:MediaRefreshCandidate[],now:number){
 if(!Array.isArray(candidates)||candidates.length>2)throw Error('TIKTOK_MEDIA_REFRESH_LIMIT');
 const validated=candidates.map(c=>{if(!c||!/^\d{5,40}$/.test(c.sourceAdId)||!/^[A-Z]{2}$/.test(c.country)||date(c.startDate)>date(c.endDate))throw Error('TIKTOK_MEDIA_REFRESH_CANDIDATE_INVALID');return c;});
 for(const c of validated){
  const id='MEDIA_REFRESH:'+c.sourceAdId,existing=jobs.find(j=>j.id===id);
  if(existing){if(!existing.complete||now-existing.lastAttemptAt<REFRESH_MS)continue;Object.assign(existing,{country:c.country,start:c.startDate,end:c.endDate,seen:[],complete:false,cycleStartedAt:now,retryAt:0,failures:0});continue;}
  jobs.push({id,kind:'MEDIA_REFRESH',sourceAdIds:[c.sourceAdId],country:c.country,start:c.startDate,end:c.endDate,page:0,seen:[],complete:false,lastAttemptAt:0,retryAt:0,failures:0,cycleStartedAt:now});
 }
}
export interface BatchProgress {
 status:'SUCCEEDED'|'PARTIAL'|'FAILED'|'NO_RESULTS';errorCode:string|null;
 completedIds:string[];coverage:{exhausted:boolean};nextPage?:number;retryAfterMs?:number;
}
export interface PlanOptions {now?:number;lookbackDays?:number;windowDays?:1|7;start?:string;end?:string}
const iso=(value:number)=>new Date(value).toISOString().slice(0,10);
function date(value:string){const parsed=Date.parse(value);if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(parsed)||iso(parsed)!==value)throw Error('TIKTOK_RANGE_INVALID');return parsed;}
/** Country values must come from the observed live source catalog. Date bounds overlap by one day. */
export function planJobs(countries:string[],options:PlanOptions={}):Job[]{
 if(!countries.length||countries.some(c=>!(/^[A-Z]{2}$/.test(c))))throw Error('TIKTOK_COUNTRIES_INVALID');
 const now=options.now??Date.now(),lookback=options.lookbackDays??30,span=options.windowDays??7;
 if(!Number.isFinite(now)||!Number.isInteger(lookback)||lookback<1||lookback>3660||![1,7].includes(span))throw Error('TIKTOK_RANGE_INVALID');
 const last=options.end?date(options.end):date(iso(now));
 const first=options.start?date(options.start):last-Math.max(1,lookback-1)*DAY;
 if(first>=last||last-first>3660*DAY)throw Error('TIKTOK_RANGE_INVALID');
 const jobs:Job[]=[];
 for(let to=last;to>first;){const from=Math.max(first,to-span*DAY),start=iso(from),end=iso(to);
  for(const country of new Set(countries))jobs.push({id:`${country}:${start}:${end}`,country,start,end,page:0,seen:[],complete:false,lastAttemptAt:0,retryAt:0,failures:0,cycleStartedAt:now});
  to=from;
 }
 return jobs;
}
/** Give the first two due retries priority; persistent failures rejoin ordinary rotation. */
export function nextJob(jobs:Job[],now:number){
 const earlyRetry=(job:Job)=>Number(job.failures>=1&&job.failures<=2);
 return jobs.filter(j=>!j.superseded&&!j.complete&&j.retryAt<=now)
  .sort((a,b)=>Number(b.kind==='MEDIA_REFRESH'&&b.failures<=2)-Number(a.kind==='MEDIA_REFRESH'&&a.failures<=2)||earlyRetry(b)-earlyRetry(a)||a.lastAttemptAt-b.lastAttemptAt)[0];
}
function retryAfter(value:number|undefined){return typeof value==='number'&&Number.isFinite(value)&&value>0?value:0;}
export function backoffMs(failures:number){return Math.min(6*3600000,60000*2**Math.min(20,Math.max(0,failures-1)));}
export function restrictionAction(code:string|null,failures:number,retryAfterMs?:number):{manual:boolean;delayMs:number}{
 if(/(?:CHALLENGE|CAPTCHA|LOGIN_REQUIRED|HTTP_403|ACCESS_BLOCKED|ACCESS_DENIED)$/.test(code??''))return {manual:true,delayMs:0};
 if(/(?:HTTP_429|RATE_LIMITED)$/.test(code??''))return {manual:false,delayMs:Math.max(retryAfter(retryAfterMs),Math.min(24*3600000,3600000*2**Math.min(5,Math.max(0,failures-1))))};
 return {manual:false,delayMs:0};
}
/** Call only after immutable evidence and its database transaction are durable. */
export function advanceJob(job:Job,result:BatchProgress,now:number){
 if(result.nextPage!==undefined&&(!Number.isInteger(result.nextPage)||result.nextPage<0))throw Error('TIKTOK_PAGE_INVALID');
 job.seen=[...new Set([...job.seen,...result.completedIds])];job.lastAttemptAt=now;
 if(result.status==='SUCCEEDED'||result.status==='NO_RESULTS'){
  if(result.nextPage!==undefined)job.page=result.nextPage;
  job.complete=job.kind==='MEDIA_REFRESH'||result.coverage.exhausted===true;job.failures=0;job.retryAt=now;delete job.error;
 }else{job.complete=false;job.failures++;job.error=result.errorCode??'TIKTOK_COLLECTION_FAILED';job.retryAt=now+Math.max(backoffMs(job.failures),retryAfter(result.retryAfterMs));}
}
/** Call only after committing the batch. Deterministic child IDs make replay safe without resetting existing child checkpoints. */
export function splitBudgetJob(jobs:Job[],job:Job,result:BatchProgress,now:number):string[]{
 if(job.kind==='MEDIA_REFRESH'||job.superseded||result.completedIds.length||!['TIKTOK_REPLAY_BUDGET','TIKTOK_TIME_BUDGET'].includes(result.errorCode??''))return [];
 const start=date(job.start),end=date(job.end),days=(end-start)/DAY;if(days<=1)return [];
 const middle=iso(start+Math.floor(days/2)*DAY);const childIds:string[]=[];
 for(const [from,to] of [[job.start,middle],[middle,job.end]]){
  const id=`${job.country}:${from}:${to}`;childIds.push(id);
  if(!jobs.some(existing=>existing.id===id))jobs.push({id,country:job.country,start:from,end:to,page:0,seen:[],complete:false,lastAttemptAt:0,retryAt:0,failures:0,cycleStartedAt:now});
 }
 job.superseded=true;job.complete=false;return childIds;
}
/** Reobserve windows touching either of the last two UTC dates; do not erase a failing checkpoint or its backoff. */
export function refreshJobs(jobs:Job[],now:number){
 const recent=date(iso(now))-DAY;
 for(const job of jobs)if(job.kind!=='MEDIA_REFRESH'&&!job.superseded&&date(job.end)>=recent&&job.failures===0&&now-job.cycleStartedAt>=REFRESH_MS){
  job.page=0;job.seen=[];job.complete=false;job.retryAt=0;job.cycleStartedAt=now;delete job.error;
 }
}
