import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const prepareSource = await readFile(new URL('../scripts/prepare-release.mjs', import.meta.url));
const write = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'saas-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'); const saas = repo; const build = join(saas, 'apps/web/.wasp/out');
  await write(join(build, '.waspinfo'), { buildType: 'Production', waspVersion: '0.25.0' });
  await write(join(saas, 'scripts/prepare-release.mjs'), prepareSource);
  await write(join(saas, 'scripts/build-api.mjs'), 'const app = new URL("../apps/web/", import.meta.url);\n');
  await write(join(saas, 'scripts/wasp-build-scope.mjs'), 'export const scope = "production";\n');
  await write(join(saas, 'apps/web/tsconfig.build.json'), { extends: './tsconfig.src.json', exclude: ['**/*.wasp.ts', '**/*.test.*'] });
  await write(join(build, 'package.json'), { private: true, dependencies: { '@ad-research/contracts': 'file:../../packages/contracts' }, devDependencies: { '@wasp.sh/spec': 'file:.wasp/spec' }, workspaces: ['.wasp/out/*', '.wasp/out/sdk/wasp'] });
  await write(join(build, 'package-lock.json'), { lockfileVersion: 3 });
  await write(join(build, 'src/server.ts'), 'export const value = 1;');
  await write(join(saas, 'apps/web/src/server.ts'), 'export const value = 1;');
  await write(join(build, 'server/package.json'), { dependencies: { '@wasp.sh/lib-auth': 'file:../libs/auth/fixture.tgz' } });
  await write(join(build, 'sdk/wasp/package.json'), { dependencies: { '@wasp.sh/lib-auth': 'file:../../libs/auth/fixture.tgz' } });
  await write(join(build, 'libs/auth/fixture.tgz'), 'fixture archive');
  await write(join(build, 'db/schema.prisma'), 'fixture schema');
  await write(join(saas, 'apps/web/schema.prisma'), 'source schema without Wasp framework models');
  await write(join(build, 'db/migrations/001/migration.sql'), 'SELECT 1;');
  await write(join(saas, 'apps/web/migrations/001/migration.sql'), 'SELECT 1;');
  await write(join(build, 'db/migrations/migration_lock.toml'), 'provider = "postgresql"\n');
  await write(join(saas, 'apps/web/migrations/migration_lock.toml'), 'provider = "postgresql"\n');
  await write(join(build, 'web-app/build/200.html'), '<script src="/assets/main.js"></script>');
  await write(join(build, 'web-app/build/assets/main.js'), 'const api = "https://api.example.com";');
  await write(join(saas, 'packages/contracts/package.json'), { name: '@ad-research/contracts', type: 'module', exports: './dist/collection.js' });
  await write(join(saas, 'packages/contracts/dist/collection.js'), 'export const value = 1;');
  await write(join(saas, 'packages/contracts/dist/collection.d.ts'), 'export declare const value = 1;');
  await write(join(saas, 'apps/web/.wasp/spec/package.json'), { name: '@wasp.sh/spec' });
  await write(join(saas, 'apps/web/dist-worker/index.mjs'), 'console.log("worker fixture");');
  await write(join(saas, 'deploy/server.env.example'), 'DATABASE_URL=\n');
  for (const file of ['scripts/backup.sh', 'scripts/restore-check.sh', 'scripts/object-references.sql', 'scripts/object-backup.mjs', 'upstream.lock.json', 'OPEN-SAAS-LICENSE']) await write(join(saas, file), 'fixture');
  const run = (output, extra = []) => spawnSync(process.execPath, [join(saas, 'scripts/prepare-release.mjs'), '--output', output, '--release-id', 'test-release', '--public-api-url', 'https://api.example.com', ...extra], { encoding: 'utf8' });
  return { root, repo, saas, build, run };
}

