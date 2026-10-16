import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const base = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(resolve(base, 'app/package.json'));
const { build } = require('esbuild');
await build({ entryPoints: {index:resolve(base, 'worker/src/cli.ts'),'source-probe':resolve(base,'worker/src/source-probe-cli.ts'),'media-recovery':resolve(base,'worker/src/media-recovery-cli.ts'),'ad-history':resolve(base,'worker/src/ad-history-cli.ts'),'seed-admin':resolve(base,'worker/src/seed-admin-cli.ts')}, outdir: resolve(base, 'app/dist-worker'), outExtension:{'.js':'.mjs'}, bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', nodePaths: [resolve(base, 'app/node_modules')], sourcemap: true });
console.log('Independent worker built: saas/app/dist-worker/index.mjs');
