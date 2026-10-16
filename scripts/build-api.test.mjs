import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildApi, withContractExternal } from './build-api.mjs';

const run = promisify(execFile);
const app = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/web');

test('externalizes only the contract package and preserves inherited external rules', () => {
  const external = withContractExternal(/node_modules/);
  assert.equal(external('@ad-research/contracts'), true);
  assert.equal(external('@ad-research/contracts/seed-baseline'), true);
  assert.equal(external('@ad-research/contracts-unrelated'), false);
  assert.equal(external('/release/app/node_modules/vendor/index.js'), true);
  assert.equal(external('/release/app/.wasp/out/sdk/wasp/server/index.js'), false);
  const calls = [];
  const predicate = withContractExternal((id, importer, resolved) => { calls.push([id, importer, resolved]); return id === 'custom-external'; });
  assert.equal(predicate('custom-external', '/input.js', true), true);
  assert.deepEqual(calls, [['custom-external', '/input.js', true]]);
  assert.equal(withContractExternal(['one', /two/])('one'), true);
  assert.equal(withContractExternal(['one', /two/])('two/subpath'), true);
  assert.equal(withContractExternal('one')('one'), true);
});

async function project(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'adthrender-build-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appDir = join(root, 'apps/web'), serverDir = join(appDir, '.wasp/out/server');
  await mkdir(join(serverDir, 'src'), { recursive: true });
  await mkdir(join(serverDir, 'node_modules/external-fixture'), { recursive: true });
  await writeFile(join(appDir, 'package.json'), '{"type":"module"}');
  await symlink(join(app, 'node_modules'), join(appDir, 'node_modules'), 'dir');
  await writeFile(join(serverDir, 'node_modules/external-fixture/package.json'), '{"type":"module"}');
  await writeFile(join(serverDir, 'node_modules/external-fixture/index.js'), 'export const sentinel = "EXTERNAL_SENTINEL_NOT_INLINED";');
  await writeFile(join(serverDir, 'node_modules/external-fixture/index.d.ts'), 'export declare const sentinel: string;');
  await writeFile(join(serverDir, 'src/server.ts'), source);
  await writeFile(join(serverDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', skipLibCheck: true, rootDir: 'src', outDir: 'dist' }, include: ['src'] }));
  // Use the actual generated Wasp plugin order, output and external policy.
  await writeFile(join(serverDir, 'rollup.config.js'), await readFile(join(app, '.wasp/out/server/rollup.config.js')));
  return { appDir, serverDir };
}

test('runs TypeScript and real Wasp Rollup, keeps package imports and loads native Node JSON', async t => {
  assert.equal(process.versions.node, '24.14.1');
  const p = await project(t, `import { getStaticSeedBaseline } from '@ad-research/contracts/seed-baseline';
import { sentinel } from '../node_modules/external-fixture/index.js';
const compiled: number = 1;
console.log(JSON.stringify({ sentinel, compiled, baseline: typeof getStaticSeedBaseline() }));`);
  const cwd = process.cwd();
  await buildApi({ appDir: p.appDir });
  assert.equal(process.cwd(), cwd);
  const output = join(p.serverDir, 'bundle/server.js');
  const bundled = await readFile(output, 'utf8');
  assert.match(bundled, /from ['"]@ad-research\/contracts\/seed-baseline['"]/);
  assert.match(bundled, /node_modules\/external-fixture\/index\.js/);
  assert.doesNotMatch(bundled, /EXTERNAL_SENTINEL_NOT_INLINED/);
  assert.match(await readFile(join(p.serverDir, 'dist/server.js'), 'utf8'), /const compiled = 1/);
  const runtime = await run(process.execPath, [output]);
  assert.deepEqual(JSON.parse(runtime.stdout.trim()), { sentinel: 'EXTERNAL_SENTINEL_NOT_INLINED', compiled: 1, baseline: 'object' });
});

test('fails on TypeScript errors before writing a bundle and restores the working directory', async t => {
  const p = await project(t, 'const invalid: number = "TYPE_ERROR";');
  const cwd = process.cwd();
  await assert.rejects(buildApi({ appDir: p.appDir }), /API_TYPESCRIPT_BUILD_FAILED/);
  assert.equal(process.cwd(), cwd);
  await assert.rejects(readFile(join(p.serverDir, 'bundle/server.js')), { code: 'ENOENT' });
});

test('builds referenced app source with isolated test scope before running unchanged Wasp Rollup', async t => {
  const p = await project(t, 'const compiled: number = 7; console.log(compiled);');
  await mkdir(join(p.appDir, 'src'), { recursive: true });
  await writeFile(join(p.appDir, 'src/runtime.ts'), 'export const appRuntime: number = 1;');
  await writeFile(join(p.appDir, 'src/runtime.test.ts'), 'const excludedTest: number = "ISOLATED_TEST";');
  const srcConfig = '// Wasp source contract\n' + JSON.stringify({ compilerOptions: { composite: true, strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', skipLibCheck: true, outDir: '.wasp/out/user' }, include: ['src'], exclude: ['**/*.wasp.ts'] });
  await writeFile(join(p.appDir, 'tsconfig.src.json'), srcConfig);
  await writeFile(join(p.appDir, 'tsconfig.build.json'), JSON.stringify({ extends: './tsconfig.src.json', exclude: ['**/*.wasp.ts', '**/*.test.*'] }));
  const serverConfig = JSON.parse(await readFile(join(p.serverDir, 'tsconfig.json'), 'utf8'));
  serverConfig.references = [{ path: '../../../tsconfig.src.json' }];
  const generated = '// Generated Wasp JSONC\n' + JSON.stringify(serverConfig);
  await writeFile(join(p.serverDir, 'tsconfig.json'), generated);
  await buildApi({ appDir: p.appDir });
  const runtime = await run(process.execPath, [join(p.serverDir, 'bundle/server.js')]);
  assert.equal(runtime.stdout.trim(), '7');
  assert.equal(await readFile(join(p.appDir, 'tsconfig.src.json'), 'utf8'), srcConfig);
  assert.equal(await readFile(join(p.serverDir, 'tsconfig.json'), 'utf8'), generated);
  assert.equal((await readdir(p.serverDir, { recursive: true })).some(name => /tsconfig\.api-build\./.test(name)), false);
});
