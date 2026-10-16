import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { request } from 'node:https';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const path = new URL('./container/nginx-site.conf.example', import.meta.url);
test('single-domain proxy keeps S3 URI/Host and covers the generated API prefixes', async () => {
  const text = await readFile(path, 'utf8');
  assert.match(text, /root \/www\/wwwroot\/adtrender\/current;/);
  assert.match(text, /index 200\.html;/); assert.match(text, /try_files \$uri \/200\.html;/);
  assert.match(text, /\(auth\|operations\|billing\|health\|growth\)/);
  assert.match(text, /proxy_pass http:\/\/127\.0\.0\.1:13900;/);
  assert.match(text, /proxy_set_header Host \$http_host;/);
  assert.match(text, /proxy_set_header X-Real-IP \$remote_addr;/);
  assert.doesNotMatch(text, /\brewrite\b|proxy_pass http:\/\/127\.0\.0\.1:13900\//);
  assert.match(text, /\/etc\/letsencrypt\/live\/ad-research-test\/fullchain\.pem/);
  assert.match(text, /root \/www\/wwwroot\/acme;/);
  assert.doesNotMatch(text, /3901|3902|3903|13901|13902|13903/);
});

const nginxAvailable = spawnSync('nginx', ['-v'], { encoding: 'utf8' }).status === 0;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const reserve = async () => { const server = createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; };
const get = (port, path, headers = {}, secure = true) => new Promise((resolve, reject) => {
  const send = secure ? request : httpRequest;
  const req = send({ hostname: '127.0.0.1', port, path, method: 'GET', rejectUnauthorized: false, headers: { Host: 'adtrender.com', ...headers } }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  }); req.on('error', reject); req.end();
});
const upload = (port, path, sizeBytes) => new Promise((resolve, reject) => {
  const chunk = Buffer.alloc(64 * 1024, 0x5a);
  let remaining = sizeBytes; let responseStarted = false;
  const req = request({ hostname: '127.0.0.1', port, path, method: 'PUT', rejectUnauthorized: false,
    headers: { Host: 'adtrender.com', 'Content-Type': 'video/mp4', 'Content-Length': sizeBytes } }, res => {
    responseStarted = true;
    const chunks = []; res.on('data', data => chunks.push(data));
    res.once('error', reject);
    res.once('end', () => { req.destroy(); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }); });
  });
  req.once('error', error => { if (!responseStarted) reject(error); });
  const write = () => {
    while (!responseStarted && remaining > 0) {
      const length = Math.min(chunk.length, remaining); remaining -= length;
      if (!req.write(chunk.subarray(0, length))) { req.once('drain', write); return; }
    }
    if (!responseStarted) req.end();
  };
  write();
});

