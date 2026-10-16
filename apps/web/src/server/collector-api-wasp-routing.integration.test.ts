import {createHash,randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {seedManifestContentHash} from '../../../../packages/contracts/src/seeds';

// This intentionally imports the compiler's Express router and real Wasp auth.
// Calling the collector handlers alone misses Wasp's preceding session gate.
const routes=[
 ['GET','/api/internal/seeds/config'],
 ['POST','/api/internal/seeds/receipt'],
 ['GET','/api/internal/collection/platform-grant'],
 ['POST','/api/internal/collection/claim'],
 ['POST','/api/internal/collection/permit'],
 ['POST','/api/internal/collection/prepare-submit'],
 ['POST','/api/internal/collection/submit'],
 ['POST','/api/internal/collection/recover-submit'],
 ['POST','/api/internal/collection/heartbeat'],
 ['POST','/api/internal/collection/start'],
 ['POST','/api/internal/collection/renew'],
 ['POST','/api/internal/collection/stop'],
 ['POST','/api/internal/collection/restriction'],
 ['POST','/api/internal/collection/checkpoint'],
 ['POST','/api/internal/collection/control-handoff'],
 ['GET','/api/internal/collection/source-stop-context'],
] as const;
const url=process.env.SAAS_TEST_DATABASE_URL;
const generatedRouter=process.env.WASP_GENERATED_COLLECTOR_ROUTES_PATH??fileURLToPath(new URL('../../.wasp/out/server/src/routes/apis/index.ts',import.meta.url));
const nodeId='wasp-machine-'+randomUUID(),incarnationId=randomUUID(),token='synthetic-opaque-node-token-'+randomUUID();
let prisma:any,fixtureDb:any,router:any,waspAuth:any,server:Server|undefined,origin:string,publicationId:string,revision:number,configHash:string;
let releaseFixture:(()=>void)|undefined,fixtureFinished:Promise<unknown>|undefined;
const headers={'authorization':'Bearer '+token,'x-collector-node':nodeId,'x-collector-incarnation':incarnationId,'x-collector-source':'meta_ad_library'};

describe.skipIf(!url)('generated Wasp machine API authentication boundary',()=>{
 beforeAll(async()=>{
  const target=new URL(url!);if(!['127.0.0.1','localhost'].includes(target.hostname)||!target.pathname.includes('_test_'))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  for(const [key,value] of Object.entries({DATABASE_URL:url!,NODE_ENV:'development',SMTP_HOST:'127.0.0.1',SMTP_PORT:'1025',SMTP_USERNAME:'synthetic',SMTP_PASSWORD:'synthetic',GOOGLE_CLIENT_ID:'synthetic',GOOGLE_CLIENT_SECRET:'synthetic',COLLECTOR_DISPATCH_ENABLED:'false',COLLECTOR_NODE_CREDENTIALS_JSON:JSON.stringify([{nodeId,tokenSha256:createHash('sha256').update(token).digest('hex'),allowedSourceKeys:['meta_ad_library']}])}))vi.stubEnv(key,value);
  // A scratch exact export has its own generated SDK. Resolve the same SDK
  // as that router, rather than comparing auth functions from two builds.
  const generatedRequire=createRequire(generatedRouter);
  const sdkPath=generatedRequire.resolve('wasp/server'),sdk=await vi.importActual<typeof import('wasp/server')>(sdkPath);prisma=sdk.prisma;
  // The only injected dependency is the database connection: both the real
  // Wasp session lookup and collector handlers use one real PG transaction.
  // Published snapshots are immutable, so the whole fixture is rolled back.
  vi.doMock(sdkPath,()=>({...sdk,prisma:new Proxy({}, {get:(_target,key)=>fixtureDb[key]})}));
  let ready!:()=>void,rejectReady!:(error:unknown)=>void;
  const fixtureReady=new Promise<void>((resolve,reject)=>{ready=resolve;rejectReady=reject;}),hold=new Promise<void>(resolve=>{releaseFixture=resolve;}),rollback=new Error('SYNTHETIC_ROUTER_FIXTURE_ROLLBACK');
  fixtureFinished=prisma.$transaction(async(tx:any)=>{
   fixtureDb=tx;await tx.collectorNode.create({data:{nodeId,incarnationId,registryRevision:1,enabled:true,codeRevision:'synthetic-wasp-route',protocolVersions:[1]}});
   await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended('seed-publication-head',0))");
   const prior=await tx.seedPublication.findFirst({orderBy:{revision:'desc'},select:{revision:true}});revision=(prior?.revision??0)+1;publicationId=randomUUID();
   const body={schemaVersion:1 as const,protocolMin:1,protocolMax:1,publicationId,revision,parentRevision:prior?.revision??null,compilerVersion:'synthetic-router-1',capabilityVersion:'synthetic-router-1',createdAt:'2026-10-11T00:00:00.000Z',queries:[],bindings:[],scanPlans:[],tombstones:[],schedulePolicyVersion:'synthetic-router-1'};
   configHash=seedManifestContentHash(body);await tx.seedPublication.create({data:{id:publicationId,revision,parentRevision:body.parentRevision,manifestHash:configHash,configSnapshot:{manifest:{...body,contentHash:configHash}},status:'PUBLISHED',reason:'Synthetic generated router regression'}});
   ready();await hold;throw rollback;
  },{timeout:60000}).catch((error:unknown)=>{if(error!==rollback){rejectReady(error);throw error;}});
  await fixtureReady;
  ({default:waspAuth}=await import(/* @vite-ignore */ generatedRequire.resolve('wasp/core/auth')));
  ({default:router}=await import(/* @vite-ignore */ generatedRouter));
  const app=express();app.use(router);app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error.statusCode??500).json({message:error.message}));
  server=createServer(app);await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',resolve);});origin='http://127.0.0.1:'+(server.address() as any).port;
 },30000);
 afterAll(async()=>{
  if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));
  releaseFixture?.();await fixtureFinished;await prisma?.$disconnect();
  vi.unstubAllEnvs();
 });

 it('accepts a registered node opaque Bearer through the generated route without a user session',async()=>{
  expect(await fixtureDb.session.count({where:{id:token}})).toBe(0);
  const response=await fetch(origin+'/api/internal/seeds/config?publicationId='+publicationId+'&manifestHash='+configHash+'&chunkIndex=0',{headers});
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({type:'SEED_MANIFEST_CHUNK',publicationId,publicationRevision:revision,manifestHash:configHash,chunkIndex:0});
 });

 it('omits Wasp session auth on exactly the sixteen collector routes, keeping the other API gates',()=>{
  const collectorLayers=router.stack.filter((layer:any)=>layer.route?.path.startsWith('/api/internal/'));
  expect(collectorLayers.map((layer:any)=>layer.route.path).sort()).toEqual(routes.map(([,path])=>path).sort());
  for(const [,path]of routes){const route=router.stack.find((layer:any)=>layer.route?.path===path).route;expect(route.stack.map((layer:any)=>layer.handle),path).not.toContain(waspAuth);}
  for(const path of ['/health','/growth/consent','/growth/events','/billing/stripe/webhook']){const route=router.stack.find((layer:any)=>layer.route?.path===path).route;expect(route.stack.map((layer:any)=>layer.handle),path).toContain(waspAuth);}
 });

 it.each(routes)('%s %s still rejects missing node identity and wrong machine tokens',async(method,path)=>{
  const missing=await fetch(origin+path,{method,headers:{authorization:headers.authorization,'x-collector-incarnation':incarnationId}});
  expect(missing.status).toBe(401);expect(await missing.json()).toEqual({error:'COLLECTOR_AUTH_REQUIRED'});
  const wrong=await fetch(origin+path,{method,headers:{...headers,authorization:'Bearer synthetic-wrong-node-token-'+randomUUID()}});
  expect(wrong.status).toBe(401);expect(await wrong.json()).toEqual({error:'COLLECTOR_AUTH_REJECTED'});
 });

 it.each(routes)('%s %s still checks the trusted machine source scope',async(method,path)=>{
  const response=await fetch(origin+path,{method,headers:{...headers,'x-collector-source':'snapchat_ads_gallery'}});
  expect(response.status).toBe(403);expect(await response.json()).toEqual({error:'MACHINE_SOURCE_FORBIDDEN'});
 });
});
