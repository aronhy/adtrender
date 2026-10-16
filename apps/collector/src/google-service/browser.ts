import type {SourceRequestGuard} from '../dispatch/execution-guard';
import {chromium,type BrowserContext,type Page,type Frame} from 'playwright';
import {buildUrl,type Job,type Advertiser} from './queue';
import {runtimeSource,accessError,parseCreativeUrl,youtubeReference,type GoogleAd,type FrameData} from './parser';
export interface Evidence {kind:string;url:string;text:string;html:string;adId?:string;variant?:number;platformVerified?:boolean;publicData?:Record<string,string>[]}
export interface Batch {version:'google-service-dom-1';sourceKey:'google_ads_transparency';observedAt:string;query:{kind:Job['kind'];country:string;language:string;term:string;advertiserId?:string;domain?:string};status:'SUCCEEDED'|'PARTIAL'|'FAILED'|'NO_RESULTS';errorCode:string|null;ads:GoogleAd[];advertisers:Advertiser[];domains:string[];searchObservations:unknown[];evidence:Evidence[];completedIds:string[];cursor?:{page:number;row:number};coverage:{completeSourceCoverage:false;exhausted:boolean;reason:string;variantsComplete:boolean}}
const evalDoc=async<T>(page:Page|Frame,expr:string):Promise<T>=>page.evaluate(`(()=>{${runtimeSource()};return ${expr};})()`);
export async function openBrowser(profile:string){return chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,chromiumSandbox:true,locale:'en-US',timezoneId:'UTC',viewport:{width:1440,height:1000},env:Object.fromEntries(Object.entries(process.env).filter(([k,v])=>v!==undefined&&['PATH','HOME','LANG','TZ','PLAYWRIGHT_BROWSERS_PATH'].includes(k))) as Record<string,string>});}
export async function collectBatch(job:Job,profile:string,options:{maxAds?:number;maxAdvertisers?:number;maxVariants?:number;maxMs?:number;maxScrolls?:number;guard?:SourceRequestGuard;signal?:AbortSignal}={}):Promise<Batch>{
 await options.guard?.beforeRequest('BROWSER_START');
 const batch:Batch={version:'google-service-dom-1',sourceKey:'google_ads_transparency',observedAt:new Date().toISOString(),query:{kind:job.kind,country:job.country,language:job.language,term:job.term,...(job.advertiserId?{advertiserId:job.advertiserId}:{}),...(job.domain?{domain:job.domain}:{})},status:'FAILED',errorCode:null,ads:[],advertisers:[],domains:[],searchObservations:[],evidence:[],completedIds:[],coverage:{completeSourceCoverage:false,exhausted:false,reason:'NOT_FINISHED',variantsComplete:false}};
 let context:BrowserContext|undefined,page:Page|undefined,sourceError:string|null=null;const start=Date.now(),budget=options.maxMs??180000;
 const controlSignal=options.guard?.signal??options.signal;const controlAbort=()=>{void context?.close().catch(()=>{});};controlSignal?.addEventListener('abort',controlAbort,{once:true});
 const watchdog=setTimeout(()=>{sourceError='GOOGLE_TIME_BUDGET';void context?.close().catch(()=>{});},budget+30000);watchdog.unref();
 const check=async(p:Page)=>{if(sourceError)throw Error(sourceError);const err=accessError(null,await p.locator('body').innerText());if(err)throw Error(err);};
 const snap=async(p:Page,kind:string,selector?:string,adId?:string,variant?:number,platformVerified?:boolean)=>{const d=await evalDoc<{html:string;text:string}>(p,`sanitizeDocument(document,${JSON.stringify(selector)??'undefined'})`);batch.evidence.push({kind,url:p.url(),...d,adId,variant,platformVerified});};
 const go=async(p:Page,url:string)=>{await options.guard?.beforeRequest(p===page?'LIST':'DETAIL');const r=await p.goto(url,{waitUntil:'domcontentloaded',timeout:45000});const err=accessError(r?.status()??null,'');if(err)throw Error(err);await p.waitForTimeout(2000);await check(p);};
 const discoverPage=async(p:Page,index:number)=>{await go(p,buildUrl(job));await p.locator('suggestion-renderer .result-container').first().waitFor({timeout:20000});for(let i=0;i<index;i++){const next=p.getByRole('button',{name:'Next Page',exact:true});if(await next.getAttribute('aria-disabled')==='true')throw Error('GOOGLE_DISCOVERY_PAGE_CHANGED');const sig=await p.locator('suggestion-renderer').allTextContents();await options.guard?.beforeRequest('NEXT_PAGE');await next.click();await p.waitForFunction(old=>JSON.stringify([...document.querySelectorAll('suggestion-renderer')].map(e=>e.textContent))!==old,JSON.stringify(sig),{timeout:20000});await p.waitForTimeout(1000);await check(p);}};
 try{
  context=await openBrowser(profile);context.setDefaultTimeout(12000);page=await context.newPage();
  context.on('response',r=>{const u=new URL(r.url());const relevant=job.kind==='SERP'?(u.hostname==='www.google.com'&&u.pathname.startsWith('/sorry')):(u.hostname==='adstransparency.google.com'&&/Search|Get|rpc/i.test(u.pathname));if(relevant&&[403,429].includes(r.status())){sourceError=`GOOGLE_HTTP_${r.status()}`;void context?.close().catch(()=>{});}});
  if(job.kind==='DISCOVER'){
   batch.cursor={...(job.cursor??{page:0,row:0})};
   for(let n=0;n<(options.maxAdvertisers??4)&&Date.now()-start<budget;n++){
    await discoverPage(page,batch.cursor.page);await snap(page,'discovery');const rows=page.locator('suggestion-renderer .result-container');const count=await rows.count();
    if(batch.cursor.row>=count){const next=page.getByRole('button',{name:'Next Page',exact:true});if(await next.getAttribute('aria-disabled')==='true'){batch.coverage.exhausted=true;batch.coverage.reason='EXPLICIT_LAST_DISCOVERY_PAGE';break;}batch.cursor.page++;batch.cursor.row=0;await discoverPage(page,batch.cursor.page);await snap(page,'discovery');}
    const row=page.locator('suggestion-renderer .result-container').nth(batch.cursor.row);const name=(await row.locator('.name').innerText()).trim();await options.guard?.beforeRequest('DETAIL');await row.click();await page.waitForURL(/\/advertiser\/AR\d+/, {timeout:20000});await page.waitForTimeout(1500);await check(page);
    const advertiserId=new URL(page.url()).pathname.match(/^\/advertiser\/(AR\d+)$/)?.[1];if(!advertiserId)throw Error('GOOGLE_ADVERTISER_ID_MISSING');await snap(page,'advertiser');batch.advertisers.push({advertiserId,name,sourceUrl:`https://adstransparency.google.com/advertiser/${advertiserId}`});batch.completedIds.push(advertiserId);batch.cursor.row++;
   }
   batch.status='SUCCEEDED';if(!batch.coverage.exhausted)batch.coverage.reason='DISCOVERY_BATCH_BUDGET';
  }else if(job.kind==='SERP'){
   await go(page,buildUrl(job));await check(page);await snap(page,'search');const observations=await evalDoc<Array<{text:string;landingPageUrl:string;domain:string}>>(page,'parseSerp(document)');batch.searchObservations=observations;batch.domains=[...new Set(observations.map(x=>x.domain))];batch.status='SUCCEEDED';batch.coverage.reason=observations.length?'OBSERVED_SPONSORED_RESULTS':'NO_SPONSORED_RESULTS_OBSERVED';
  }else{
   await go(page,buildUrl(job));await page.waitForFunction(()=>document.querySelector('a[href*="/creative/"]')||/No ads found|No ads match|No results/.test(document.body.innerText),undefined,{timeout:30000});await check(page);
   // Video is a format within YouTube, independently verified by the visible filter.
   if(job.kind==='YOUTUBE'){
    const f=page.getByRole('button',{name:'Ad format filter button: selected All formats',exact:true});if(await f.count()){await options.guard?.beforeRequest('FILTER');await f.click();await page.getByText('Video',{exact:true}).click();await page.waitForTimeout(3000);}
    if(!await page.getByRole('button',{name:'Ad format filter button: selected Video',exact:true}).count())throw Error('GOOGLE_VIDEO_FILTER_UNVERIFIED');
   }
   const detail=await context.newPage();const seen=new Set(job.seen);let stalls=0;
   for(let step=0;step<(options.maxScrolls??25)&&Date.now()-start<budget;step++){
    await check(page);const listing=await evalDoc<{platformVerified:boolean;creatives:Array<{sourceAdId:string;advertiserId:string;sourceUrl:string;url:string;name:string|null}>}>(page,`parseListing(document,location.href,${JSON.stringify(job.kind)})`);
    if(!listing.platformVerified)throw Error('GOOGLE_PLATFORM_UNVERIFIED');await snap(page,'listing',undefined,undefined,undefined,true);
    if(/No ads found|No ads match|No results found/.test(await page.locator('body').innerText())){batch.coverage.exhausted=true;batch.coverage.reason='EXPLICIT_NO_RESULTS';batch.status=batch.ads.length?'SUCCEEDED':'NO_RESULTS';break;}
    const fresh=listing.creatives.filter(a=>!seen.has(a.sourceAdId));
    for(const card of fresh.slice(0,(options.maxAds??4)-batch.ads.length)){
     await go(detail,card.url);await detail.locator('creative-details').waitFor({timeout:20000});await detail.waitForTimeout(1500);await check(detail);const variants:GoogleAd[]=[];
     for(let v=0;v<(options.maxVariants??10)&&Date.now()-start<budget;v++){
      const frames:FrameData[]=[];
      const visit=async(f:Frame)=>{const u=f.url();if(/youtube(?:-nocookie)?\.com\//.test(u)){const ref=youtubeReference(u);if(ref)frames.push({text:'',links:[],media:[],videoReferences:[ref]});return;}if(!/^https:\/\/tpc\.googlesyndication\.com\//.test(u)&&u!=='about:blank')return;
       const data=await evalDoc<FrameData>(f,'frameData(document.body)');frames.push(data);const clean=await evalDoc<{html:string;text:string}>(f,'sanitizeDocument(document)');batch.evidence.push({kind:'creative-frame',url:u==='about:blank'?u:new URL(u).origin+new URL(u).pathname,...clean,publicData:data.publicData,adId:card.sourceAdId,variant:v+1});for(const child of f.childFrames())await visit(child);};
      for(const el of await detail.locator('creative-details creative:visible iframe').elementHandles()){const frame=await el.contentFrame();if(frame)await visit(frame);}
      const ad=await evalDoc<GoogleAd>(detail,`parseDetail(document,location.href,${JSON.stringify(job.kind)},${JSON.stringify(job.country)},${JSON.stringify(frames)})`);ad.advertiserName??=card.name;variants.push(ad);await snap(detail,'detail','creative-details',ad.sourceAdId,ad.variant.index);
      if(ad.variant.total===null||ad.variant.index>=ad.variant.total)break;
      const next=detail.getByRole('button',{name:'Next variation',exact:true});if(!await next.count()||await next.getAttribute('aria-disabled')==='true')break;await options.guard?.beforeRequest('NEXT_PAGE');await next.click();await detail.waitForTimeout(1800);await check(detail);
      if(JSON.stringify(batch).length>18000000)break;
     }
     const ad=variants[0];if(!ad)throw Error('GOOGLE_DETAIL_EMPTY');ad.variants=variants.map(v=>({index:v.variant.index,body:v.body,landingPageUrl:v.landingPageUrl,media:v.media,videoReferences:v.videoReferences}));ad.variantsComplete=ad.variant.total!==null&&new Set(variants.map(v=>v.variant.index)).size===ad.variant.total;
     ad.media=[...new Map(variants.flatMap(v=>v.media).map(m=>[m.url,m])).values()];ad.videoReferences=[...new Set(variants.flatMap(v=>v.videoReferences))];batch.ads.push(ad);seen.add(ad.sourceAdId);batch.completedIds.push(ad.sourceAdId);
     if(batch.ads.length>=(options.maxAds??4)||Date.now()-start>=budget)break;
    }
    if(batch.ads.length>=(options.maxAds??4)||Date.now()-start>=budget||JSON.stringify(batch).length>18000000){batch.coverage.reason='BATCH_BUDGET';batch.status='SUCCEEDED';break;}
    await options.guard?.beforeRequest('NEXT_PAGE');const signature=listing.creatives.map(x=>x.sourceAdId).join('|');await page.evaluate(()=>{const el=document.scrollingElement??document.documentElement;el.scrollTop=el.scrollHeight;});await page.waitForTimeout(3000);const after=await evalDoc<typeof listing>(page,`parseListing(document,location.href,${JSON.stringify(job.kind)})`);stalls=after.creatives.map(x=>x.sourceAdId).join('|')===signature?stalls+1:0;if(stalls>=3)throw Error('GOOGLE_LIST_STALLED');
   }
   if(batch.status==='FAILED')throw Error('GOOGLE_LIST_BUDGET');batch.coverage.variantsComplete=batch.ads.length>0&&batch.ads.every(a=>a.variantsComplete);
  }
 }catch(e){const message=e instanceof Error?e.message:'';batch.errorCode=sourceError??(/^GOOGLE_[A-Z_0-9]+$/.test(message)?message:/profile appears to be in use|user data directory is already in use/i.test(message)?'GOOGLE_PROFILE_LOCKED':e instanceof Error&&e.name==='TimeoutError'?'GOOGLE_TIMEOUT':'GOOGLE_BROWSER_ERROR');batch.status=batch.ads.length||batch.advertisers.length?'PARTIAL':'FAILED';batch.coverage.reason=batch.errorCode;batch.coverage.exhausted=false;if(page)try{await snap(page,'error');}catch{}}
 finally{controlSignal?.removeEventListener('abort',controlAbort);clearTimeout(watchdog);await context?.close().catch(()=>{});}
 return batch;
}