test('real local Nginx routes SPA, keeps API uploads bounded and streams large signed S3 uploads', { skip: !nginxAvailable, timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'saas-nginx-check-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const publicDir = join(dir, 'public'); await mkdir(join(publicDir, 'assets'), { recursive: true });
  await writeFile(join(publicDir, '200.html'), 'SPA_FIXTURE'); await writeFile(join(publicDir, 'assets/test.js'), 'STATIC_FIXTURE');
  const api = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ route: 'api', uri: req.url, host: req.headers.host, realIp: req.headers['x-real-ip'] })); });
  const s3 = createServer((req, res) => {
    const reply = bodyBytes => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ route: 's3', uri: req.url, host: req.headers.host, ...(bodyBytes === undefined ? {} : { bodyBytes }) })); };
    if (req.method !== 'PUT') { reply(); return; }
    let bodyBytes = 0;
    req.on('data', chunk => { bodyBytes += chunk.length; });
    req.on('end', () => reply(bodyBytes));
  });
  const apiPort = await listen(api); const s3Port = await listen(s3);
  t.after(() => new Promise(resolve => api.close(resolve))); t.after(() => new Promise(resolve => s3.close(resolve)));
  const httpsPort = await reserve(); const httpPort = await reserve();
  const cert = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=adtrender.com', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { encoding: 'utf8' });
  assert.equal(cert.status, 0, 'Could not generate isolated test certificate');
  let config = await readFile(path, 'utf8');
  config = config.replaceAll('listen 80;', `listen 127.0.0.1:${httpPort};`).replaceAll('listen 443 ssl;', `listen 127.0.0.1:${httpsPort} ssl;`)
    .replaceAll('/www/wwwroot/adtrender/current', publicDir).replaceAll('/etc/letsencrypt/live/ad-research-test/fullchain.pem', join(dir, 'cert.pem')).replaceAll('/etc/letsencrypt/live/ad-research-test/privkey.pem', join(dir, 'key.pem'))
    .replaceAll('/var/log/nginx/ad-research-test.error.log', join(dir, 'error.log')).replaceAll('127.0.0.1:13001', `127.0.0.1:${apiPort}`).replaceAll('127.0.0.1:13900', `127.0.0.1:${s3Port}`);
  await writeFile(join(dir, 'nginx.conf'), `daemon off;\npid ${dir}/nginx.pid;\nerror_log ${dir}/error.log crit;\nevents {}\nhttp { client_body_temp_path ${dir}/body; proxy_temp_path ${dir}/proxy; ${config} }`);
  const syntax = spawnSync('nginx', ['-p', dir+'/', '-c', join(dir, 'nginx.conf'), '-t'], { encoding: 'utf8' }); assert.equal(syntax.status, 0, syntax.stderr);
  const nginx = spawn('nginx', ['-p', dir+'/', '-c', join(dir, 'nginx.conf')], { stdio: 'ignore' });
  t.after(async () => { if (nginx.exitCode === null) await new Promise(resolve => { nginx.once('exit', resolve); nginx.kill('SIGQUIT'); }); });
  let ready; for (let i = 0; i < 30; i++) { try { ready = await get(httpsPort, '/'); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); } }
  assert.equal(ready?.body, 'SPA_FIXTURE');
  assert.equal((await get(httpsPort, '/app/ads/example?workspace=fixture')).body, 'SPA_FIXTURE');
  for (const route of ['/app/admin?url=https%3A%2F%2Fattacker.example&token=fixture-secret&module=users&lang=en', '/app/admin/?redirect=https://attacker.example', '/app/admin/users?access_token=fixture-secret']) {
    for (const [port, secure] of [[httpsPort, true], [httpPort, false]]) {
      const redirected = await get(port, route, {}, secure);
      assert.equal(redirected.status, 302);
      assert.equal(redirected.headers.location, 'https://admin.adtrender.com/app/admin');
      assert(!redirected.headers.location.includes('fixture-secret'));
    }
  }
  assert.equal((await get(httpsPort, '/assets/test.js')).body, 'STATIC_FIXTURE');
  const missing = await get(httpsPort, '/assets/missing.js'); assert.equal(missing.status, 404); assert(!missing.body.includes('SPA_FIXTURE'));
  for (const route of ['/auth/email/verify-email', '/operations/app-command', '/operations/get-public-ad', '/billing/stripe/webhook', '/health', '/growth/consent', '/growth/events']) {
    const response = JSON.parse((await get(httpsPort, route, { 'X-Real-IP': '198.51.100.7', 'X-Forwarded-For': '198.51.100.8' })).body);
    assert.equal(response.route, 'api'); assert.equal(response.realIp, '127.0.0.1');
  }
  const signedPath = '/ad-research-test-objects/public-media/key%20space?X-Amz-Signature=fixture&X-Amz-Expires=60';
  assert.deepEqual(JSON.parse((await get(httpsPort, signedPath)).body), { route: 's3', uri: signedPath, host: 'adtrender.com' });
  const fileSize = 129 * 1024 * 1024;
  const uploaded = await upload(httpsPort, signedPath, fileSize);
  assert.equal(uploaded.status, 200, 'S3 uploads must preserve media files above the previous 128 MiB proxy limit');
  assert.deepEqual(JSON.parse(uploaded.body), { route: 's3', uri: signedPath, host: 'adtrender.com', bodyBytes: fileSize });
  assert.equal((await upload(httpsPort, '/operations/app-command', 3 * 1024 * 1024)).status, 413, 'API uploads must retain the 2 MiB limit');
});

