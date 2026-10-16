import {it,expect} from 'vitest';
import {seedJobs,mergeSeedJobs,seedQueueSummary,nextJob,buildSearchUrl,discoverJobs} from './queue';

it('discovers commerce, slot games and comic dramas in every configured market',()=>{
 const jobs=seedJobs();const countries=[...new Set(jobs.map(j=>j.country))];
 for(const country of countries){for(const keyword of ['pet supplies','baby products','car accessories','skin care','furniture','slots','free spins','download app','motion comic','animated short drama','ToonShort']){
  expect(jobs.some(j=>j.country===country&&j.keyword===keyword)).toBe(true);
 }}
 expect(jobs.some(j=>j.country==='MX'&&j.keyword==='tragamonedas'&&j.seedFamilies?.includes('GAMES'))).toBe(true);
 expect(jobs.some(j=>j.country==='TW'&&j.keyword==='寵物用品'&&j.seedFamilies?.includes('ECOMMERCE'))).toBe(true);
 expect(jobs.some(j=>j.country==='SG'&&j.keyword==='漫剧'&&j.seedFamilies?.includes('COMICS'))).toBe(true);
 expect(new Set(jobs.map(j=>j.id)).size).toBe(jobs.length);
});

it('searches all available ad statuses and media without a named-brand or placement restriction',()=>{
 const j=seedJobs().find(j=>j.country==='US'&&j.keyword==='download app')!;const url=new URL(buildSearchUrl(j));
 expect(url.searchParams.get('active_status')).toBe('all');expect(url.searchParams.get('ad_type')).toBe('all');expect(url.searchParams.get('media_type')).toBe('all');
 expect(url.searchParams.get('q')).toBe('download app');expect(url.searchParams.has('publisher_platforms')).toBe(false);
});

it('merges a wider catalog without resetting old evidence, retries or advertiser children',()=>{
 const j={...seedJobs()[0],seen:['12345'],dueAt:900,lastAttemptAt:500,failures:1,cycleStartedAt:400};
 delete j.seedFamilies;delete j.seedCategories;
 const jobs=[j];discoverJobs(jobs,j,[{advertiserPageUrl:'https://www.facebook.com/profile.php?id=987654321'}]);
 mergeSeedJobs(jobs);
 expect(jobs[0]).toMatchObject({seen:['12345'],dueAt:900,lastAttemptAt:500,failures:1,cycleStartedAt:400,seedFamilies:['ECOMMERCE']});
 expect(jobs.filter(x=>x.pageId==='987654321')).toHaveLength(1);
 const summary=seedQueueSummary(jobs);expect(summary.bySeedFamily.ECOMMERCE).toBeGreaterThan(0);expect(summary.bySeedFamily.GAMES).toBeGreaterThan(0);expect(summary.bySeedFamily.COMICS).toBeGreaterThan(0);expect(summary.advertiserJobs).toBe(1);
});

it('alternates the three primary directions and advertiser follow-up',()=>{
 const commerce=seedJobs().find(j=>j.keyword==='pet supplies')!,game=seedJobs().find(j=>j.keyword==='slots')!,comic=seedJobs().find(j=>j.keyword==='motion comic')!;
 const jobs=[commerce,game,comic];discoverJobs(jobs,commerce,[{advertiserPageUrl:'https://www.facebook.com/profile.php?id=987654321'}]);
 expect(nextJob(jobs,100,'ECOMMERCE')).toBe(game);expect(nextJob(jobs,100,'GAMES')).toBe(comic);expect(nextJob(jobs,100,'COMICS')).toBe(jobs[3]);expect(nextJob(jobs,100,'ADVERTISER')).toBe(commerce);
 game.dueAt=200;expect(nextJob(jobs,100,'ECOMMERCE')).toBe(comic);
});
