import { chromium, type Browser } from 'playwright';
import { validateCollectionQuery, type CollectionQuery, type CollectionOutcome, type ParsedAd } from '../../../packages/contracts/src/collection';
import { classifyMetaPage, parseMetaDocument, META_PARSER_VERSION, type MetaParseResult } from './meta-parser';

export function buildMetaSearchUrl(input: CollectionQuery): string {
  const q=validateCollectionQuery(input);
  const url=new URL('https://www.facebook.com/ads/library/');
  url.search=new URLSearchParams({q:q.keyword,country:q.country,active_status:q.status,media_type:q.mediaType,ad_type:'all',search_type:'keyword_unordered'}).toString();
  return url.toString();
}
export interface MetaSourceEvidence {url:string;httpStatus:number|null;html:string;observedAt:string;parserVersion:string}
export interface MetaCollectionOptions { signal?: AbortSignal; browserChannel?: string; requestGuard?:()=>Promise<void>; onEvidence?:(snapshot:MetaSourceEvidence)=>Promise<void> }
export function configuredMetaBrowserChannel(env: Record<string,string|undefined> = process.env): 'chrome'|'chromium'|undefined {
  const channel=env.META_BROWSER_CHANNEL?.trim();
  if(!channel)return undefined;
  if(channel!=='chrome'&&channel!=='chromium')throw new Error('META_BROWSER_CHANNEL_INVALID');
  return channel;
}
/** One bounded attempt. Retry policy belongs to the leased job worker, never this adapter. */
export async function collectMetaAds(input: CollectionQuery, options: MetaCollectionOptions = {}): Promise<CollectionOutcome> {
  const query=validateCollectionQuery(input);
  const ads=new Map<string,ParsedAd>();
  let observedCardCount=0;
  let browser:Browser|undefined;
  let cancelled=Boolean(options.signal?.aborted);
  let sourceHttpRestriction:number|undefined;
  const collectedAt=new Date().toISOString();
  const outcome=(status:CollectionOutcome['status'],errorCode:string|null=null,retryable=false):CollectionOutcome=>({status,ads:[...ads.values()],errorCode,retryable,observedCardCount,parsedAdCount:ads.size,parserVersion:META_PARSER_VERSION,collectedAt});
  const failure=(errorCode:string,retryable=false,status:CollectionOutcome['status']='failed')=>outcome(ads.size?'partial':status,errorCode,retryable);
  if(options.browserChannel!==undefined&&!['chrome','chromium'].includes(options.browserChannel))return failure('META_BROWSER_CHANNEL_INVALID');
  const abort=()=>{cancelled=true;void browser?.close().catch(()=>{});};
  if(cancelled)return outcome('cancelled','COLLECTION_CANCELLED');
  options.signal?.addEventListener('abort',abort,{once:true});
  try {
    await options.requestGuard?.();
    browser=await chromium.launch({headless:true,chromiumSandbox:true,...(options.browserChannel?{channel:options.browserChannel}:{})});
    if(cancelled)return outcome('cancelled','COLLECTION_CANCELLED');
    const context=await browser.newContext({locale:'en-US',viewport:{width:1440,height:1000}});
    const page=await context.newPage();
    page.on('response',response=>{
      const status=response.status();
      if(status!==403 && status!==429)return;
      const kind=response.request().resourceType();
      if(!['document','xhr','fetch'].includes(kind))return;
      try {
        const host=new URL(response.url()).hostname;
        if(host==='facebook.com'||host.endsWith('.facebook.com'))sourceHttpRestriction=status;
      } catch { /* An unparseable response URL is not trusted source evidence. */ }
    });
    await options.requestGuard?.();
    const response=await page.goto(buildMetaSearchUrl(query),{waitUntil:'domcontentloaded',timeout:30_000});
    const httpStatus=response?.status();
    const captureEvidence=async()=>{
      if(!options.onEvidence)return;
      try {await options.onEvidence({url:page.url(),httpStatus:httpStatus??null,html:await page.content(),observedAt:new Date().toISOString(),parserVersion:META_PARSER_VERSION});}
      catch {throw new Error('EVIDENCE_STORAGE_FAILED');}
    };
    await captureEvidence();
    if(httpStatus===403||httpStatus===429)return failure(`META_HTTP_${httpStatus}`,false,'restricted');
    if(httpStatus && httpStatus>=400)return failure(`META_HTTP_${httpStatus}`,httpStatus>=500);
    await page.waitForFunction(()=>/Library ID|资料库编号|No ads match your search criteria|No results found|没有符合搜索条件的广告|Security Check|安全检查|captcha|checkpoint|Log in to Facebook|登录 Facebook|登录以继续|Log in to continue/i.test(document.body?.innerText??''),undefined,{timeout:20_000});
    let unchanged=0;
    for(let attempt=0;attempt<5;attempt++) {
      if(cancelled)return outcome('cancelled','COLLECTION_CANCELLED');
      if(sourceHttpRestriction)return failure(`META_HTTP_${sourceHttpRestriction}`,false,'restricted');
      await captureEvidence();
      const state=classifyMetaPage(await page.locator('body').innerText());
      if(state==='challenge'||state==='login-required')return failure(state==='challenge'?'META_SOURCE_CHALLENGE':'META_SOURCE_LOGIN_REQUIRED',false,'restricted');
      if(state==='no-results')return ads.size?failure('META_RESULTS_DISAPPEARED'):outcome('no-results');
      if(state!=='ready')return failure('META_SOURCE_CHANGED');
      const expression=`(function(){const __name=(fn)=>fn;return (${parseMetaDocument.toString()})(document,${JSON.stringify(query.country)});})()`;
      const parsed=await page.evaluate(expression) as MetaParseResult;
      if(cancelled)return outcome('cancelled','COLLECTION_CANCELLED');
      observedCardCount=Math.max(observedCardCount,parsed.observedCardCount);
      if(!parsed.ads.length)return failure('META_PARSE_EMPTY');
      const previousSize=ads.size;
      for(const ad of parsed.ads) {
        const existing=ads.get(ad.sourceAdId);
        if(existing) {
          existing.media.push(...ad.media.filter(item=>!existing.media.some(current=>current.url===item.url)));
          for(const key of ['advertiserName','advertiserPageUrl','advertiserAvatarUrl','body','headline','description','displayUrl','cta','landingPageUrl','sourceStatusText','startDate','endDate'] as const) if(existing[key]==null)existing[key]=ad[key]??null;
          if(existing.status==='unknown')existing.status=ad.status;
          if(ad.platforms)existing.platforms=[...new Set([...(existing.platforms??[]),...ad.platforms])];
        } else if(ads.size<query.limit)ads.set(ad.sourceAdId,ad);
      }
      if(parsed.rejectedCardCount)return failure('META_PARSE_PARTIAL');
      if(ads.size>=query.limit)return outcome('success');
      unchanged=ads.size===previousSize?unchanged+1:0;
      if(unchanged>=2)return outcome('success');
      if(attempt<4){await options.requestGuard?.();await page.evaluate(()=>window.scrollBy(0,1600));await page.waitForTimeout(1000);}
    }
    return outcome('success');
  } catch(error) {
    if(cancelled)return outcome('cancelled','COLLECTION_CANCELLED');
    const message=error instanceof Error?error.message:'';
    if(sourceHttpRestriction)return failure(`META_HTTP_${sourceHttpRestriction}`,false,'restricted');
    if(message==='EVIDENCE_STORAGE_FAILED')return failure('EVIDENCE_STORAGE_FAILED');
    if(/Executable doesn't exist|Executable does not exist|browser.*not found|Chromium distribution.*not found/i.test(message))return failure('META_BROWSER_NOT_INSTALLED');
    if(/Timeout/i.test(message))return failure('META_TIMEOUT',true);
    if(/net::|ECONN|ENOTFOUND|network/i.test(message))return failure('META_NETWORK_ERROR',true);
    return failure('META_BROWSER_ERROR');
  } finally {
    options.signal?.removeEventListener('abort',abort);
    await browser?.close().catch(()=>{});
  }
}
