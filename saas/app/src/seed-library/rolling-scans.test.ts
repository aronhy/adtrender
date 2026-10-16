import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {seedManifestContentHash,type SeedConfigManifest,type SeedScanPlanInput,type OwnerBinding} from '@ad-research/contracts/seeds';
import {compileSeedPlan,type NativeCapability} from './planner';
import {rollPublishedScanManifest} from './rolling-scans';

const capabilities:NativeCapability[]=[{sourceKey:'pinterest_ads_repository',channel:'SWEEP',modes:['COUNTRY_DATE_SWEEP'],countries:['US'],version:'frozen-1',adapterVersion:'pinterest-public-dom-1'}];
const now=new Date('2026-10-10T00:00:00Z');
function plan(extra:Partial<SeedScanPlanInput>={}):SeedScanPlanInput{return {id:randomUUID(),revision:1,sourceKey:'pinterest_ads_repository',targetScope:{kind:'CONFIGURED_MARKETS'},datePolicy:{kind:'ROLLING',windowDays:7},category:'ALL',status:'ACTIVE',evidence:{},...extra};}
function published(plans=[plan()],caps=capabilities):SeedConfigManifest{
 const compiled=compileSeedPlan([],plans,caps,[],now);
 const body={schemaVersion:1 as const,protocolMin:1,protocolMax:1,publicationId:randomUUID(),revision:10,parentRevision:9,compilerVersion:'seed-compiler-1',capabilityVersion:'native-capabilities-1',createdAt:now.toISOString(),queries:compiled.queries,bindings:compiled.bindings.map(b=>({...b,validFromRevision:10})),scanPlans:plans,tombstones:[],schedulePolicyVersion:'compatibility-fair-1'};
 return {...body,contentHash:seedManifestContentHash(body)};
}
function rehash(m:SeedConfigManifest):SeedConfigManifest{return {...m,contentHash:seedManifestContentHash(m)};}
describe('published UTC rolling scan windows',()=>{
 it('is a semantic no-op throughout the same UTC day',()=>{
  const old=published();const result=rollPublishedScanManifest(old,capabilities,new Date('2026-10-10T23:59:59.999Z'),11);
  expect(result).toMatchObject({changed:false,reason:'SCAN_WINDOWS_UNCHANGED'});expect(result.manifest).toEqual(old);
 });
 it('advances native date windows only at the UTC day boundary',()=>{
  const old=published();const result=rollPublishedScanManifest(old,capabilities,new Date('2026-10-11T00:00:00Z'),11);
  expect(result.changed).toBe(true);expect(result.manifest.queries[0].params).toMatchObject({country:'US',dateStart:'2026-10-05',dateEnd:'2026-10-11'});
  expect(result.manifest.tombstones).toContainEqual({queryId:old.queries[0].queryId,reason:'SCAN_WINDOW_ROLLED_FORWARD'});
  expect(result.manifest.scanPlans).toEqual(old.scanPlans);expect(result.manifest.bindings[0]).toMatchObject({scanPlanId:old.scanPlans[0].id,ownerRevision:1,validFromRevision:11});
  expect(rollPublishedScanManifest(result.manifest,capabilities,new Date('2026-10-11T18:00:00Z'),12).changed).toBe(false);
 });
 it('holds fixed and paused scan owners while another published window rolls',()=>{
  const active=plan(),fixed=plan({datePolicy:{kind:'FIXED',start:'2026-10-04',end:'2026-10-10'}}),paused=plan({status:'PAUSED'}),old=published([active,fixed,paused]);
  const oldQ=old.queries[0],result=rollPublishedScanManifest(old,capabilities,new Date('2026-10-11'),11).manifest;
  expect(result.queries.find(q=>q.queryId===oldQ.queryId)).toEqual(oldQ);
  expect(result.bindings.filter(b=>b.queryId===oldQ.queryId).map(b=>b.scanPlanId).sort()).toEqual([fixed.id,paused.id].sort());
  expect(result.tombstones).toHaveLength(0);
  expect(rollPublishedScanManifest(published([fixed,paused]),capabilities,new Date('2026-10-11'),11).reason).toBe('NO_ACTIVE_ROLLING_SCANS');
 });
 it.each(['LEGACY','SEED'] as const)('preserves a shared active %s owner on the old date query',ownerKind=>{
  let old=published();const shared:OwnerBinding={...old.bindings[0],ownerKind,scanPlanId:null,seedId:ownerKind==='SEED'?randomUUID():null,legacyOwnerKey:ownerKind==='LEGACY'?'old-native-queue':null};
  old=rehash({...old,bindings:[...old.bindings,shared]});const result=rollPublishedScanManifest(old,capabilities,new Date('2026-10-11'),11).manifest;
  expect(result.queries.find(q=>q.queryId===old.queries[0].queryId)?.desiredEnabled).toBe(true);expect(result.bindings).toContainEqual(shared);expect(result.tombstones).toHaveLength(0);
 });
 it('keeps a shared paused owner but disables its query when the active scan leaves',()=>{
  let old=published();const shared:OwnerBinding={...old.bindings[0],ownerKind:'LEGACY',scanPlanId:null,legacyOwnerKey:'paused-legacy',participationStatus:'PAUSED'};
  old=rehash({...old,bindings:[...old.bindings,shared]});const result=rollPublishedScanManifest(old,capabilities,new Date('2026-10-11'),11).manifest;
  expect(result.queries.find(q=>q.queryId===old.queries[0].queryId)?.desiredEnabled).toBe(false);expect(result.bindings).toContainEqual(shared);
 });
 it('uses only the frozen countries and adapter profile without adding an unpublished scope',()=>{
  const old=published();const result=rollPublishedScanManifest(old,capabilities,new Date('2026-10-11'),11).manifest;
  expect(result.queries.map(q=>q.params.country)).toEqual(['US']);expect(result.queries[0]).toMatchObject({adapterVersion:'pinterest-public-dom-1',capabilityVersion:'frozen-1'});
 });
 it('continues supported published countries when another requested country was already unverified',()=>{
  const old=published([plan({targetScope:{kind:'EXPLICIT_COUNTRIES',countries:['US','JP']}})]);
  expect(old.queries.map(q=>q.params.country)).toEqual(['US']);
  const rolled=rollPublishedScanManifest(old,capabilities,new Date('2026-10-11'),11);
  expect(rolled.changed).toBe(true);expect(rolled.manifest.queries.map(q=>q.params.country)).toEqual(['US']);expect(rolled.manifest.queries[0].params.dateEnd).toBe('2026-10-11');
 });
 it('refuses historical snapshots with missing or malformed frozen capabilities',()=>{
  const old=published();expect(rollPublishedScanManifest(old,null,new Date('2026-10-11'),11)).toMatchObject({changed:false,reason:'FROZEN_CAPABILITIES_MISSING',manifest:old});
  expect(rollPublishedScanManifest(old,[{...capabilities[0],countries:'US'}] as any,new Date('2026-10-11'),11)).toMatchObject({changed:false,reason:'FROZEN_CAPABILITIES_INVALID'});
  expect(rollPublishedScanManifest(old,[],new Date('2026-10-11'),11)).toMatchObject({changed:false,reason:'PUBLISHED_SCAN_WINDOW_UNSUPPORTED'});
 });
 it('reuses an existing random registry ID and original native job ID for the new window',()=>{
  const old=published(),fresh=compileSeedPlan([],old.scanPlans,capabilities,[],new Date('2026-10-11')).queries[0],query={...fresh,queryId:randomUUID(),nativeJobIds:['original-native-id','secondary-native-id']};
  const result=rollPublishedScanManifest(old,capabilities,new Date('2026-10-11'),11,[{sourceKey:query.sourceKey,queryKey:query.queryKey,queryId:query.queryId,nativeJobId:'original-native-id',query}]).manifest;
  expect(result.queries[0].queryId).toBe(query.queryId);expect(result.queries[0].nativeJobIds).toEqual(query.nativeJobIds);
 });
 it('restores a previous window by content even if a rollback was created on the current day',()=>{
  const old=rehash({...published(),createdAt:'2026-10-11T03:00:00Z',revision:20,parentRevision:19});
  expect(rollPublishedScanManifest(old,capabilities,new Date('2026-10-11T05:00:00Z'),21).changed).toBe(true);
 });
 it('keeps TikTok native exclusive boundaries separate from Pinterest inclusive dates',()=>{
  const caps=[{...capabilities[0],sourceKey:'tiktok_commercial_library',adapterVersion:'tiktok-public-dom-1'}],old=published([plan({sourceKey:'tiktok_commercial_library'})],caps);
  expect(rollPublishedScanManifest(old,caps,new Date('2026-10-11'),11).manifest.queries[0].params).toEqual({country:'US',startDate:'2026-10-04',endDate:'2026-10-11'});
 });
});
