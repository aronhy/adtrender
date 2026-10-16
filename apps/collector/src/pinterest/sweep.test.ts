import {describe,it,expect} from 'vitest';
import {planSweep,nextShard,backoffMs} from './sweep';
describe('full public Pinterest coverage',()=>{
 it('covers every day and discovered country with bounded inclusive windows',()=>{
  const jobs=planSweep(['DE','AT'],'2025-10-07','2026-10-07');
  expect(jobs.length).toBe(106);
  for(const country of ['DE','AT']){
   const days=new Set<number>();
   for(const j of jobs.filter(j=>j.country===country)){const s=Date.parse(j.start),e=Date.parse(j.end);expect(e-s).toBeLessThan(7*86400000);for(let t=s;t<=e;t+=86400000)days.add(t);}
   expect(days.size).toBe(366);
  }
  expect(jobs.every(j=>j.keyword===''&&j.category==='ALL')).toBe(true);
 });
 it('rotates among shards and does not mark unprocessed history complete',()=>{
  const jobs=planSweep(['AT','DE'],'2026-10-01','2026-10-07');
  jobs[0].lastAttemptAt=100;
  expect(nextShard(jobs,1000)?.country).toBe('DE');
  jobs[1].retryAt=2000;
  expect(nextShard(jobs,1000)?.country).toBe('AT');
  expect(jobs.every(j=>!j.complete)).toBe(true);
 });
 it('backs off failures within a finite maximum',()=>{
  expect(backoffMs(1)).toBe(60000);expect(backoffMs(99)).toBe(21600000);
 });
});
import {advanceShard} from './sweep';
describe('durable cursor advancement',()=>{
 it('keeps partial pages pending and advances only the committed successful page',()=>{
  const job=planSweep(['AT'],'2026-10-01','2026-10-07')[0];
  advanceShard(job,{status:'PARTIAL',errorCode:'TIMEOUT',nextPage:1,exhausted:true},100);
  expect(job.page).toBe(0);expect(job.complete).toBe(false);expect(job.retryAt).toBe(60100);
  advanceShard(job,{status:'SUCCEEDED',errorCode:null,nextPage:1,exhausted:false},200);
  expect(job.page).toBe(1);expect(job.complete).toBe(false);expect(job.failures).toBe(0);
 });
 it('requires an explicit end-of-pagination result to finish a shard',()=>{
  const job=planSweep(['AT'],'2026-10-01','2026-10-07')[0];
  advanceShard(job,{status:'SUCCEEDED',errorCode:null,nextPage:2,exhausted:true},200);
  expect(job.complete).toBe(true);
 });
});
describe('failed shard recovery',()=>{
 it('retries due failures before a large untouched historical backlog',()=>{
  const jobs=planSweep(['AT','BE'],'2025-10-07','2026-10-07');
  jobs[0].lastAttemptAt=100;jobs[0].failures=1;jobs[0].retryAt=200;
  expect(nextShard(jobs,250)?.id).toBe(jobs[0].id);
 });
 it('gives an untouched shard a turn among continuously due persistent failures without resetting native progress',()=>{
  const jobs=planSweep(['DE'],'2026-01-01','2026-05-31'),untouched=jobs[jobs.length-1];
  for(const [index,job] of jobs.slice(0,-1).entries())Object.assign(job,{failures:20,page:index+1,lastAttemptAt:100+index,retryAt:200});
  const progress=jobs.map(({id,page,failures,retryAt,complete})=>({id,page,failures,retryAt,complete})),visits=new Set<string>();
  expect(nextShard(jobs,1000)?.id).toBe(untouched.id);
  for(let turn=0;turn<jobs.length;turn++){const selected=nextShard(jobs,1000+turn)!;visits.add(selected.id);selected.lastAttemptAt=1000+turn;}
  expect(visits.size).toBe(jobs.length);expect(visits.has(untouched.id)).toBe(true);
  expect(jobs.map(({id,page,failures,retryAt,complete})=>({id,page,failures,retryAt,complete}))).toEqual(progress);
 });
 it.each([1,2])('keeps retry %s priority only after its native retryAt',failures=>{
  const jobs=planSweep(['AT','DE'],'2026-10-01','2026-10-07');Object.assign(jobs[0],{failures,lastAttemptAt:100,retryAt:200,page:3});
  expect(nextShard(jobs,199)?.id).toBe(jobs[1].id);expect(nextShard(jobs,200)?.id).toBe(jobs[0].id);
  expect(jobs[0]).toMatchObject({failures,lastAttemptAt:100,retryAt:200,page:3});
 });
});
