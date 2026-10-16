import {describe,it,expect} from 'vitest';
import {inventoryLegacyState} from './legacy-import';
describe('legacy persistent queue inventory',()=>{
 it('keeps native ids, progress digest and source cooling without turning them into seed identities',()=>{
  const state={schemaVersion:3,jobs:[{id:'original-job',country:'US',language:'und',keyword:'',pageId:'123456',seen:['ad-1'],failures:2,dueAt:500,lastAttemptAt:200}],pauseUntil:800,nextBatchAt:700};
  const report=inventoryLegacyState('meta_ad_library',state);expect(report.jobs[0].nativeJobId).toBe('original-job');expect(report.jobs[0].params.pageId).toBe('123456');expect(report.jobs[0].checkpoint.seen).toEqual(['ad-1']);expect(report.sourceControls[0].notBefore).toBe(800);expect(report.jobs[0].checkpointDigest).toMatch(/^[a-f0-9]{64}$/);
 });
 it('does not collapse Google SERP and ATC or unsupported old media-refresh identities',()=>{
  const base={country:'DE',language:'en',term:'brand',seen:[],dueAt:0};const google=inventoryLegacyState('google_ads_transparency',{jobs:[{...base,id:'serp',kind:'SERP'},{...base,id:'atc',kind:'DISCOVER'}],pauses:{SERP:500,ATC:700},nextBatchAt:300});expect(google.jobs[0].queryKey).not.toBe(google.jobs[1].queryKey);expect(google.sourceControls.find(c=>c.channel==='ATC')?.notBefore).toBe(700);
  const media=inventoryLegacyState('tiktok_commercial_library',{jobs:[{id:'MEDIA_REFRESH:123',kind:'MEDIA_REFRESH',country:'DE',start:'2026-10-01',end:'2026-10-02',sourceAdIds:['123']}]});expect(media.unmappedJobs).toEqual([{nativeJobId:'MEDIA_REFRESH:123',reason:'LEGACY_MEDIA_REFRESH_REQUIRES_MAPPING'}]);
 });
});