test('admin Nginx serves its own SPA and leaves auth, API and object storage on the customer origin', { skip: !nginxAvailable, timeout: 20000 }, async t => {
  const template = await readFile(new URL('./container/nginx-admin-site.conf.example', import.meta.url), 'utf8').catch(error => {
    if (error.code === 'ENOENT') assert.fail('Admin Nginx template is required');
    throw error;
  });
  const dir = await mkdtemp(join(tmpdir(), 'saas-admin-nginx-check-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const publicDir = join(dir, 'public'); await mkdir(join(publicDir, 'assets'), { recursive: true });
  await writeFile(join(publicDir, '200.html'), 'ADMIN_SPA_FIXTURE'); await writeFile(join(publicDir, 'assets/admin.js'), 'ADMIN_STATIC_FIXTURE');
  const httpsPort = await reserve(), httpPort = await reserve();
  const cert = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=admin.adtrender.com', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { encoding: 'utf8' });
  assert.equal(cert.status, 0, 'Could not generate isolated test certificate');
  const config = template.replaceAll('listen 80;', `listen 127.0.0.1:${httpPort};`).replaceAll('listen 443 ssl;', `listen 127.0.0.1:${httpsPort} ssl;`)
    .replaceAll('/www/wwwroot/adtrender-admin/current', publicDir).replaceAll('/etc/letsencrypt/live/adtrender-admin/fullchain.pem', join(dir, 'cert.pem')).replaceAll('/etc/letsencrypt/live/adtrender-admin/privkey.pem', join(dir, 'key.pem'))
    .replaceAll('/var/log/nginx/adtrender-admin.error.log', join(dir, 'error.log'));
  await writeFile(join(dir, 'nginx.conf'), `daemon off;\npid ${dir}/nginx.pid;\nerror_log ${dir}/error.log crit;\nevents {}\nhttp { ${config} }`);
  const syntax = spawnSync('nginx', ['-p', dir+'/', '-c', join(dir, 'nginx.conf'), '-t'], { encoding: 'utf8' }); assert.equal(syntax.status, 0, syntax.stderr);
  const nginx = spawn('nginx', ['-p', dir+'/', '-c', join(dir, 'nginx.conf')], { stdio: 'ignore' });
  t.after(async () => { if (nginx.exitCode === null) await new Promise(resolve => { nginx.once('exit', resolve); nginx.kill('SIGQUIT'); }); });
  let ready; for (let i = 0; i < 30; i++) { try { ready = await get(httpsPort, '/', { Host: 'admin.adtrender.com' }); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); } }
  assert.equal(ready?.status, 302); assert.equal(ready.headers.location, 'https://admin.adtrender.com/app/admin');
  assert.equal((await get(httpsPort, '/?url=https://attacker.example&token=fixture-secret', { Host: 'attacker.example' })).headers.location, 'https://admin.adtrender.com/app/admin');
  assert.equal((await get(httpsPort, '/app/admin?module=users&lang=en', { Host: 'admin.adtrender.com' })).body, 'ADMIN_SPA_FIXTURE');
  assert.equal((await get(httpsPort, '/login', { Host: 'admin.adtrender.com' })).body, 'ADMIN_SPA_FIXTURE');
  assert.equal((await get(httpsPort, '/assets/admin.js', { Host: 'admin.adtrender.com' })).body, 'ADMIN_STATIC_FIXTURE');
  for (const route of ['/assets/missing.js', '/auth/google/callback?code=fixture-secret', '/operations/get-platform-admin-data', '/api/internal/seeds/config', '/billing/stripe/webhook', '/health', '/growth/events', '/ad-research-test-objects/public-media/fixture?X-Amz-Signature=fixture-secret']) {
    const result = await get(httpsPort, route, { Host: 'admin.adtrender.com' });
    assert.equal(result.status, 404, route); assert(!result.body.includes('ADMIN_SPA_FIXTURE'));
  }
});