test('prepares self-contained local dependencies, excludes env and keeps artifact hash repeatable', async t => {
  const f = await fixture(t);
  await write(join(f.build, '.env.server'), 'SECRET=fixture-private-value');
  await write(join(f.build, 'node_modules/private-file'), 'fixture');
  const first = join(f.root, 'first'); const second = join(f.root, 'second');
  for (const target of [first, second]) { const result = f.run(target); assert.equal(result.status, 0, result.stderr); }
  const a = JSON.parse(await readFile(join(first, 'release-manifest.json'))); const b = JSON.parse(await readFile(join(second, 'release-manifest.json')));
  assert.equal(a.artifactHash, b.artifactHash);
  assert.equal(a.installedOnTarget, false); assert.equal(a.deployed, false);
  assert(a.files.some(file => file.path === 'apps/web/.wasp/out/server/package.json'));
  assert(a.files.some(file => file.path === 'packages/contracts/dist/collection.js'));
  assert(a.files.some(file => file.path === 'public/200.html'));
  assert(a.files.some(file => file.path === 'apps/web/.wasp/out/db/migrations/001/migration.sql'));
  assert(a.files.some(file => file.path === 'apps/web/.wasp/out/db/migrations/migration_lock.toml'));
  assert(a.files.some(file => file.path === 'ops/object-references.sql'));
  assert(a.files.some(file => file.path === 'ops/object-backup.mjs'));
  assert(a.files.some(file => file.path === 'scripts/build-api.mjs'));
  assert.equal(await readFile(join(first, 'scripts/build-api.mjs'), 'utf8'), 'const app = new URL("../apps/web/", import.meta.url);\n');
  assert(a.files.some(file => file.path === 'apps/web/tsconfig.build.json'));
  assert.equal(await readFile(join(first, 'scripts/wasp-build-scope.mjs'), 'utf8'), 'export const scope = "production";\n');
  assert.equal(a.files.filter(file => file.path.startsWith('scripts/')).length, 2);
  assert(!a.files.some(file => file.path.includes('node_modules') || file.path.endsWith('.env.server')));
  const repeat = f.run(first); assert.equal(repeat.status, 1); assert.match(repeat.stderr, /RELEASE_OUTPUT_EXISTS/);
});

