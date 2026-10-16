import {it,expect} from 'vitest';
import {keywordSeeds,publisherCandidates,platformStrategy,seedCategories,COUNTRY_CODES} from './catalog';

it('expands all three directions across the country baseline without claiming advertising coverage',()=>{
 expect(COUNTRY_CODES).toContain('BR');expect(COUNTRY_CODES).toContain('PL');expect(COUNTRY_CODES).toContain('JP');expect(COUNTRY_CODES.length).toBeGreaterThan(240);
 const seeds=keywordSeeds(['BR','MX','DE','FR','JP','PL','TW']);
 for(const country of ['BR','MX','DE','FR','JP','PL','TW'])for(const family of ['ECOMMERCE','GAMES','COMICS'])expect(seeds.some(s=>s.country===country&&s.family===family)).toBe(true);
 expect(seeds.some(s=>s.country==='BR'&&s.keyword==='caça-níqueis'&&s.family==='GAMES')).toBe(true);
 expect(seeds.some(s=>s.country==='MX'&&s.keyword==='tragamonedas')).toBe(true);
 expect(seeds.some(s=>s.country==='DE'&&s.keyword==='spielautomaten')).toBe(true);
 expect(seeds.some(s=>s.country==='JP'&&s.keyword==='スロット')).toBe(true);
 expect(seeds.some(s=>s.country==='TW'&&s.keyword==='漫劇'&&s.family==='COMICS')).toBe(true);
 expect(seeds.some(s=>s.country==='BR'&&s.keyword==='quadrinhos animados')).toBe(true);
 expect(new Set(seeds.map(s=>JSON.stringify([s.country,s.language,s.keyword]))).size).toBe(seeds.length);
});

it('keeps both slot types in one category without payment-type labels',()=>{
 const slot=seedCategories.find(s=>s.id==='slots')!;
 expect(slot.keywords).toContain('free coins');expect(slot.keywords).toContain('no deposit bonus');
 expect(seedCategories.some(s=>/real-money|social-slots|free-slots/.test(s.id))).toBe(false);
 expect(Object.keys(slot)).toEqual(['id','family','keywords']);
});

it('uses verified products as clues, never as invented platform advertiser identities',()=>{
 const candidates=publisherCandidates();expect(candidates.some(c=>c.publisher==='ToonShort')).toBe(true);expect(candidates.some(c=>c.publisher==='Slotomania')).toBe(true);
 for(const c of candidates){expect(c.sources).toEqual(['research_seed_catalog']);expect(c.sourceUrl).toMatch(/^https:\/\//);expect(c).not.toHaveProperty('advertiserId');expect(c).not.toHaveProperty('paymentType');}
});

it('preserves platform capabilities instead of pretending every library searches keywords',()=>{
 expect(platformStrategy('META')).toBe('KEYWORD');expect(platformStrategy('GOOGLE')).toBe('NAME_AND_DOMAIN');
 expect(platformStrategy('SNAPCHAT')).toBe('PUBLISHER_NAME');expect(platformStrategy('TIKTOK')).toBe('COUNTRY_DATE_SWEEP');expect(platformStrategy('PINTEREST')).toBe('COUNTRY_DATE_SWEEP');
 expect(()=>keywordSeeds(['NOT_A_COUNTRY'])).toThrow('SEED_COUNTRIES_INVALID');
});
