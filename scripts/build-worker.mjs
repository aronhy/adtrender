import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const base = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(resolve(base, 'apps/web/package.json'));
const { build } = require('esbuild');
await build({ entryPoints: {index:resolve(base, 'apps/worker/src/cli.ts'),'media-recovery':resolve(base,'apps/worker/src/media-recovery-cli.ts'),'ad-history':resolve(base,'apps/worker/src/ad-history-cli.ts'),'seed-admin':resolve(base,'apps/worker/src/seed-admin-cli.ts')}, outdir: resolve(base, 'apps/web/dist-worker'), outExtension:{'.js':'.mjs'}, bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', nodePaths: [resolve(base, 'apps/web/node_modules')], sourcemap: true });
console.log('Independent worker built: apps/web/dist-worker/index.mjs');
