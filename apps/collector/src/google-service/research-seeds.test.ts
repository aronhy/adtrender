import {it,expect} from 'vitest';import {seedJobs,mergeSeedJobs,makeJob,nextJob,buildUrl,discover} from './queue';
it('uses product names and verified domains for ATC, and content words for sponsored SERP discovery',()=>{
 const jobs=seedJobs();expect(jobs.some(j=>j.kind==='SERP'&&j.country==='BR'&&j.term==='caça-níqueis')).toBe(true);
 expect(jobs.some(j=>j.kind==='SERP'&&j.term==='motion comic')).toBe(true);
 expect(jobs.some(j=>j.kind==='DISCOVER'&&j.term==='ToonShort'&&j.seedFamily==='COMICS')).toBe(true);
 expect(jobs.some(j=>j.kind==='YOUTUBE'&&j.domain==='toonbox.com')).toBe(true);
 expect(jobs.some(j=>j.kind==='DISCOVER'&&j.term==='no deposit bonus')).toBe(false);
 const slot=jobs.find(j=>j.kind==='SEARCH'&&j.domain==='slotomania.com')!;expect(new URL(buildUrl(slot)).searchParams.get('domain')).toBe('slotomania.com');
});
it('carries query-purpose metadata to native advertiser children while giving older untagged work a turn',()=>{
 const parent={...makeJob('DISCOVER','US','en','Slotomania'),seedFamily:'GAMES' as const,seedCategory:'slots'};const children=[parent];
 discover(children,parent,[{advertiserId:'AR123456',name:'Known payer',sourceUrl:'https://adstransparency.google.com/advertiser/AR123456'}]);
 expect(children.find(j=>j.kind==='SEARCH')?.seedFamily).toBe('GAMES');
 const old=makeJob('SERP','US','en','old query'),primary={...makeJob('SERP','US','en','pet supplies'),seedFamily:'ECOMMERCE' as const};
 expect(nextJob([primary,old],100,{ATC:0,SERP:0},'YOUTUBE',0,'COMICS')).toBe(old);
});
it('merges new directions without resetting old native identities, cursors or cooldowns',()=>{
 const old=makeJob('SEARCH','US','en','','AR123456');old.cursor={page:3,row:2};old.seen=['CR123456'];old.dueAt=999;
 const jobs=[old];mergeSeedJobs(jobs);expect(jobs[0]).toMatchObject({advertiserId:'AR123456',cursor:{page:3,row:2},seen:['CR123456'],dueAt:999});
});
it('rotates primary seed directions within a kind without bypassing lane restrictions',()=>{
 const jobs=seedJobs().filter(j=>j.kind==='SERP');const picked=nextJob(jobs,100,{ATC:0,SERP:0},'YOUTUBE',0,'ECOMMERCE');expect(picked?.seedFamily).toBe('GAMES');
 expect(nextJob(jobs,100,{ATC:0,SERP:200},'YOUTUBE',0,'ECOMMERCE')).toBeUndefined();
});
