import {describe,it,expect} from 'vitest';
import {nativeScanWindows} from '@ad-research/contracts/seed-native-plan';
import {planJobs} from '../../collector/src/tiktok-service/queue';
import {planSweep} from '../../collector/src/pinterest/sweep';
import {compileSeedPlan} from '../../app/src/seed-library/planner';
describe('native partition compatibility',()=>{
 it('retains the existing TikTok and Pinterest partition identities',()=>{
  for(const days of [1,7,8,14,30]){
   const end='2026-10-11',start=new Date(Date.parse(end)-days*86400000).toISOString().slice(0,10),countries=['DE','FR'];
   expect(nativeScanWindows('tiktok_commercial_library',countries,start,end)).toEqual(planJobs(countries,{start,end}).map(j=>({country:j.country,start:j.start,end:j.end})));
   expect(nativeScanWindows('pinterest_ads_repository',countries,start,end)).toEqual(planSweep(countries,start,end).map(j=>({country:j.country,start:j.start,end:j.end})));
  }
 });
 it('supports one-day rolling native intervals and explains unsupported same-day TikTok bounds',()=>{
  const cap={sourceKey:'tiktok_commercial_library',channel:'SWEEP',modes:['COUNTRY_DATE_SWEEP'],countries:['DE'],version:'verified',adapterVersion:'native'};
  const plan={id:'00000000-0000-4000-8000-000000000099',revision:1,sourceKey:cap.sourceKey,targetScope:{kind:'EXPLICIT_COUNTRIES',countries:['DE']},datePolicy:{kind:'ROLLING',windowDays:1},category:'ALL',status:'ACTIVE',evidence:{}};
  const rolled=compileSeedPlan([],[plan],[cap],[],new Date('2026-10-11T00:00:00Z'));expect(rolled.queries[0].params).toEqual({country:'DE',startDate:'2026-10-10',endDate:'2026-10-11'});
  const exact=compileSeedPlan([],[{...plan,datePolicy:{kind:'FIXED',start:'2026-10-11',end:'2026-10-11'}}],[cap],[]);expect(exact.queries).toHaveLength(0);expect(exact.decisions[0].reason).toBe('TIKTOK_NATIVE_RANGE_REQUIRES_BOUNDARIES');
 });
});
