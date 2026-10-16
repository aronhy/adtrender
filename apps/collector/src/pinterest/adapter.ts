import {chromium,type Page} from 'playwright';
import {classifyPinterestPage,validatePinterestOptions} from './state';
import {pinterestParserRuntimeSource,type PinterestCard} from './parser';
export const PINTEREST_VERSION='pinterest-public-dom-1';
export interface PinterestAd extends PinterestCard {observedAt:string;reportedCountries:string[];sourceFields:Record<string,string>;rawText:string;rawHtml:string}
export interface PinterestBatch {
 version:string;sourceKey:'pinterest_ads_repository';platform:'PINTEREST';observedAt:string;
 query:{keyword:string;country:string;limit:number;dateStart?:string;dateEnd?:string;category?:string;page?:number};
 status:string;errorCode:string|null;ads:PinterestAd[];
 evidence:Array<{url:string;httpStatus:number|null;text:string;html:string}>;
 diagnostics:Array<{kind:string;code:string;resource?:string}>;
 coverage:{complete:false;observedCards:number;selected:number};
}
/** Bounded native browser collection. Uses a fresh, anonymous profile; never user's cookies. */
export async function collectPinterest(input:{keyword:string;country:string;limit:number;channel?:'chrome'|'chromium'}):Promise<PinterestBatch> {
 const validated=validatePinterestOptions(input);
 if(!/^[A-Z]{2}$/.test(input.country))throw Error('PINTEREST_COUNTRY_INVALID');
 const batch:PinterestBatch={version:PINTEREST_VERSION,sourceKey:'pinterest_ads_repository',platform:'PINTEREST',observedAt:new Date().toISOString(),query:{...validated,country:input.country},status:'FAILED',errorCode:null,ads:[],evidence:[],diagnostics:[],coverage:{complete:false,observedCards:0,selected:0}};
 let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 const capture=async(page:Page,httpStatus:number|null)=>{
  const snapshot=await page.evaluate(()=>{
   const root=document.body.cloneNode(true) as HTMLElement;
   root.querySelectorAll('script,style,noscript,iframe').forEach(e=>e.remove());
   root.querySelectorAll('*').forEach(e=>{for(const a of Array.from(e.attributes))if(!['href','src','alt','title','data-test-id','id','role','value'].includes(a.name))e.removeAttribute(a.name);});
   return {text:document.body.innerText,html:root.outerHTML};
  });
  const result={url:page.url(),httpStatus,...snapshot};batch.evidence.push(result);return result;
 };
 try {
  browser=await chromium.launch({headless:true,chromiumSandbox:true,...(input.channel?{channel:input.channel}:{})});
  const context=await browser.newContext({locale:'en-US',viewport:{width:1440,height:1000}});
  const page=await context.newPage();page.setDefaultTimeout(20000);
  page.on('pageerror',()=>{if(batch.diagnostics.length<50)batch.diagnostics.push({kind:'pageerror',code:'SCRIPT_ERROR'});});
  page.on('requestfailed',r=>{if(batch.diagnostics.length<50){const u=new URL(r.url());batch.diagnostics.push({kind:'requestfailed',code:r.failure()?.errorText??'NETWORK_ERROR',resource:u.origin+u.pathname});}});
  page.on('response',r=>{if(r.status()>=400&&batch.diagnostics.length<50){const u=new URL(r.url());batch.diagnostics.push({kind:'http',code:String(r.status()),resource:u.origin+u.pathname});}});
  const response=await page.goto('https://ads.pinterest.com/ads-repository/',{waitUntil:'domcontentloaded',timeout:30000});
  const status=response?.status()??null;
  try{await page.getByPlaceholder('Search by advertiser').waitFor();}catch{/* Classify actual page, not timeout alone. */}
  const initial=await capture(page,status);
  const initialState=classifyPinterestPage({status,text:initial.text,adCount:0});
  if(['ACCESS_BLOCKED','RATE_LIMITED','CHALLENGE','LOGIN_REQUIRED','EMPTY_PAGE','HTTP_ERROR'].includes(initialState)){batch.errorCode=initialState;return batch;}
  const countries=await page.locator('#country option').evaluateAll(es=>es.map(e=>({code:(e as HTMLOptionElement).value,name:e.textContent?.trim()})));
  if(!countries.some(c=>c.code===input.country)){batch.errorCode='COUNTRY_UNSUPPORTED';return batch;}
  await page.locator('#country').selectOption(input.country);
  await page.getByPlaceholder('Search by advertiser').fill(validated.keyword);
  await page.getByRole('button',{name:'Search',exact:true}).click();
  try{await page.waitForFunction(()=>Array.from(document.querySelectorAll('a[href^="/ads-repository/"][target="_blank"]')).some(a=>(a.parentElement?.querySelectorAll('[title]').length??0)>=2)||/no ads found|no results found|verify you are human|log in to continue/i.test(document.body.innerText),undefined,{timeout:25000});}catch{/* Save and classify incomplete rendering. */}
  const search=await capture(page,status);
  const cards=await page.evaluate(`(()=>{${pinterestParserRuntimeSource()};return parsePinterestCards(document)})()`) as PinterestCard[];
  batch.coverage.observedCards=cards.length;
  const state=classifyPinterestPage({status,text:search.text,adCount:cards.length});
  if(state!=='READY'){batch.status=state==='NO_RESULTS'?'NO_RESULTS':'FAILED';batch.errorCode=state==='NO_RESULTS'?null:state;return batch;}
  const dates=await page.locator('#startDate,#endDate').evaluateAll(es=>es.map(e=>(e as HTMLInputElement).value));
  batch.query.dateStart=dates[0];batch.query.dateEnd=dates[1];
  for(const card of cards.slice(0,input.limit)) {
   const r=await page.goto(card.sourceUrl,{waitUntil:'domcontentloaded',timeout:30000});
   try{await page.locator('[data-test-id="ad-details-content"] h2').first().waitFor();}catch{/* Save failed detail for investigation. */}
   const detail=await capture(page,r?.status()??null);
   const detailState=classifyPinterestPage({status:detail.httpStatus,text:detail.text,adCount:0});
   if(['ACCESS_BLOCKED','RATE_LIMITED','CHALLENGE','LOGIN_REQUIRED','HTTP_ERROR'].includes(detailState)){batch.errorCode=detailState;break;}
   const parsed=await page.evaluate(`(()=>{${pinterestParserRuntimeSource()};const doc=new DOMParser().parseFromString(${JSON.stringify(detail.html)},'text/html');return {fields:parsePinterestDetails(doc),media:parsePinterestMedia(doc)}})()`) as {fields:Record<string,string>;media:PinterestCard['media']};
   const fields=parsed.fields;
   if(!fields['Advertiser name']){batch.errorCode='DETAIL_INCOMPLETE';break;}
   const reported=Object.entries(Object.fromEntries(countries.map(c=>[c.name,c.code]))).filter(([name])=>(fields.Countries??'').split(/[,\n]/).map(x=>x.trim()).includes(name)).map(([,code])=>code);
   const media=[...new Map([...card.media.filter(m=>m.type==='IMAGE'),...parsed.media].map(m=>[m.url,m])).values()];
   batch.ads.push({...card,media,observedAt:new Date().toISOString(),reportedCountries:reported,sourceFields:fields,rawText:detail.text,rawHtml:detail.html});
  }
  batch.coverage.selected=batch.ads.length;
  batch.status=batch.errorCode?(batch.ads.length?'PARTIAL':'FAILED'):'SUCCEEDED';
 } catch(error) {
  batch.errorCode=error instanceof Error&&/Executable.*exist/.test(error.message)?'BROWSER_NOT_INSTALLED':error instanceof Error&&error.name==='TimeoutError'?'TIMEOUT':'COLLECTOR_ERROR';
  batch.status=batch.ads.length?'PARTIAL':'FAILED';
 } finally {await browser?.close().catch(()=>{});}
 return batch;
}