test('requires the API build entry before creating a release', async t => {
  const f = await fixture(t);
  await rm(join(f.saas, 'scripts/build-api.mjs'));
  const output = join(f.root, 'missing-api-build-entry'); const result = f.run(output);
  assert.equal(result.status, 1); assert.match(result.stderr, /RELEASE_API_BUILD_SCRIPT_REQUIRED/);
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('requires production type configuration and its runtime helper before creating a release', async t => {
  for (const missing of ['scripts/wasp-build-scope.mjs', 'apps/web/tsconfig.build.json']) {
    const f = await fixture(t);
    await rm(join(f.saas, missing));
    const output = join(f.root, 'missing-build-scope'); const result = f.run(output);
    assert.equal(result.status, 1); assert.match(result.stderr, /RELEASE_BUILD_SCOPE_REQUIRED/);
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
});

test('refuses local dependencies that escape the package', async t => {
  const f = await fixture(t);
  await write(join(f.build, 'server/package.json'), { dependencies: { private: 'file:../../../../outside' } });
  const result = f.run(join(f.root, 'release'));
  assert.equal(result.status, 1); assert.match(result.stderr, /RELEASE_LOCAL_DEPENDENCY_MISSING/);
});

test('refuses a public bundle containing a private key or symbolic link', async t => {
  const f = await fixture(t);
  await write(join(f.build, 'src/private.ts'), `const forbidden = "${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}";`);
  await write(join(f.saas, 'apps/web/src/private.ts'), await readFile(join(f.build, 'src/private.ts')));
  let result = f.run(join(f.root, 'private-key'));
  assert.equal(result.status, 1); assert.match(result.stderr, /RELEASE_POSSIBLE_SECRET_REJECTED/);
  await rm(join(f.build, 'src/private.ts'));
  await rm(join(f.saas, 'apps/web/src/private.ts'));
  await symlink(join(f.saas, 'OPEN-SAAS-LICENSE'), join(f.build, 'src/linked-file'));
  result = f.run(join(f.root, 'symlink'));
  assert.equal(result.status, 1); assert.match(result.stderr, /RELEASE_SYMLINK_REJECTED/);
});

test('refuses output inside the checkout even through an existing parent symlink', async t => {
  const f = await fixture(t);
  await symlink(f.repo, join(f.root, 'checkout-alias'));
  const result = f.run(join(f.root, 'checkout-alias/release'));
  assert.equal(result.status, 1); assert.match(result.stderr, /RELEASE_OUTPUT_MUST_BE_OUTSIDE_CHECKOUT/);
});

test('refuses generated development code despite an existing static bundle', async t => {
  const f = await fixture(t);
  await write(join(f.build, '.waspinfo'), { buildType: 'Development', waspVersion: '0.25.0' });
  const result = f.run(join(f.root, 'development'));
  assert.equal(result.status, 1); assert.match(result.stderr, /RELEASE_PRODUCTION_BUILD_REQUIRED/);
});

test('refuses stale generated source before creating a release, including test-only edits', async t => {
  const f = await fixture(t);
  await write(join(f.saas, 'apps/web/src/server/middleware.integration.test.ts'), 'const principal: string = "fixture";');
  await write(join(f.build, 'src/server/middleware.integration.test.ts'), 'const principal = "fixture" as const;');
  const output = join(f.root, 'stale-source'); const result = f.run(output);
  assert.equal(result.status, 1); assert.match(result.stderr, /RELEASE_SOURCE_BUILD_MISMATCH/);
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('refuses missing generated source and unreviewed generated-only source files', async t => {
  const f = await fixture(t);
  await rm(join(f.build, 'src/server.ts'));
  let result = f.run(join(f.root, 'missing-source'));
  assert.equal(result.status, 1); assert.match(result.stderr, /RELEASE_SOURCE_BUILD_MISMATCH/);
  await write(join(f.build, 'src/server.ts'), await readFile(join(f.saas, 'apps/web/src/server.ts')));
  await write(join(f.build, 'src/deleted-from-checkout.ts'), 'export const stale = true;');
  result = f.run(join(f.root, 'generated-only-source'));
  assert.equal(result.status, 1); assert.match(result.stderr, /RELEASE_SOURCE_BUILD_MISMATCH/);
});

for (const [name, change] of [
  ['a newly committed migration missing from the generated build', f => write(join(f.saas, 'apps/web/migrations/002/migration.sql'), 'SELECT 2;')],
  ['an unreviewed generated-only migration', f => write(join(f.build, 'db/migrations/002/migration.sql'), 'SELECT 2;')],
  ['changed generated migration SQL at the same path', f => write(join(f.build, 'db/migrations/001/migration.sql'), 'SELECT 42;')],
  ['a missing generated migration lock', f => rm(join(f.build, 'db/migrations/migration_lock.toml'))],
  ['changed generated migration lock contents', f => write(join(f.build, 'db/migrations/migration_lock.toml'), 'provider = "sqlite"\n')],
  ['a missing source migration lock', f => rm(join(f.saas, 'apps/web/migrations/migration_lock.toml'))],
]) {
  test(`refuses ${name} before creating a release`, async t => {
    const f = await fixture(t); await change(f);
    const output = join(f.root, 'mismatched-migrations'); const result = f.run(output);
    assert.equal(result.status, 1); assert.match(result.stderr, /RELEASE_MIGRATION_BUILD_MISMATCH/);
    await assert.rejects(stat(output), { code: 'ENOENT' });
  });
}

test('requires the source migration history, not only the generated copy', async t => {
  const f = await fixture(t); await rm(join(f.saas, 'apps/web/migrations'), { recursive: true });
  const output = join(f.root, 'missing-source-migrations'); const result = f.run(output);
  assert.equal(result.status, 1); assert.match(result.stderr, /RELEASE_MIGRATION_SOURCE_REQUIRED/);
  await assert.rejects(stat(output), { code: 'ENOENT' });
});
