import { createRequire } from 'node:module';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { runSourceProbe, grantSourceProfile } from './source-probe';
import { verifiedSourceProfiles } from '../../contracts/src/collection';
const network=vi.hoisted(()=>({status:'success',calls:0}));
vi.mock('../../collector/src/meta-adapter',async importOriginal=>{
 const original=await importOriginal<typeof import('../../collector/src/meta-adapter')>();
 return {...original,collectMetaAds:async(query:any,options:any)=>{
  network.calls++;await options.onEvidence({url:original.buildMetaSearchUrl(query),httpStatus:network.status==='success'?200:403,html:'<html><body>Library ID: 987654321 <p>Explicit isolated test DOM; never a production source sample.</p></body></html>',observedAt:new Date().toISOString(),parserVersion:'meta-dom-1'});
  return {status:network.status,errorCode:network.status==='success'?null:'META_HTTP_403',retryable:false,ads:network.status==='success'?[{sourceAdId:'987654321'}]:[],observedCardCount:network.status==='success'?1:0,parsedAdCount:network.status==='success'?1:0,parserVersion:'meta-dom-1',collectedAt:new Date().toISOString()};
 }};
});
const require=createRequire(new URL('../../app/package.json',import.meta.url));
const url=process.env.SAAS_TEST_DATABASE_URL;let db:any,admin:any,outsider:any,source:any;const directories:string[]=[];
const env={SOURCE_PROBE_SIGNING_KEY:'f'.repeat(64)},query={keyword:'coffee',country:'US',status:'all',mediaType:'all',limit:3};
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
async function fixture() {const evidenceRoot=await mkdtemp(join(tmpdir(),'source-probe-test-'));directories.push(evidenceRoot);return {actorUserId:admin.id,sourceId:source.id,query,evidenceRoot};}
beforeEach(()=>{network.status='success';network.calls=0;});
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
afterAll(()=>db?.$disconnect());
describe.skipIf(!url)('operator source probes with mocked network and real PostgreSQL authorization',()=>{
 beforeAll(async()=>{const {PrismaClient}=require('@prisma/client');db=new PrismaClient({datasources:{db:{url}}});admin=await db.user.create({data:{email:`probe-admin-${randomUUID()}@example.test`,isAdmin:true}});outsider=await db.user.create({data:{email:`probe-outsider-${randomUUID()}@example.test`}});source=await db.dataSource.create({data:{key:`probe-${randomUUID()}`,name:'Explicit isolated probe test',adapterVersion:'meta-dom-1',status:'PAUSED'}});});
 it('requires a current platform admin, a signing key and limit at most three before network work',async()=>{
  const input=await fixture();await expect(runSourceProbe(db,{...input,actorUserId:outsider.id},env)).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});
  await expect(runSourceProbe(db,input,{})).rejects.toMatchObject({code:'SOURCE_PROBE_SIGNING_KEY_REQUIRED'});
  await expect(runSourceProbe(db,{...input,query:{...query,limit:4}},env)).rejects.toMatchObject({code:'SOURCE_PROBE_LIMIT_EXCEEDED'});expect(network.calls).toBe(0);
 });
 it('reads raw evidence, verifies its signature and grants only the exact profile without activating',async()=>{
  const input=await fixture();const probe=await runSourceProbe(db,input,env);expect(network.calls).toBe(1);const profile=await grantSourceProfile(db,{...input,manifestPath:probe.manifestPath},env);
  expect(profile).toMatchObject({sourceId:source.id,query,adapterVersion:'meta-dom-1'});expect((await db.dataSource.findUnique({where:{id:source.id}})).status).toBe('PAUSED');
  expect((await grantSourceProfile(db,{...input,manifestPath:probe.manifestPath},env)).id).toBe(profile.id);
  expect(await db.auditEvent.count({where:{action:'SOURCE_QUERY_VERIFIED',targetId:source.id,metadata:{path:['probeId'],equals:profile.id}}})).toBe(1);
  const read=await db.dataSource.findUnique({where:{id:source.id}});expect(verifiedSourceProfiles(read).some(item=>item.id===profile.id)).toBe(true);
 });
 it('rejects unsigned or altered manifests and changed raw HTML',async()=>{
  const input=await fixture();const probe=await runSourceProbe(db,input,env);const original=await readFile(probe.manifestPath,'utf8');const envelope=JSON.parse(original);envelope.manifest.query.country='GB';await writeFile(probe.manifestPath,JSON.stringify(envelope));
  await expect(grantSourceProfile(db,{...input,manifestPath:probe.manifestPath},env)).rejects.toMatchObject({code:'SOURCE_PROBE_SIGNATURE_INVALID'});
  await writeFile(probe.manifestPath,original);const item=JSON.parse(original).manifest.evidence[0];const path=join(dirname(probe.manifestPath),item.file);const html=await readFile(path,'utf8');await writeFile(path,html.replace('987654321','111111111'));
  await expect(grantSourceProfile(db,{...input,manifestPath:probe.manifestPath},env)).rejects.toMatchObject({code:'SOURCE_PROBE_EVIDENCE_HASH_MISMATCH'});
 });
 it('rejects a signed fixture provenance and never grants a restricted real-attempt report',async()=>{
  const input=await fixture();const probe=await runSourceProbe(db,input,env);const envelope=JSON.parse(await readFile(probe.manifestPath,'utf8'));envelope.manifest.provenance='fixture';envelope.manifestSha256=createHash('sha256').update(JSON.stringify(canonical(envelope.manifest))).digest('hex');envelope.signature=createHmac('sha256',Buffer.from(env.SOURCE_PROBE_SIGNING_KEY,'hex')).update(`meta-source-probe-v1:${envelope.manifestSha256}`).digest('hex');await writeFile(probe.manifestPath,JSON.stringify(envelope));
  await expect(grantSourceProfile(db,{...input,manifestPath:probe.manifestPath},env)).rejects.toMatchObject({code:'SOURCE_PROBE_MANIFEST_INVALID'});
  network.status='restricted';const blocked=await runSourceProbe(db,input,env);expect(blocked).toMatchObject({status:'restricted',errorCode:'META_HTTP_403'});
  await expect(grantSourceProfile(db,{...input,manifestPath:blocked.manifestPath},env)).rejects.toMatchObject({code:'SOURCE_PROBE_NOT_SUCCESSFUL'});expect((await db.dataSource.findUnique({where:{id:source.id}})).status).toBe('PAUSED');
 });
});
