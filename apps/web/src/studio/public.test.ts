import {beforeEach,describe,expect,it,vi} from 'vitest';
const fixture=vi.hoisted(()=>({adCount:vi.fn(),brandCount:vi.fn(),mediaCount:vi.fn(),ads:vi.fn()}));
vi.mock('wasp/server',()=>({prisma:{ad:{count:fixture.adCount,findMany:fixture.ads},advertiser:{count:fixture.brandCount},mediaObject:{count:fixture.mediaCount}}}));
vi.mock('../server/views',async importOriginal=>({...await importOriginal<typeof import('../server/views')>(),mediaView:vi.fn()}));
import {getStudioPublicOverview,getCustomerSnapshot} from './public';
beforeEach(()=>{vi.clearAllMocks();fixture.adCount.mockResolvedValue(0);fixture.brandCount.mockResolvedValue(0);fixture.mediaCount.mockResolvedValue(0);fixture.ads.mockResolvedValue([]);});
describe('anonymous studio overview public catalog boundary',()=>{
 it('excludes quarantined ads from counts and featured creatives across the public catalog',async()=>{
  const result=await getStudioPublicOverview();expect(result.counts).toEqual({ads:0,advertisers:0,media:0});
  for(const where of [fixture.adCount.mock.calls[0][0].where,fixture.ads.mock.calls[0][0].where])expect(where.quarantinedAt).toBeNull();
  expect(fixture.brandCount.mock.calls[0][0].where.ads.some).toEqual({quarantinedAt:null});
  expect(fixture.mediaCount.mock.calls[0][0].where.ad).toEqual({quarantinedAt:null});
 });
 it('keeps an observed advertiser name without requiring a related advertiser record',async()=>{
  fixture.ads.mockResolvedValue([{id:'observed-name',advertiser:null,fieldProvenance:{advertiserName:{value:' Observed Brand '}},headline:'Creative',body:null,landingPageUrl:null,publisherPlatforms:['Facebook'],mediaType:'IMAGE',media:[]}]);
  const result=await getStudioPublicOverview();expect(result.ads).toHaveLength(1);expect(result.ads[0].advertiserName).toBe('Observed Brand');expect(result.counts.advertisers).toBe(0);
 });
 it('leaves a missing advertiser name empty for the customer UI fallback',async()=>{
  fixture.ads.mockResolvedValue([{id:'unnamed',advertiser:null,fieldProvenance:{},headline:'Creative',body:null,landingPageUrl:null,publisherPlatforms:['Facebook'],mediaType:'IMAGE',media:[]}]);
  const result=await getStudioPublicOverview();expect(result.ads[0].advertiserName).toBeNull();
 });
 it('applies the existing homepage language filter to observed advertiser names',async()=>{
  fixture.ads.mockResolvedValue([{id:'observed-arabic',advertiser:null,fieldProvenance:{advertiserName:{value:'علامة تجارية'}},headline:'Creative',body:null,landingPageUrl:null,publisherPlatforms:['Facebook'],mediaType:'IMAGE',media:[]}]);
  const result=await getStudioPublicOverview();expect(result.ads).toEqual([]);
 });
});

it('reports that this public frontend has no customer snapshot service',async()=>{expect(await getCustomerSnapshot()).toEqual({snapshotId:null,asOf:null,enabled:false});expect(fixture.adCount).not.toHaveBeenCalled();});
