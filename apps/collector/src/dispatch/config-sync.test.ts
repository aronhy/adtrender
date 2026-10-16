import {afterEach,expect,it} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {seedManifestContentHash,type SeedConfigManifest} from '../../../../packages/contracts/src/seeds';
import {advance as advanceSnapchat,recordDiscovery as recordSnapchatDiscovery,DAY} from '../snapchat-service/queue';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function root(){const dir=await mkdtemp(join(tmpdir(),'seed-config-'));roots.push(dir);return dir;}
const qid='11111111-1111-4111-8111-111111111111',sid='22222222-2222-4222-8222-222222222222';
function manifest(revision=1,enabled=true):SeedConfigManifest{
 const m:any={schemaVersion:1,protocolMin:1,protocolMax:1,publicationId:'33333333-3333-4333-8333-333333333333',revision,parentRevision:revision===1?null:revision-1,compilerVersion:'fixture-1',capabilityVersion:'fixture-1',createdAt:'2026-10-11T00:00:00Z',queries:[{queryId:qid,queryKey:'a'.repeat(64),queryKeyVersion:'legacy-1',sourceKey:'meta_ad_library',channel:'PUBLIC_DOM',mode:'KEYWORD',params:{country:'DE',language:'en',keyword:'word',status:'all',mediaType:'all'},legacyDims:{},adapterVersion:'meta-service-dom-1',capabilityVersion:'fixture-1',desiredEnabled:enabled,nativeJobIds:['original-native-job']}],bindings:[{queryId:qid,ownerKind:'SEED',seedId:sid,scanPlanId:null,legacyOwnerKey:null,ownerRevision:1,participationStatus:enabled?'ACTIVE':'PAUSED',purposeSnapshot:[{family:'GAMES',category:'games'}],validFromRevision:revision,validToRevision:null}],scanPlans:[],tombstones:[],schedulePolicyVersion:'fixture-1'};
 return {...m,contentHash:seedManifestContentHash(m)};
}
async function api(){const path='./config-'+'sync';return import(path).catch(()=>({})) as Promise<any>;}
function snapchatManifest(revision=1):SeedConfigManifest{
 const m=manifest(revision);m.queries[0]={...m.queries[0],sourceKey:'snapchat_ads_gallery',channel:'PUBLISHER',mode:'NAME',params:{country:'ALL',publisher:'Fixture payer'},adapterVersion:'snapchat-service-public-1',nativeJobIds:['ALL:fixture payer']};
 return {...m,contentHash:seedManifestContentHash(m)};
}
it('adds a new Snapchat NAME as an unconfirmed candidate with the native no-results retry',async()=>{
 const {applyManifestAtBoundary}=await api(),state=applyManifestAtBoundary({controlMode:'CONFIG_QUEUE',jobs:[]},snapchatManifest(),'snapchat'),job=state.jobs[0];
 expect(job).toMatchObject({id:'ALL:fixture payer',publisher:'Fixture payer',kind:'CANDIDATE',seen:[]});expect(job.confirmedAt).toBeUndefined();
 advanceSnapchat(job,{completedIds:[],status:'NO_RESULTS',errorCode:null,exhausted:true,nextUrl:null},100);
 expect(job.retryAt).toBe(100+7*DAY);
});
it('keeps an existing Snapchat WATCH and all native progress on a new publication',async()=>{
 const {applyManifestAtBoundary}=await api(),job={id:'ALL:fixture payer',country:'ALL',publisher:'Fixture payer',kind:'WATCH',confirmedAt:10,seen:['source-ad'],nextUrl:'https://adsapi.snapchat.com/v1/ads_library/ads/search?cursor=saved',retryAt:999,complete:false,cycleAt:7,lastAttemptAt:20,failures:2};
 const state={controlMode:'CONFIG_QUEUE',jobs:[job],pauseUntil:2000,nextBatchAt:1500},next=applyManifestAtBoundary(state,snapchatManifest(2),'snapchat');
 expect(next.jobs[0]).toEqual(job);expect(next).toMatchObject({pauseUntil:2000,nextBatchAt:1500});expect(state.jobs[0]).toEqual(job);
});
it('promotes a configured Snapchat candidate only after native ad discovery',async()=>{
 const {applyManifestAtBoundary}=await api(),state=applyManifestAtBoundary({controlMode:'CONFIG_QUEUE',jobs:[]},snapchatManifest(),'snapchat'),job=state.jobs[0];
 recordSnapchatDiscovery(state.jobs,job,[],100);expect(job.confirmedAt).toBeUndefined();
 recordSnapchatDiscovery(state.jobs,job,[{advertiserName:'Fixture payer',brand:null}],200);expect(job).toMatchObject({kind:'WATCH',confirmedAt:200});
 advanceSnapchat(job,{completedIds:['source-ad'],status:'SUCCEEDED',errorCode:null,exhausted:true,nextUrl:null},200);expect(job.retryAt).toBe(200+DAY);
});
it('applies a paused query without losing native identity, progress or source restrictions',async()=>{
 const {applyManifestAtBoundary,isManagedJobEnabled}=await api();expect(applyManifestAtBoundary).toBeTypeOf('function');
 const state:any={schema:1,controlMode:'CONFIG_QUEUE',jobs:[{id:'original-native-job',country:'DE',language:'en',keyword:'word',seen:['old-ad'],failures:2,dueAt:17,lastAttemptAt:13,exhaustedAt:null,cursor:{page:2,row:3}}],pauseUntil:999,restrictions:3};
 const result=applyManifestAtBoundary(state,manifest(1,false),'meta');
 expect(result.jobs[0]).toMatchObject({id:'original-native-job',seen:['old-ad'],failures:2,cursor:{page:2,row:3},dueAt:17});
 expect(result).toMatchObject({pauseUntil:999,restrictions:3});expect(isManagedJobEnabled(result,'original-native-job')).toBe(false);
 expect(state.jobs[0].seen).toEqual(['old-ad']);expect(state.seedConfig).toBeUndefined();
});
it('keeps one shared active owner and disables execution after its final owner pauses',async()=>{
 const {applyManifestAtBoundary,isManagedJobEnabled}=await api();expect(applyManifestAtBoundary).toBeTypeOf('function');
 let m=manifest();m.bindings.push({...m.bindings[0],seedId:'44444444-4444-4444-8444-444444444444',participationStatus:'PAUSED'});m={...m,contentHash:seedManifestContentHash(m)};
 const first=applyManifestAtBoundary({controlMode:'CONFIG_QUEUE',jobs:[]},m,'meta');expect(isManagedJobEnabled(first,'original-native-job')).toBe(true);
 m.bindings=m.bindings.map(binding=>({...binding,participationStatus:'PAUSED'}));m={...m,contentHash:seedManifestContentHash(m)};
 const next=applyManifestAtBoundary({controlMode:'CONFIG_QUEUE',jobs:[]},m,'meta');expect(isManagedJobEnabled(next,'original-native-job')).toBe(false);
});
it('rejects changed native parameters and applying while old facts are pending',async()=>{
 const {applyManifestAtBoundary}=await api();expect(applyManifestAtBoundary).toBeTypeOf('function');
 expect(()=>applyManifestAtBoundary({jobs:[{id:'original-native-job',country:'FR',language:'en',keyword:'word'}]},manifest(),'meta')).toThrow('CONFIG_NATIVE_PARAMS_CONFLICT');
 expect(()=>applyManifestAtBoundary({jobs:[],pending:{jobId:'old',file:'archive'}},manifest(),'meta')).toThrow('CONFIG_BOUNDARY_PENDING');
});
it('rejects changing mode or channel while reusing an applied native job identity',async()=>{
 const {applyManifestAtBoundary}=await api(),first=applyManifestAtBoundary({jobs:[]},manifest(),'meta');
 for(const change of [{mode:'NAME'},{channel:'META'}]){const next=manifest(2);Object.assign(next.queries[0],change);next.contentHash=seedManifestContentHash(next);expect(()=>applyManifestAtBoundary(first,next,'meta')).toThrow('CONFIG_NATIVE_PARAMS_CONFLICT');}
});
it('downloads atomically without claiming applied, and rejects a changed payload at the same revision',async()=>{
 const {syncSeedConfig,readCachedManifest}=await api();expect(syncSeedConfig).toBeTypeOf('function');
 const dir=await root(),receipts:any[]=[];
 const context={root:dir,sequenceRoot:dir,nodeId:'fixture-node',incarnationId:'55555555-5555-4555-8555-555555555555',protocolVersion:1};
 await syncSeedConfig({fetchConfig:async()=>({status:200,manifest:manifest()}),sendConfigReceipt:async(r:any)=>{receipts.push(r);}},context);
 expect(receipts.map(receipt=>receipt.applyStatus)).toEqual(['DOWNLOADED','VALIDATED']);
 const cached=await readCachedManifest(dir,1);expect(cached.contentHash).toBe(manifest().contentHash);
 const before=await readFile(join(dir,'dispatch','manifest.json'),'utf8');
 await expect(syncSeedConfig({fetchConfig:async()=>({status:200,manifest:manifest(1,false)}),sendConfigReceipt:async()=>{}},context)).rejects.toThrow('CONFIG_REVISION_CONFLICT');
 expect(await readFile(join(dir,'dispatch','manifest.json'),'utf8')).toBe(before);
});
it('allows a full snapshot across missed revisions but never downgrades a local applied revision',async()=>{
 const {applyManifestAtBoundary}=await api();expect(applyManifestAtBoundary).toBeTypeOf('function');
 const first=applyManifestAtBoundary({jobs:[]},manifest(7),'meta');expect(first.seedConfig.revision).toBe(7);
 expect(()=>applyManifestAtBoundary(first,manifest(6),'meta')).toThrow('CONFIG_REVISION_DOWNGRADE');
});
it('shares node sequence while each source flushes only its own durable config outbox',async()=>{
 const {syncSeedConfig,flushConfigReceipts}=await api();expect(syncSeedConfig).toBeTypeOf('function');const shared=await root(),base={sequenceRoot:shared,nodeId:'node',incarnationId:'55555555-5555-4555-8555-555555555555',protocolVersion:1},metaContext={...base,root:join(shared,'meta'),sourceKey:'meta_ad_library'},googleContext={...base,root:join(shared,'google'),sourceKey:'google_ads_transparency'};
 const m=manifest(),g:any=structuredClone(m);g.queries[0]={...g.queries[0],sourceKey:'google_ads_transparency',mode:'DISCOVER',channel:'ATC',params:{country:'DE',language:'en',term:'word'},nativeJobIds:['google-job']};g.contentHash=seedManifestContentHash(g);
 await expect(syncSeedConfig({fetchConfig:async()=>({status:200,manifest:m}),sendConfigReceipt:async()=>{throw Error('OFFLINE');}},metaContext)).rejects.toThrow('OFFLINE');
 const googleReceipts:any[]=[],metaReceipts:any[]=[];await syncSeedConfig({fetchConfig:async()=>({status:200,manifest:g}),sendConfigReceipt:async(r:any)=>{googleReceipts.push(r);}},googleContext);
 expect(googleReceipts.map(r=>r.manifestHash)).toEqual([g.contentHash,g.contentHash]);await flushConfigReceipts({sendConfigReceipt:async(r:any)=>{metaReceipts.push(r);}},metaContext);expect(metaReceipts.map(r=>r.applyStatus)).toEqual(['DOWNLOADED','VALIDATED']);expect(new Set([...googleReceipts,...metaReceipts].map(r=>r.sequence)).size).toBe(4);
});
