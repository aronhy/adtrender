import {describe,expect,it} from 'vitest';
import {advanceJob,nextJob,planJobs,refreshJobs,restrictionAction,enqueueMediaRefresh} from './queue';

const now=Date.parse('2026-10-07T18:20:00Z');
describe('TikTok discovery queue',()=>{
 it('plans only catalog countries with overlapping date boundaries and no zero-day query',()=>{
  const jobs=planJobs(['GB','DE','GB'],{now});
  expect(jobs).toHaveLength(10);
  expect(jobs.slice(0,4).map(j=>[j.country,j.start,j.end])).toEqual([
   ['GB','2026-09-30','2026-10-07'],['DE','2026-09-30','2026-10-07'],
   ['GB','2026-09-23','2026-09-30'],['DE','2026-09-23','2026-09-30'],
  ]);
  expect(jobs.at(-1)).toMatchObject({country:'DE',start:'2026-09-08',end:'2026-09-09'});
  expect(jobs.some(j=>j.country==='US')).toBe(false);
  expect(jobs.every(j=>j.start<j.end)).toBe(true);
 });
 it('supports one-day shards and rejects impossible calendar dates and unsupported sizes',()=>{
  expect(planJobs(['GB'],{start:'2026-10-06',end:'2026-10-07',windowDays:1})).toHaveLength(1);
  expect(()=>planJobs(['GB'],{start:'2026-10-07',end:'2026-10-07'})).toThrow('TIKTOK_RANGE_INVALID');
  expect(()=>planJobs(['GB'],{start:'2026-02-30',end:'2026-03-01'})).toThrow('TIKTOK_RANGE_INVALID');
  expect(()=>planJobs(['GB'],{windowDays:2 as 1})).toThrow('TIKTOK_RANGE_INVALID');
  expect(()=>planJobs([])).toThrow('TIKTOK_COUNTRIES_INVALID');
 });
 it.each([1,2])('prioritizes a due failure-%i retry over an untouched country backlog',failures=>{
  const jobs=planJobs(['GB','DE','FR','IT'],{now,lookbackDays:30});
  Object.assign(jobs[0],{lastAttemptAt:100,retryAt:200,failures});
  expect(nextJob(jobs,200)?.id).toBe(jobs[0].id);
 });
 it.each([3,4,100])('returns failure-%i retries to ordinary rotation so a new country can run',failures=>{
  const jobs=planJobs(['GB','DE'],{now,lookbackDays:1});
  Object.assign(jobs[0],{lastAttemptAt:100,retryAt:200,failures});
  expect(nextJob(jobs,200)?.country).toBe('DE');
  jobs[1].lastAttemptAt=300;expect(nextJob(jobs,300)?.country).toBe('GB');
 });
 it.each([1,2,3])('never selects a failure-%i retry before its retryAt',failures=>{
  const jobs=planJobs(['GB','DE'],{now,lookbackDays:1});
  Object.assign(jobs[0],{lastAttemptAt:100,retryAt:201,failures});
  expect(nextJob(jobs,200)?.country).toBe('DE');
  jobs[1].complete=true;expect(nextJob(jobs,200)).toBeUndefined();
 });
 it('still respects completion and cooldown during ordinary rotation',()=>{
  const jobs=planJobs(['GB','DE'],{now,lookbackDays:1});
  jobs[0].lastAttemptAt=100;jobs[0].failures=3;
  expect(nextJob(jobs,200)?.country).toBe('DE');
  jobs[1].retryAt=300;expect(nextJob(jobs,200)?.country).toBe('GB');
  jobs[0].complete=true;expect(nextJob(jobs,200)).toBeUndefined();
 });
 it('keeps committed partial IDs but does not advance or claim exhaustion',()=>{
  const job=planJobs(['GB'],{now,lookbackDays:1})[0];
  advanceJob(job,{status:'PARTIAL',errorCode:'TIKTOK_TIMEOUT',completedIds:['123','123'],nextPage:4,coverage:{exhausted:true}},now);
  expect(job).toMatchObject({seen:['123'],page:0,complete:false,failures:1,retryAt:now+60000});
  advanceJob(job,{status:'SUCCEEDED',errorCode:null,completedIds:['456'],nextPage:2,coverage:{exhausted:false}},now+60000);
  expect(job).toMatchObject({seen:['123','456'],page:2,complete:false,failures:0});
  advanceJob(job,{status:'SUCCEEDED',errorCode:null,completedIds:[],coverage:{exhausted:true}},now+120000);
  expect(job.complete).toBe(true);
 });
 it('bounds network backoff but never retries sooner than a server Retry-After',()=>{
  const job=planJobs(['GB'],{now,lookbackDays:1})[0];job.failures=100;
  advanceJob(job,{status:'FAILED',errorCode:'TIKTOK_TIMEOUT',completedIds:[],coverage:{exhausted:false}},now);
  expect(job.retryAt).toBe(now+6*3600000);
  advanceJob(job,{status:'FAILED',errorCode:'TIKTOK_HTTP_429',retryAfterMs:12*3600000,completedIds:[],coverage:{exhausted:false}},now);
  expect(job.retryAt).toBe(now+12*3600000);
 });
 it('refreshes recent windows after six hours while retaining unfinished older checkpoints',()=>{
  const jobs=planJobs(['GB'],{now,lookbackDays:30});
  jobs[0].cycleStartedAt=now-6*3600000;jobs[0].seen=['123'];jobs[0].complete=true;jobs[0].page=4;
  jobs[1].cycleStartedAt=now-6*3600000;jobs[1].seen=['456'];jobs[1].page=5;
  refreshJobs(jobs,now);
  expect(jobs[0]).toMatchObject({seen:[],complete:false,page:0,cycleStartedAt:now});
  expect(jobs[1]).toMatchObject({seen:['456'],page:5});
 });
 it('requires operator resume for challenges and login, and cools down rate limits globally',()=>{
  expect(restrictionAction('TIKTOK_SOURCE_CHALLENGE',1)).toEqual({manual:true,delayMs:0});
  expect(restrictionAction('LOGIN_REQUIRED',1)).toEqual({manual:true,delayMs:0});
  expect(restrictionAction('TIKTOK_HTTP_403',1)).toEqual({manual:true,delayMs:0});
  expect(restrictionAction('TIKTOK_HTTP_429',1,7200000)).toEqual({manual:false,delayMs:7200000});
  expect(restrictionAction('TIKTOK_TIMEOUT',1)).toEqual({manual:false,delayMs:0});
 });
 it('does not mutate a checkpoint when the collector returns an invalid next page',()=>{
  const job=planJobs(['GB'],{now,lookbackDays:1})[0],before=structuredClone(job);
  expect(()=>advanceJob(job,{status:'SUCCEEDED',errorCode:null,completedIds:['123'],nextPage:-1,coverage:{exhausted:false}},now)).toThrow('TIKTOK_PAGE_INVALID');
  expect(job).toEqual(before);
 });
 it('retains server cooldown during refresh, even after the refresh interval',()=>{
  const jobs=planJobs(['GB'],{now,lookbackDays:1});jobs[0].cycleStartedAt=now-7*3600000;jobs[0].failures=1;jobs[0].retryAt=now+3600000;jobs[0].seen=['123'];
  refreshJobs(jobs,now);expect(jobs[0]).toMatchObject({retryAt:now+3600000,seen:['123'],failures:1});
 });
 it('never selects or refreshes a superseded parent even when its checkpoint is old and due',()=>{
  const jobs=planJobs(['GB','DE'],{now,lookbackDays:1});
  Object.assign(jobs[0],{superseded:true,cycleStartedAt:now-7*3600000,seen:['123'],page:7});
  expect(nextJob(jobs,now)?.country).toBe('DE');
  refreshJobs(jobs,now);expect(jobs[0]).toMatchObject({seen:['123'],page:7,complete:false,cycleStartedAt:now-7*3600000});
 });
 it('selects a due bounded media refresh before an untouched discovery backlog',()=>{
  const jobs=planJobs(['GB','DE'],{now,lookbackDays:1});
  jobs.push({...jobs[0],id:'MEDIA_REFRESH:1878345342543026',kind:'MEDIA_REFRESH',sourceAdIds:['1878345342543026']} as any);
  expect(nextJob(jobs,now)?.id).toBe('MEDIA_REFRESH:1878345342543026');
 });
 it('finishes a successful targeted refresh without claiming full-source exhaustion',()=>{
  const job:any={...planJobs(['GB'],{now,lookbackDays:1})[0],kind:'MEDIA_REFRESH',sourceAdIds:['1878345342543026']};
  advanceJob(job,{status:'SUCCEEDED',errorCode:null,completedIds:['1878345342543026'],coverage:{exhausted:false}},now);
  expect(job.complete).toBe(true);
  refreshJobs([job],now+7*3600000);expect(job.complete).toBe(true);expect(job.seen).toEqual(['1878345342543026']);
 });
 it('keeps a failed media refresh checkpoint and its retry time during later candidate scans',()=>{
  const jobs=planJobs(['GB'],{now,lookbackDays:1}),candidate={sourceAdId:'1878345342543026',country:'GB',startDate:'2026-10-06',endDate:'2026-10-07'};
  enqueueMediaRefresh(jobs,[candidate],now);const job=jobs.at(-1)!;advanceJob(job,{status:'FAILED',errorCode:'TIKTOK_TIMEOUT',completedIds:[],coverage:{exhausted:false}},now);const before=structuredClone(job);
  enqueueMediaRefresh(jobs,[candidate],now+3600000);expect(jobs.at(-1)).toEqual(before);
  expect(()=>enqueueMediaRefresh(jobs,[candidate,candidate,candidate],now)).toThrow('TIKTOK_MEDIA_REFRESH_LIMIT');expect(jobs).toHaveLength(2);
 });
});
