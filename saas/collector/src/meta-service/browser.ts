import type {SourceRequestGuard} from '../dispatch/execution-guard';
import {chromium,type BrowserContext,type Page} from 'playwright';
import {parseMetaDocument,parseMetaEmbeddedAdvertisers,type MetaParseResult,type MetaEmbeddedAdvertiser} from '../meta-parser';
import type {ParsedAd} from '../../../contracts/src/collection';
import {buildSearchUrl,searchDecision,type Job} from './queue';import type {SeedFamily} from './spy-seeds';
import {sanitizeEvidence,accessState,browserErrorCode,graphqlErrorCode} from './evidence';
import {metaProxy} from './egress';
export interface Evidence {url:string;httpStatus:number|null;kind:'listing'|'detail';adId?:string;html:string;text:string;observedAt:string}
export interface Batch {version:'meta-service-dom-1';sourceKey:'meta_ad_library';platform:'META';observedAt:string;query:{country:string;language:string;keyword:string;pageId?:string;status:'active'|'all';mediaType:'all';seedFamilies?:SeedFamily[];seedCategories?:string[]};status:'SUCCEEDED'|'PARTIAL'|'FAILED'|'NO_RESULTS';errorCode:string|null;ads:ParsedAd[];evidence:Evidence[];completedIds:string[];coverage:{completeSourceCoverage:false;exhausted:boolean;observedCards:number;reason:string};advertisers:MetaEmbeddedAdvertiser[];resultCount:number|null;diagnostics:Array<{status:number;path:string}>}
export async function browserContext(profile:string){const proxy=metaProxy(process.env.META_PROXY_URL);return chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,chromiumSandbox:true,locale:'en-US',timezoneId:'UTC',viewport:{width:1440,height:1000},...(proxy?{proxy}:{}),env:Object.fromEntries(Object.entries(process.env).filter(([k,v])=>v!==undefined&&['PATH','HOME','LANG','TZ','PLAYWRIGHT_BROWSERS_PATH'].includes(k))) as Record<string,string>});}
async function evidence(page:Page,httpStatus:number|null,kind:Evidence['kind'],adId?:string):Promise<Evidence>{const clean=await page.evaluate(`(()=>{const __name=f=>f;const dialog=${JSON.stringify(kind)}==='detail'?document.querySelector('[role=\"dialog\"]'):null;const doc=dialog?{body:dialog}:document;return (${sanitizeEvidence.toString()})(doc);})()`) as {html:string;text:string};return {url:page.url(),httpStatus,kind,...(adId?{adId}:{}),...clean,observedAt:new Date().toISOString()};}
const bodyText=(page:Page)=>page.evaluate(()=>document.body?.innerText??'');
async function ready(page:Page){await page.waitForFunction(()=>/Library ID\s*[:：]\s*\d+|No ads match your search criteria|No results found|Security Check|verify you are human|Log in to Facebook|Log in to continue/i.test(document.body?.innerText??''),undefined,{timeout:45000});}
function stateError(state:string){if(state==='restricted')throw Error('META_SOURCE_CHALLENGE');if(state==='login')throw Error('META_SOURCE_LOGIN_REQUIRED');}
export async function collectBatch(job:Job,profile:string,options:{maxAds?:number;maxScrolls?:number;maxMs?:number;guard?:SourceRequestGuard;signal?:AbortSignal}={}):Promise<Batch>{
 await options.guard?.beforeRequest('BROWSER_START');
 const batch:Batch={version:'meta-service-dom-1',sourceKey:'meta_ad_library',platform:'META',observedAt:new Date().toISOString(),query:{country:job.country,language:job.language,keyword:job.keyword,...(job.pageId?{pageId:job.pageId}:{}),status:'all',mediaType:'all',...(job.seedFamilies?{seedFamilies:job.seedFamilies}:{}),...(job.seedCategories?{seedCategories:job.seedCategories}:{})},status:'FAILED',errorCode:null,ads:[],evidence:[],completedIds:[],coverage:{completeSourceCoverage:false,exhausted:false,observedCards:0,reason:'NOT_FINISHED'},advertisers:[],resultCount:null,diagnostics:[]};
 let context:BrowserContext|undefined,page:Page|undefined,status:number|null=null;const seen=new Set(job.seen);const start=Date.now();let restricted:number|undefined;let dataResponses=0;let sourceError:string|null=null;const responseChecks=new Set<Promise<void>>();
 const controlSignal=options.guard?.signal??options.signal;const controlAbort=()=>{void context?.close().catch(()=>{});};controlSignal?.addEventListener('abort',controlAbort,{once:true});
 const watchdog=setTimeout(()=>{void context?.close().catch(()=>{});},(options.maxMs??180000)+60000);watchdog.unref();
 try{
  context=await browserContext(profile);page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('response',r=>{
   const u=new URL(r.url());if(u.hostname!=='www.facebook.com')return;
   if(r.status()>=400&&batch.diagnostics.length<30)batch.diagnostics.push({status:r.status(),path:u.pathname});
   if(u.pathname!=='/api/graphql/')return;
   const check=(async()=>{
    if([403,429].includes(r.status())){restricted=r.status();sourceError=`META_HTTP_${restricted}`;}
    else if(r.status()===200){try{const err=graphqlErrorCode(await r.text());if(err){sourceError=err;if(batch.diagnostics.length<30)batch.diagnostics.push({status:200,path:u.pathname+'#'+err});}else dataResponses++;}catch{}}
    // Closing the context stops the site's own automatic pagination retries too.
    if(sourceError)await context?.close().catch(()=>{});
   })();responseChecks.add(check);void check.finally(()=>responseChecks.delete(check));
  });
  await options.guard?.beforeRequest('LIST');status=(await page.goto(buildSearchUrl(job),{waitUntil:'domcontentloaded',timeout:45000}))?.status()??null;
  if(status===429)throw Error('META_HTTP_429');
  await page.waitForFunction(()=>Boolean(document.body?.innerText),undefined,{timeout:30000});
  await page.waitForTimeout(4000);
  let state=accessState(status,await bodyText(page));stateError(state);
  if(state==='shell'&&!job.pageId){
   // Some public entry documents return 403 but render a functioning search UI.
   // One normal UI search must produce actual cards and a successful data response.
   const input=page.getByPlaceholder('Search by keyword or advertiser');await input.fill(job.keyword);await options.guard?.beforeRequest('LIST');await input.press('Enter');
  }
  await ready(page);await Promise.allSettled([...responseChecks]);if(sourceError)throw Error(sourceError);state=accessState(restricted??200,await bodyText(page));stateError(state);
  if(restricted)throw Error(`META_HTTP_${restricted}`);
  if(status===403&&dataResponses===0)throw Error('META_HTTP_403');
  let stalls=0;const sessionIds=new Set<string>();
  for(let scroll=0;scroll<(options.maxScrolls??80);scroll++){
   if(sourceError)throw Error(sourceError);if(restricted)throw Error(`META_HTTP_${restricted}`);
   const text=await bodyText(page);state=accessState(200,text);stateError(state);
   if(state==='empty'){batch.coverage.exhausted=true;batch.coverage.reason='EXPLICIT_NO_RESULTS';batch.status=batch.ads.length?'SUCCEEDED':'NO_RESULTS';break;}
   const parsed=await page.evaluate(`(()=>{const __name=f=>f;return (${parseMetaDocument.toString()})(document,${JSON.stringify(job.country)});})()`) as MetaParseResult;
   // The listing payload the page already shipped carries page_id for every
   // card. No extra request; a missing or changed payload yields no records.
   const embedded=await page.evaluate(`(()=>{const __name=f=>f;return (${parseMetaEmbeddedAdvertisers.toString()})(document);})()`).then(value=>value as {advertisers:MetaEmbeddedAdvertiser[];resultCount:number|null}).catch(()=>({advertisers:[] as MetaEmbeddedAdvertiser[],resultCount:null}));
   for(const advertiser of embedded.advertisers)if(!batch.advertisers.some(known=>known.sourceAdId===advertiser.sourceAdId))batch.advertisers.push(advertiser);
   if(embedded.resultCount!==null)batch.resultCount=Math.max(batch.resultCount??0,embedded.resultCount);
   for(const ad of parsed.ads){const identity=embedded.advertisers.find(row=>row.sourceAdId===ad.sourceAdId);if(!ad.advertiserAvatarUrl&&identity?.advertiserAvatarUrl)ad.advertiserAvatarUrl=identity.advertiserAvatarUrl;}
   batch.coverage.observedCards=Math.max(batch.coverage.observedCards,parsed.observedCardCount);
   const fresh=parsed.ads.filter(a=>!seen.has(a.sourceAdId)&&!batch.ads.some(x=>x.sourceAdId===a.sourceAdId));
   // Preserve pages that contributed new ads, plus explicit end/error pages.
   if(fresh.length||scroll===0)batch.evidence.push(await evidence(page,status,'listing'));
   for(const ad of fresh.slice(0,(options.maxAds??20)-batch.ads.length))batch.ads.push(ad);
   const newSession=parsed.ads.filter(a=>!sessionIds.has(a.sourceAdId)).length;parsed.ads.forEach(a=>sessionIds.add(a.sourceAdId));stalls=newSession?0:stalls+1;
   if(parsed.rejectedCardCount)throw Error('META_PARSE_PARTIAL');
   const explicitEnd=/you(?:'|’)ve reached the end|end of results|no more ads to show/i.test(text);
   const budget=batch.ads.length>=(options.maxAds??20)||Date.now()-start>=(options.maxMs??180000);
   const decision=searchDecision({explicitEnd,noResults:false,newCount:fresh.length,stalls,budgetReached:budget});
   if(decision==='exhausted'){batch.coverage.exhausted=true;batch.coverage.reason='EXPLICIT_END';batch.status='SUCCEEDED';break;}
   if(decision==='continue-later'){batch.coverage.reason='BATCH_BUDGET';batch.status='SUCCEEDED';break;}
   if(decision==='stalled')throw Error('META_SCROLL_STALLED');
   const signature=await page.evaluate(()=>[...new Set(document.body.innerText.match(/Library ID\s*[:：]\s*\d+/g)??[])].sort().join('|'));
   await page.evaluate(()=>{const root=document.scrollingElement??document.documentElement;root.scrollTop=root.scrollHeight;});
   await options.guard?.beforeRequest('NEXT_PAGE');const more=page.getByRole('button',{name:'See more',exact:true});if(await more.count()&&await more.last().isVisible())await more.last().click({timeout:5000});
   // Wait for actual result hydration, not an arbitrary short sleep. A long ad
   // can span several viewports without any new ID until the result sentinel.
   await page.waitForFunction(old=>[...new Set(document.body.innerText.match(/Library ID\s*[:：]\s*\d+/g)??[])].sort().join('|')!==old||/No ads match your search criteria|No results found|Security Check|verify you are human|Log in to continue/i.test(document.body.innerText),signature,{timeout:20000}).catch(()=>{});
   await page.waitForTimeout(700);
  }
  if(batch.status==='FAILED')throw Error('META_SCROLL_BUDGET');
  // List snapshots remain authoritative even if detail enrichment is unavailable.
  // Capture public detail dialogs through the visible control, never private APIs.
  for(const ad of batch.ads){
   if(Date.now()-start>(options.maxMs??180000)||JSON.stringify(batch).length>12000000)break;
   const marker=page.locator('span').filter({hasText:new RegExp(`^Library ID:\\s*${ad.sourceAdId}$`)}).last();
   if(!await marker.count())continue;
   let card=marker.locator('xpath=..');
   for(let depth=0;depth<12;depth++){if(await card.getByRole('button',{name:'See ad details',exact:true}).count())break;card=card.locator('xpath=..');}
   const button=card.getByRole('button',{name:'See ad details',exact:true});if(await button.count()!==1)continue;
   try{await options.guard?.beforeRequest('DETAIL');await button.click({timeout:5000});const dialog=page.getByRole('dialog');await dialog.first().waitFor({timeout:8000});await page.waitForTimeout(800);stateError(accessState(restricted??200,await bodyText(page)));if(restricted)throw Error(`META_HTTP_${restricted}`);batch.evidence.push(await evidence(page,200,'detail',ad.sourceAdId));await page.keyboard.press('Escape');await page.waitForTimeout(300);if(await dialog.first().isVisible())break;}
   catch(e){if(e instanceof Error&&/^META_/.test(e.message))throw e;await page.keyboard.press('Escape').catch(()=>{});break;}
  }
  await Promise.allSettled([...responseChecks]);if(sourceError)throw Error(sourceError);
 }catch(e){batch.errorCode=sourceError??(restricted?`META_HTTP_${restricted}`:browserErrorCode(e));batch.status=batch.ads.length?'PARTIAL':'FAILED';batch.coverage.reason=batch.errorCode;batch.coverage.exhausted=false;if(page)try{batch.evidence.push(await evidence(page,status,'listing'));}catch{}}
 finally{controlSignal?.removeEventListener('abort',controlAbort);clearTimeout(watchdog);await context?.close().catch(()=>{});}
 batch.completedIds=batch.ads.map(a=>a.sourceAdId);return batch;
}
