import { describe, expect, it } from 'vitest';
import { aggregateCatalog, captureSpan, catalogAdvertiserDomains, catalogHistoryWhere, landingDomain, normalizedPlatforms, observationTrend, safeLandingUrl, type CatalogRow } from './catalog-data';

const row=(id:string,extra:Partial<CatalogRow>={}):CatalogRow=>({id,advertiserId:'brand-a',publisherPlatforms:['FACEBOOK'],mediaType:'IMAGE',sourceStatus:'ACTIVE',firstObservedAt:'2026-10-21T17:00:00Z',lastObservedAt:'2026-10-22T00:00:00Z',landingPageUrl:'https://shop.example/products/bag',createdAt:'2026-10-21T17:00:00Z',...extra});
describe('studio public catalog aggregation',()=>{
  it('uses actual landing sites ahead of social source page domains and labels source-only identities separately',()=>{
    expect(catalogAdvertiserDomains(['https://shopify.com/products'], 'facebook.com','https://facebook.com/advertiser')).toEqual({domain:'shopify.com',sourcePageDomain:'facebook.com'});
    expect(catalogAdvertiserDomains([], 'facebook.com','https://facebook.com/advertiser')).toEqual({domain:null,sourcePageDomain:'facebook.com'});
  });
  it('counts records independently rather than merging source advertiser identities',()=>{
    const result=aggregateCatalog([row('a'),row('b',{advertiserId:'same-name-other-source'}),row('c',{advertiserId:null,sourceStatus:'UNKNOWN'})],new Date('2026-10-22T01:00:00Z'));
    expect(result.stats).toEqual({ads:3,advertisers:2,active:2,images:3,videos:0,landingPages:1});
    expect(result).not.toHaveProperty('spend');expect(result).not.toHaveProperty('reach');expect(result).not.toHaveProperty('products');
  });
  it('counts one ad once per disclosed channel while preserving overlapping placements',()=>{
    const result=aggregateCatalog([row('a',{publisherPlatforms:['Facebook','FACEBOOK','INSTAGRAM']}),row('b',{publisherPlatforms:[]})]);
    expect(result.channels.find(r=>r.id==='facebook')?.count).toBe(1);
    expect(result.channels.find(r=>r.id==='instagram')?.count).toBe(1);
    expect(result.stats.ads).toBe(2);
    expect(result.channels.some(r=>['meta','microsoft','unknown'].includes(r.id))).toBe(false);
  });
  it('uses observed publisher platforms and never invents a default Facebook channel',()=>{
    expect(normalizedPlatforms([])).toEqual([]);expect(normalizedPlatforms(['META','Microsoft','unknown'])).toEqual([]);
    expect(normalizedPlatforms(['Audience Network','audience_network','YouTube','SEARCH','DISPLAY'])).toEqual(['audience_network','youtube','google']);
  });
  it('uses the Beijing date for capture trends and fills only the selected thirty-day window',()=>{
    const result=aggregateCatalog([row('a'),row('b',{firstObservedAt:'2026-10-21T15:59:00Z'}),row('older',{firstObservedAt:'2025-01-01T00:00:00Z'})],new Date('2026-10-22T01:00:00Z'));
    expect(result.trend).toHaveLength(30);expect(result.trend[29]).toEqual({date:'2026-10-22',count:1});expect(result.trend[28]).toEqual({date:'2026-10-21',count:1});
    expect(result.stats.ads).toBe(3);expect(result.trend.reduce((s,r)=>s+r.count,0)).toBe(2);
  });
  it('retains distinct real landing URLs and rejects executable or credential URLs',()=>{
    const result=aggregateCatalog([row('a'),row('b',{landingPageUrl:'https://shop.example/products/bag?variant=2'}),row('c',{landingPageUrl:'javascript:alert(1)'})]);
    expect(result.stats.landingPages).toBe(2);expect(result.landingPages.every(r=>r.domain==='shop.example')).toBe(true);
    expect(safeLandingUrl('javascript:alert(1)')).toBe(null);expect(safeLandingUrl('https://user:secret@example.com')).toBe(null);expect(safeLandingUrl('/relative')).toBe(null);
    expect(landingDomain('https://WWW.Shop.Example/a')).toBe('shop.example');
  });
  it('does not mutate source records during catalog aggregation',()=>{
    const rows=[row('a'),row('b',{publisherPlatforms:['TIKTOK','INSTAGRAM']})],before=JSON.stringify(rows);aggregateCatalog(rows);expect(JSON.stringify(rows)).toBe(before);
  });
});
describe('studio capture period display',()=>{
  it('includes capture and current Beijing calendar day',()=>{expect(captureSpan('2026-10-21T15:59:00Z',new Date('2026-10-21T16:01:00Z'))).toEqual({start:'2026-10-21',end:'2026-10-22',days:2});});
  it('keeps a same-day capture as one day',()=>{expect(captureSpan('2026-10-22T00:00:00Z',new Date('2026-10-22T10:00:00Z'))?.days).toBe(1);});
  it('leaves missing, invalid, future or invalid-now periods unavailable',()=>{for(const value of [null,'bad-date','2027-01-01'])expect(captureSpan(value,new Date('2026-10-22T00:00:00Z'))).toBe(null);expect(captureSpan('2026-10-22',new Date('bad'))).toBe(null);});
});
describe('studio history follows the visible ad scope',()=>{
  it('adds observation counts from distinct scopes into a single chronological daily chart',()=>{expect(observationTrend([{day:'2026-10-22',observationCount:2},{day:'2026-10-21',observationCount:1},{day:'2026-10-22',observationCount:3}])).toEqual([{date:'2026-10-21',count:1},{date:'2026-10-22',count:5}]);});
  it('retains all advertiser, channel, date and text filters in the history relation',()=>{
    const where={quarantinedAt:null,advertiserId:{in:['followed-a','followed-b']},publisherPlatforms:{hasSome:['INSTAGRAM']},firstObservedAt:{gte:new Date('2026-10-01')},OR:[{headline:{contains:'bags',mode:'insensitive'}}]};
    expect(catalogHistoryWhere(where)).toEqual({ad:where});expect(where).not.toHaveProperty('id');
  });
  it('limits domain history to exactly matched ads, including an empty domain result',()=>{
    const base={quarantinedAt:null,advertiserId:'selected-advertiser'};
    expect(catalogHistoryWhere(base,['domain-match'])).toEqual({ad:{...base,id:{in:['domain-match']}}});
    expect(catalogHistoryWhere(base,[])).toEqual({ad:{...base,id:{in:[]}}});
  });
});
