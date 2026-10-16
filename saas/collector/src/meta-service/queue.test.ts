import {describe,it,expect} from 'vitest';
import {seedJobs,nextJob,applyBatch,discoverJobs,buildSearchUrl,searchDecision,restrictionDelay} from './queue';
describe('Meta unattended discovery queue',()=>{
 it('has local and English ecommerce terms across countries without pretending keywords are classifications',()=>{
  const jobs=seedJobs();expect(new Set(jobs.map(j=>j.country)).size).toBeGreaterThanOrEqual(20);
  expect(new Set(jobs.map(j=>j.language)).size).toBeGreaterThanOrEqual(8);
  expect(jobs.some(j=>j.keyword==='shop now'&&j.country==='US')).toBe(true);
  expect(jobs.some(j=>j.keyword==='sales')).toBe(true);
  expect(jobs.some(j=>j.keyword==='comprar ahora'&&j.country==='MX')).toBe(true);
  expect(new Set(jobs.map(j=>j.id)).size).toBe(jobs.length);
 });
 it('does not confuse stalled scrolling or a budget with source exhaustion',()=>{
  expect(searchDecision({explicitEnd:false,noResults:false,newCount:0,stalls:3,budgetReached:false})).toBe('stalled');
  expect(searchDecision({explicitEnd:false,noResults:false,newCount:20,stalls:0,budgetReached:true})).toBe('continue-later');
  expect(searchDecision({explicitEnd:true,noResults:false,newCount:0,stalls:0,budgetReached:false})).toBe('exhausted');
 });
 it('advances seen IDs only after a committed successful batch and preserves partial recovery',()=>{
  const j=seedJobs()[0];applyBatch(j,{ids:['123456'],status:'PARTIAL',errorCode:'TIMEOUT',exhausted:false},100);
  expect(j.seen).toEqual(['123456']);expect(j.exhaustedAt).toBeNull();expect(j.failures).toBe(1);
  applyBatch(j,{ids:['123456','789012'],status:'SUCCEEDED',errorCode:null,exhausted:true},200);
  expect(j.seen).toEqual(['123456','789012']);expect(j.exhaustedAt).toBe(200);expect(j.dueAt).toBeGreaterThan(200);
 });
 it('rotates due jobs fairly and does not retry a cooling-down job',()=>{
  const jobs=seedJobs().slice(0,2);jobs[0].dueAt=500;expect(nextJob(jobs,100)?.id).toBe(jobs[1].id);
  jobs[1].lastAttemptAt=50;jobs[0].dueAt=0;expect(nextJob(jobs,100)?.id).toBe(jobs[0].id);
 });
 it('derives advertiser jobs only from an observed numeric Facebook page ID, one per country',()=>{
  const seed=seedJobs()[0],jobs=[seed];
  discoverJobs(jobs,seed,[{advertiserPageUrl:'https://www.facebook.com/profile.php?id=123456789'}, {advertiserPageUrl:'https://evil.example/123456789'}, {advertiserPageUrl:'https://www.facebook.com/some.name'}]);
  expect(jobs).toHaveLength(2);expect(jobs[1].pageId).toBe('123456789');
  discoverJobs(jobs,seed,[{advertiserPageUrl:'https://www.facebook.com/profile.php?id=123456789'}]);expect(jobs).toHaveLength(2);
  const u=new URL(buildSearchUrl(jobs[1]));expect(u.searchParams.get('view_all_page_id')).toBe('123456789');expect(u.searchParams.has('q')).toBe(false);
 });
 it('encodes keyword input and preserves language as query provenance',()=>{
  const j={...seedJobs()[0],keyword:'sales & country=XX'};const u=new URL(buildSearchUrl(j));
  expect(u.origin).toBe('https://www.facebook.com');expect(u.searchParams.get('q')).toBe(j.keyword);expect(u.searchParams.get('country')).toBe(j.country);
 });
 it('backs off source restrictions globally instead of cycling keywords or IPs',()=>{
  expect(restrictionDelay('META_HTTP_403',1)).toBe(3600000);
  expect(restrictionDelay('META_SOURCE_CHALLENGE',9)).toBe(86400000);
  expect(restrictionDelay('META_TIMEOUT',1)).toBe(0);
 });
});
it('retries due failed queries before a large untouched keyword backlog',()=>{
 const jobs=seedJobs();jobs[0].failures=1;jobs[0].lastAttemptAt=100;jobs[0].dueAt=200;
 expect(nextJob(jobs,250)?.id).toBe(jobs[0].id);expect(nextJob(jobs,150)?.id).toBe(jobs[1].id);
});
it('globally cools down HTTP 200 application-level limits',()=>{expect(restrictionDelay('META_RATE_LIMITED',1)).toBe(3600000);});
import {prepareCycle} from './queue';
it('keeps incomplete discovery progress past six hours and only resets an explicitly ended query',()=>{
 const j={...seedJobs()[0],seen:['123456'],cycleStartedAt:100};prepareCycle(j,1000);expect(j.seen).toEqual(['123456']);prepareCycle(j,21600101);expect(j.seen).toEqual(['123456']);expect(j.exhaustedAt).toBeNull();
 j.exhaustedAt=21600101;prepareCycle(j,43200200);expect(j.seen).toEqual([]);expect(j.exhaustedAt).toBeNull();
});
