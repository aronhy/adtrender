import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runtimeLock} from './runtime-lock.mjs';
const app=JSON.parse(readFileSync(new URL('../../../app/package.json',import.meta.url)));
const source=JSON.parse(readFileSync(new URL('../../../app/package-lock.json',import.meta.url)));

test('runtime uses committed direct and transitive package checksums, including nested optional versions',()=>{
  const {lock,pkg}=runtimeLock(app,source);
  assert.equal(pkg.dependencies.prisma,app.dependencies['@prisma/client']);
  assert.ok(lock.packages['node_modules/@prisma/engines']);
  assert.ok(lock.packages['node_modules/prisma/node_modules/fsevents']);
  for(const [key,item] of Object.entries(lock.packages))if(key){assert.equal(item.integrity,source.packages[key].integrity);assert.equal(item.version,source.packages[key].version);assert.equal(item.dev,undefined);}
  assert.equal(lock.packages['node_modules/react'],undefined);
  assert.deepEqual(runtimeLock(app,source),runtimeLock(app,source));
});
test('dependency drift or missing locked engine refuses runtime build',()=>{
  assert.throws(()=>runtimeLock({...app,dependencies:{...app.dependencies,playwright:'0.0.1'}},source),/FLEET_APP_LOCK_DRIFT/);
  const broken=structuredClone(source);delete broken.packages['node_modules/@prisma/engines'];
  assert.throws(()=>runtimeLock(app,broken),/FLEET_LOCK_DEPENDENCY_MISSING/);
});
