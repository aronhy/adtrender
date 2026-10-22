import { describe, expect, it } from 'vitest';
import { studioAdsCsv } from './ads-export';
import type { AdView } from '../types';
describe('local studio ad CSV export',()=>{
  it('exports only provided real records without introducing effects or spend',()=>{
    const fixture={sourceAdId:'ad-1',advertiserName:'A, B',headline:'"Sale"',copy:'=HYPERLINK("bad")',publisherPlatforms:['Facebook','Instagram'],status:'unknown',firstObservedAt:null,lastObservedAt:null,sourceUrl:'https://example.test/ad',landingPageUrl:null} as AdView;
    const csv=studioAdsCsv([fixture]);expect(csv).toContain('"A, B"');expect(csv).toContain('""Sale""');expect(csv).toContain('"\'=HYPERLINK');expect(csv.split('\r\n')).toHaveLength(2);expect(csv).not.toContain('估算');expect(csv).not.toContain('曝光');
  });
  it('exports the integrated customer library without supplier identities or supplier URLs',()=>{const ad={id:'material-42',sourceAdId:'warehouse:internal-hash',dataSourceKey:'bigspy',advertiserName:'Brand',publisherPlatforms:['Facebook'],status:'unknown',firstObservedAt:null,lastObservedAt:null,sourceUrl:'https://app.bigspy.com/zh/adspy/ad-library',landingPageUrl:'https://shop.example/item'} as AdView;const csv=studioAdsCsv([ad]);expect(csv.split('\r\n')[0]).toContain('素材编号');expect(csv).toContain('material-42');expect(csv).not.toMatch(/数据来源|来源键|来源广告编号|bigspy|warehouse:internal-hash/i);expect(csv).toContain('Facebook');expect(csv).toContain('https://shop.example/item');});
  it('retains an actual public platform ad link while removing provider landing links',()=>{const ad={id:'material-native',sourceAdId:'native-id',dataSourceKey:'adflex',publisherPlatforms:['Facebook'],sourceUrl:'https://www.facebook.com/ads/library/?id=123',landingPageUrl:'https://app.adflex.io/private'} as AdView;const csv=studioAdsCsv([ad]);expect(csv).toContain('https://www.facebook.com/ads/library/?id=123');expect(csv).not.toContain('adflex');});
  it('retains legitimate YouTube original links in customer exports',()=>{const csv=studioAdsCsv([{id:'youtube-material',dataSourceKey:'bigspy',publisherPlatforms:['YouTube'],sourceUrl:'https://www.youtube.com/watch?v=abc'} as AdView]);expect(csv).toContain('https://www.youtube.com/watch?v=abc');expect(csv).not.toContain('bigspy');});
  it('exports an empty result as a header without inventing records',()=>{expect(studioAdsCsv([]).split('\r\n')).toHaveLength(1);});
});
