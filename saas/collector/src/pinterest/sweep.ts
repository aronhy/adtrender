export interface Shard {id:string;country:string;start:string;end:string;keyword:'';category:'ALL';page:number;complete:boolean;lastAttemptAt:number;retryAt:number;failures:number;pending?:string[];error?:string}
export function planSweep(countries:string[],start:string,end:string):Shard[] {
 const first=Date.parse(start),last=Date.parse(end),day=86400000;
 if(!countries.length||countries.some(c=>!/^[A-Z]{2}$/.test(c))||!Number.isFinite(first)||!Number.isFinite(last)||first>last)throw Error('SWEEP_RANGE_INVALID');
 const jobs:Shard[]=[];
 for(let to=last;to>=first;to-=7*day){const from=Math.max(first,to-6*day);const s=new Date(from).toISOString().slice(0,10),e=new Date(to).toISOString().slice(0,10);for(const country of [...new Set(countries)])jobs.push({id:`${country}:${s}:${e}`,country,start:s,end:e,keyword:'',category:'ALL',page:0,complete:false,lastAttemptAt:0,retryAt:0,failures:0});}
 return jobs;
}
/** The first two due retries retain priority; persistent failures rejoin ordinary rotation. */
export function nextShard(jobs:Shard[],now:number){const earlyRetry=(job:Shard)=>Number(job.failures>=1&&job.failures<=2);return jobs.filter(j=>!j.complete&&j.retryAt<=now).sort((a,b)=>earlyRetry(b)-earlyRetry(a)||a.lastAttemptAt-b.lastAttemptAt)[0];}
export function backoffMs(failures:number){return Math.min(21600000,60000*2**Math.min(20,Math.max(0,failures-1)));}
/** Call only after durable archive + successful DB commit, including replay. */
export function advanceShard(job:Shard,result:{status:string;errorCode:string|null;nextPage:number;exhausted:boolean},now:number) {
 if(['SUCCEEDED','NO_RESULTS'].includes(result.status)) {job.page=result.nextPage;job.complete=result.exhausted;job.failures=0;job.retryAt=0;delete job.error;}
 else {job.failures++;job.error=result.errorCode??'FAILED';job.retryAt=now+backoffMs(job.failures);}
 job.lastAttemptAt=now;
}
