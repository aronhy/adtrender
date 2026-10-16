import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const saas = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = saas;
const sha = data => createHash('sha256').update(data).digest('hex');
const fail = code => { throw new Error(code); };
const assertNoSecret = (path, bytes) => {
  if (/\.(?:js|mjs|ts|json|map|html|css|md|ya?ml|service|example)$/.test(path) && /(?:sk_live_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(bytes.toString('utf8'))) fail('RELEASE_POSSIBLE_SECRET_REJECTED');
};
const args = process.argv.slice(2); const options = new Map();
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: node scripts/prepare-release.mjs --output NEW_DIRECTORY --release-id VERSION --public-api-url https://api.example.com\nConsumes production apps/web/.wasp/out with an explicit Vite build and apps/web/dist-worker/index.mjs. Copies no credentials or node_modules; does not install, migrate, deploy or change current.'); process.exit(0);
}
async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function entries(root) {
  const result = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) fail('RELEASE_SYMLINK_REJECTED');
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.env') || entry.name.endsWith('.env') || ['.npmrc', '.pgpass'].includes(entry.name)) continue;
    if (/\.(pem|key|p12|pfx)$/i.test(entry.name) || /^id_(rsa|ed25519)$/.test(entry.name)) fail('RELEASE_SECRET_FILE_REJECTED');
    if (entry.isDirectory()) result.push(...await entries(path));
    else if (entry.isFile()) result.push(path);
    else fail('RELEASE_SPECIAL_FILE_REJECTED');
  }
  return result;
}
async function copyTree(from, to) {
  for (const file of await entries(from)) {
    assertNoSecret(file, await readFile(file));
    const output = join(to, relative(from, file)); await mkdir(dirname(output), { recursive: true, mode: 0o755 }); await cp(file, output, { errorOnExist: true, force: false });
  }
}
async function assertGeneratedTreeMatches(source, generated, requiredCode, mismatchCode) {
  if (!await exists(source)) fail(requiredCode);
  const sourceFiles = await entries(source); const generatedFiles = await entries(generated);
  const sourcePaths = sourceFiles.map(path => relative(source, path));
  const generatedPaths = generatedFiles.map(path => relative(generated, path));
  // Compare both inventories to reject stale deleted files as well as missed edits.
  if (sourcePaths.length !== generatedPaths.length || sourcePaths.some((path, index) => path !== generatedPaths[index])) fail(mismatchCode);
  for (let index = 0; index < sourceFiles.length; index++) {
    const [original, copy] = await Promise.all([readFile(sourceFiles[index]), readFile(generatedFiles[index])]);
    if (!original.equals(copy)) fail(mismatchCode);
  }
}
async function normalizeModes(root) {
  await chmod(root, 0o755);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await normalizeModes(path);
    else if (entry.isFile()) await chmod(path, entry.name.endsWith('.sh') ? 0o755 : 0o644);
    else fail('RELEASE_SPECIAL_FILE_REJECTED');
  }
}
try {
  for (let i = 0; i < args.length; i += 2) { if (!['--output', '--release-id', '--public-api-url'].includes(args[i]) || !args[i + 1] || options.has(args[i])) fail('RELEASE_USAGE'); options.set(args[i], args[i + 1]); }
  for (const key of ['--output', '--release-id', '--public-api-url']) if (!options.has(key)) fail('RELEASE_USAGE');
  const releaseId = options.get('--release-id'); if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(releaseId)) fail('RELEASE_INVALID_ID');
  let api; try { api = new URL(options.get('--public-api-url')); } catch { fail('RELEASE_INVALID_PUBLIC_API_URL'); }
  if (api.protocol !== 'https:' || api.username || api.password || api.origin !== options.get('--public-api-url')) fail('RELEASE_INVALID_PUBLIC_API_URL');
  const requestedOutput = resolve(options.get('--output'));
  const output = join(await realpath(dirname(requestedOutput)), basename(requestedOutput));
  const realRepo = await realpath(repo); const build = join(saas, 'apps/web/.wasp/out');
  if (output === realRepo || output.startsWith(`${realRepo}${sep}`)) fail('RELEASE_OUTPUT_MUST_BE_OUTSIDE_CHECKOUT');
  if (await exists(output)) fail('RELEASE_OUTPUT_EXISTS');
  if (process.versions.node !== '24.14.1') fail('RELEASE_PROJECT_NODE_REQUIRED');
  const required = ['.waspinfo', 'package.json', 'package-lock.json', 'src', 'server/package.json', 'sdk/wasp/package.json', 'db/schema.prisma', 'db/migrations', 'libs', 'web-app/build/200.html'];
  for (const path of required) if (!await exists(join(build, path))) fail('RELEASE_WASP_BUILD_REQUIRED');
  const buildInfo = JSON.parse(await readFile(join(build, '.waspinfo'), 'utf8'));
  if (buildInfo.buildType !== 'Production' || buildInfo.waspVersion !== '0.25.0') fail('RELEASE_PRODUCTION_BUILD_REQUIRED');
  // Wasp copies app/src verbatim; generated-only modules live elsewhere.
  await assertGeneratedTreeMatches(join(saas, 'apps/web/src'), join(build, 'src'), 'RELEASE_APP_SOURCE_REQUIRED', 'RELEASE_SOURCE_BUILD_MISMATCH');
  // Migration history and its provider lock must also match the checkout before
  // copying anything. Do not compare schema.prisma: Wasp adds framework models.
  const sourceMigrations = join(saas, 'apps/web/migrations'), generatedMigrations = join(build, 'db/migrations');
  await assertGeneratedTreeMatches(sourceMigrations, generatedMigrations, 'RELEASE_MIGRATION_SOURCE_REQUIRED', 'RELEASE_MIGRATION_BUILD_MISMATCH');
  for (const directory of [sourceMigrations, generatedMigrations]) if (!await exists(join(directory, 'migration_lock.toml'))) fail('RELEASE_MIGRATION_BUILD_MISMATCH');
  for (const path of ['packages/contracts/dist/collection.js', 'packages/contracts/dist/collection.d.ts', 'apps/web/dist-worker/index.mjs']) if (!await exists(join(saas, path))) fail('RELEASE_SHARED_OR_WORKER_BUILD_REQUIRED');
  if (!await exists(join(saas, 'scripts/build-api.mjs'))) fail('RELEASE_API_BUILD_SCRIPT_REQUIRED');
  if (!await exists(join(saas, 'scripts/wasp-build-scope.mjs')) || !await exists(join(saas, 'apps/web/tsconfig.build.json'))) fail('RELEASE_BUILD_SCOPE_REQUIRED');
  const packageJson = JSON.parse(await readFile(join(build, 'package.json'), 'utf8'));
  if (packageJson.dependencies?.['@ad-research/contracts'] !== 'file:../../packages/contracts') fail('RELEASE_CONTRACT_DEPENDENCY_CHANGED');
  const publicFiles = await entries(join(build, 'web-app/build'));
  const publicCode = (await Promise.all(publicFiles.filter(path => /\.(js|html)$/.test(path)).map(path => readFile(path, 'utf8')))).join('\n');
  if (!publicCode.includes(api.origin)) fail('RELEASE_PUBLIC_API_NOT_IN_BUILD');
  // A generated production release is platform-neutral source + web assets. Native
  // modules, Prisma engines and Playwright browsers are installed on the target OS.
  await mkdir(output, { mode: 0o755 });
  const app = join(output, 'apps/web'); await copyTree(build, app);
  await cp(join(saas, 'apps/web/tsconfig.build.json'), join(app, 'tsconfig.build.json'), { force: false, errorOnExist: true });
  for (const directory of ['server', 'sdk', 'libs', 'db', 'web-app', 'user', 'types']) {
    if (!await exists(join(app, directory))) continue;
    await mkdir(join(app, '.wasp/out'), { recursive: true, mode: 0o755 });
    await rename(join(app, directory), join(app, '.wasp/out', directory));
  }
  await rename(join(app, '.waspinfo'), join(app, '.wasp/out/.waspinfo'));
  await copyTree(join(saas, 'packages/contracts'), join(output, 'packages/contracts'));
  await copyTree(join(saas, 'apps/web/dist-worker'), join(app, 'dist-worker'));
  await copyTree(join(saas, 'deploy'), join(output, 'deploy'));
  await mkdir(join(output, 'scripts'), { recursive: true, mode: 0o755 });
  await cp(join(saas, 'scripts/build-api.mjs'), join(output, 'scripts/build-api.mjs'), { force: false, errorOnExist: true });
  await cp(join(saas, 'scripts/wasp-build-scope.mjs'), join(output, 'scripts/wasp-build-scope.mjs'), { force: false, errorOnExist: true });
  await copyTree(join(app, '.wasp/out/web-app/build'), join(output, 'public'));
  // Wasp's package has a local spec dependency as a development dependency. Keep
  // its generated package alongside the app for npm ci without fetching a CLI.
  if (packageJson.devDependencies?.['@wasp.sh/spec'] === 'file:.wasp/spec') await copyTree(join(saas, 'apps/web/.wasp/spec'), join(app, '.wasp/spec'));
  await mkdir(join(output, 'ops'), { recursive: true, mode: 0o755 });
  for (const name of ['backup.sh', 'restore-check.sh', 'object-references.sql', 'object-backup.mjs']) await cp(join(saas, 'scripts', name), join(output, 'ops', name), { force: false, errorOnExist: true });
  for (const name of ['upstream.lock.json', 'OPEN-SAAS-LICENSE']) await cp(join(saas, name), join(output, name), { force: false, errorOnExist: true });
  await normalizeModes(output);
  const files = [];
  for (const path of await entries(output)) {
    const bytes = await readFile(path);
    assertNoSecret(path, bytes);
    files.push({ path: relative(output, path).split(sep).join('/'), sha256: sha(bytes), sizeBytes: bytes.length });
  }
  const inside = (path, root) => { const candidate = relative(root, path); return candidate !== '..' && !candidate.startsWith(`..${sep}`) && !candidate.startsWith(sep); };
  for (const file of files.filter(file => file.path.endsWith('/package.json'))) {
    const path = join(output, file.path); const pkg = JSON.parse(await readFile(path, 'utf8'));
    for (const dependencies of [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies]) for (const value of Object.values(dependencies ?? {})) {
      if (typeof value !== 'string' || !value.startsWith('file:')) continue;
      const target = resolve(dirname(path), value.slice(5));
      if (!inside(target, output) || !await exists(target)) fail('RELEASE_LOCAL_DEPENDENCY_MISSING');
    }
  }
  let sourceCommit = null; let workingTreeDirty = null;
  try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(); workingTreeDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()); } catch { /* Archive exports may not have Git metadata. */ }
  const manifest = { formatVersion: 1, releaseId, preparedAt: new Date().toISOString(), sourceCommit, workingTreeDirty, node: '24.14.1', npm: '11.18.0', wasp: '0.25.0', publicApiUrl: api.origin, files, artifactHash: sha(JSON.stringify(files)), installedOnTarget: false, deployed: false };
  await writeFile(join(output, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  console.log(JSON.stringify({ status: 'RELEASE_PREPARED_NOT_DEPLOYED', output, releaseId, files: files.length, artifactHash: manifest.artifactHash, workingTreeDirty }));
} catch (error) { console.error(error instanceof Error && /^RELEASE_[A-Z_]+$/.test(error.message) ? error.message : 'RELEASE_PREPARATION_FAILED'); process.exitCode = 1; }
