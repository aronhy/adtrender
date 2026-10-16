import type {SourceRequestGuard} from '../dispatch/execution-guard';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { parseDetail, parseListing, sanitizeEvidence, classifyPage, readRetryAfter } from './parser';
import type { Batch, Evidence, TikTokAd } from './types';
import type { Job } from './queue';

export interface BrowserOptions {maxAds?:number;maxPages?:number;maxMs?:number;channel?:string;settleMs?:number;signal?:AbortSignal;handleSignals?:boolean;guard?:SourceRequestGuard}
const origin='https://library.tiktok.com';
const displayDate=(iso:string)=>`${Number(iso.slice(5,7))}/${Number(iso.slice(8,10))}/${iso.slice(0,4)}`;
export function searchUrl(job:Pick<Job,'country'|'start'|'end'>) {
  if (!/^[A-Z]{2}$/.test(job.country) || !/^\d{4}-\d{2}-\d{2}$/.test(job.start) || !/^\d{4}-\d{2}-\d{2}$/.test(job.end) || !(Date.parse(job.start)<Date.parse(job.end))) throw Error('TIKTOK_QUERY_INVALID');
  // Parameters observed from the library's own public Search control, not a private API.
  const u=new URL('/ads',origin);
  for(const [k,v] of Object.entries({region:job.country,start_time:String(Date.parse(job.start)),end_time:String(Date.parse(job.end)),adv_name:'',adv_biz_ids:'',query_type:'',sort_type:'create_time,desc',ad_type:'0',ad_status:'1',ages:'all',ad_reach:'all',gender:'ALL'}))u.searchParams.set(k,v);
  return u.href;
}
export async function launchContext(options:BrowserOptions={}) {
  const browser=await chromium.launch({channel:options.channel??'chromium',headless:true,chromiumSandbox:true,handleSIGTERM:options.handleSignals??true,handleSIGINT:options.handleSignals??true,
    env:Object.fromEntries(Object.entries(process.env).filter(([k,v])=>v!==undefined&&['PATH','HOME','LANG','TZ','PLAYWRIGHT_BROWSERS_PATH'].includes(k))) as Record<string,string>});
  try {const context=await browser.newContext({locale:'en-US',timezoneId:'UTC',viewport:{width:1440,height:1000}});context.on('close',()=>{void browser.close().catch(()=>{});});return context;}
  catch(e){await browser.close();throw e;}
}
export async function discoverCountries(options:BrowserOptions={},createContext:()=>Promise<BrowserContext>=()=>launchContext(options)) {
  await options.guard?.beforeRequest('BROWSER_START');const context=await createContext();
  try{
    const page=await context.newPage();await options.guard?.beforeRequest('CATALOG');const r=await page.goto(origin+'/ads',{waitUntil:'domcontentloaded',timeout:30000});
    if(r?.status()!==200)throw Object.assign(Error(r?.status()===429?'TIKTOK_RATE_LIMITED':r?.status()===403?'TIKTOK_ACCESS_BLOCKED':`TIKTOK_CATALOG_HTTP_${r?.status()??0}`),{retryAfterMs:readRetryAfter(r?.headers()['retry-after']??null)});
    await page.locator('body').waitFor();
    const state=classifyPage({status:200,text:await page.locator('body').innerText(),count:0,loading:false});
    if(['CHALLENGE','LOGIN_REQUIRED'].includes(state))throw Error('TIKTOK_'+state);
    await page.getByRole('button',{name:/Ad target country/}).click({timeout:20000});
    await page.locator('[id*="_list_"]').first().waitFor({timeout:10000});
    const countries=await page.locator('[id*="_list_"]').evaluateAll(es=>[...new Set(es.map(e=>e.id.match(/_list_([A-Z]{2})$/)?.[1]).filter((x):x is string=>Boolean(x)))]);
    if(!countries.length)throw Error('TIKTOK_CATALOG_EMPTY');return countries;
  }finally{await context.close();}
}
async function snapshot(page:Page,httpStatus:number|null,kind:Evidence['kind'],adId?:string,observedAt=new Date().toISOString()):Promise<Evidence>{
  const data=await page.evaluate(`(()=>{const __name=f=>f;return (${sanitizeEvidence.toString()})(document);})()`) as {text:string;html:string};
  return {url:page.url(),httpStatus,kind,...(adId?{adId}:{}),observedAt,...data};
}
async function listing(page:Page){return page.evaluate(`(()=>{const __name=f=>f;return (${parseListing.toString()})(document);})()`) as Promise<Array<{id:string;url:string}>>;}
function sourceError(e:unknown){const message=e instanceof Error?e.message:'';return /^TIKTOK_[A-Z_0-9]+$/.test(message)?message:e instanceof Error&&e.name==='TimeoutError'?'TIKTOK_TIMEOUT':'TIKTOK_BROWSER_ERROR';}
async function observeDetail(detail:Page,url:string,settleMs:number,guard?:SourceRequestGuard){
 await guard?.beforeRequest('DETAIL');
 const r=await detail.goto(url,{waitUntil:'domcontentloaded',timeout:25000});
 if(r?.status()!==200)throw Error(`TIKTOK_DETAIL_HTTP_${r?.status()??0}`);
 const initialState=classifyPage({status:200,text:await detail.locator('body').innerText(),count:0,loading:false});
 if(['CHALLENGE','LOGIN_REQUIRED','ACCESS_BLOCKED','RATE_LIMITED','HTTP_ERROR'].includes(initialState))throw Error('TIKTOK_'+initialState);
 await detail.waitForFunction(()=>document.body?.textContent?.includes('Advertiser')&&Boolean(document.querySelector('.ad_detail_summary_container .item_value')),{},{timeout:25000});
 await detail.waitForTimeout(settleMs);
 if(await detail.locator('video').count())await detail.waitForFunction(()=>[...document.querySelectorAll('video')].every(v=>Boolean(v.getAttribute('src')?.startsWith('https:')||v.querySelector('source')?.getAttribute('src')?.startsWith('https:'))),undefined,{timeout:10000}).catch(()=>{throw Error('TIKTOK_MEDIA_NOT_READY');});
 const state=classifyPage({status:200,text:await detail.locator('body').innerText(),count:1,loading:false});if(state!=='READY')throw Error('TIKTOK_'+state);
 const observedAt=new Date().toISOString();
 const ad=await detail.evaluate(`(()=>{const __name=f=>f;return (${parseDetail.toString()})(document,${JSON.stringify(url)},${JSON.stringify(observedAt)});})()`) as TikTokAd;
 return {ad,evidence:await snapshot(detail,200,'detail',ad.sourceAdId,observedAt)};
}

