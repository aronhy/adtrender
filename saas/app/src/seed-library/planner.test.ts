import {describe,it,expect} from 'vitest';
import {compileSeedPlan} from './planner';
const seed=(extra:any={})=>({id:'00000000-0000-4000-8000-000000000001',kind:'NAME',namespace:'public',rawValue:'Example Brand',language:'en',purposeTags:[{family:'ECOMMERCE',category:'fashion'}],targetScope:{kind:'EXPLICIT_COUNTRIES',countries:['US']},targetPlatforms:['meta_ad_library','google_ads_transparency','snapchat_ads_gallery'],status:'ACTIVE',priority:0,revision:1,...extra});
const capabilities=[
 {sourceKey:'meta_ad_library',channel:'META',modes:['KEYWORD','NATIVE_ADVERTISER'],countries:['US','JP'],version:'fixture1',adapterVersion:'meta-service-dom-1'},
 {sourceKey:'google_ads_transparency',channel:'ATC',modes:['NAME','DOMAIN','NATIVE_ADVERTISER'],countries:['US'],version:'fixture1',adapterVersion:'google-service-dom-1'},
 {sourceKey:'snapchat_ads_gallery',channel:'PUBLISHER',modes:['NAME'],countries:['US'],global:true,version:'fixture1',adapterVersion:'snapchat-service-public-1'},
 {sourceKey:'tiktok_commercial_library',channel:'SWEEP',modes:['COUNTRY_DATE_SWEEP'],countries:['US'],version:'fixture1',adapterVersion:'tiktok-public-dom-1'},
 {sourceKey:'pinterest_ads_repository',channel:'SWEEP',modes:['COUNTRY_DATE_SWEEP'],countries:['US'],version:'fixture1',adapterVersion:'pinterest-public-dom-1'},
];
describe('seed native query planner',()=>{
 it('compiles one name into platform-specific queries without transferring identities',()=>{
  const p=compileSeedPlan([seed()],[],capabilities,[]);expect(p.queries).toHaveLength(3);
  expect(p.queries.find((q:any)=>q.sourceKey==='meta_ad_library')?.params.keyword).toBe('Example Brand');
  expect(p.queries.find((q:any)=>q.sourceKey==='google_ads_transparency')?.params.kind).toBe('DISCOVER');
  expect(p.queries.find((q:any)=>q.sourceKey==='snapchat_ads_gallery')?.params.publisher).toBe('Example Brand');
 });
 it('shares actual query across purposes and keeps paused owners separate',()=>{
  const p=compileSeedPlan([seed(),seed({id:'00000000-0000-4000-8000-000000000002',status:'PAUSED',purposeTags:[{family:'GAMES',category:'slots'}]})],[],capabilities,[]);
  expect(p.queries).toHaveLength(3);expect(p.queries.every((q:any)=>q.desiredEnabled)).toBe(true);expect(p.bindings).toHaveLength(6);expect(p.bindings.filter((b:any)=>b.participationStatus==='PAUSED')).toHaveLength(3);
 });
 it('marks keywords unsupported on scanners and does not invent per-seed sweep tasks',()=>{
  const p=compileSeedPlan([seed({kind:'KEYWORD',targetPlatforms:['tiktok_commercial_library','pinterest_ads_repository']})],[],capabilities,[]);expect(p.queries).toHaveLength(0);expect(p.decisions.every((d:any)=>d.decision==='UNSUPPORTED_MODE')).toBe(true);
 });
 it('does not fabricate native identities or ignore unsupported countries',()=>{
  const p=compileSeedPlan([seed({kind:'NATIVE_ADVERTISER',namespace:'meta_ad_library',rawValue:'page-url-sha256:abc',verificationStatus:'VERIFIED',targetPlatforms:['meta_ad_library']}),seed({targetScope:{kind:'EXPLICIT_COUNTRIES',countries:['ZZ']}})],[],capabilities,[]);expect(p.queries).toHaveLength(0);expect(p.decisions.some((d:any)=>d.decision==='NEEDS_RESOLUTION')).toBe(true);expect(p.decisions.some((d:any)=>d.decision==='UNVERIFIED_COUNTRY')).toBe(true);
 });
 it('preserves legacy owner and job id without resetting checkpoints',()=>{
  const first=compileSeedPlan([seed({targetPlatforms:['meta_ad_library']})],[],capabilities,[]);const q=first.queries[0];
  const p=compileSeedPlan([seed({targetPlatforms:['meta_ad_library'],status:'PAUSED'})],[],capabilities,[{sourceKey:q.sourceKey,queryKey:q.queryKey,queryId:q.queryId,nativeJobId:'original-native-id',query:q,legacyOwnerKey:'old-queue',checkpointDigest:'a'.repeat(64)}]);
  expect(p.queries[0].nativeJobIds).toContain('original-native-id');expect(p.queries[0].desiredEnabled).toBe(true);expect(p.bindings.some((b:any)=>b.ownerKind==='LEGACY')).toBe(true);
 });
 it('retires a legacy owner only after publish intent without stopping a shared seed',()=>{
  const s=seed({targetPlatforms:['meta_ad_library']}),first=compileSeedPlan([s],[],capabilities,[]),q=first.queries[0];
  const mapping={sourceKey:q.sourceKey,queryKey:q.queryKey,queryId:q.queryId,nativeJobId:'retained-native-job',query:q,legacyOwnerKey:'old-queue',legacyOwnerStatus:'PAUSED' as const,legacyOwnerRevision:2};
  const shared=compileSeedPlan([s],[],capabilities,[mapping]);expect(shared.queries[0].desiredEnabled).toBe(true);expect(shared.bindings.find(b=>b.ownerKind==='LEGACY')).toMatchObject({participationStatus:'PAUSED',ownerRevision:2});
  const lastPaused=compileSeedPlan([{...s,status:'PAUSED'}],[],capabilities,[mapping]);expect(lastPaused.queries[0].desiredEnabled).toBe(false);
  const removed=compileSeedPlan([],[],capabilities,[{...mapping,legacyOwnerStatus:'REMOVED'}]);expect(removed.queries).toHaveLength(0);expect(removed.bindings).toHaveLength(0);
 });
 it('shares real country/date shards between scan plans, without claiming keyword coverage',()=>{
  const plan={id:'00000000-0000-4000-8000-000000000003',revision:1,sourceKey:'pinterest_ads_repository',targetScope:{kind:'EXPLICIT_COUNTRIES',countries:['US']},datePolicy:{kind:'FIXED',start:'2026-10-01',end:'2026-10-07'},category:'ALL',status:'ACTIVE',evidence:{}};
  const p=compileSeedPlan([], [plan,{...plan,id:'00000000-0000-4000-8000-000000000004'}],capabilities,[]);expect(p.queries).toHaveLength(1);expect(p.bindings).toHaveLength(2);expect(p.bindings.every((b:any)=>b.ownerKind==='SCAN_PLAN'&&b.purposeSnapshot.length===0)).toBe(true);
 });
 it('keeps language compatibility and configured geographic filters',()=>{
  const p=compileSeedPlan([seed({targetPlatforms:['meta_ad_library']}),seed({id:'00000000-0000-4000-8000-000000000002',language:'und',targetPlatforms:['meta_ad_library']})],[],capabilities,[]);expect(p.queries).toHaveLength(2);
  expect(compileSeedPlan([seed({targetPlatforms:['google_ads_transparency'],targetScope:{kind:'CONFIGURED_MARKETS'}})],[],capabilities,[]).queries.every((q:any)=>q.params.country==='US')).toBe(true);
 });
});
