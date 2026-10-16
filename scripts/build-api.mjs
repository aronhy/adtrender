import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileScopedApiProject } from './wasp-build-scope.mjs';

const defaultApp = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/web');

/** Keep Wasp's external policy and its SDK bundling behavior. The contracts
 * package is a runtime dependency; its file: symlink must not turn it into
 * application source when Rollup follows real paths.
 */
export function withContractExternal(original) {
  const inherited = (rule, id, importer, isResolved) => {
    if (typeof rule === 'function') return rule(id, importer, isResolved);
    if (Array.isArray(rule)) return rule.some(item => inherited(item, id, importer, isResolved));
    if (rule instanceof RegExp) return rule.test(id);
    return typeof rule === 'string' && rule === id;
  };
  return (id, importer, isResolved) => id === '@ad-research/contracts' || id.startsWith('@ad-research/contracts/') || inherited(original, id, importer, isResolved);
}

export async function buildApi({ appDir = defaultApp } = {}) {
  const serverDir = join(appDir, '.wasp/out/server');
  const require = createRequire(join(appDir, 'package.json'));
  await compileScopedApiProject({ serverDir, appDir, tsc: require.resolve('typescript/bin/tsc') });
  const previousCwd = process.cwd();
  try {
    // Generated input/output paths and resolve plugins use this directory.
    process.chdir(serverDir);
    const { default: generated } = await import(pathToFileURL(join(serverDir, 'rollup.config.js')).href);
    const { rollup } = await import(pathToFileURL(require.resolve('rollup')).href);
    for (const config of Array.isArray(generated) ? generated : [generated]) {
      const { output, ...input } = config;
      const bundle = await rollup({ ...input, external: withContractExternal(input.external) });
      try {
        for (const target of Array.isArray(output) ? output : [output]) await bundle.write(target);
      } finally {
        await bundle.close();
      }
    }
  } finally {
    process.chdir(previousCwd);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await buildApi();
    console.log('API built: TypeScript checked; generated Rollup configuration preserved; contracts are runtime dependencies.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
