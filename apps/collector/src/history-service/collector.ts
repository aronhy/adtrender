import {chromium,type BrowserContext} from 'playwright';
import {parseMetaDocument} from '../meta-parser';
import {sanitizeEvidence,graphqlErrorCode} from '../meta-service/evidence';
import {collectBatch as collectTikTok} from '../tiktok-service/browser';
import {pinterestParserRuntimeSource} from '../pinterest/parser';
import {parseAd as parseSnap} from '../snapchat-service/parser';
import {accessError as snapAccess} from '../snapchat-service/access';
import {collectGoogle} from './google';
import {fixedUrl,safeError,type Target,type Result} from './types';
export interface Options {createContext?:()=>Promise<BrowserContext>;request?:typeof fetch;maxMs?:number;settleMs?:number;signal?:AbortSignal}
export function historyQuery(t:Target){return {historyKind:'HISTORY_RECHECK',targetSourceAdId:t.sourceAdId,attemptId:t.attemptId,country:t.country??'ALL',scopeKind:'EXACT_AD_DETAIL',countryMeaning:'original-discovery-context-not-targeting-or-current-filter',discoveryQuery:t.discoveryQuery};}
export async function anonymousContext(){const browser=await chromium.launch({channel:'chromium',headless:true,chromiumSandbox:true,env:Object.fromEntries(Object.entries(process.env).filter(([k,v])=>v!==undefined&&['PATH','HOME','LANG','TZ','PLAYWRIGHT_BROWSERS_PATH'].includes(k))) as Record<string,string>});try{const context=await browser.newContext({locale:'en-US',timezoneId:'UTC',viewport:{width:1440,height:1000}});context.on('close',()=>{void browser.close().catch(()=>{});});return context;}catch(e){await browser.close();throw e;}}
function access(status:number|null,text:string){if(status===403||status===429)return 'HISTORY_HTTP_'+status;if(/verify (?:that )?you are human|security check|captcha|checkpoint|unusual traffic/i.test(text))return 'HISTORY_SOURCE_CHALLENGE';if(/log in to continue|log in to Facebook|login required|sign in to continue/i.test(text))return 'HISTORY_LOGIN_REQUIRED';if(status!==null&&status>=400)return status===404||status===410?'HISTORY_NOT_OBSERVED':'HISTORY_HTTP_'+status;return null;}
function resultFromBatch(b:Record<string,any>):Result {return b.status==='SUCCEEDED'&&b.ads.length===1?{outcome:'OBSERVED',errorCode:null,batch:b}:{outcome:'FAILED',errorCode:b.errorCode??'HISTORY_DETAIL_INCOMPLETE',retryAfterMs:b.retryAfterMs,evidence:b.evidence};}
/** A single exact known identity per attempt, fresh anonymous context, no search/dedupe. */
export async function collectTarget(t:Target,options:Options={}):Promise<Result>{
 if(!fixedUrl(t))return {outcome:'UNSUPPORTED',errorCode:'HISTORY_SOURCE_URL_UNSUPPORTED'};
 if(t.sourceKey!=='snapchat_ads_gallery'&&(!t.country||!/^[A-Z]{2}$/.test(t.country)))return {outcome:'UNSUPPORTED',errorCode:'HISTORY_DISCOVERY_SCOPE_MISSING'};
 if(options.signal?.aborted)return {outcome:'FAILED',errorCode:'HISTORY_ABORTED'};
 if(t.sourceKey==='google_ads_transparency')return collectGoogle(t,historyQuery(t),{...options,createContext:options.createContext??anonymousContext});
 if(t.sourceKey==='snapchat_ads_gallery')return collectSnap(t,options);
 if(t.sourceKey==='tiktok_commercial_library'){
  const start=t.discoveryQuery.startDate,end=t.discoveryQuery.endDate;
  if(typeof start!=='string'||typeof end!=='string'||!/^\d{4}-\d\d-\d\d$/.test(start)||!/^\d{4}-\d\d-\d\d$/.test(end)||!(Date.parse(start)<Date.parse(end)))return {outcome:'UNSUPPORTED',errorCode:'HISTORY_DISCOVERY_RANGE_MISSING'};
  let redirectBlocked=false;
  const guardedContext=async()=>{const context=await (options.createContext??anonymousContext)();await context.route('**/*',async route=>{const r=route.request();if(r.isNavigationRequest()&&r.frame().parentFrame()===null&&new URL(r.url()).origin!=='https://library.tiktok.com'){redirectBlocked=true;await route.abort();}else await route.fallback();});return context;};
  const b=await collectTikTok({id:t.adId,kind:'MEDIA_REFRESH',sourceAdIds:[t.sourceAdId],country:t.country!,start,end,page:0,seen:[],complete:false,lastAttemptAt:0,retryAt:0,failures:0,cycleStartedAt:Date.now()},{maxAds:1,maxMs:options.maxMs??90000,settleMs:options.settleMs??1500,signal:options.signal,handleSignals:false},guardedContext);
  if(redirectBlocked)return {outcome:'FAILED',errorCode:'HISTORY_REDIRECT_REJECTED',evidence:b.evidence};
  Object.assign(b.query,historyQuery(t));b.coverage.reason=b.status==='SUCCEEDED'?'HISTORY_EXACT_DETAIL':b.coverage.reason;
  return resultFromBatch(b);
 }
 let context:BrowserContext|undefined;let code:string|null=null;let retryAfterMs:number|undefined;const evidence:any[]=[];const close=()=>context?.close().catch(()=>{});
 const timeout=setTimeout(()=>{code='HISTORY_TIME_BUDGET';void close();},options.maxMs??90000);timeout.unref();
 const abort=()=>{code='HISTORY_ABORTED';void close();};options.signal?.addEventListener('abort',abort,{once:true});
 try{
  context=await (options.createContext??anonymousContext)();if(code)throw Error(code);const page=await context.newPage();page.setDefaultTimeout(20000);
  const expectedOrigin=new URL(t.sourceUrl).origin;
  // Cross-origin top-level redirects are never followed (login/advertiser/other hosts).
  await page.route('**/*',async route=>{const r=route.request();if(r.isNavigationRequest()&&r.frame()===page.mainFrame()&&new URL(r.url()).origin!==expectedOrigin){code='HISTORY_REDIRECT_REJECTED';await route.abort();}else await route.fallback();});
  const checks=new Set<Promise<void>>();
  context.on('response',r=>{const u=new URL(r.url());if(u.origin!==expectedOrigin||!['document','xhr','fetch'].includes(r.request().resourceType()))return;
   const check=(async()=>{if([403,429].includes(r.status())){code='HISTORY_HTTP_'+r.status();const retry=r.headers()['retry-after'];if(retry){const ms=/^\d+$/.test(retry)?Number(retry)*1000:Date.parse(retry)-Date.now();if(Number.isFinite(ms)&&ms>0)retryAfterMs=Math.min(ms,604800000);}}
    else if(t.sourceKey==='meta_ad_library'&&u.pathname==='/api/graphql/'&&r.status()===200){try{code=graphqlErrorCode(await r.text())??code;}catch{}}
    if(code)await close();})();checks.add(check);void check.finally(()=>checks.delete(check));
  });
  const response=await page.goto(t.sourceUrl,{waitUntil:'domcontentloaded',timeout:30000});const status=response?.status()??null;
  if(code)throw Error(code);const initial=access(status,await page.locator('body').innerText());if(initial)throw Error(initial);
  await page.waitForFunction(source=>source==='meta_ad_library'?/Library ID\s*[:：]\s*\d+|资料库编号\s*[:：]\s*\d+|no results|no ads|not available|log in|captcha|security check/i.test(document.body.innerText):Boolean(document.querySelector('[data-test-id="ad-details-content"] h2'))||/not found|not available|log in|captcha/i.test(document.body.innerText),t.sourceKey,{timeout:25000});
  await page.waitForTimeout(options.settleMs??1500);await Promise.allSettled([...checks]);if(code)throw Error(code);
  const text=await page.locator('body').innerText();const blocked=access(status,text);if(blocked)throw Error(blocked);
  // Canonical final identity must still be the requested identity.
  if(!fixedUrl({...t,sourceUrl:page.url()}))throw Error('HISTORY_REDIRECT_ID_MISMATCH');
  const clean=await page.evaluate(`(()=>{const __name=f=>f;return (${sanitizeEvidence.toString()})(document);})()`) as {text:string;html:string};
  const observedAt=new Date().toISOString();const ev={url:t.sourceUrl,httpStatus:status,kind:'detail',adId:t.sourceAdId,observedAt,...clean};evidence.push(ev);
  let batch:Record<string,any>;
  if(t.sourceKey==='meta_ad_library'){
   const parsed:any=await page.evaluate(`(()=>{const __name=f=>f;return (${parseMetaDocument.toString()})(document,${JSON.stringify(t.country)});})()`);
   const ads=parsed.ads.filter((a:any)=>a.sourceAdId===t.sourceAdId);
   if(ads.length!==1)return {outcome:'NOT_OBSERVED',errorCode:'HISTORY_TARGET_NOT_OBSERVED',evidence};
   batch={version:'meta-service-dom-1',sourceKey:t.sourceKey,platform:'META',observedAt,query:{language:'en',keyword:'',...historyQuery(t)},status:'SUCCEEDED',errorCode:null,ads,evidence,completedIds:[t.sourceAdId],coverage:{completeSourceCoverage:false,exhausted:false,reason:'HISTORY_EXACT_DETAIL',observedCards:1},diagnostics:[]};
  }else{
   const parsed:any=await page.evaluate(`(()=>{${pinterestParserRuntimeSource()};return {fields:parsePinterestDetails(document),media:parsePinterestMedia(document)};})()`);
   if(!parsed.fields['Advertiser name']&&parsed.fields['Ad status']!=='Disapproved')return {outcome:'NOT_OBSERVED',errorCode:'PINTEREST_DETAIL_INCOMPLETE',evidence};
   // Text shown only on search cards cannot be copied from yesterday's card.
   // Detail fields, media and raw DOM are fully captured; unknown copy stays null.
   const countries:string[]=[];const names=new Intl.DisplayNames(['en'],{type:'region'});const reported=(parsed.fields.Countries??'').split(/[,\n]/).map((s:string)=>s.trim());
   for(const c of 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO CH TR GB US CA AU NZ'.split(' '))if(reported.includes(names.of(c)))countries.push(c);
   const ad={sourceAdId:t.sourceAdId,sourceUrl:t.sourceUrl,advertiserName:parsed.fields['Advertiser name']??null,headline:null,body:null,bodyTruncated:false,media:parsed.media,observedAt,reportedCountries:countries,sourceFields:parsed.fields,rawText:clean.text,rawHtml:clean.html};
   batch={version:'pinterest-public-dom-1',sourceKey:t.sourceKey,platform:'PINTEREST',observedAt,query:{keyword:'',limit:1,...historyQuery(t)},status:'SUCCEEDED',errorCode:null,ads:[ad],evidence,diagnostics:[],coverage:{complete:false,completeSourceCoverage:false,observedCards:1,selected:1,reason:'HISTORY_EXACT_DETAIL'}};
  }
  return {outcome:'OBSERVED',errorCode:null,batch};
 }catch(e){const errorCode=code??safeError(e);return {outcome:errorCode==='HISTORY_NOT_OBSERVED'?'NOT_OBSERVED':'FAILED',errorCode,retryAfterMs,evidence};}
 finally{clearTimeout(timeout);options.signal?.removeEventListener('abort',abort);await close();}
}
async function collectSnap(t:Target,options:Options):Promise<Result>{
 const url='https://adsapi.snapchat.com/v1/ads_library/ads/'+t.sourceAdId;
 let retryAfterMs:number|undefined;const evidence:any[]=[];
 try{
  const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(options.maxMs??45000)]):AbortSignal.timeout(options.maxMs??45000);
  const r=await (options.request??fetch)(url,{headers:{accept:'application/json'},redirect:'error',signal});
  const err=snapAccess(r.status,'');if(err){const retry=r.headers.get('retry-after');if(retry){const ms=/^\d+$/.test(retry)?Number(retry)*1000:Date.parse(retry)-Date.now();if(Number.isFinite(ms)&&ms>0)retryAfterMs=Math.min(ms,604800000);}await r.body?.cancel();throw Error(err);}
  if(r.status===404||r.status===410){await r.body?.cancel();return {outcome:'NOT_OBSERVED',errorCode:'SNAP_TARGET_NOT_OBSERVED',evidence:[{url,status:r.status}]};}
  if(!r.ok){await r.body?.cancel();throw Error('SNAP_HTTP_'+r.status);}
  const reader=r.body?.getReader();if(!reader)throw Error('SNAP_RESPONSE_EMPTY');let size=0;const chunks:Uint8Array[]=[];
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>4000000)throw Error('SNAP_RESPONSE_BUDGET');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  const text=Buffer.concat(chunks).toString('utf8'),blocked=snapAccess(null,text.slice(0,4000));if(blocked&&!r.headers.get('content-type')?.includes('json'))throw Error(blocked);
  const raw=JSON.parse(text);evidence.push({kind:'public-response',url,status:r.status,request:null,raw,adIds:[t.sourceAdId]});
  if(raw.request_status!=='SUCCESS')throw Error('SNAP_DETAIL_FAILED');
  const ad=parseSnap(raw.ad_preview,t.country??'ALL');if(ad.sourceAdId!==t.sourceAdId)throw Error('SNAP_DETAIL_MISMATCH');
  const batch={sourceKey:t.sourceKey,version:'snapchat-service-public-1',observedAt:new Date().toISOString(),query:{publisher:ad.advertiserName??'Exact known ad',...historyQuery(t)},status:'SUCCEEDED',errorCode:null,ads:[ad],evidence,completedIds:[t.sourceAdId],nextUrl:null,coverage:{completeSourceCoverage:false,exhausted:false,reason:'HISTORY_EXACT_DETAIL',scope:'Exact known ad; original discovery country is not targeting proof'}};
  return {outcome:'OBSERVED',errorCode:null,batch};
 }catch(e){return {outcome:'FAILED',errorCode:safeError(e),retryAfterMs,evidence};}
}
