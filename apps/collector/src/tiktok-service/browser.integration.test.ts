import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { collectBatch, discoverCountries } from './browser';
const fixture = readFileSync('apps/collector/src/tiktok-service/fixtures/detail.redacted.html','utf8').replace('<video class=""','<video src="https://library.tiktok.com/api/v1/cdn/synthetic/video/fixture" class=""');
const job={id:'DE:2026-10-06:2026-10-07',country:'DE',start:'2026-10-06',end:'2026-10-07',page:0,seen:[],complete:false,lastAttemptAt:0,retryAt:0,failures:0,cycleStartedAt:0};

it('waits through a loading zero, collects new details after View more and resumes without duplicate details',async()=>{
 const browser=await chromium.launch({channel:process.env.TIKTOK_TEST_CHANNEL??'chromium',headless:true,chromiumSandbox:true});
 try{
  const factory=async()=>{
   const c=await browser.newContext();
   await c.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if(u.pathname.includes('/detail')){const id=u.searchParams.get('ad_id')!;await route.fulfill({body:fixture.replaceAll('1878382825663537',id),contentType:'text/html'});return;}
    await route.fulfill({contentType:'text/html',body:`<button aria-label="Ad target country">Germany</button><button aria-label="Last shown date">10/6/2026—10/7/2026</button><input placeholder="Search by name or keyword"><button onclick="search()">Search</button><div id="results">Total ads: 0</div><script>
    const ids=['1878382825663537','1878382825663538'];let index=0;function link(id){return '<a class="link" href="/ads/detail/?ad_id='+id+'">View ad</a>';}function search(){document.querySelector('#results').innerHTML='Total ads: 0';setTimeout(()=>{index=0;document.querySelector('#results').innerHTML=link(ids[0])+'<div class="loading_more"><span class="loading_more_text" onclick="more()">View more</span></div>';},100);}function more(){document.querySelector('.loading_more').remove();document.querySelector('#results').insertAdjacentHTML('beforeend',link(ids[1]));}</script>`});
   });return c;
  };
  const first=await collectBatch(job,{maxAds:2,maxPages:3,maxMs:20000,settleMs:50},factory);
  expect(first.ads.map(a=>a.sourceAdId)).toEqual(['1878382825663537','1878382825663538']);
  expect(first.status).toBe('SUCCEEDED');expect(first.coverage.exhausted).toBe(false);
  const resumed=await collectBatch({...job,seen:['1878382825663537']},{maxAds:1,maxPages:3,maxMs:20000,settleMs:50},factory);
  expect(resumed.completedIds).toEqual(['1878382825663538']);
 }finally{await browser.close();}
},60000);

it('stops a source 429 with its Retry-After and never treats it as empty',async()=>{
 const browser=await chromium.launch({channel:process.env.TIKTOK_TEST_CHANNEL??'chromium',headless:true,chromiumSandbox:true});
 let shutdownReads=0,closeCalls=0;
 try{
  const result=await collectBatch(job,{maxMs:10000},async()=>{const c=await browser.newContext();const close=c.close.bind(c);
   vi.spyOn(c,'close').mockImplementation(async options=>{closeCalls++;await close(options);});
   // A navigation aborted by shutdown can leave evaluate waiting forever for
   // its destroyed execution context. The collector must not start that read.
   c.on('page',p=>{vi.spyOn(p,'evaluate').mockImplementation(async()=>{shutdownReads++;throw Error('SHUTDOWN_SNAPSHOT_READ');});});
   await c.route('**/*',r=>r.fulfill({status:429,headers:{'Retry-After':'120'},body:'Too many requests'}));return c;});
  expect(result.status).toBe('FAILED');expect(result.errorCode).toBe('TIKTOK_RATE_LIMITED');expect(result.retryAfterMs).toBe(120000);expect(result.coverage.exhausted).toBe(false);
  expect(shutdownReads).toBe(0);expect(closeCalls).toBe(1);
 }finally{await browser.close();}
},30000);

it('preserves a watchdog timeout rather than classifying its cancelled requests as network failures',async()=>{
 const browser=await chromium.launch({channel:process.env.TIKTOK_TEST_CHANNEL??'chromium',headless:true,chromiumSandbox:true});
 try{
  const result=await collectBatch(job,{maxMs:1000},async()=>{const c=await browser.newContext();await c.route('**/*',()=>{});return c;});
  expect(result.errorCode).toBe('TIKTOK_TIME_BUDGET');expect(result.coverage.exhausted).toBe(false);
 }finally{await browser.close();}
},20000);

