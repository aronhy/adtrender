export const DAY=86400000;
export const COUNTRIES:Record<string,string>={AT:'Austria',BE:'Belgium',BG:'Bulgaria',HR:'Croatia',CY:'Cyprus',CZ:'Czechia',DK:'Denmark',EE:'Estonia',FI:'Finland',FR:'France',DE:'Germany',GR:'Greece',HU:'Hungary',IE:'Ireland',IT:'Italy',LV:'Latvia',LT:'Lithuania',LU:'Luxembourg',MT:'Malta',NL:'Netherlands',PL:'Poland',PT:'Portugal',RO:'Romania',SK:'Slovakia',SI:'Slovenia',ES:'Spain',SE:'Sweden',TR:'Turkey'};
export type JobKind='CANDIDATE'|'WATCH';
export interface Job {id:string;publisher:string;country:string;seen:string[];complete:boolean;lastAttemptAt:number;retryAt:number;failures:number;cycleAt:number;nextUrl?:string|null;kind?:JobKind;candidateSources?:string[];discoveredAt?:number;confirmedAt?:number}
export function makeJob(publisher:string,country='ALL'):Job{publisher=publisher.trim();if(!publisher||publisher.length>200||country!=='ALL'&&!COUNTRIES[country])throw Error('SNAP_QUERY_INVALID');return {id:`${country}:${publisher.toLowerCase()}`,publisher,country,seen:[],complete:false,lastAttemptAt:0,retryAt:0,failures:0,cycleAt:0};}
/** Bootstrap only. The live candidate feed and Snapchat observations expand this queue. */
export function seedJobs(publishers=['nike','adidas','puma','shein','temu','amazon','zalando','h&m','sephora','loreal','samsung','apple']){return [...new Map(publishers.map(p=>{const j=makeJob(p);return[j.id,j];})).values()];}
export interface Candidate {publisher:string;sources:string[]}
export function mergeCandidates(jobs:Job[],candidates:Candidate[],now:number){
 if(!Array.isArray(candidates)||candidates.some(c=>!c||typeof c.publisher!=='string'||!Array.isArray(c.sources)||!c.sources.length||c.sources.some(s=>typeof s!=='string'||!/^[a-z0-9_-]{1,80}$/.test(s))))throw Error('SNAP_CANDIDATES_INVALID');
 const index=new Map(jobs.map(j=>[j.id,j]));let added=0;
 for(const c of candidates){const name=c.publisher.trim();if(!name||name.length>200||/[\u0000-\u001f\u007f]/.test(name))continue;const fresh=makeJob(name);const existing=index.get(fresh.id);
  if(existing){existing.candidateSources=[...new Set([...(existing.candidateSources??[]),...c.sources])];continue;}
  fresh.kind='CANDIDATE';fresh.candidateSources=[...new Set(c.sources)];fresh.discoveredAt=now;jobs.push(fresh);index.set(fresh.id,fresh);added++;
 }return added;
}
/** Only call after the native batch was durably imported, never on candidate metadata. */
export function recordDiscovery(jobs:Job[],job:Job,ads:{advertiserName:string|null;brand:string|null}[],now:number){
 if(!ads.length)return;job.kind='WATCH';job.confirmedAt??=now;
 mergeCandidates(jobs,ads.flatMap(a=>[a.advertiserName,a.brand].filter((p):p is string=>!!p).map(publisher=>({publisher,sources:['snapchat_ads_gallery']}))),now);
}
export function queueSummary(jobs:Job[]){
 const groups=new Map<string,Job[]>();for(const j of jobs){const key=j.publisher.toLowerCase();groups.set(key,[...(groups.get(key)??[]),j]);}
 const publishers=[...groups.values()];return {publishers:publishers.length,candidatePublishers:publishers.filter(g=>g.every(j=>j.kind==='CANDIDATE')).length,confirmedPublishers:publishers.filter(g=>g.some(j=>j.confirmedAt!==undefined)).length,unvisitedPublishers:publishers.filter(g=>g.every(j=>j.lastAttemptAt===0)).length};
}
export function nextJob(jobs:Job[],now:number,pauseUntil:number,nextBatchAt:number,lastKind?:JobKind){
 if(now<pauseUntil||now<nextBatchAt)return;const due=jobs.filter(j=>j.retryAt<=now).sort((a,b)=>a.lastAttemptAt-b.lastAttemptAt);
 if(lastKind){const preferred=lastKind==='CANDIDATE'?'WATCH':'CANDIDATE';return due.find(j=>(j.kind??'WATCH')===preferred)??due[0];}return due[0];
}
export function prepare(job:Job,now:number){if(job.complete&&job.retryAt<=now){job.seen=[];job.complete=false;job.cycleAt=now;job.nextUrl=null;}}
export function restrictionDelay(code:string|null,failures:number){return /HTTP_403|HTTP_429|CHALLENGE|LOGIN_REQUIRED/.test(code??'')?Math.min(DAY,3600000*2**Math.min(5,Math.max(0,failures-1))):0;}
export function advance(j:Job,b:{completedIds:string[];status:string;errorCode:string|null;exhausted:boolean;nextUrl?:string|null},now:number){j.seen=[...new Set([...j.seen,...b.completedIds])];j.lastAttemptAt=now;if(b.nextUrl!==undefined)j.nextUrl=b.nextUrl;if(['SUCCEEDED','NO_RESULTS'].includes(b.status)){j.failures=0;j.complete=b.exhausted;j.nextUrl=b.nextUrl??null;j.retryAt=now+(j.complete?(b.status==='NO_RESULTS'&&j.kind==='CANDIDATE'?7*DAY:DAY):0);}else{if(b.errorCode==='SNAP_HTTP_400'&&j.nextUrl)j.nextUrl=null;j.failures++;j.complete=false;j.retryAt=now+Math.min(6*3600000,60000*2**Math.min(10,j.failures-1));}}
