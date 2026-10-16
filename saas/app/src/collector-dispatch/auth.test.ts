import {createHash,randomUUID} from 'node:crypto';import {describe,it,expect} from 'vitest';
import {parseCollectorCredentials,authenticateCollector} from './auth';
describe('collector machine authentication',()=>{
 it('derives source scopes from server credentials and requires an incarnation',()=>{
  const token='synthetic-credential-with-at-least-32-chars',credentials=parseCollectorCredentials(JSON.stringify([{nodeId:'test-node',tokenSha256:createHash('sha256').update(token).digest('hex'),allowedSourceKeys:['meta_ad_library']}]));
  const headers={authorization:'Bearer '+token,'x-collector-node':'test-node','x-collector-incarnation':randomUUID()};expect(authenticateCollector(headers,credentials).allowedSourceKeys).toEqual(['meta_ad_library']);
  expect(()=>authenticateCollector({...headers,authorization:'Bearer '+'x'.repeat(40)},credentials)).toThrow('COLLECTOR_AUTH_REJECTED');expect(()=>authenticateCollector({...headers,'x-collector-incarnation':''},credentials)).toThrow('COLLECTOR_AUTH_REQUIRED');
 });
 it('rejects wildcard, duplicate nodes, plaintext token config and absent registry config',()=>{
  expect(()=>parseCollectorCredentials(undefined)).toThrow('COLLECTOR_AUTH_NOT_CONFIGURED');for(const c of [{nodeId:'node',tokenSha256:'a'.repeat(64),allowedSourceKeys:['*']},{nodeId:'node',tokenSha256:'a'.repeat(64),allowedSourceKeys:['meta_ad_library'],token:'private'}])expect(()=>parseCollectorCredentials(JSON.stringify([c]))).toThrow('COLLECTOR_AUTH_CONFIG_INVALID');
 });
});
