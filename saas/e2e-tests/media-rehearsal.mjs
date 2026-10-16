/** Local-only visual rehearsal. Synthetic assets, isolated DB, native app/API.
 * Run with the bundled Node. No existing env files or cloud credentials are read.
 * HTTPS certificate acceptance is a separate human browser step, never automated.
 */
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import https from 'node:https';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile), base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(base, 'app/package.json'));
const { PrismaClient } = require('@prisma/client');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const serverRequire = createRequire(join(base, 'app/.wasp/out/server/package.json'));
const { hashPassword } = await import(serverRequire.resolve('@wasp.sh/lib-auth/node'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const suffix = randomUUID().replaceAll('-', ''), database = `saas_media_ui_test_${suffix}`;
const pg = '/opt/homebrew/opt/postgresql@15/bin';
const url = `postgresql://saas_local@127.0.0.1:55438/${database}`;
assert(/^saas_media_ui_test_[a-f0-9]{32}$/.test(database));
const root = await mkdtemp('/private/tmp/ds-meta-media-ui-'); await chmod(root, 0o700);
const origin = 'http://127.0.0.1:3004', apiOrigin = 'http://127.0.0.1:3002', endpoint = 'https://127.0.0.1:14443';
const bucket = 'media-ui-fixture', accessKeyId = 'LOCAL_MEDIA_FIXTURE_ONLY', secretAccessKey = 'synthetic-media-key-not-a-cloud-credential';
const email = `media-${suffix}@example.test`, password = 'LocalMediaFixture-2026!';
const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, NODE_ENV: 'development', DATABASE_URL: url, PORT: '3002',
  WASP_WEB_CLIENT_URL: origin, WASP_SERVER_URL: apiOrigin, REACT_APP_API_URL: apiOrigin,
  JWT_SECRET: `media-rehearsal-${suffix}`, OUTBOX_ENCRYPTION_KEY: 'c'.repeat(64), SMTP_HOST: '127.0.0.1', SMTP_PORT: '1',
  SMTP_USERNAME: 'fixture', SMTP_PASSWORD: 'fixture', EMAIL_FROM: 'media@example.test', REGISTRATION_MODE: 'invite',
  BILLING_ENABLED: 'false', GOOGLE_AUTH_ENABLED: 'false', GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
  S3_BUCKET: bucket, S3_REGION: 'us-east-1', S3_ENDPOINT: endpoint, S3_FORCE_PATH_STYLE: 'true',
  AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, AWS_EC2_METADATA_DISABLED: 'true' };
const children = [], objects = new Map(), metrics = { signedGets: 0, ranges: 0, rejected: 0, injectedFailures: 0 };
let db, service, created = false, stopping = false, failureMode = true;
async function stop() {
  if (stopping) return; stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exitCode === null ? once(child, 'exit') : Promise.resolve()));
  if (service) await new Promise(resolve => service.close(resolve));
  await db?.$disconnect();
  // This dedicated database is retained for inspection; no existing DB is touched.
  await writeFile(join(root, 'stopped.json'), JSON.stringify({ status: 'STOPPED', databaseRetained: created, database, metrics }), { mode: 0o600 });
}
process.once('SIGTERM', () => void stop().then(() => process.exit(0)));
process.once('SIGINT', () => void stop().then(() => process.exit(0)));
function launch(args, cwd, childEnv = env) {
  const child = spawn(process.execPath, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  // Deliberately retain no raw logs: provider/URL data must not reach reports.
  child.stdout.resume(); child.stderr.resume(); return child;
}
async function waitReady(address) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(address, { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('LOCAL_SERVICE_NOT_READY');
}
function signed(request, target) {
  const p = target.searchParams, credential = p.get('X-Amz-Credential')?.split('/'), when = p.get('X-Amz-Date'), ttl = Number(p.get('X-Amz-Expires'));
  if (p.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' || p.get('X-Amz-SignedHeaders') !== 'host' || !credential || credential.join('/').split('/').length !== 5
    || credential[0] !== accessKeyId || credential[2] !== 'us-east-1' || credential[3] !== 's3' || credential[4] !== 'aws4_request'
    || !/^\d{8}T\d{6}Z$/.test(when ?? '') || !Number.isInteger(ttl) || ttl < 1 || ttl > 300) return false;
  const timestamp = Date.parse(when.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'));
  if (Date.now() < timestamp || Date.now() >= timestamp + ttl * 1000 || credential[1] !== when.slice(0, 8)) return false;
  const query = [...p].filter(([key]) => key !== 'X-Amz-Signature').map(([key, value]) => [encode(key), encode(value)])
    .sort(([ak,av], [bk,bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0).map(([key,value]) => `${key}=${value}`).join('&');
  const canonical = [request.method, target.pathname, query, `host:${request.headers.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = credential.slice(1).join('/'), text = ['AWS4-HMAC-SHA256', when, scope, hash(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, credential[1]), 'us-east-1'), 's3'), 'aws4_request');
  const actual = Buffer.from(p.get('X-Amz-Signature') ?? '', 'hex'), expected = hmac(signingKey, text);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function localGet(address, ca, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(address, { ca, headers, timeout: 5000 }, response => {
      const parts = []; response.on('data', chunk => parts.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(parts), headers: response.headers }));
    }).on('error', reject);
  });
}
try {
  await exec(join(pg, 'createdb'), ['-h','127.0.0.1','-p','55438','-U','saas_local','--template=template0',database], { env: { PATH: process.env.PATH, PGPASSFILE: '/dev/null' } }); created = true;
  await exec(process.execPath, [join(base,'app/node_modules/prisma/build/index.js'),'migrate','deploy','--schema',join(base,'app/.wasp/out/db/schema.prisma')], { cwd: root, env, maxBuffer: 1024 * 1024 });
  await exec('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost'], { env: { PATH: process.env.PATH } });
  await chmod(join(root,'key.pem'),0o600); await chmod(join(root,'cert.pem'),0o600);
  await exec('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x360:rate=1','-frames:v','1',join(root,'image.png')]);
  await exec('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24','-t','4','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',join(root,'video.mp4')]);
  const image = await readFile(join(root,'image.png')), video = await readFile(join(root,'video.mp4'));
  const ca = await readFile(join(root,'cert.pem'));
  db = new PrismaClient({ datasources: { db: { url } } });
  const userId=randomUUID(), orgId=randomUUID(), workspaceId=randomUUID(), adId=randomUUID();
  const ids=[randomUUID(),randomUUID(),randomUUID()];
  const media = [{bytes:image,type:'IMAGE',mimeType:'image/png'},{bytes:video,type:'VIDEO',mimeType:'video/mp4'},{bytes:image,type:'IMAGE',mimeType:'image/png'}];
  const hashedPassword = await hashPassword(password);
  await db.$transaction(async tx => {
    await tx.user.create({data:{id:userId,email,displayName:'合成媒体验收员',onboardingCompletedAt:new Date()}});
    await tx.auth.create({data:{id:randomUUID(),userId,identities:{create:{providerName:'email',providerUserId:email,providerData:JSON.stringify({hashedPassword,isEmailVerified:true,emailVerificationSentAt:null,passwordResetSentAt:null})}}}});
    await tx.organization.create({data:{id:orgId,name:'本机合成媒体验收',slug:`media-${suffix}`}});
    await tx.organizationMember.create({data:{organizationId:orgId,userId,role:'OWNER'}});
    await tx.workspace.create({data:{id:workspaceId,organizationId:orgId,name:'独立媒体工作区',slug:`media-${suffix}`}});
    const source=await tx.dataSource.create({data:{key:`media-ui-${suffix}`,name:'合成媒体夹具（非真实广告来源）',status:'PAUSED',adapterVersion:'synthetic-ui-v1'}});
    await tx.ad.create({data:{id:adId,dataSourceId:source.id,sourceAdId:`synthetic-${suffix}`,sourceUrl:'https://example.test/synthetic-media',body:'合成媒体验收：测试图、四秒视频与加载失败恢复。不代表真实广告或来源覆盖。',headline:'本机图片与视频播放验收',mediaType:'MIXED',sourceStatus:'UNKNOWN',fieldProvenance:{syntheticFixture:true,advertiserName:{value:'合成媒体验收'}},media:{create:media.map((item,index)=>({id:ids[index],sourceUrl:`https://example.test/synthetic-${index}`,type:item.type,mimeType:item.mimeType,status:'READY',storageKey:`public-media/${ids[index]}`,sha256:hash(item.bytes),sizeBytes:BigInt(item.bytes.length),width:640,height:360,durationMs:item.type==='VIDEO'?4000:null,displayOrder:index,downloadedAt:new Date()}))}}});
  });
  media.forEach((item,index)=>objects.set(`/${bucket}/public-media/${ids[index]}`,{...item,index}));
  service=https.createServer({key:await readFile(join(root,'key.pem')),cert:ca},(request,response)=>{
    const target=new URL(request.url,endpoint);
    response.setHeader('Cache-Control','private, no-store');
    response.setHeader('Access-Control-Allow-Origin',origin); response.setHeader('Cross-Origin-Resource-Policy','cross-origin');
    if(target.pathname==='/health'){response.writeHead(200,{'Content-Type':'text/plain'}).end('LOCAL_SYNTHETIC_MEDIA_ONLY');return;}
    if(request.method==='POST'&&target.pathname==='/repair'&&request.headers['x-fixture-control']===suffix){failureMode=false;response.writeHead(204).end();return;}
    if(!signed(request,target)){metrics.rejected++;response.writeHead(403).end('Signature rejected');return;}
    const item=objects.get(target.pathname); if(!item){response.writeHead(404).end();return;}
    if(item.index===2&&failureMode){metrics.injectedFailures++;response.writeHead(503).end('Synthetic temporary failure');return;}
    metrics.signedGets++;response.setHeader('Content-Type',item.mimeType);response.setHeader('Accept-Ranges','bytes');
    const range=/^bytes=(\d+)-(\d*)$/.exec(request.headers.range??'');
    if(range){const start=Number(range[1]),end=Math.min(Number(range[2]||item.bytes.length-1),item.bytes.length-1);if(start>end){response.writeHead(416).end();return;}metrics.ranges++;response.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${item.bytes.length}`,'Content-Length':end-start+1}).end(item.bytes.subarray(start,end+1));}
    else response.writeHead(200,{'Content-Length':item.bytes.length}).end(item.bytes);
  });
  service.listen(14443,'127.0.0.1');await once(service,'listening');
  const sdk=new S3Client({endpoint,region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId,secretAccessKey},ignoreConfiguredEndpointUrls:true});
  const signedImage=await getSignedUrl(sdk,new GetObjectCommand({Bucket:bucket,Key:`public-media/${ids[0]}`}),{expiresIn:2});
  assert.equal((await localGet(endpoint+`/${bucket}/public-media/${ids[0]}`,ca)).status,403);
  assert.deepEqual((await localGet(signedImage,ca)).body,image);
  const signedVideo=await getSignedUrl(sdk,new GetObjectCommand({Bucket:bucket,Key:`public-media/${ids[1]}`}),{expiresIn:60});
  const range=await localGet(signedVideo,ca,{Range:'bytes=0-31'});assert.equal(range.status,206);assert.deepEqual(range.body,video.subarray(0,32));
  const changed=new URL(signedVideo);changed.searchParams.set('X-Amz-Signature','0'.repeat(64));assert.equal((await localGet(changed.href,ca)).status,403);
  await new Promise(resolve=>setTimeout(resolve,2200));assert.equal((await localGet(signedImage,ca)).status,403);sdk.destroy();
  const networkGuard=`import http from 'node:http';import https from 'node:https';import {syncBuiltinESMExports} from 'node:module';for(const t of [http,https]){const request=t.request.bind(t);t.request=(value,...rest)=>{const host=typeof value==='string'||value instanceof URL?new URL(value).hostname:value.hostname??value.host;if(!['127.0.0.1','localhost','::1','[::1]'].includes(host))throw Error('EXTERNAL_REQUEST_FORBIDDEN');return request(value,...rest)}}syncBuiltinESMExports();globalThis.fetch=async()=>{throw Error('PROVIDER_FETCH_FORBIDDEN')};`;
  launch(['--import',`data:text/javascript,${encodeURIComponent(networkGuard)}`,join(base,'app/.wasp/out/server/bundle/server.js')],root);
  await waitReady(apiOrigin+'/auth/options');
  launch([join(base,'app/node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','3004','--strictPort'],join(base,'app'));
  await waitReady(origin+'/login');
  const summary={status:'LOCAL_MEDIA_SERVICES_READY',database,origin,apiOrigin,objectHealthUrl:endpoint+'/health',email,password,workspaceId,adId,
    searchUrl:`${origin}/app/ads?workspace=${workspaceId}&q=${encodeURIComponent('合成媒体验收')}`,detailUrl:`${origin}/app/ads/${adId}?workspace=${workspaceId}`,
    fixtureRoot:root,controlToken:suffix,objects:media.map((item,index)=>({id:ids[index],type:item.type,sizeBytes:item.bytes.length,sha256:hash(item.bytes)})),
    certificateSha256:hash(ca),serviceChecks:{unsignedRejected:true,signedImageBytesMatch:true,tamperedSignatureRejected:true,expiredSignatureRejected:true,videoRangeMatches:true},browserAcceptance:'NOT_RUN'};
  await writeFile(join(root,'fixture.json'),JSON.stringify(summary,null,2),{mode:0o600});
  await writeFile(join(root,'service-evidence.json'),JSON.stringify({...summary,password:undefined,controlToken:undefined},null,2),{mode:0o600});
  console.log(JSON.stringify({status:summary.status,fixtureRoot:root,database,objectHealthUrl:summary.objectHealthUrl,serviceChecks:summary.serviceChecks}));
}catch{console.error(JSON.stringify({status:'LOCAL_MEDIA_REHEARSAL_FAILED',code:'FIXTURE_SETUP_FAILED',fixtureRoot:root}));await stop();process.exitCode=1;}
