/** Offline integration check. Run in an isolated container with --network none. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import {rm} from 'node:fs/promises';
import {chromium} from 'playwright';
import {collectBatch} from '../../src/meta-service/browser';
import {seedJobs} from '../../src/meta-service/queue';
const launch=chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext=async (...args:Parameters<typeof launch>)=>{
 const context=await launch(...args);
 await context.route('https://www.facebook.com/**',async route=>{
  if(new URL(route.request().url()).pathname==='/api/graphql/')await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({errors:[{message:'Rate limit exceeded',code:1675004}]})});
  else await route.fulfill({status:403,contentType:'text/html',body:'<!doctype html><body>Search by keyword or advertiser<input placeholder="Search by keyword or advertiser"><script>document.querySelector("input").addEventListener("keydown",e=>{if(e.key==="Enter")fetch("/api/graphql/",{method:"POST"})});</script></body>'});
 });return context;
};
const profile='/tmp/meta-offline-limit-'+randomUUID();
try{const start=Date.now(),batch=await collectBatch(seedJobs()[0],profile,{maxAds:1,maxMs:30000});assert.equal(batch.errorCode,'META_RATE_LIMITED');assert.equal(batch.ads.length,0);assert.equal(batch.coverage.exhausted,false);assert.ok(Date.now()-start<20000,'must close promptly, not wait for normal readiness timeout');console.log(JSON.stringify({offline:true,httpStatus:200,errorCode:batch.errorCode,closedPromptly:true,ads:0,passed:true}));}
finally{chromium.launchPersistentContext=launch;await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});}
