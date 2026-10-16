import {it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {loadCandidateFeed} from './candidates';import {mergeCandidates,seedJobs} from './queue';

it('loads a refreshed public name catalog and expands an existing checkpoint',async()=>{
 const root=await mkdtemp(join(tmpdir(),'snap-candidates-'));
 try{const file=join(root,'advertiser-candidates.json');await writeFile(file,JSON.stringify({schema:1,generatedAt:'2026-10-09T00:00:00.000Z',candidates:[{publisher:'Independent Berlin Store',sources:['google_ads_transparency']}]}));
 const feed=await loadCandidateFeed(file,Date.parse('2026-10-09T01:00:00Z'));const jobs=seedJobs();jobs[0].seen=['old'];mergeCandidates(jobs,feed.candidates,1);
 expect(jobs).toHaveLength(13);expect(jobs[0].seen).toEqual(['old']);expect(feed.stale).toBe(false);
 const stale=await loadCandidateFeed(file,Date.parse('2026-10-12T00:00:00Z'));expect(stale.stale).toBe(true);
 await writeFile(file,JSON.stringify({schema:1,generatedAt:'2026-10-09T02:00:00.000Z',candidates:[{publisher:'Second Store',sources:['pinterest_ads_repository']}]}));
 mergeCandidates(jobs,(await loadCandidateFeed(file,Date.parse('2026-10-09T02:01:00Z'))).candidates,2);expect(jobs).toHaveLength(14);
 }finally{await rm(root,{recursive:true,force:true});}
});

it('rejects invalid dates, provenance and truncated catalogs instead of silently using them',async()=>{
 const root=await mkdtemp(join(tmpdir(),'snap-bad-candidates-'));const file=join(root,'feed.json');
 try{for(const value of [{schema:1,generatedAt:'invalid',candidates:[]},{schema:1,generatedAt:'2026-10-09T00:00:00Z',candidates:[{publisher:'Shop',sources:[]}]},{schema:1,generatedAt:'2026-10-09T00:00:00Z',candidates:[],truncated:true}]){
 await writeFile(file,JSON.stringify(value));await expect(loadCandidateFeed(file,Date.parse('2026-10-09T01:00:00Z'))).rejects.toThrow('SNAP_CANDIDATES_INVALID');
 }}finally{await rm(root,{recursive:true,force:true});}
});
