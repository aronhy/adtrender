import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { prerenderWaspTools } from './wasp-tools-prerender.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/web');
const require = createRequire(resolve(app, 'package.json'));
const waspRequire = createRequire(require.resolve('wasp/client/vite'));
const { default: ssr } = await import(pathToFileURL(waspRequire.resolve('@wasp.sh/lib-vite-ssr')).href);
const originalSsr = () => ssr({ clientEntrySrc: '/@wasp/client-entry.tsx', ssrEntrySrc: '/@wasp/ssr-entry.tsx', ssrPaths: [], spaFallbackFile: '200.html' });
const paths = ['/tools', '/tools/roas-calculator'];

test('replaces the managed SSR route inputs and retains Wasp entries and SPA fallback', async t => {
  const plugins = await prerenderWaspTools(originalSsr(), paths);
  const build = plugins.find(plugin => plugin.name === '@wasp.sh/lib-vite-ssr:build');
  const config = build.config();
  assert.deepEqual(config.environments.client.build.rolldownOptions.input, ['tools/index.html', 'tools/roas-calculator/index.html', '200.html']);
  assert.equal(config.environments.ssr.build.rolldownOptions.input, '/@wasp/ssr-entry.tsx');

  // Exercise the real managed build hook through its builder boundary. This
  // proves SSR still receives Wasp's client entry and each route/fallback path.
  const rendered = [];
  const root = await mkdtemp(join(tmpdir(), 'adtrender-tools-prerender-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'entry.mjs'), 'export default (path, options) => JSON.stringify({ path, ...options });');
  const environments = { ssr: { config: { build: { outDir: root } } }, client: {} };
  await config.builder.buildApp({
    environments,
    async build(environment) {
      if (environment === environments.ssr) return { output: [{ type: 'chunk', isEntry: true, exports: ['default'], fileName: 'entry.mjs' }] };
      for (const id of config.environments.client.build.rolldownOptions.input) {
        rendered.push(JSON.parse(await build.load.handler(id)));
      }
    },
  });
  assert.deepEqual(rendered, [
    { path: '/tools', clientEntrySrc: '/@wasp/client-entry.tsx' },
    { path: '/tools/roas-calculator', clientEntrySrc: '/@wasp/client-entry.tsx' },
    { path: '200.html', clientEntrySrc: '/@wasp/client-entry.tsx' },
  ]);
});

test('preserves non-SSR plugin identity, hooks, ordering, and nested promise options', async () => {
  const buildStart = () => {}, buildEnd = () => {};
  const checker = { name: 'wasp:typescript-check', apply: 'build', enforce: 'pre', buildStart: { order: 'pre', handler: buildStart }, buildEnd };
  const config = { name: 'wasp:config', config() {} };
  const virtual = { name: 'wasp:virtual-modules', resolveId() {} };
  const react = { name: 'vite:react-babel', transform() {} };
  const original = originalSsr();
  const tree = [config, Promise.resolve([false, checker, Promise.resolve([original[0], virtual, original[1]])]), null, original[2], react, undefined, original[3]];
  const result = await prerenderWaspTools(tree, paths);
  assert.strictEqual(result[0], config);
  assert.strictEqual(result[1][0], false);
  assert.strictEqual(result[1][1], checker);
  assert.strictEqual(result[1][1].buildStart.handler, buildStart);
  assert.strictEqual(result[1][1].buildEnd, buildEnd);
  assert.strictEqual(result[1][2][1], virtual);
  assert.strictEqual(result[2], null);
  assert.strictEqual(result[4], react);
  assert.strictEqual(result[5], undefined);
  assert.notStrictEqual(result[1][2][0], original[0]);
  assert.notStrictEqual(result[1][2][2], original[1]);
  assert.notStrictEqual(result[3], original[2]);
  assert.notStrictEqual(result[6], original[3]);
  assert.deepEqual(original[2].config().environments.client.build.rolldownOptions.input, ['200.html']);
});

test('fails closed when Wasp removes, duplicates, renames, or adds an SSR plugin', async () => {
  const plugins = originalSsr();
  for (const invalid of [
    [],
    plugins.slice(0, 3),
    [...plugins, plugins[3]],
    [plugins[0], plugins[1], plugins[2], plugins[2]],
    [...plugins.slice(0, 3), { name: '@wasp.sh/lib-vite-ssr:changed' }],
    [...plugins, { name: '@wasp.sh/lib-vite-ssr:new-hook' }],
  ]) {
    await assert.rejects(prerenderWaspTools(invalid, paths), /WASP_SSR_PLUGIN_CONTRACT/);
  }
});
