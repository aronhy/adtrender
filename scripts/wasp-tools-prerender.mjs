import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const prefix = '@wasp.sh/lib-vite-ssr:';
const expectedNames = ['set-environments', 'dev', 'build', 'preview'].map(name => prefix + name);

/** Reconfigure Wasp's managed SSR plugins without dropping its other hooks.
 * @param {import('../apps/web/node_modules/vite/dist/node/index').PluginOption[]} plugins
 * @param {readonly string[]} ssrPaths
 * @returns {Promise<import('../apps/web/node_modules/vite/dist/node/index').PluginOption[]>}
 */
export async function prerenderWaspTools(plugins, ssrPaths) {
  const names = [];
  const resolveTree = async option => {
    option = await option;
    if (Array.isArray(option)) return Promise.all(option.map(resolveTree));
    if (option && typeof option.name === 'string' && option.name.startsWith(prefix)) names.push(option.name);
    return option;
  };
  const resolved = await Promise.all(plugins.map(resolveTree));
  if (names.length !== expectedNames.length || expectedNames.some(name => names.filter(found => found === name).length !== 1)) {
    throw new Error(`WASP_SSR_PLUGIN_CONTRACT: expected ${expectedNames.join(', ')}; received ${names.join(', ') || '(none)'}`);
  }

  // Resolve from Wasp itself so this uses its managed version and does not add
  // a separate app dependency or edit the generated SDK.
  const appRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
  const waspRequire = createRequire(appRequire.resolve('wasp/client/vite'));
  const { default: ssr } = await import(pathToFileURL(waspRequire.resolve('@wasp.sh/lib-vite-ssr')).href);
  const replacements = new Map(ssr({
    clientEntrySrc: '/@wasp/client-entry.tsx',
    ssrEntrySrc: '/@wasp/ssr-entry.tsx',
    ssrPaths,
    spaFallbackFile: '200.html',
  }).map(plugin => [plugin.name, plugin]));
  const replace = option => Array.isArray(option) ? option.map(replace) : replacements.get(option?.name) ?? option;
  return resolved.map(replace);
}
