import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {validateSeedManifestDescriptor,validateSeedManifestChunk} from './seeds';
const publicationId='11111111-1111-4111-8111-111111111111',manifestHash='a'.repeat(64),raw=Buffer.from('种子😀');
const descriptor={schemaVersion:1,type:'SEED_MANIFEST_DESCRIPTOR',publicationId,publicationRevision:1,manifestHash,byteSha256:'b'.repeat(64),byteLength:16*1024*1024,chunkBytes:1024*1024,totalChunks:16};
const chunk={schemaVersion:1,type:'SEED_MANIFEST_CHUNK',publicationId,publicationRevision:1,manifestHash,chunkIndex:0,byteSha256:createHash('sha256').update(raw).digest('hex'),byteLength:raw.length,dataBase64:raw.toString('base64')};
describe('immutable manifest byte transfer',()=>{
 it('accepts a large manifest descriptor without a total seed or page cap',()=>expect(validateSeedManifestDescriptor(descriptor)).toEqual(descriptor));
 it('rejects inconsistent sizes, versions, hashes and unsupported fields',()=>{
  for(const patch of [{totalChunks:15},{chunkBytes:2*1024*1024},{byteLength:0},{byteLength:Number.MAX_SAFE_INTEGER+1},{schemaVersion:2},{manifestHash:'fake'},{extra:true}])expect(()=>validateSeedManifestDescriptor({...descriptor,...patch})).toThrow();
 });
 it('verifies canonical base64, exact bytes and a per-page SHA for multibyte text',()=>expect(validateSeedManifestChunk(chunk)).toEqual(chunk));
 it('rejects corrupted bytes, size, index and noncanonical base64',()=>{
  for(const patch of [{byteSha256:'b'.repeat(64)},{byteLength:raw.length+1},{chunkIndex:-1},{dataBase64:chunk.dataBase64+'\n'},{dataBase64:chunk.dataBase64.replace(/.$/,'!')}])expect(()=>validateSeedManifestChunk({...chunk,...patch})).toThrow();
 });
});
