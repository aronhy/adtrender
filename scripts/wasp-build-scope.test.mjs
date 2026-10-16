import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { compileScopedApiProject, scopeWaspTypeCheck } from './wasp-build-scope.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/web');
const require = createRequire(join(app, 'package.json'));
const ts = require('typescript');
const tsc = require.resolve('typescript/bin/tsc');
const run = promisify(execFile);

async function fixture(t, { rootDir = '.', runtime = 'export const count: number = 1;' } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'adthrender-wasp-scope-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appDir = join(root, 'apps/web'), serverDir = join(appDir, '.wasp/out/server');
  await mkdir(join(serverDir, 'src'), { recursive: true });
  await mkdir(join(appDir, 'src'), { recursive: true });
  await mkdir(join(appDir, 'another'), { recursive: true });
  await writeFile(join(appDir, 'package.json'), '{"type":"module"}');
  await symlink(join(app, 'node_modules'), join(appDir, 'node_modules'), 'dir');
  await writeFile(join(appDir, 'src/runtime.ts'), runtime);
  await writeFile(join(appDir, 'src/isolated.test.ts'), 'const shouldNotBeAppSource: number = "FAIL";');
  await writeFile(join(appDir, 'tsconfig.src.json'), `// Original Wasp contract must remain untouched.\n${JSON.stringify({ compilerOptions: { strict: true, composite: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', skipLibCheck: true, rootDir: 'src', outDir: '.wasp/out/user' }, include: ['src'], exclude: ['**/*.wasp.ts'] })}`);
  await writeFile(join(appDir, 'tsconfig.build.json'), JSON.stringify({ extends: './tsconfig.src.json', exclude: ['**/*.wasp.ts', '**/*.test.*'] }));
  await writeFile(join(appDir, 'another/runtime.ts'), 'export const untouched: number = 1;');
  await writeFile(join(appDir, 'another/tsconfig.json'), JSON.stringify({ compilerOptions: { composite: true, strict: true, target: 'es2022', skipLibCheck: true }, files: ['runtime.ts'] }));
  // Implicit any is permitted by the generated server config, unlike app source.
  await writeFile(join(serverDir, 'src/server.ts'), 'export function generated(value) { return value; }');
  const generated = { compilerOptions: { strict: false, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', skipLibCheck: true, rootDir, outDir: 'dist', sourceMap: true }, include: ['src'], references: [{ path: '../../../tsconfig.src.json' }, { path: '../../../another/tsconfig.json' }] };
  await writeFile(join(serverDir, 'tsconfig.json'), `// Generated Wasp JSONC\n${JSON.stringify(generated)}`);
  await writeFile(join(serverDir, 'tsconfig.tsbuildinfo'), 'SERVER_SENTINEL');
  return { root, appDir, serverDir, generated, project: join(appDir, 'tsconfig.build.json') };
}

async function assertTemporaryFilesRemoved(serverDir) {
  const names = await readdir(serverDir, { recursive: true });
  assert.equal(names.some(name => /tsconfig\.api-build\..*\.(?:json|tsbuildinfo)$/.test(name)), false);
  assert.equal(await readFile(join(serverDir, 'tsconfig.tsbuildinfo'), 'utf8'), 'SERVER_SENTINEL');
}

test('rejects a missing or duplicate Wasp checker', async () => {
  await assert.rejects(scopeWaspTypeCheck([], '/tmp/tsconfig.build.json'), /WASP_TYPESCRIPT_CHECKER_COUNT: 0/);
  await assert.rejects(scopeWaspTypeCheck([{ name: 'wasp:typescript-check' }, { name: 'wasp:typescript-check' }], '/tmp/tsconfig.build.json'), /WASP_TYPESCRIPT_CHECKER_COUNT: 2/);
});

test('retains other plugins and hooks while recursively resolving promise and array options', async t => {
  const p = await fixture(t);
  const otherStart = () => {}, otherEnd = () => {}, other = { name: 'other-plugin', buildStart: otherStart, buildEnd: otherEnd };
  const oldStart = () => { throw new Error('ORIGINAL_CHECKER_MUST_NOT_RUN'); };
  const finish = () => {};
  const checker = { name: 'wasp:typescript-check', apply: 'build', enforce: 'pre', buildStart: { order: 'pre', sequential: true, handler: oldStart }, buildEnd: finish };
  const options = await scopeWaspTypeCheck([other, Promise.resolve([false, null, undefined, Promise.resolve(checker)])], p.project);
  assert.strictEqual(options[0], other);
  assert.strictEqual(options[0].buildStart, otherStart);
  assert.deepEqual(options[1].slice(0, 3), [false, null, undefined]);
  const scoped = options[1][3];
  assert.notStrictEqual(scoped, checker);
  assert.strictEqual(scoped.buildEnd, finish);
  assert.equal(scoped.apply, 'build');
  assert.equal(scoped.enforce, 'pre');
  assert.equal(scoped.buildStart.order, 'pre');
  assert.equal(scoped.buildStart.sequential, true);
  assert.strictEqual(checker.buildStart.handler, oldStart);
  await scoped.buildStart.handler.call({});
  await assert.rejects(readFile(join(p.appDir, '.wasp/out/user/runtime.js')), { code: 'ENOENT' });
});

test('scoped Vite checker really runs strict TypeScript and rejects invalid runtime code', async t => {
  const p = await fixture(t, { runtime: 'export function invalid(value) { return value; }' });
  const [checker] = await scopeWaspTypeCheck([{ name: 'wasp:typescript-check', apply: 'build', buildStart() {} }], p.project);
  await assert.rejects(checker.buildStart(), /WASP_TYPESCRIPT_CHECK_FAILED/);
});

test('Vite checker uses the supplied node and compiler with --project and --noEmit', async t => {
  const p = await fixture(t);
  const recorder = join(p.root, 'record-args.mjs'), output = join(p.root, 'args.json');
  await writeFile(recorder, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(output)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));`);
  const [checker] = await scopeWaspTypeCheck([{ name: 'wasp:typescript-check' }], p.project, process.execPath, recorder);
  await checker.buildStart();
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { args: ['--project', p.project, '--noEmit'], cwd: p.appDir });
});

test('API scope copies all JSONC options and changes only the exact source reference', async t => {
  const p = await fixture(t);
  const recorder = join(p.root, 'record-config.mjs'), output = join(p.root, 'config.json');
  await writeFile(recorder, `import {readFileSync,writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(output)},JSON.stringify({args:process.argv.slice(2),config:JSON.parse(readFileSync(process.argv[3],'utf8')),cwd:process.cwd()}));`);
  const original = await readFile(join(p.serverDir, 'tsconfig.json'), 'utf8');
  await compileScopedApiProject({ ...p, tsc: recorder });
  const recorded = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(recorded.args[0], '--build');
  assert.equal(dirname(recorded.args[1]), p.serverDir);
  assert.deepEqual(recorded.config, { ...p.generated, references: [{ path: p.project }, p.generated.references[1]] });
  assert.equal(recorded.cwd, p.serverDir);
  assert.equal(await readFile(join(p.serverDir, 'tsconfig.json'), 'utf8'), original);
  await assertTemporaryFilesRemoved(p.serverDir);
});

for (const rootDir of ['.', 'src']) {
  test(`API scope excludes isolated tests and cleans its actual metadata with rootDir=${rootDir}`, async t => {
    const p = await fixture(t, { rootDir });
    // Demonstrates that the original config actually contains the bad test.
    await assert.rejects(run(process.execPath, [tsc, '--project', join(p.appDir, 'tsconfig.src.json'), '--noEmit']), error => {
      assert.match(error.stdout, /isolated\.test\.ts.*TS2322/);
      return true;
    });
    await compileScopedApiProject(p);
    const appOutput = await readFile(join(p.appDir, '.wasp/out/user/runtime.js'), 'utf8');
    assert.match(appOutput, /count = 1/);
    assert.match(await readFile(join(p.appDir, 'another/runtime.js'), 'utf8'), /untouched = 1/);
    const reference = ts.getParsedCommandLineOfConfigFile(p.project, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() { throw new Error('INVALID_TEST_CONFIG'); } });
    const referenceMetadata = ts.getTsBuildInfoEmitOutputFilePath(reference.options);
    assert.equal((await stat(referenceMetadata)).isFile(), true);
    await assertTemporaryFilesRemoved(p.serverDir);
  });
}

test('API scope still checks strict app source and cleans temporary files after failure', async t => {
  const p = await fixture(t, { runtime: 'export const count: number = "BAD_RUNTIME";' });
  await assert.rejects(compileScopedApiProject(p), /API_TYPESCRIPT_BUILD_FAILED/);
  await assertTemporaryFilesRemoved(p.serverDir);
});

test('API scope does not overwrite or remove a shared explicit build-info file', async t => {
  const p = await fixture(t);
  await writeFile(join(p.serverDir, 'tsconfig.json'), JSON.stringify({ ...p.generated, compilerOptions: { ...p.generated.compilerOptions, tsBuildInfoFile: './shared.tsbuildinfo' } }));
  await writeFile(join(p.serverDir, 'shared.tsbuildinfo'), 'SHARED_SENTINEL');
  await assert.rejects(compileScopedApiProject(p), /API_TYPESCRIPT_SCOPE_METADATA_NOT_EXCLUSIVE/);
  assert.equal(await readFile(join(p.serverDir, 'shared.tsbuildinfo'), 'utf8'), 'SHARED_SENTINEL');
  await assertTemporaryFilesRemoved(p.serverDir);
});

test('invalid JSONC does not run the compiler or leave a temporary configuration', async t => {
  const p = await fixture(t);
  await writeFile(join(p.serverDir, 'tsconfig.json'), '{ invalid JSONC }');
  await assert.rejects(compileScopedApiProject(p), /API_TYPESCRIPT_CONFIG_INVALID/);
  await assertTemporaryFilesRemoved(p.serverDir);
});
