import {describe,it,expect} from 'vitest';
import {legacyQueryIdentity} from './legacy-query-key';
import {projectQueryLedger,buildQueryLedger} from './metrics';

const run=(extra:Record<string,unknown>={})=>({id:'run1',sourceKey:'meta_ad_library',idempotencyKey:'meta-service:abc',querySnapshot:{country:'US',language:'en',keyword:'shop now'},status:'SUCCEEDED',startedAt:new Date('2026-10-10T01:00:00Z'),finishedAt:new Date('2026-10-10T01:01:00Z'),createdAt:new Date('2026-10-10T01:00:00Z'),fetchedCount:2,insertedCount:1,updatedCount:1,errorCode:null,restrictionReason:null,coverage:{},items:[{status:'INGESTED',sourceAdId:'12345'}],...extra});
describe('historical seed query ledger',()=>{
 it('historical_ingested_is_not_item_inserted',()=>{
  const [r]=projectQueryLedger([run()]);expect(r.insertedCount).toBe(1);expect(r.itemInsertedCount).toBeNull();expect(r.attributionQuality).toBe('HISTORICAL_QUERY');expect(r.seedAttribution).toBe('UNATTRIBUTED');expect(r.requestCount).toBeNull();
 });
 it('reports exact managed ownership separately without retroactively attributing historical runs',()=>{
  const frozen={queryId:'query-1',queryKey:'a'.repeat(64),quality:'EXACT_QUERY',bindingSnapshot:[{ownerKind:'SEED',seedId:'seed-1'},{ownerKind:'SEED',seedId:'seed-2'}]};
  const rows=projectQueryLedger([run(),run({id:'managed-run',idempotencyKey:'meta-service:managed',managedAttribution:frozen})]);
  expect(rows).toHaveLength(2);const exact=rows.find(r=>r.attributionQuality==='EXACT_QUERY');expect(exact).toMatchObject({seedAttribution:'EXACT_QUERY',queryIds:['query-1'],seedIds:['seed-1','seed-2'],insertedCount:1,executionCount:1});expect(rows.find(r=>r.seedAttribution==='UNATTRIBUTED')?.insertedCount).toBe(1);
 });
 it('zero_fetched_is_not_reliable_empty',()=>{
  const [r]=projectQueryLedger([run({fetchedCount:0,insertedCount:0,updatedCount:0})]);expect(r.unknownEmptyCount).toBe(1);expect(r.reliableNoResultsCount).toBe(0);
  const [explicit]=projectQueryLedger([run({fetchedCount:0,insertedCount:0,updatedCount:0,coverage:{reason:'EXPLICIT_NO_RESULTS'}})]);expect(explicit.reliableNoResultsCount).toBe(1);
  const [limited]=projectQueryLedger([run({fetchedCount:0,errorCode:'META_HTTP_429',status:'FAILED',coverage:{reason:'EXPLICIT_NO_RESULTS'}})]);expect(limited.reliableNoResultsCount).toBe(0);expect(limited.rateLimitedCount).toBe(1);
 });
 it('serp_archive_is_not_ad_fact',()=>{
  const [r]=projectQueryLedger([run({sourceKey:'google_ads_transparency',idempotencyKey:'google-service:a',querySnapshot:{kind:'SERP',country:'US',language:'en',term:'buy shoes'},fetchedCount:0,insertedCount:0,updatedCount:0,coverage:{reason:'OBSERVED_SPONSORED_RESULTS'}})]);expect(r.channel).toBe('SERP');expect(r.searchCluesAvailable).toBe(false);expect(r.reliableNoResultsCount).toBe(0);
 });
 it('replay_preserves_original_counts',()=>{
  const [r]=projectQueryLedger([run(),run()]);expect(r.executionCount).toBe(1);expect(r.insertedCount).toBe(1);expect(r.updatedCount).toBe(1);
 });
 it('keeps historic language keys and removes purpose/page progress from identities',()=>{
  const key=legacyQueryIdentity('meta_ad_library',{country:'US',language:'en',keyword:'shop now'}).key;
  expect(legacyQueryIdentity('meta_ad_library',{country:'US',language:'en',keyword:'shop now',seedFamilies:['GAMES']}).key).toBe(key);
  expect(legacyQueryIdentity('meta_ad_library',{country:'US',language:'und',keyword:'shop now'}).key).not.toBe(key);
  expect(legacyQueryIdentity('pinterest_ads_repository',{country:'DE',dateStart:'2026-10-01',dateEnd:'2026-10-07',page:0}).key).toBe(legacyQueryIdentity('pinterest_ads_repository',{country:'DE',dateStart:'2026-10-01',dateEnd:'2026-10-07',page:1}).key);
 });
 it('separates history/operator and identity-only discoveries',()=>{
  const rows=projectQueryLedger([run(),run({id:'r2',idempotencyKey:'pinterest-operator:abc'}),run({id:'r3',sourceKey:'google_ads_transparency',idempotencyKey:'google-service:b',querySnapshot:{kind:'DISCOVER',country:'US',language:'en',term:'brand'},fetchedCount:0,insertedCount:0,updatedCount:0,coverage:{advertisersDiscovered:2}})]);
  expect(rows).toHaveLength(3);expect(rows.find(r=>r.mode==='OPERATOR')).toBeTruthy();expect(rows.find(r=>r.channel==='ATC')?.identityFoundCount).toBe(1);
 });
 it('keeps partial result and restriction simultaneously; unknown query shapes are not guessed',()=>{
  const [r]=projectQueryLedger([run({status:'PARTIAL',errorCode:'META_HTTP_429'})]);expect(r.hasResultsCount).toBe(1);expect(r.partialCount).toBe(1);expect(r.rateLimitedCount).toBe(1);
  expect(legacyQueryIdentity('meta_ad_library',{mystery:true}).quality).toBe('UNATTRIBUTED');
 });
 it('does not label access challenges or failed requests as empty or rate limited',()=>{
  const [r]=projectQueryLedger([run({fetchedCount:0,status:'FAILED',errorCode:'META_HTTP_403'})]);expect(r.restrictedCount).toBe(1);expect(r.rateLimitedCount).toBe(0);expect(r.unknownEmptyCount).toBe(0);
 });
 it('validates date windows and paginates all commits without daily caps',async()=>{
  await expect(buildQueryLedger({$queryRawUnsafe:async<T>()=>[] as T},{from:'bad',to:'bad'})).rejects.toThrow('LEDGER_WINDOW_INVALID');
  const batches=[[run()],[]];const db={$queryRawUnsafe:async<T>()=>(batches.shift()??[]) as T};const rows=await buildQueryLedger(db,{from:'2026-10-10T00:00:00Z',to:'2026-10-11T00:00:00Z'});expect(rows[0].insertedCount).toBe(1);
 });
});
