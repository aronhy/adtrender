import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: node scripts/build-polar-footer.mjs --output NEW_DIRECTORY');
const output = resolve(args[1]);
await mkdir(output, { recursive: false });
const assets = join(output, 'assets');
await mkdir(assets);
await build({
  absWorkingDir: repo,
  entryPoints: { 'polar-footer': 'apps/web/src/client/landing/polar-footer-entry.tsx' },
  outdir: assets,
  entryNames: '[name]-[hash]',
  bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], jsx: 'automatic',
  minify: true, sourcemap: false, legalComments: 'eof',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const publicDir = join(repo, 'apps/web/public');
await mkdir(join(output, 'homepage-assets'));
for (const filename of ['antarctic-panorama.webp', 'polar-mark.svg']) {
  await cp(join(publicDir, 'homepage-assets', filename), join(output, 'homepage-assets', filename), { force: false, errorOnExist: true });
}
const files = [];
for (const dir of ['assets', 'homepage-assets']) for (const name of (await readdir(join(output, dir))).sort()) {
  const path = join(dir, name);
  const bytes = await readFile(join(output, path));
  files.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const js = files.find(file => file.path.endsWith('.js'));
const css = files.find(file => file.path.endsWith('.css'));
if (!js || !css) throw new Error('Missing generated footer assets');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim());
const manifest = { formatVersion: 1, sourceCommit, workingTreeDirty: dirty, sourceRepository: 'https://github.com/aronhy/adtrender', slogan: 'Find your next winning ad', files, entry: '/' + js.path, stylesheet: '/' + css.path };
await writeFile(join(output, 'polar-footer-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, sourceCommit, workingTreeDirty: dirty, files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) }));
