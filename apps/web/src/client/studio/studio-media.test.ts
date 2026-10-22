import { describe, expect, it } from 'vitest';
import { nextStudioMedia,studioMediaCandidates } from './studio-media';
import { safeStudioAdsReturn } from './studio-navigation';
describe('studio media display after a temporary failed request',()=>{
  it('does not let an unavailable first item hide a later ready image',()=>{const rows=studioMediaCandidates([{id:'unavailable',type:'IMAGE',status:'UNAVAILABLE',displayUrl:'https://example.test/failed.jpg'},{id:'actual',type:'IMAGE',status:'READY',displayUrl:'https://example.test/actual.jpg'}]);expect(rows.map(m=>m.id)).toEqual(['actual']);});
  it('falls back from a failed video to its ready image, and retry restores the original candidate',()=>{const rows=studioMediaCandidates([{id:'video',type:'VIDEO',status:'READY',displayUrl:'https://example.test/ad.mp4'},{id:'image',type:'IMAGE',status:'READY',displayUrl:'https://example.test/poster.jpg'}]);expect(nextStudioMedia(rows,[])?.type).toBe('VIDEO');expect(nextStudioMedia(rows,['https://example.test/ad.mp4'])?.type).toBe('IMAGE');expect(nextStudioMedia(rows,rows.map(m=>m.url))).toBe(undefined);expect(nextStudioMedia(rows,[])?.url).toBe('https://example.test/ad.mp4');});
  it('newly refreshed URLs are not hidden by failures of an older signed URL',()=>{const rows=studioMediaCandidates([{id:'image',type:'IMAGE',status:'READY',displayUrl:'https://example.test/poster.jpg?version=2'}]);expect(nextStudioMedia(rows,['https://example.test/poster.jpg?version=1'])?.id).toBe('image');});
});
describe('studio safe return navigation',()=>{
  it('retains business filters and ordinary pagination for the current ad library',()=>{const result=safeStudioAdsReturn('/app/ads?q=iHerb&channel=facebook&format=image&cursor=abc&page=2&workspace=local');expect(result).toBe('/app/ads?q=iHerb&channel=facebook&format=image&cursor=abc&page=2&workspace=local');});
  it('removes internal provider scopes and their bound pagination from customer return links',()=>{
    expect(safeStudioAdsReturn('/app/ads?workspace=local&source=bigspy&channel=facebook&q=creative&page=3&cursor=abc')).toBe('/app/ads?workspace=local&channel=facebook&q=creative');
    for(const source of ['bigspy','adflex','meta_ad_library','provider_future-2','a'.repeat(100)])expect(safeStudioAdsReturn('/app/ads?source='+source)).toBe('/app/ads');
    expect(safeStudioAdsReturn('/app/ads?channel=facebook&page=3&cursor=abc')).toBe('/app/ads?channel=facebook&page=3&cursor=abc');
  });
  it('drops malformed or ambiguous provider parameters while preserving safe list state',()=>{
    for(const source of ['','UPPER','https://evil.test','//evil.test','bigspy<script>','../bigspy','x'.repeat(101),'bigspy\n'])expect(safeStudioAdsReturn('/app/ads?q=creative&channel=facebook&source='+encodeURIComponent(source))).toBe('/app/ads?q=creative&channel=facebook');
    expect(safeStudioAdsReturn('/app/ads?source=bigspy&source=adflex&q=creative')).toBe('/app/ads?q=creative');
    expect(safeStudioAdsReturn('/app/ads?source=bigspy&returnTo=https://evil.test')).toBe('/app/ads');
  });
  it('rejects external, source, control-character and detail routes and strips nested redirects',()=>{for(const url of ['https://evil.test/app/ads','//evil.test/app/ads','/app/ads/other','/app/ads/../account','/app/ads\\evil','/app/ads\n'])expect(safeStudioAdsReturn(url)).toBe(null);expect(safeStudioAdsReturn('/app/ads?q=bag&returnTo=https://evil.test')).toBe('/app/ads?q=bag');});
});
