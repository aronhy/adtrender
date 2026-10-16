import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('Caddy serves the SPA-only root and keeps missing assets out of the fallback', async () => {
  const config = await readFile(new URL('./Caddyfile.example', import.meta.url), 'utf8');
  const assets = config.match(/handle \/assets\/\* \{([\s\S]*?)\n    \}/)?.[1];
  assert(assets); assert.match(assets, /file_server/); assert.doesNotMatch(assets, /try_files|rewrite/);
  assert.match(config, /file_server\s*\{\s*index index\.html 200\.html\s*\}/);
  assert.match(config, /header_up X-Real-IP \{remote_host\}/);
});

test('container image uses locked runtime, explicit builds and a non-root user', async () => {
  const dockerfile = await readFile(new URL('./container/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /FROM node:24\.14\.1-bookworm-slim/);
  assert.match(dockerfile, /npm@11\.18\.0/);
  assert.match(dockerfile, /npm ci[^\n]+--ignore-scripts[^\n]+--no-audit/);
  assert.match(dockerfile, /prisma\/build\/index\.js generate/);
  assert.match(dockerfile, /npm run bundle --workspace=@wasp\.sh\/generated-server/);
  assert.match(dockerfile, /playwright\/cli\.js install --with-deps chromium/);
  assert.match(dockerfile, /USER node:node/);
  assert.doesNotMatch(dockerfile, /--no-sandbox|npm audit|ARG .*SECRET|ENV .*PASSWORD/);
  const policy = JSON.parse(await readFile(new URL('./container/seccomp_profile.json', import.meta.url), 'utf8'));
  assert.equal(policy.defaultAction, 'SCMP_ACT_ERRNO');
  for (const name of ['clone', 'setns', 'unshare']) assert(policy.syscalls.some(rule => rule.action === 'SCMP_ACT_ALLOW' && rule.names.includes(name) && !rule.includes?.caps?.length));
});

test('Chromium may chroot in its user namespace without granting container capabilities', async () => {
  const policy = JSON.parse(await readFile(new URL('./container/seccomp_profile.json', import.meta.url), 'utf8'));
  const chrootRules = policy.syscalls.filter(rule => rule.names.includes('chroot'));
  assert.equal(chrootRules.length, 1);
  assert.deepEqual(chrootRules[0].names, ['chroot']);
  assert.equal(chrootRules[0].action, 'SCMP_ACT_ALLOW');
  assert.deepEqual(chrootRules[0].args, []);
  assert.deepEqual(chrootRules[0].includes, {});
  assert.deepEqual(chrootRules[0].excludes, {});
  assert.equal(policy.defaultAction, 'SCMP_ACT_ERRNO');
  // Restoring this one rule must reproduce the exact official profile: no
  // unrelated syscall permission may be added by the sandbox compatibility fix.
  chrootRules[0].comment = ''; chrootRules[0].includes = { caps: ['CAP_SYS_CHROOT'] };
  assert.equal(createHash('sha256').update(JSON.stringify(policy, null, '\t')+'\n').digest('hex'), 'cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849');
});

const composeAvailable = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
test('Compose isolates data, exposes only loopback API/S3 and shares the app environment', { skip: !composeAvailable }, () => {
  const result = spawnSync('docker', ['compose', '-f', fileURLToPath(new URL('./container/compose.yml', import.meta.url)), 'config', '--no-env-resolution', '--format', 'json'], {
    encoding: 'utf8', env: { ...process.env, AD_RESEARCH_RELEASE_ID: 'static-check', AD_RESEARCH_APP_ENV_FILE: '/nonexistent/app.env', AD_RESEARCH_DB_ENV_FILE: '/nonexistent/db.env', AD_RESEARCH_GARAGE_ENV_FILE: '/nonexistent/garage.env' },
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout); const { api, worker, database, garage } = config.services;
  assert.equal(api.image, worker.image); assert.deepEqual(api.env_file, worker.env_file);
  assert.equal(api.user, '1000:1000'); assert.equal(worker.user, '1000:1000');
  assert.equal(api.ports[0].host_ip, '127.0.0.1'); assert.equal(api.ports[0].published, '13001');
  assert.equal(garage.ports[0].host_ip, '127.0.0.1'); assert.equal(garage.ports[0].published, '13900');
  assert.equal(database.ports, undefined); assert.equal(worker.ports, undefined);
  assert.equal(config.networks.data.internal, true); assert.deepEqual(Object.keys(database.networks), ['data']);
  assert.deepEqual(Object.keys(garage.networks).sort(), ['data', 'ingress']);
  assert.equal(config.networks.ingress.driver, 'bridge'); assert.notEqual(config.networks.ingress.internal, true);
  for (const service of [api, worker]) assert.deepEqual(Object.keys(service.networks).sort(), ['data', 'outbound']);
  assert.equal(database.image, 'postgres:15.17-bookworm'); assert.equal(garage.image, 'dxflrs/garage:v2.4.1');
  assert.deepEqual(garage.command, ['/garage', 'server', '--single-node', '--default-bucket']);
  assert.deepEqual(garage.volumes.filter(v => v.type === 'volume').map(v => v.target).sort(), ['/data/meta', '/data/objects']);
  for (const service of Object.values(config.services)) { assert.equal(service.privileged, undefined); assert.equal(service.container_name, undefined); assert.equal(service.network_mode, undefined); }
  assert.equal(worker.cap_add, undefined); assert.deepEqual(worker.cap_drop, ['ALL']);
  assert(worker.security_opt.includes('no-new-privileges:true'));
  assert(worker.security_opt.some(value => value.startsWith('seccomp=')));
});

test('external worker override replaces only security options and preserves isolation', { skip: !composeAvailable }, () => {
  const base = fileURLToPath(new URL('./container/compose.yml', import.meta.url));
  const env = { ...process.env, AD_RESEARCH_RELEASE_ID: 'static-check', AD_RESEARCH_APP_ENV_FILE: '/nonexistent/app.env', AD_RESEARCH_DB_ENV_FILE: '/nonexistent/db.env', AD_RESEARCH_GARAGE_ENV_FILE: '/nonexistent/garage.env' };
  const run = (override = false) => {
    const args = ['compose', '-f', base]; if (override) args.push('-f', '-');
    args.push('config', '--no-env-resolution', '--format', 'json');
    const result = spawnSync('docker', args, { encoding: 'utf8', env, input: override ? 'services:\n  worker:\n    security_opt: !override\n      - no-new-privileges:true\n      - seccomp=/etc/ad-research-test/seccomp_profile.json\n' : undefined });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const baseConfig = run(); const overridden = run(true);
  assert.deepEqual(overridden.services.worker.security_opt, ['no-new-privileges:true', 'seccomp=/etc/ad-research-test/seccomp_profile.json']);
  baseConfig.services.worker.security_opt = overridden.services.worker.security_opt;
  assert.deepEqual(overridden, baseConfig);
});
