import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, copyFile, stat} from 'node:fs/promises';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runtimeLock} from './runtime-lock.mjs';

const here=dirname(fileURLToPath(import.meta.url));const repo=resolve(here,'../../../..');
const args=process.argv.slice(2);const allowDirty=args.includes('--allow-dirty');
const output=args[args.indexOf('--output')+1];
if(!args.includes('--output')||!output||output.startsWith('--'))throw Error('FLEET_BUILD_USAGE');
const out=resolve(output);
try{await stat(out);throw Error('FLEET_BUILD_OUTPUT_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
const git=(...a)=>execFileSync('git',a,{cwd:repo,encoding:'utf8'}).trim();
const revision=git('rev-parse','HEAD');const cleanTree=git('status','--porcelain')==='';
if(!cleanTree&&!allowDirty)throw Error('FLEET_CLEAN_CHECKOUT_REQUIRED');
await mkdir(out,{recursive:true,mode:0o755});
const paths={pinterest:'saas/collector/src/pinterest/daemon.ts',google:'saas/collector/src/google-service/daemon.ts',tiktok:'saas/collector/src/tiktok-service/daemon.ts',snapchat:'saas/collector/src/snapchat-service/daemon.ts'};
// Meta retains its separate 2 GiB / 2 CPU and private-egress deployment entry.
// Build its managed daemon as an optional code artifact, never a tiny-fleet slot.
if(args.includes('--with-meta'))paths.meta='saas/collector/src/meta-service/daemon.ts';
const names=[];
for(const [platform,path] of Object.entries(paths)){
  await build({absWorkingDir:repo,entryPoints:[path],bundle:true,platform:'node',format:'esm',packages:'external',outfile:join(out,platform+'.mjs'),logLevel:'silent'});
  names.push(platform+'.mjs');
  const sql='saas/collector/deploy/'+platform+'/ingest.sql';
  await copyFile(join(repo,sql),join(out,platform+'.ingest.sql'));names.push(platform+'.ingest.sql');
}
for(const name of ['targets.json','runner.py','authorization.py','fleet_config.py','host_ops.py','candidate-refresh.py','relay-run.sh','relay-askpass.sh','runtime.Dockerfile']){
  await copyFile(join(here,name),join(out,name));names.push(name);
}
await copyFile(join(repo,'saas/deploy/container/seccomp_profile.json'),join(out,'seccomp_profile.json'));names.push('seccomp_profile.json');
const app=JSON.parse(await readFile(join(repo,'saas/app/package.json'),'utf8'));
const nodeMinimum=app.engines.node.match(/^>=(\d+\.\d+\.\d+)$/)?.[1];
if(!nodeMinimum||!['playwright','@prisma/client'].every(key=>/^\d+\.\d+\.\d+$/.test(app.dependencies[key]))||app.devDependencies.prisma!==app.dependencies['@prisma/client'])throw Error('FLEET_PINNED_DEPENDENCIES_REQUIRED');
await mkdir(join(out,'runtime'));
const locked=runtimeLock(app,JSON.parse(await readFile(join(repo,'saas/app/package-lock.json'),'utf8')));
await writeFile(join(out,'runtime/package.json'),JSON.stringify(locked.pkg,null,2)+'\n');
await writeFile(join(out,'runtime/package-lock.json'),JSON.stringify(locked.lock,null,2)+'\n');
await copyFile(join(here,'runtime-schema.prisma'),join(out,'runtime/schema.prisma'));
names.push('runtime/package.json','runtime/package-lock.json','runtime/schema.prisma');
const files=[];for(const name of names.sort()){const body=await readFile(join(out,name));files.push({path:name,bytes:body.length,sha256:createHash('sha256').update(body).digest('hex')});}
const capabilityDigest=createHash('sha256').update(JSON.stringify({protocolVersion:1,platforms:Object.keys(paths).sort(),runtime:{nodeMinimum,playwright:app.dependencies.playwright,prisma:app.dependencies['@prisma/client']},programs:files.filter(f=>f.path.endsWith('.mjs'))})).digest('hex');
await writeFile(join(out,'manifest.json'),JSON.stringify({schema:1,revision,cleanTree,capabilityDigest,runtime:{nodeMinimum,playwright:app.dependencies.playwright,prisma:app.dependencies['@prisma/client']},files},null,2)+'\n');
console.log(JSON.stringify({revision,cleanTree,platforms:Object.keys(paths),aliases:{youtube:'google'},files:files.length,output:out}));
