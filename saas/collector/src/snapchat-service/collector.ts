import type {SourceRequestGuard} from '../dispatch/execution-guard';
import {setTimeout as sleep} from 'node:timers/promises';import {parseAd,parseSearch,sourceApiUrl,type SnapAd} from './parser';import {accessError} from './access';import type {Job} from './queue';
export interface Evidence {kind:'public-response';url:string;status:number;request:unknown;raw:unknown;adIds:string[]}
export interface Batch {sourceKey:'snapchat_ads_gallery';version:'snapchat-service-public-1';observedAt:string;query:{publisher:string;country:string};status:'SUCCEEDED'|'PARTIAL'|'FAILED'|'NO_RESULTS';errorCode:string|null;retryAfterMs?:number;ads:SnapAd[];evidence:Evidence[];completedIds:string[];nextUrl:string|null;coverage:{completeSourceCoverage:false;exhausted:boolean;reason:string;scope:string}}
export async function collectBatch(job:Job,options:{request?:typeof fetch;delayMs?:number;maxPages?:number;maxMs?:number;guard?:SourceRequestGuard;signal?:AbortSignal}={}):Promise<Batch>{
 await options.guard?.beforeRequest('API_START');
 const b:Batch={sourceKey:'snapchat_ads_gallery',version:'snapchat-service-public-1',observedAt:new Date().toISOString(),query:{publisher:job.publisher,country:job.country},status:'FAILED',errorCode:null,ads:[],evidence:[],completedIds:[],nextUrl:job.nextUrl??null,coverage:{completeSourceCoverage:false,exhausted:false,reason:'NOT_FINISHED',scope:'Exact publisher query within publicly disclosed regions'}};
 const start=Date.now(),maxMs=options.maxMs??180000,request=options.request??fetch;const seen=new Set(job.seen);const visited=new Set<string>();let bytes=0;
 const get=async(url:string,payload?:unknown)=>{
  if(!sourceApiUrl(url))throw Error('SNAP_CURSOR_INVALID');const remaining=maxMs-(Date.now()-start);if(remaining<=0)throw Error('SNAP_TIME_BUDGET');
  await options.guard?.beforeRequest(payload?'LIST':'DETAIL');const r=await request(url,{method:payload?'POST':'GET',headers:{'content-type':'application/json','accept':'application/json'},...(payload?{body:JSON.stringify(payload)}:{}),redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(Math.min(45000,remaining)),...(options.guard?.signal?[options.guard.signal]:options.signal?[options.signal]:[])])});
  const err=accessError(r.status,'');if(err){const retry=r.headers.get('retry-after');if(retry){const value=/^\d+$/.test(retry)?Number(retry)*1000:Date.parse(retry)-Date.now();if(Number.isFinite(value)&&value>0)b.retryAfterMs=value;}await r.body?.cancel();throw Error(err);}
  if(!r.ok){await r.body?.cancel();throw Error('SNAP_HTTP_'+r.status);}
  const reader=r.body?.getReader();if(!reader)throw Error('SNAP_RESPONSE_EMPTY');const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4000000||bytes+size>6000000)throw Error('SNAP_RESPONSE_BUDGET');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  bytes+=size;const raw=Buffer.concat(chunks).toString('utf8');const challenge=accessError(null,raw.slice(0,4000));if(challenge&&!r.headers.get('content-type')?.includes('json'))throw Error(challenge);
  let data:Record<string,unknown>;try{data=JSON.parse(raw);}catch{throw Error('SNAP_RESPONSE_SCHEMA');}if(!data||typeof data!=='object')throw Error('SNAP_RESPONSE_SCHEMA');
  const records=Array.isArray(data.ad_previews)?data.ad_previews.map(x=>x?.ad_preview):data.ad_preview?[data.ad_preview]:[];b.evidence.push({kind:'public-response',url,status:r.status,request:payload??null,raw:data,adIds:records.map(x=>(x as {id?:unknown})?.id).filter((x):x is string=>typeof x==='string')});
  if(data.request_status!=='SUCCESS'){const error=accessError(null,String(data.display_message??'')+' '+String(data.debug_message??''));if(error)throw Error(error);}
  return data;
 };
 try{for(let page=0;page<(options.maxPages??2);page++){
  const url=b.nextUrl??'https://adsapi.snapchat.com/v1/ads_library/ads/search?limit=8';if(!sourceApiUrl(url)||new URL(url).pathname!=='/v1/ads_library/ads/search')throw Error('SNAP_CURSOR_INVALID');if(visited.has(url))throw Error('SNAP_CURSOR_STALLED');visited.add(url);
  const payload={countries:job.country==='ALL'?[]:[job.country==='GR'?'el':job.country.toLowerCase()],paying_advertiser_name:job.publisher};const data=await get(url,payload);const listing=parseSearch(data,job.country);
  if(listing.ads.length>8)throw Error('SNAP_PAGE_LIMIT');
  for(const ad of listing.ads){if(seen.has(ad.sourceAdId))continue;await sleep(options.delayMs??1000);const d=await get('https://adsapi.snapchat.com/v1/ads_library/ads/'+ad.sourceAdId);if(d.request_status!=='SUCCESS')throw Error('SNAP_DETAIL_FAILED');const detail=parseAd(d.ad_preview,job.country);if(detail.sourceAdId!==ad.sourceAdId)throw Error('SNAP_DETAIL_MISMATCH');b.ads.push(detail);b.completedIds.push(detail.sourceAdId);seen.add(detail.sourceAdId);}
  b.nextUrl=listing.nextUrl;
  if(!listing.nextUrl){b.status=b.ads.length?'SUCCEEDED':listing.ads.length||job.seen.length?'SUCCEEDED':'NO_RESULTS';b.coverage.exhausted=true;b.coverage.reason='SOURCE_LAST_PAGE';break;}
  if(b.ads.length>=8||page+1>=(options.maxPages??2)){b.status='SUCCEEDED';b.coverage.reason='BATCH_BUDGET';break;}await sleep(options.delayMs??1000);
 }}catch(e){const code=e instanceof Error?e.message:'';b.errorCode=/^SNAP_[A-Z_0-9]+$/.test(code)?code:e instanceof Error&&['TimeoutError','AbortError'].includes(e.name)?'SNAP_TIMEOUT':'SNAP_NETWORK_ERROR';b.status=b.ads.length?'PARTIAL':'FAILED';b.coverage.exhausted=false;b.coverage.reason=b.errorCode;}
 return b;
}
