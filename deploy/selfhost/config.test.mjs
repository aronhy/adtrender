import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, readFile, rm, appendFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
let compose = true;
try { execFileSync('docker', ['compose', 'version'], { stdio: 'ignore', timeout: 10000 }); } catch { compose = false; }
if (process.env.CI && !compose) throw new Error('Docker Compose CLI is required for self-host CI checks');

for (const domain of ['localhost', 'research.example.test']) {
  test(`initialization wires both application surfaces for ${domain}`, { skip: !compose }, async t => {
    const fixture = await mkdtemp(join(tmpdir(), 'adtrender-selfhost-'));
    t.after(() => rm(fixture, { recursive: true, force: true }));
    await mkdir(join(fixture, 'scripts'));
    await copyFile(join(root, 'scripts/selfhost-init.sh'), join(fixture, 'scripts/selfhost-init.sh'));
    execFileSync('bash', [join(fixture, 'scripts/selfhost-init.sh'), domain, 'owner@example.test'], { stdio: 'ignore' });
    const env = join(fixture, '.env');
    assert.equal((await stat(env)).mode & 0o777, 0o600);
    if (domain !== 'localhost') await appendFile(env, '\nSMTP_HOST=smtp.example.test\nSMTP_USERNAME=fixture\nSMTP_PASSWORD=fixture\nEMAIL_FROM=mail@example.test\n');
    // Compose config does not contact Docker or start containers. Never print
    // its full output: it contains the generated, test-only credentials.
    const config = JSON.parse(execFileSync('docker', ['compose', '--env-file', env, '-f', join(root, 'docker-compose.yaml'), '--profile', 'mailpit', 'config', '--format', 'json'], { encoding: 'utf8', timeout: 15000 }));
    const { api, worker, caddy, migrate } = config.services;
    const customer = `https://${domain}`, admin = `https://admin.${domain}`, apiUrl = `https://api.${domain}`;
    for (const service of [api, worker]) {
      assert.equal(service.environment.WASP_WEB_CLIENT_URL, customer);
      assert.equal(service.environment.ADMIN_WEB_CLIENT_URL, admin);
    }
    for (const service of [caddy, migrate]) assert.deepEqual(service.build.args, { API_URL: apiUrl, APP_URL: customer, ADMIN_URL: admin });
    assert.equal(caddy.environment.ADMIN_HOST, `admin.${domain}`);
    assert.ok(caddy.networks.default.aliases.includes(`admin.${domain}`));
    const original = await readFile(env);
    assert.throws(() => execFileSync('bash', [join(fixture, 'scripts/selfhost-init.sh'), domain, 'another@example.test'], { stdio: 'ignore' }));
    assert.deepEqual(await readFile(env), original);
  });
}
