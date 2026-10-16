import type {SourceRequestGuard} from '../dispatch/execution-guard';
import {chromium,type Browser,type Page} from 'playwright';
import {pinterestParserRuntimeSource,type PinterestCard} from './parser';
import {classifyPinterestPage} from './state';
import type {PinterestBatch} from './adapter';
import type {Shard} from './sweep';
export interface SweepResult {batch:PinterestBatch;nextPage:number;exhausted:boolean;catalog:{countries:Array<{code:string;name:string}>;categories:string[]};pageIds:string[]}
const dateDisplay=(iso:string)=>`${iso.slice(5,7)}/${iso.slice(8,10)}/${iso.slice(0,4)}`;
async function snapshot(page:Page,status:number|null){const x=await page.evaluate(()=>{const root=document.body.cloneNode(true) as HTMLElement;root.querySelectorAll('script,style,noscript,iframe').forEach(e=>e.remove());root.querySelectorAll('*').forEach(e=>{for(const a of Array.from(e.attributes))if(!['href','src','alt','title','data-test-id','id','role','value','aria-label','aria-disabled'].includes(a.name))e.removeAttribute(a.name);});return {text:document.body.innerText,html:root.outerHTML};});return {url:page.url(),httpStatus:status,...x};}
async function waitResults(page:Page,previous?:string){
 await page.waitForFunction((old)=>{const links=Array.from(document.querySelectorAll('a[href^="/ads-repository/"][target="_blank"]'));const ids=links.map(a=>a.getAttribute('href')).join('|');return (links.length>0&&(!old||old!==ids)&&links.some(a=>(a.parentElement?.querySelectorAll('[title]').length??0)>=2))||/no ads found|no results found|no ads match|verify you are human|access denied/i.test(document.body.innerText);},previous,{timeout:30000});
 // Cards fetch their creative content separately. A finite hydration wait preserves
 // incomplete cards as raw evidence instead of silently dropping their identities.
 const until=Date.now()+10000;
 while(Date.now()<until){const ready=await page.evaluate(()=>Array.from(document.querySelectorAll('a[href^="/ads-repository/"][target="_blank"]')).every(a=>(a.parentElement?.querySelectorAll('[title]').length??0)>=2));if(ready)break;await page.waitForTimeout(500);}
}
async function launch(){return chromium.launch({channel:'chromium',headless:true,chromiumSandbox:true,env:Object.fromEntries(Object.entries(process.env).filter(([k,v])=>v!==undefined&&['PATH','HOME','LANG','TZ','PLAYWRIGHT_BROWSERS_PATH'].includes(k))) as Record<string,string>});}
export async function discoverPinterest(options:{guard?:SourceRequestGuard}={}){await options.guard?.beforeRequest('BROWSER_START');const browser=await launch();try{const page=await browser.newPage({locale:'en-US',timezoneId:'UTC'});await options.guard?.beforeRequest('CATALOG');await page.goto('https://ads.pinterest.com/ads-repository/',{waitUntil:'domcontentloaded',timeout:30000});await page.locator('#country option').first().waitFor({state:'attached'});return {countries:await page.locator('#country option').evaluateAll(es=>es.map(e=>({code:(e as HTMLOptionElement).value,name:e.textContent?.trim()??''}))),categories:await page.locator('#adVertical option').evaluateAll(es=>es.map(e=>(e as HTMLOptionElement).value))};}finally{await browser.close();}}
export async function collectSweepPage(shard:Shard,options:{guard?:SourceRequestGuard;signal?:AbortSignal}={}):Promise<SweepResult>{
 await options.guard?.beforeRequest('BROWSER_START');
 const batch:PinterestBatch={version:'pinterest-public-dom-1',sourceKey:'pinterest_ads_repository',platform:'PINTEREST',observedAt:new Date().toISOString(),query:{keyword:'',country:shard.country,limit:20,dateStart:shard.start,dateEnd:shard.end,category:'ALL',page:shard.page},status:'FAILED',errorCode:null,ads:[],evidence:[],diagnostics:[],coverage:{complete:false,observedCards:0,selected:0}};
 const result:SweepResult={batch,nextPage:shard.page,exhausted:false,catalog:{countries:[],categories:[]},pageIds:[]};let browser:Browser|undefined;
 const controlSignal=options.guard?.signal??options.signal;const controlAbort=()=>{void browser?.close().catch(()=>{});};controlSignal?.addEventListener('abort',controlAbort,{once:true});
 const watchdog=setTimeout(()=>{void browser?.close().catch(()=>{});},12*60*1000);watchdog.unref();
 try{
  browser=await launch();const context=await browser.newContext({locale:'en-US',timezoneId:'UTC',viewport:{width:1440,height:1000}});const page=await context.newPage();page.setDefaultTimeout(20000);
  let sourceStatus:number|null=null;
  page.on('response',r=>{if(r.status()>=400&&batch.diagnostics.length<50){const u=new URL(r.url());batch.diagnostics.push({kind:'http',code:String(r.status()),resource:u.origin+u.pathname});}});
  await options.guard?.beforeRequest('LIST');const r=await page.goto('https://ads.pinterest.com/ads-repository/',{waitUntil:'domcontentloaded',timeout:30000});sourceStatus=r?.status()??null;
  if(sourceStatus!==200)throw Error(sourceStatus===403?'ACCESS_BLOCKED':sourceStatus===429?'RATE_LIMITED':'HTTP_ERROR');
  await page.locator('#country').waitFor();
  result.catalog={countries:await page.locator('#country option').evaluateAll(es=>es.map(e=>({code:(e as HTMLOptionElement).value,name:e.textContent?.trim()??''}))),categories:await page.locator('#adVertical option').evaluateAll(es=>es.map(e=>(e as HTMLOptionElement).value))};
  if(!result.catalog.countries.some(c=>c.code===shard.country))throw Error('COUNTRY_UNSUPPORTED');
  // Dates are rendered after the application finishes initializing. On fresh
  // sessions an initial public search exposes them.
  if(!await page.locator('#startDate').count()){await options.guard?.beforeRequest('LIST');await page.getByRole('button',{name:'Search',exact:true}).click();await page.locator('#startDate').waitFor();await waitResults(page).catch(()=>{});}
  await options.guard?.beforeRequest('FILTER');await page.locator('#country').selectOption(shard.country);await page.locator('#adVertical').selectOption('ALL');
  await page.getByPlaceholder('Search by advertiser').fill('');
  for(const [id,iso] of [['startDate',shard.start],['endDate',shard.end]]){await page.locator('#'+id).fill(dateDisplay(iso));await page.locator('#'+id).press('Enter');}
  if(await page.locator('#startDate').inputValue()!==dateDisplay(shard.start)||await page.locator('#endDate').inputValue()!==dateDisplay(shard.end))throw Error('DATE_FILTER_MISMATCH');
  // Handle rejection immediately, but still await authorization and the click
  // before returning. Shutdown must not leave an unobserved wait or action.
  const searchResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/resource/ApiResource/get/',{timeout:30000})
   .then(response=>({ok:true as const,response}),error=>({ok:false as const,error}));
  await options.guard?.beforeRequest('LIST');await page.getByRole('button',{name:'Search',exact:true}).click();
  const outcome=await searchResponse;if(!outcome.ok)throw outcome.error;const searched=outcome.response;
  if(searched.status()!==200)throw Error(searched.status()===429?'RATE_LIMITED':searched.status()===403?'ACCESS_BLOCKED':'SEARCH_HTTP_ERROR');
  await waitResults(page);
  const initialText=await page.locator('body').innerText();
  if(/date range must|invalid date/i.test(initialText))throw Error('DATE_FILTER_REJECTED');
  for(let index=0;index<shard.page;index++){
   const next=page.getByRole('button',{name:'Next page',exact:true});
   if(!await next.count()||await next.getAttribute('aria-disabled')==='true')throw Error('CURSOR_INVALID');
   const ids=await page.locator('a[href^="/ads-repository/"][target="_blank"]').evaluateAll(es=>es.map(e=>e.getAttribute('href')).join('|'));
   await options.guard?.beforeRequest('NEXT_PAGE');await next.click();await waitResults(page,ids);
  }
  const listing=await snapshot(page,sourceStatus);batch.evidence.push(listing);
  const ids=await page.evaluate(`(()=>{${pinterestParserRuntimeSource()};return Array.from(document.querySelectorAll('a[href^="/ads-repository/"][target="_blank"]')).map(a=>a.getAttribute('href')??'').filter(h=>pinterestAdIdFromPath(h)!==null)})()`) as string[];
  result.pageIds=[...new Set(ids.map(h=>h.split('/')[2]))];
  batch.coverage.observedCards=result.pageIds.length;
  const state=classifyPinterestPage({status:sourceStatus,text:listing.text,adCount:ids.length});
  if(state==='NO_RESULTS'){if(shard.page>0)throw Error('CURSOR_INVALID');batch.status='NO_RESULTS';result.exhausted=true;return result;}
  if(state!=='READY')throw Error(state);
  if(ids.length>100)throw Error('PAGE_TOO_LARGE');
  const parsed=await page.evaluate(`(()=>{${pinterestParserRuntimeSource()};return parsePinterestCards(document)})()`) as PinterestCard[];
  const next=page.getByRole('button',{name:'Next page',exact:true});
  if(!await next.count())throw Error('PAGINATION_CONTROL_MISSING');
  const atEnd=await next.getAttribute('aria-disabled')==='true'||!await next.isEnabled();
  const detail=await context.newPage();detail.setDefaultTimeout(15000);
  for(const id of result.pageIds){
   const card=parsed.find(c=>c.sourceAdId===id)??{sourceAdId:id,sourceUrl:`https://ads.pinterest.com/ads-repository/${id}/`,advertiserName:'',headline:'',body:null,bodyTruncated:false,media:[]};
   await options.guard?.beforeRequest('DETAIL');const response=await detail.goto(card.sourceUrl,{waitUntil:'domcontentloaded',timeout:25000});
   const status=response?.status()??null;
   // A rejected document cannot render the expected title. Preserve it before
   // classifying; otherwise a 403/429 is incorrectly reported as a timeout.
   if(status!==200){batch.evidence.push(await snapshot(detail,status));throw Error(status===403?'ACCESS_BLOCKED':status===429?'RATE_LIMITED':'DETAIL_HTTP_ERROR');}
   let waitError:unknown;
   try{await detail.locator('[data-test-id="ad-details-content"] h2').first().waitFor();}catch(error){waitError=error;}
   const ev=await snapshot(detail,status);batch.evidence.push(ev);
   if(waitError){
    const detailState=classifyPinterestPage({status,text:ev.text,adCount:0});
    if(['CHALLENGE','LOGIN_REQUIRED'].includes(detailState))throw Error(detailState);
    throw waitError instanceof Error&&waitError.name==='TimeoutError'?Error('DETAIL_TIMEOUT'):waitError;
   }
   const detailData=await detail.evaluate(`(()=>{${pinterestParserRuntimeSource()};const doc=new DOMParser().parseFromString(${JSON.stringify(ev.html)},'text/html');return {fields:parsePinterestDetails(doc),media:parsePinterestMedia(doc)}})()`) as {fields:Record<string,string>;media:PinterestCard['media']};
   const fields=detailData.fields;
   const redacted=fields['Ad status']==='Disapproved';
   if(!fields['Advertiser name']&&!redacted)throw Error('DETAIL_INCOMPLETE');
   const media=redacted?[]:[...new Map([...card.media.filter(m=>m.type==='IMAGE'),...detailData.media].map(m=>[m.url,m])).values()];
   const reportedCountries=result.catalog.countries.filter(c=>(fields.Countries??'').split(/[,\n]/).map(s=>s.trim()).includes(c.name)||(fields['Reach by country']??'').split(',').some(x=>x.trim().startsWith(c.name+':'))).map(c=>c.code);
   batch.ads.push({...card,advertiserName:fields['Advertiser name']??'',...(redacted?{headline:'',body:null,bodyTruncated:false}:{}),media,observedAt:new Date().toISOString(),reportedCountries,sourceFields:fields,rawText:ev.text,rawHtml:ev.html});
   await detail.waitForTimeout(350);
  }
  batch.coverage={complete:false,observedCards:result.pageIds.length,selected:batch.ads.length};
  batch.status='SUCCEEDED';result.nextPage=shard.page+1;result.exhausted=atEnd;
 }catch(e){const msg=e instanceof Error?e.message:'';batch.errorCode=/^[A-Z_]+$/.test(msg)?msg:(e instanceof Error&&e.name==='TimeoutError'?'TIMEOUT':'COLLECTOR_ERROR');batch.status=batch.ads.length?'PARTIAL':'FAILED';batch.coverage.selected=batch.ads.length;}
 finally{controlSignal?.removeEventListener('abort',controlAbort);clearTimeout(watchdog);await browser?.close().catch(()=>{});}
 return result;
}
