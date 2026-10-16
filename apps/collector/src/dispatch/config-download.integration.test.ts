import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer,type Server} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import express from 'express';
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
const shared=vi.hoisted(()=>({db:null as any}));
vi.mock('../../../web/.wasp/out/sdk/wasp/server/index.ts',()=>({prisma:new Proxy({}, {get:(_,key)=>shared.db[key]})}));
vi.mock('../../../web/.wasp/out/sdk/wasp/dist/server/index.js',()=>({prisma:new Proxy({}, {get:(_,key)=>shared.db[key]})}));
import {collectorConfig} from '../../../web/src/server/collector-api';
import {scopeManifest} from '../../../web/src/seed-library/publications';
import {seedCanonical,seedManifestContentHash,validateSeedManifest,type SeedConfigManifest} from '../../../../packages/contracts/src/seeds';
import {createDispatchHttpClient} from './dispatch-client';
import {syncSeedConfig} from './config-sync';

const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const chunkBytes=1024*1024,url=process.env.SAAS_TEST_DATABASE_URL,servers:Server[]=[],roots:string[]=[];
const originalCredentials=process.env.COLLECTOR_NODE_CREDENTIALS_JSON;
let db:any,big:SeedConfigManifest;
beforeAll(()=>{
 big=manifest(16000);validateSeedManifest(big);
 if(!url)return;const target=new URL(url);if(!['127.0.0.1','localhost'].includes(target.hostname)||!target.pathname.includes('_test_'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
 const {PrismaClient}=createRequire(new URL('../../../web/package.json',import.meta.url))('@prisma/client');db=new PrismaClient({datasources:{db:{url}}});
});
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));if(originalCredentials===undefined)delete process.env.COLLECTOR_NODE_CREDENTIALS_JSON;else process.env.COLLECTOR_NODE_CREDENTIALS_JSON=originalCredentials;});
afterAll(async()=>{await db?.$disconnect();});
function manifest(count:number,revision=1,publicationId=randomUUID(),parentRevision:number|null=null):SeedConfigManifest{
 const queries=Array.from({length:count},(_,i)=>({queryId:randomUUID(),queryKey:sha('synthetic-scale-'+i),queryKeyVersion:'seed-query-1',sourceKey:'meta_ad_library' as const,channel:'META',mode:'KEYWORD',params:{country:'US',language:'en',keyword:'Synthetic 欧品 🙂 '+i},legacyDims:{},adapterVersion:'meta-service-dom-1',capabilityVersion:'fixture-1',desiredEnabled:true,nativeJobIds:['synthetic-native-'+i]}));
 const google={...queries[0],queryId:randomUUID(),queryKey:sha('synthetic-google'),sourceKey:'google_ads_transparency' as const,channel:'ATC',mode:'DISCOVER',params:{country:'US',language:'en',term:'Synthetic Google'},nativeJobIds:['synthetic-google'],adapterVersion:'google-service-dom-1'};
 const bindings=[...queries,google].map((q,i)=>({queryId:q.queryId,ownerKind:'LEGACY' as const,seedId:null,scanPlanId:null,legacyOwnerKey:'synthetic-owner-'+i,ownerRevision:1,participationStatus:'ACTIVE' as const,purposeSnapshot:[],validFromRevision:revision,validToRevision:null}));
 const body={schemaVersion:1 as const,protocolMin:1,protocolMax:1,publicationId,revision,parentRevision,compilerVersion:'fixture-1',capabilityVersion:'fixture-1',createdAt:'2026-10-11T00:00:00.000Z',queries:[...queries,google],bindings,scanPlans:[],tombstones:[],schedulePolicyVersion:'fixture-1'};
 return {...body,contentHash:seedManifestContentHash(body)};
}
function memory(initial:SeedConfigManifest){
 const publications=new Map([[initial.publicationId,{id:initial.publicationId,revision:initial.revision,status:'PUBLISHED',configSnapshot:{manifest:initial}}]]);let latest=initial.publicationId;
 return {backend:{collectorNode:{findUnique:async({where}:any)=>({nodeId:where.nodeId,incarnationId:identity.incarnationId})},seedPublication:{findFirst:async()=>publications.get(latest),findUnique:async({where}:any)=>publications.get(where.id)},seedQuery:{findMany:async()=>[]}},publish(next:SeedConfigManifest){publications.set(next.publicationId,{id:next.publicationId,revision:next.revision,status:'PUBLISHED',configSnapshot:{manifest:next}});latest=next.publicationId;}};
}
const identity={nodeId:'synthetic-config-download',incarnationId:randomUUID(),allowedSourceKeys:['meta_ad_library','google_ads_transparency']};
async function http(backend:any,node=identity){
 shared.db=backend;const token='synthetic-config-token-'+randomUUID();process.env.COLLECTOR_NODE_CREDENTIALS_JSON=JSON.stringify([{nodeId:node.nodeId,tokenSha256:sha(token),allowedSourceKeys:node.allowedSourceKeys}]);
 const app=express();app.get('/api/internal/seeds/config',collectorConfig);const server=createServer(app);servers.push(server);await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address() as any,origin='http://127.0.0.1:'+address.port;
 const headers={authorization:'Bearer '+token,'x-collector-node':node.nodeId,'x-collector-incarnation':node.incarnationId,'x-collector-source':'meta_ad_library'};
 return {origin,headers,async get(query:string,override:Record<string,string>={}){return fetch(origin+'/api/internal/seeds/config'+query,{headers:{...headers,...override}});},client(request:typeof fetch=fetch){return createDispatchHttpClient({origin,token,nodeId:node.nodeId,incarnationId:node.incarnationId,sourceKey:'meta_ad_library',request});}};
}
describe('actual HTTP manifest download contract without source requests',()=>{
 it('describes canonical UTF8 and serves bounded immutable byte chunks',async()=>{
  const endpoint=await http(memory(big).backend),response=await endpoint.get('?chunked=1'),descriptor=await response.json(),scoped=scopeManifest(big,['meta_ad_library']),bytes=Buffer.from(seedCanonical(scoped),'utf8');
  expect(response.status).toBe(200);expect(bytes.length).toBeGreaterThan(8_000_000);expect(descriptor).toMatchObject({type:'SEED_MANIFEST_DESCRIPTOR',schemaVersion:1,publicationId:big.publicationId,publicationRevision:big.revision,manifestHash:scoped.contentHash,byteSha256:sha(bytes),byteLength:bytes.length,chunkBytes,totalChunks:Math.ceil(bytes.length/chunkBytes)});
  const parts:Buffer[]=[];for(let index=0;index<descriptor.totalChunks;index++){const pageResponse=await endpoint.get('?publicationId='+descriptor.publicationId+'&manifestHash='+descriptor.manifestHash+'&chunkIndex='+index),page=await pageResponse.json(),part=Buffer.from(page.dataBase64,'base64');expect(pageResponse.status).toBe(200);expect(page).toMatchObject({type:'SEED_MANIFEST_CHUNK',schemaVersion:1,publicationId:descriptor.publicationId,publicationRevision:descriptor.publicationRevision,manifestHash:descriptor.manifestHash,chunkIndex:index,byteSha256:sha(part),byteLength:part.length});expect(part.length).toBeLessThanOrEqual(chunkBytes);parts.push(part);}
  expect(Buffer.concat(parts).equals(bytes)).toBe(true);
 },60000);
 it('transparently downloads 16000 queries and preserves conditional 304',async()=>{
  const endpoint=await http(memory(big).backend),pages:{query:string;bytes:number}[]=[],client=endpoint.client(async(input,init)=>{const response=await fetch(input,init);pages.push({query:new URL(String(input)).search,bytes:(await response.clone().arrayBuffer()).byteLength});return response;});
  const result=await client.fetchConfig();expect(result.status).toBe(200);if(result.status!==200)throw Error('CONFIG_NOT_DOWNLOADED');expect(seedCanonical(result.manifest)).toBe(seedCanonical(scopeManifest(big,['meta_ad_library'])));expect(result.manifest.queries).toHaveLength(16000);expect(pages.length).toBeGreaterThan(2);expect(pages.every(page=>page.bytes<2_000_000)).toBe(true);
  const prior=pages.length;expect(await client.fetchConfig(result.manifest.contentHash)).toEqual({status:304});expect(pages).toHaveLength(prior+1);
 },60000);
 it('finishes the frozen publication when a newer version is published between pages',async()=>{
  const store=memory(big),endpoint=await http(store.backend),next=manifest(1,2,randomUUID(),1);let advanced=false;
  const client=endpoint.client(async(input,init)=>{const params=new URL(String(input)).searchParams;if(params.get('chunkIndex')==='1'&&!advanced){store.publish(next);advanced=true;}return fetch(input,init);});
  const old=await client.fetchConfig();expect(advanced).toBe(true);expect(old).toMatchObject({status:200,manifest:{publicationId:big.publicationId,revision:1}});if(old.status!==200)throw Error('CONFIG_NOT_DOWNLOADED');expect(old.manifest.queries).toHaveLength(16000);
  expect(await client.fetchConfig(old.manifest.contentHash)).toMatchObject({status:200,manifest:{publicationId:next.publicationId,revision:2}});
 },60000);
 it('rejects a page requested under another authenticated source scope',async()=>{
  const endpoint=await http(memory(big).backend),descriptor=await (await endpoint.get('?chunked=1')).json();
  const response=await endpoint.get('?publicationId='+descriptor.publicationId+'&manifestHash='+descriptor.manifestHash+'&chunkIndex=0',{'x-collector-source':'google_ads_transparency'});expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'SEED_CONFIG_SCOPE_MISMATCH'});
  const client=endpoint.client(async(input,init)=>{if(new URL(String(input)).searchParams.has('chunkIndex')){const headers=new Headers(init?.headers);headers.set('x-collector-source','google_ads_transparency');return fetch(input,{...init,headers});}return fetch(input,init);});await expect(client.fetchConfig()).rejects.toMatchObject({code:'SEED_CONFIG_SCOPE_MISMATCH'});
 },60000);
 it('rejects damaged bytes before caching or emitting config receipts',async()=>{
  const endpoint=await http(memory(big).backend),client=endpoint.client(async(input,init)=>{const response=await fetch(input,init);if(new URL(String(input)).searchParams.get('chunkIndex')!=='0')return response;const page=await response.json(),bytes=Buffer.from(page.dataBase64,'base64');bytes[0]^=1;page.dataBase64=bytes.toString('base64');return new Response(JSON.stringify(page),{status:200});});
  await expect(client.fetchConfig()).rejects.toThrow('COLLECTOR_CONTROL_RESPONSE_INVALID');
  const root=await mkdtemp(join(tmpdir(),'config-corruption-'));roots.push(root);const sent:any[]=[];
  await expect(syncSeedConfig({...client,sendConfigReceipt:async receipt=>{sent.push(receipt);}},{root,sequenceRoot:root,nodeId:identity.nodeId,incarnationId:identity.incarnationId,sourceKey:'meta_ad_library',protocolVersion:1})).rejects.toThrow('CONFIG_CONTROL_UNAVAILABLE');expect(sent).toEqual([]);
 },60000);
 it('keeps the old small-manifest response and rejects invalid chunk coordinates',async()=>{
  const small=manifest(1),endpoint=await http(memory(small).backend),legacy=await endpoint.get('');expect(await legacy.json()).toEqual(scopeManifest(small,['meta_ad_library']));const descriptor=await (await endpoint.get('?chunked=1')).json();
  for(const query of ['?publicationId='+small.publicationId,'?publicationId='+small.publicationId+'&manifestHash='+descriptor.manifestHash+'&chunkIndex=-1','?publicationId='+small.publicationId+'&manifestHash='+descriptor.manifestHash+'&chunkIndex='+descriptor.totalChunks]){const response=await endpoint.get(query);expect(response.status).toBe(400);expect(await response.json()).toEqual({error:'SEED_CONFIG_CHUNK_INVALID'});}
 });
 it('rechecks node incarnation on every chunk before returning bytes',async()=>{
  const small=manifest(1),store=memory(small),endpoint=await http(store.backend),descriptor=await (await endpoint.get('?chunked=1')).json();
  store.backend.collectorNode.findUnique=async({where}:any)=>({nodeId:where.nodeId,incarnationId:randomUUID()});
  const response=await endpoint.get('?publicationId='+descriptor.publicationId+'&manifestHash='+descriptor.manifestHash+'&chunkIndex=0');expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'MACHINE_IDENTITY_REJECTED'});
 });
});
describe.skipIf(!url)('PostgreSQL publication through the real chunked HTTP client',()=>{
 it('downloads 16000 frozen queries from the current database publication',async()=>{
  const rollback=Error('CONFIG_DOWNLOAD_ROLLBACK');await expect(db.$transaction(async(tx:any)=>{
   await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended('seed-publication-head',0))");
   const head=await tx.seedPublication.findFirst({orderBy:{revision:'desc'}}),revision=(head?.revision??0)+1,body={...big,publicationId:randomUUID(),revision,parentRevision:head?.revision??null,bindings:big.bindings.map(binding=>({...binding,validFromRevision:revision}))},current={...body,contentHash:seedManifestContentHash(body)};
   await tx.seedPublication.create({data:{id:current.publicationId,revision,parentRevision:current.parentRevision,status:'PUBLISHED',manifestHash:current.contentHash,configSnapshot:{manifest:current},reason:'Synthetic local chunked config download'}});
   const node={...identity,nodeId:'config-pg-'+randomUUID(),incarnationId:randomUUID()};await tx.collectorNode.create({data:{nodeId:node.nodeId,incarnationId:node.incarnationId,registryRevision:1,codeRevision:'fixture',protocolVersions:[1]}});
   const endpoint=await http(tx,node),download=await endpoint.client().fetchConfig();expect(download).toMatchObject({status:200,manifest:{publicationId:current.publicationId,revision}});if(download.status!==200)throw Error('CONFIG_NOT_DOWNLOADED');expect(seedCanonical(download.manifest)).toBe(seedCanonical(scopeManifest(current,['meta_ad_library'])));expect(download.manifest.queries).toHaveLength(16000);throw rollback;
  },{timeout:60000})).rejects.toBe(rollback);
 },60000);
});
