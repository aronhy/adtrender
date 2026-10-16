import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultApp = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/web');

function runTsc(runtimeNode, tsc, args, cwd, failureCode) {
  return new Promise((done, reject) => {
    const child = spawn(runtimeNode, [tsc, ...args], { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? done() : reject(new Error(`${failureCode}: ${signal ?? code}`)));
  });
}

/** Redirect only Wasp's source-project reference. Keeping the temporary config
 * beside the generated config preserves every relative compiler path.
 */
export async function compileScopedApiProject({ serverDir, appDir = defaultApp, runtimeNode = process.execPath, tsc } = {}) {
  if (!serverDir) throw new Error('API_TYPESCRIPT_SERVER_DIRECTORY_REQUIRED');
  serverDir = resolve(serverDir);
  appDir = resolve(appDir);
  const require = createRequire(join(appDir, 'package.json'));
  const ts = require('typescript');
  const sourcePath = join(serverDir, 'tsconfig.json');
  const parsed = ts.parseConfigFileTextToJson(sourcePath, await readFile(sourcePath, 'utf8'));
  if (parsed.error) throw new Error(`API_TYPESCRIPT_CONFIG_INVALID: ${ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n')}`);
  const config = parsed.config;
  if (Array.isArray(config.references)) {
    config.references = config.references.map(reference => typeof reference.path === 'string' && resolve(serverDir, reference.path) === join(appDir, 'tsconfig.src.json')
      ? { ...reference, path: join(appDir, 'tsconfig.build.json') }
      : reference);
  }
  const temporary = join(serverDir, `tsconfig.api-build.${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify(config), { flag: 'wx' });
  let metadata;
  let ownsMetadata = false;
  try {
    const command = ts.getParsedCommandLineOfConfigFile(temporary, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(`API_TYPESCRIPT_CONFIG_INVALID: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
      },
    });
    if (!command) throw new Error('API_TYPESCRIPT_CONFIG_INVALID');
    metadata = ts.getTsBuildInfoEmitOutputFilePath({ ...command.options, tscBuild: true });
    // An explicit shared tsBuildInfoFile must never be overwritten or removed.
    if (!metadata || basename(metadata) !== `${basename(temporary, '.json')}.tsbuildinfo`) {
      throw new Error('API_TYPESCRIPT_SCOPE_METADATA_NOT_EXCLUSIVE');
    }
    try {
      await stat(metadata);
      throw new Error('API_TYPESCRIPT_SCOPE_METADATA_EXISTS');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    ownsMetadata = true;
    await runTsc(runtimeNode, tsc ?? require.resolve('typescript/bin/tsc'), ['--build', temporary], serverDir, 'API_TYPESCRIPT_BUILD_FAILED');
  } finally {
    if (ownsMetadata) await rm(metadata, { force: true });
    await rm(temporary, { force: true });
  }
}

/** Preserve Wasp's complete plugin tree and replace exactly one checker hook.
 * @param {import('../apps/web/node_modules/vite/dist/node/index').PluginOption[]} plugins
 * @param {string} project
 * @param {string} [runtimeNode]
 * @param {string} [tsc]
 * @returns {Promise<import('../apps/web/node_modules/vite/dist/node/index').PluginOption[]>}
 */
export async function scopeWaspTypeCheck(plugins, project, runtimeNode = process.execPath, tsc) {
  project = resolve(project);
  let compiler;
  let checkerCount = 0;
  const visit = async option => {
    option = await option;
    if (Array.isArray(option)) return Promise.all(option.map(visit));
    if (!option || option.name !== 'wasp:typescript-check') return option;
    checkerCount += 1;
    const check = async function () {
      await runTsc(runtimeNode, compiler, ['--project', project, '--noEmit'], dirname(project), 'WASP_TYPESCRIPT_CHECK_FAILED');
    };
    return { ...option, buildStart: typeof option.buildStart === 'object' && option.buildStart !== null ? { ...option.buildStart, handler: check } : check };
  };
  const scoped = await Promise.all(plugins.map(visit));
  if (checkerCount !== 1) throw new Error(`WASP_TYPESCRIPT_CHECKER_COUNT: ${checkerCount}`);
  const require = createRequire(join(dirname(project), 'package.json'));
  compiler = tsc ?? require.resolve('typescript/bin/tsc');
  return scoped;
}