export async function collectBatch(job:Job,options:BrowserOptions={},createContext:()=>Promise<BrowserContext>=()=>launchContext(options)):Promise<Batch>{
 await options.guard?.beforeRequest('BROWSER_START');options={...options,signal:options.guard?.signal??options.signal};
  const maxAds=options.maxAds??20,maxPages=options.maxPages??30,maxMs=options.maxMs??240000,settleMs=options.settleMs??1000;
  if(!Number.isInteger(maxAds)||maxAds<1||maxAds>20||!Number.isInteger(maxPages)||maxPages<1||maxPages>200||!Number.isFinite(maxMs)||maxMs<1000||maxMs>900000)throw Error('TIKTOK_BUDGET_INVALID');
  const url=searchUrl(job),started=Date.now();
  const batch:Batch={version:'tiktok-public-dom-1',sourceKey:'tiktok_commercial_library',platform:'TIKTOK',observedAt:new Date().toISOString(),query:{country:job.country,startDate:job.start,endDate:job.end},status:'FAILED',errorCode:null,ads:[],evidence:[],completedIds:[],coverage:{completeSourceCoverage:false,exhausted:false,reason:'NOT_FINISHED',observedCards:0},nextPage:job.page,diagnostics:[]};
  let context:BrowserContext|undefined,page:Page|undefined,restricted:string|undefined,timedOut=false,closing=false,closePromise:Promise<void>|undefined;
  const closeContext=()=>{closing=true;if(!context)return Promise.resolve();return closePromise??=context.close().catch(()=>{});};
  const fail=async(code:string)=>{restricted??=code;await closeContext();};
  const onAbort=()=>{void fail('TIKTOK_ABORTED');};
  const timer=setTimeout(()=>{timedOut=true;void closeContext();},maxMs+5000);timer.unref();
  options.signal?.addEventListener('abort',onAbort,{once:true});
  try{
    if(options.signal?.aborted)throw Error('TIKTOK_ABORTED');
    context=await createContext();if(restricted||timedOut)throw Error(restricted??'TIKTOK_TIME_BUDGET');page=await context.newPage();page.setDefaultTimeout(15000);
    context.on('response',r=>{
      const u=new URL(r.url());if(u.origin!==origin)return;
      if(r.status()>=400&&batch.diagnostics.length<30)batch.diagnostics.push({status:r.status(),path:u.pathname});
      if(['document','xhr','fetch'].includes(r.request().resourceType())&&!u.pathname.startsWith('/api/v1/cdn/')&&r.status()>=400){
        const delay=readRetryAfter(r.headers()['retry-after']??null);if(delay!==undefined)batch.retryAfterMs=Math.max(batch.retryAfterMs??0,delay);
        void fail(r.status()===429?'TIKTOK_RATE_LIMITED':r.status()===403?'TIKTOK_ACCESS_BLOCKED':`TIKTOK_SOURCE_HTTP_${r.status()}`);
      }
    });
    context.on('requestfailed',r=>{const u=new URL(r.url());if(!restricted&&!timedOut&&!closing&&r.failure()?.errorText!=='net::ERR_ABORTED'&&u.origin===origin&&['document','xhr','fetch'].includes(r.resourceType())&&!u.pathname.startsWith('/api/v1/cdn/'))void fail('TIKTOK_SOURCE_NETWORK_ERROR');});
    if(job.kind==='MEDIA_REFRESH'){
      const ids=job.sourceAdIds;if(!Array.isArray(ids)||!ids.length||ids.length>2||new Set(ids).size!==ids.length||ids.some(id=>!/^\d{5,40}$/.test(id)))throw Error('TIKTOK_MEDIA_REFRESH_TARGET_INVALID');
      for(const id of ids){if(restricted)throw Error(restricted);const observed=await observeDetail(page,origin+'/ads/detail/?ad_id='+id,settleMs,options.guard);batch.ads.push(observed.ad);batch.evidence.push(observed.evidence);batch.completedIds.push(id);}
      batch.status='SUCCEEDED';batch.coverage.reason='MEDIA_REFRESH_DETAIL';batch.coverage.observedCards=ids.length;return batch;
    }
    await options.guard?.beforeRequest('LIST');const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
    if(response?.status()!==200)throw Error(`TIKTOK_HTTP_${response?.status()??0}`);
    const dates=page.getByRole('button',{name:'Last shown date',exact:true});await dates.waitFor();
    const dateText=(await dates.textContent())?.replace(/\s/g,'')??'';
    if(!dateText.includes(displayDate(job.start))||!dateText.includes(displayDate(job.end)))throw Error('TIKTOK_DATE_FILTER_MISMATCH');
    const countryText=await page.getByRole('button',{name:/Ad target country/}).innerText();
    const expectedName=new Intl.DisplayNames(['en'],{type:'region'}).of(job.country)!;
    const alternatives=job.country==='TR'?['Turkey','Türkiye']:job.country==='CZ'?['Czechia','Czech Republic']:job.country==='SK'?['Slovak','Slovakia']:[expectedName];
    if(!alternatives.some(n=>countryText.includes(n)))throw Error('TIKTOK_COUNTRY_FILTER_MISMATCH');
    const keyword=page.getByPlaceholder('Search by name or keyword');if(await keyword.inputValue()!=='')throw Error('TIKTOK_KEYWORD_FILTER_MISMATCH');
    const state=async()=>{
      if(restricted)throw Error(restricted);
      const cards=await listing(page!);const text=await page!.locator('body').innerText();
      const result=classifyPage({status:200,text,count:cards.length,loading:false});
      if(!['READY','EMPTY','LOADING'].includes(result))throw Error('TIKTOK_'+result);
      return {cards,text,result};
    };
    const waitReady=async(previous?:string)=>{
      const until=Math.min(started+maxMs,Date.now()+30000);
      while(Date.now()<until){const s=await state();if(s.result==='EMPTY'||(s.result==='READY'&&(!previous||s.cards.map(c=>c.id).join('|')!==previous))){await page!.waitForTimeout(settleMs);const stable=await state();if(stable.result===s.result)return stable;}await page!.waitForTimeout(250);}
      throw Error('TIKTOK_RESULTS_TIMEOUT');
    };
    // Re-submit the restored visible filters. Direct navigation can retain a transient empty result.
    await options.guard?.beforeRequest('LIST');await page.getByRole('button',{name:'Search',exact:true}).click();await page.waitForTimeout(settleMs);
    let current=await waitReady();
    if(current.result==='EMPTY'){
      batch.evidence.push(await snapshot(page,200,'listing'));
      await options.guard?.beforeRequest('LIST');await page.getByRole('button',{name:'Search',exact:true}).click();await page.waitForTimeout(Math.max(settleMs,2000));current=await waitReady();
      if(current.result==='EMPTY'){
        batch.evidence.push(await snapshot(page,200,'listing'));batch.status='NO_RESULTS';batch.coverage.reason='REPEATED_EMPTY_NOT_EXHAUSTIVE';return batch;
      }
    }
    const seen=new Set(job.seen),detail=await context.newPage();detail.setDefaultTimeout(15000);
    // The public UI has no durable cursor: replay, dedupe, then extend the frontier.
    for(let pageIndex=0;pageIndex<Math.min(2000,job.page+maxPages);pageIndex++){
      if(Date.now()-started>=maxMs)throw Error(batch.ads.length?'TIKTOK_TIME_BUDGET':'TIKTOK_REPLAY_BUDGET');
      if(restricted)throw Error(restricted);
      batch.nextPage=Math.max(job.page,pageIndex);batch.coverage.observedCards=Math.max(batch.coverage.observedCards,current.cards.length);
      if(JSON.stringify(batch).length>18000000)throw Error('TIKTOK_EVIDENCE_BUDGET');
      const fresh=current.cards.filter(c=>!seen.has(c.id));
      if(fresh.length||pageIndex===0)batch.evidence.push(await snapshot(page,200,'listing'));
      for(const card of fresh){
        if(batch.ads.length>=maxAds||Date.now()-started>=maxMs){batch.status='SUCCEEDED';batch.coverage.reason='BATCH_BUDGET';return batch;}
        const {ad,evidence:ev}=await observeDetail(detail,card.url,settleMs,options.guard);
        batch.ads.push(ad);batch.evidence.push(ev);batch.completedIds.push(ad.sourceAdId);seen.add(ad.sourceAdId);
        await detail.waitForTimeout(350);
      }
      if(batch.ads.length>=maxAds||Date.now()-started>=maxMs){batch.status='SUCCEEDED';batch.coverage.reason='BATCH_BUDGET';return batch;}
      const more=page.locator('.loading_more_text').filter({hasText:/^View more$/});
      if(!await more.count()||!await more.isVisible())throw Error('TIKTOK_END_UNCONFIRMED');
      const old=current.cards.map(c=>c.id).join('|');await options.guard?.beforeRequest('NEXT_PAGE');await more.click();current=await waitReady(old);
      if(current.result==='EMPTY')throw Error('TIKTOK_PAGINATION_INVALID');
    }
    batch.status=batch.ads.length?'SUCCEEDED':'PARTIAL';batch.coverage.reason='PAGE_BUDGET';
    if(!batch.ads.length)batch.errorCode='TIKTOK_REPLAY_BUDGET';
  }catch(e){batch.errorCode=restricted??(timedOut?'TIKTOK_TIME_BUDGET':sourceError(e));batch.status=batch.ads.length?'PARTIAL':'FAILED';batch.coverage.reason=batch.errorCode;batch.coverage.exhausted=false;
    // An aborted navigation can leave evaluate waiting for an execution context
    // that is already being destroyed. Preserve diagnostics without a DOM read.
    if(page&&!closing&&!page.isClosed())try{batch.evidence.push(await snapshot(page,null,'listing'));}catch{}
  }
  finally{clearTimeout(timer);options.signal?.removeEventListener('abort',onAbort);await closeContext();}
  return batch;
}
