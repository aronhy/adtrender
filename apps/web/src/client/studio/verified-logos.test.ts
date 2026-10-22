import {describe,expect,it} from 'vitest';
import {studioLogoCandidates} from './verified-logos';
describe('catalog logo candidates',()=>{
 it('uses the catalog logo without inventing a domain icon',()=>{expect(studioLogoCandidates('https://assets.example.test/logo.png','brand.example.test')).toEqual(['https://assets.example.test/logo.png']);expect(studioLogoCandidates(null,'brand.example.test')).toEqual([]);});
 it('rejects non-HTTPS and credential-bearing logos',()=>{for(const url of ['http://example.test/logo.png','javascript:alert(1)','https://user:password@example.test/logo.png','/local-capture.png'])expect(studioLogoCandidates(url)).toEqual([]);});
});
