import type {BrowserContext,Frame,Page} from 'playwright';
import {runtimeSource,accessError,parseCreativeUrl,youtubeReference,type GoogleAd,type FrameData} from '../google-service/parser';
import {safeError,type Target,type Result} from './types';
/** Verify the exact ID on this advertiser's current, filtered public listing first. */
export async function collectGoogle(t:Target,query:Record<string,unknown>,options:{createContext:()=>Promise<BrowserContext>;signal?:AbortSignal;maxMs?:number;settleMs?:number}):Promise<Result>{
 const identity=parseCreativeUrl(t.sourceUrl);const kind=['SEARCH','YOUTUBE'].includes(String(t.discoveryQuery.kind))?String(t.discoveryQuery.kind):t.publisherPlatforms.find(p=>['SEARCH','YOUTUBE'].includes(p));
 if(!identity||!kind)return {outcome:'UNSUPPORTED',errorCode:'GOOGLE_PLATFORM_SCOPE_MISSING'};
 const listingUrl=`https://adstransparency.google.com/advertiser/${identity.advertiserId}?region=${t.country}&hl=en&platform=${kind}`;
 const evidence:any[]=[];let context:BrowserContext|undefined,code:string|null=null,retryAfterMs:number|undefined;
 const close=()=>context?.close().catch(()=>{});const timer=setTimeout(()=>{code='GOOGLE_TIME_BUDGET';void close();},options.maxMs??90000);timer.unref();const abort=()=>{code='HISTORY_ABORTED';void close();};options.signal?.addEventListener('abort',abort,{once:true});
 const evaluate=<T>(p:Page|Frame,expression:string)=>p.evaluate(`(()=>{${runtimeSource()};return ${expression};})()`) as Promise<T>;
 try{
  context=await options.createContext();if(code)throw Error(code);context.setDefaultTimeout(15000);
  context.on('response',r=>{const u=new URL(r.url());if(u.origin==='https://adstransparency.google.com'&&['document','xhr','fetch'].includes(r.request().resourceType())&&[403,429].includes(r.status())){code='GOOGLE_HTTP_'+r.status();const retry=r.headers()['retry-after'];if(retry){const ms=/^\d+$/.test(retry)?Number(retry)*1000:Date.parse(retry)-Date.now();if(Number.isFinite(ms)&&ms>0)retryAfterMs=Math.min(ms,604800000);}void close();}});
  const page=await context.newPage();
  await page.route('**/*',async route=>{const r=route.request();if(r.isNavigationRequest()&&r.frame()===page.mainFrame()&&new URL(r.url()).origin!=='https://adstransparency.google.com'){code='GOOGLE_REDIRECT_REJECTED';await route.abort();}else await route.fallback();});
  const check=async()=>{if(code)throw Error(code);const error=accessError(null,await page.locator('body').innerText());if(error)throw Error(error);};
  const go=async(url:string)=>{const r=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});const error=accessError(r?.status()??null,'');if(error)throw Error(error);if(r&&r.status()>=400)throw Error('GOOGLE_HTTP_'+r.status());await page.waitForTimeout(options.settleMs??1500);await check();};
  await go(listingUrl);await page.waitForFunction(()=>document.querySelector('a[href*="/creative/"]')||/No ads found|No ads match|No results/.test(document.body.innerText),undefined,{timeout:25000});
  let found=false;
  // Finite visible-list scroll budget. Missing from this window means not observed.
  for(let step=0;step<6;step++){
   await check();const clean=await evaluate<{text:string;html:string}>(page,'__googleParser.sanitizeDocument(document)');
   const listing=await evaluate<{platformVerified:boolean;creatives:Array<{sourceAdId:string;sourceUrl:string}>}>(page,`(()=>{const saved=new DOMParser().parseFromString(${JSON.stringify(clean.html)},"text/html");saved.querySelectorAll('a[href*="/creative/"]').forEach(a=>{if(!a.closest('creative-preview'))a.remove();});return __googleParser.parseListing(saved,location.href,${JSON.stringify(kind)});})()`);
   if(!listing.platformVerified)throw Error('GOOGLE_PLATFORM_UNVERIFIED');
   evidence.push({kind:'listing',url:page.url(),...clean,platformVerified:true});
   if(listing.creatives.some(c=>c.sourceAdId===t.sourceAdId&&c.sourceUrl===t.sourceUrl)){found=true;break;}
   if(/No ads found|No ads match|No results/.test(clean.text))break;
   await page.evaluate(()=>{const root=document.scrollingElement??document.documentElement;root.scrollTop=root.scrollHeight;});await page.waitForTimeout(options.settleMs??1500);
  }
  if(!found)return {outcome:'NOT_OBSERVED',errorCode:'GOOGLE_TARGET_NOT_IN_BOUNDED_LISTING',evidence};
  await go(t.sourceUrl);await page.locator('creative-details').waitFor({timeout:25000});if(parseCreativeUrl(page.url())?.sourceAdId!==t.sourceAdId)throw Error('GOOGLE_DETAIL_MISMATCH');
  const variants:GoogleAd[]=[];
  for(let index=0;index<10;index++){
   await check();const frames:FrameData[]=[];
   const visit=async(f:Frame):Promise<void>=>{const url=f.url();const yt=youtubeReference(url);if(yt){frames.push({text:'',links:[],media:[],videoReferences:[yt]});return;}if(!url.startsWith('https://tpc.googlesyndication.com/')&&url!=='about:blank')return;const data=await evaluate<FrameData>(f,'__googleParser.frameData(document.body)');frames.push(data);const clean=await evaluate<{text:string;html:string}>(f,'__googleParser.sanitizeDocument(document)');evidence.push({kind:'creative-frame',url:url==='about:blank'?url:new URL(url).origin+new URL(url).pathname,...clean,publicData:data.publicData,adId:t.sourceAdId,variant:index+1});for(const child of f.childFrames())await visit(child);};
   for(const el of await page.locator('creative-details creative:visible iframe').elementHandles()){const frame=await el.contentFrame();if(frame)await visit(frame);}
   const ad=await evaluate<GoogleAd>(page,`__googleParser.parseDetail(document,location.href,${JSON.stringify(kind)},${JSON.stringify(t.country)},${JSON.stringify(frames)})`);if(ad.sourceAdId!==t.sourceAdId)throw Error('GOOGLE_DETAIL_MISMATCH');variants.push(ad);
   evidence.push({kind:'detail',url:t.sourceUrl,...await evaluate(page,'__googleParser.sanitizeDocument(document,"creative-details")') as object,adId:t.sourceAdId,variant:ad.variant.index});
   if(ad.variant.total===null||ad.variant.index>=ad.variant.total)break;const next=page.getByRole('button',{name:'Next variation',exact:true});if(!await next.count()||await next.getAttribute('aria-disabled')==='true')break;await next.click();await page.waitForTimeout(options.settleMs??1800);if(JSON.stringify(evidence).length>8000000)throw Error('GOOGLE_EVIDENCE_BUDGET');
  }
  const ad=variants[0];ad.variants=variants.map(v=>({index:v.variant.index,body:v.body,landingPageUrl:v.landingPageUrl,media:v.media,videoReferences:v.videoReferences}));ad.variantsComplete=ad.variant.total!==null&&new Set(variants.map(v=>v.variant.index)).size===ad.variant.total;
  ad.media=[...new Map(variants.flatMap(v=>v.media).map(m=>[m.url,m])).values()];ad.videoReferences=[...new Set(variants.flatMap(v=>v.videoReferences))];
  return {outcome:'OBSERVED',errorCode:null,batch:{version:'google-service-dom-1',sourceKey:t.sourceKey,observedAt:new Date().toISOString(),query:{kind,language:'en',term:'',advertiserId:identity.advertiserId,...query},status:'SUCCEEDED',errorCode:null,ads:[ad],advertisers:[],domains:[],searchObservations:[],evidence,completedIds:[t.sourceAdId],coverage:{completeSourceCoverage:false,exhausted:false,reason:'HISTORY_MATCHED_LISTING_AND_DETAIL',variantsComplete:ad.variantsComplete}}};
 }catch(e){return {outcome:'FAILED',errorCode:code??safeError(e),retryAfterMs,evidence};}
 finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);await close();}
}
