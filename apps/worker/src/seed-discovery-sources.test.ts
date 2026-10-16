import {describe,it,expect} from 'vitest';
import {seedDiscoverySourcesFromEnvironment} from './seed-control';

describe('seed discovery source configuration',()=>{
 it('keeps legacy defaults when no source filter is supplied',()=>{
  expect(seedDiscoverySourcesFromEnvironment({})).toBeUndefined();
 });
 it('accepts explicit supported sources without expanding their scope',()=>{
  expect(seedDiscoverySourcesFromEnvironment({SEED_DISCOVERY_SOURCE_KEYS:' meta_ad_library '})).toEqual(['meta_ad_library']);
  expect(seedDiscoverySourcesFromEnvironment({SEED_DISCOVERY_SOURCE_KEYS:'meta_ad_library,google_ads_transparency'})).toEqual(['meta_ad_library','google_ads_transparency']);
 });
 it.each(['',' ','unknown','meta_ad_library,unknown',',meta_ad_library'])('rejects malformed explicit scope %j',value=>{
  expect(()=>seedDiscoverySourcesFromEnvironment({SEED_DISCOVERY_SOURCE_KEYS:value})).toThrow('SEED_DISCOVERY_SOURCE_FILTER_INVALID');
 });
});