it('classifies a country catalog restriction with its Retry-After',async()=>{
 const browser=await chromium.launch({channel:process.env.TIKTOK_TEST_CHANNEL??'chromium',headless:true,chromiumSandbox:true});
 try{
  await expect(discoverCountries({},async()=>{const c=await browser.newContext();await c.route('**/*',r=>r.fulfill({status:429,headers:{'Retry-After':'300'},body:'Too many requests'}));return c;})).rejects.toMatchObject({message:'TIKTOK_RATE_LIMITED',retryAfterMs:300000});
 }finally{await browser.close();}
},30000);

it('lets the daemon finish an in-flight browser operation after SIGTERM',async()=>{
 const program=`import {launchContext} from './apps/collector/src/tiktok-service/browser.ts';
 process.on('SIGTERM',()=>{});
 const c=await launchContext({channel:${JSON.stringify(process.env.TIKTOK_TEST_CHANNEL??'chromium')},handleSignals:false});
 const p=await c.newPage();await p.setContent('<p>ready</p>');console.log('READY');
 await new Promise(r=>process.once('SIGTERM',r));await new Promise(r=>setTimeout(r,500));
 try{console.log('AFTER_SIGNAL_'+await p.locator('p').innerText());}finally{await c.close();}`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',program],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
 let out='',err='',sent=false;
 child.stdout.on('data',chunk=>{out+=String(chunk);if(!sent&&out.includes('READY')){sent=true;child.kill('SIGTERM');}});
 child.stderr.on('data',chunk=>{err+=String(chunk);});
 const timeout=setTimeout(()=>child.kill('SIGKILL'),15000);
 try{const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});expect({code,out,error:err.slice(0,100)}).toMatchObject({code:0,out:'READY\nAFTER_SIGNAL_ready\n'});}
 finally{clearTimeout(timeout);if(child.exitCode===null)child.kill('SIGKILL');}
},20000);

it('does not confirm an empty shard when a source data request fails',async()=>{
 const browser=await chromium.launch({channel:process.env.TIKTOK_TEST_CHANNEL??'chromium',headless:true,chromiumSandbox:true});
 try{
  const result=await collectBatch(job,{maxMs:15000,settleMs:50},async()=>{const c=await browser.newContext();await c.route('**/*',r=>new URL(r.request().url()).pathname==='/fixture-query'?r.fulfill({status:500,body:'failed'}):r.fulfill({contentType:'text/html',body:'<button aria-label="Ad target country">Germany</button><button aria-label="Last shown date">10/6/2026—10/7/2026</button><input placeholder="Search by name or keyword"><button onclick="fetch(\'/fixture-query\')">Search</button><h6>No ads found</h6>'}));return c;});
  expect(result.status).toBe('FAILED');expect(result.coverage.exhausted).toBe(false);expect(result.errorCode).toBe('TIKTOK_SOURCE_HTTP_500');
 }finally{await browser.close();}
},30000);

it('reobserves one requested detail for material refresh even when discovery already committed its ID',async()=>{
 const browser=await chromium.launch({channel:process.env.TIKTOK_TEST_CHANNEL??'chromium',headless:true,chromiumSandbox:true});const visited:string[]=[];
 try{
  const id='1878382825663537';
  const result=await collectBatch({...job,id:'MEDIA_REFRESH:'+id,kind:'MEDIA_REFRESH',sourceAdIds:[id],seen:[id]},{maxMs:15000,settleMs:50},async()=>{
   const c=await browser.newContext();await c.route('**/*',async r=>{const u=new URL(r.request().url());if(r.request().resourceType()==='document')visited.push(u.pathname);await r.fulfill({contentType:'text/html',body:fixture});});return c;
  });
  expect(visited).toEqual(['/ads/detail/']);expect(result.status).toBe('SUCCEEDED');expect(result.completedIds).toEqual([id]);expect(result.coverage).toMatchObject({exhausted:false,completeSourceCoverage:false,reason:'MEDIA_REFRESH_DETAIL'});expect(result.evidence[0]).toMatchObject({kind:'detail',adId:id,httpStatus:200});
 }finally{await browser.close();}
},30000);
it('stops a refresh on a public source challenge before waiting for advertiser hydration',async()=>{
 const browser=await chromium.launch({channel:process.env.TIKTOK_TEST_CHANNEL??'chromium',headless:true,chromiumSandbox:true});
 try{const result=await collectBatch({...job,id:'MEDIA_REFRESH:1878382825663537',kind:'MEDIA_REFRESH',sourceAdIds:['1878382825663537']},{maxMs:1000},async()=>{const c=await browser.newContext();await c.route('**/*',r=>r.fulfill({contentType:'text/html',body:'<h1>Verify you are human</h1>'}));return c;});expect(result.errorCode).toBe('TIKTOK_CHALLENGE');expect(result.completedIds).toEqual([]);}finally{await browser.close();}
},15000);
