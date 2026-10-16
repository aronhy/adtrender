import {it,expect} from 'vitest';
import {mergeCandidates,recordDiscovery,queueSummary,makeJob,nextJob,advance,prepare,DAY} from './queue';

it('adds candidates beyond the starter list without resetting existing progress',()=>{
 const old=makeJob('Nike');old.seen=['committed'];old.nextUrl='https://adsapi.snapchat.com/v1/ads_library/ads/search?cursor=saved';old.retryAt=99;
 const jobs=[old];const candidates=Array.from({length:80},(_,i)=>({publisher:`Independent shop ${i}`,sources:['google_ads_transparency']}));
 mergeCandidates(jobs,[...candidates,{publisher:' nike ',sources:['meta_ad_library']},{publisher:'',sources:['meta_ad_library']}],10);
 expect(jobs).toHaveLength(81);expect(jobs[0]).toMatchObject({seen:['committed'],retryAt:99,nextUrl:'https://adsapi.snapchat.com/v1/ads_library/ads/search?cursor=saved'});
 expect(jobs[1]).toMatchObject({publisher:'Independent shop 0',kind:'CANDIDATE',candidateSources:['google_ads_transparency']});
 expect(queueSummary(jobs).confirmedPublishers).toBe(0);
});

it('confirms only Snapchat observations and expands actual payer and brand names',()=>{
 const job=makeJob('Example');const jobs=[job];
 recordDiscovery(jobs,job,[{advertiserName:'Example Europe GmbH',brand:'Example Shop'}],20);
 expect(job.confirmedAt).toBe(20);expect(job.kind).toBe('WATCH');expect(jobs.map(j=>j.publisher)).toEqual(['Example','Example Europe GmbH','Example Shop']);
 expect(queueSummary(jobs)).toMatchObject({publishers:3,confirmedPublishers:1,candidatePublishers:2,unvisitedPublishers:3});
 mergeCandidates(jobs,[{publisher:'EXAMPLE EUROPE GMBH',sources:['meta_ad_library']}],30);
 expect(jobs).toHaveLength(3);expect(jobs[1].candidateSources).toEqual(['snapchat_ads_gallery','meta_ad_library']);
});

it('continues discovery and known-ad monitoring fairly while respecting cooldown',()=>{
 const watch=makeJob('Nike');const jobs=[watch];mergeCandidates(jobs,[{publisher:'Fresh shop',sources:['pinterest_ads_repository']}],1);
 expect(nextJob(jobs,100,0,0,'WATCH')).toBe(jobs[1]);
 expect(nextJob(jobs,100,0,0,'CANDIDATE')).toBe(watch);
 expect(nextJob(jobs,100,101,0,'WATCH')).toBeUndefined();
 expect(nextJob(jobs,100,0,101,'WATCH')).toBeUndefined();
 watch.retryAt=101;expect(nextJob(jobs,100,0,0,'CANDIDATE')).toBe(jobs[1]);
});

it('retries empty candidate names weekly without falsely confirming or losing source cursors',()=>{
 const jobs:ReturnType<typeof makeJob>[]=[];mergeCandidates(jobs,[{publisher:'New shop',sources:['google_ads_transparency']}],1);const j=jobs[0];
 advance(j,{completedIds:[],status:'NO_RESULTS',errorCode:null,exhausted:true},100);
 expect(j.retryAt).toBe(100+7*DAY);expect(queueSummary(jobs).confirmedPublishers).toBe(0);
 prepare(j,j.retryAt);expect(j.complete).toBe(false);expect(j.seen).toEqual([]);
 recordDiscovery(jobs,j,[{advertiserName:'New shop',brand:null}],200);
 advance(j,{completedIds:['snap-ad'],status:'SUCCEEDED',errorCode:null,exhausted:true},200);
 expect(j.retryAt).toBe(200+DAY);expect(j.confirmedAt).toBe(200);
});

it('rejects malformed feeds before adding any jobs, but preserves normal Unicode names',()=>{
 const jobs=[makeJob('Nike')];
 expect(()=>mergeCandidates(jobs,[{publisher:'Valid',sources:['meta_ad_library']},{publisher:'Invalid',sources:'bad'}] as never,1)).toThrow('SNAP_CANDIDATES_INVALID');
 expect(jobs).toHaveLength(1);
 mergeCandidates(jobs,[{publisher:' 美妆 商店 ',sources:['public-brand-catalog']},{publisher:'a\nsecret',sources:['catalog']}],1);
 expect(jobs.map(j=>j.publisher)).toEqual(['Nike','美妆 商店']);
});
