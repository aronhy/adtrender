import {build} from 'esbuild';import {mkdir,copyFile} from 'node:fs/promises';import {resolve} from 'node:path';
const out=resolve(process.argv[2]??'/private/tmp/ds-meta-history-build');await mkdir(out,{recursive:true});
await build({entryPoints:['apps/collector/src/history-service/daemon.ts'],bundle:true,platform:'node',target:'node24',format:'esm',external:['playwright','@prisma/client'],outfile:out+'/history-daemon.mjs'});
await copyFile('apps/collector/deploy/history/schema.sql',out+'/schema.sql');console.log(out);
