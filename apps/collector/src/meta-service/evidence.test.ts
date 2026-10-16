// @vitest-environment jsdom
import {describe,it,expect} from 'vitest';
import {sanitizeEvidence,accessState} from './evidence';
describe('Meta public evidence',()=>{
 it('removes executable scripts, inputs, cookies and private page attributes while retaining ad facts and URLs',()=>{
  const doc=new DOMParser().parseFromString('<body><script>token=secret</script><input value="secret"><div data-token="secret"><span>Library ID: 123456</span><img src="https://scontent.xx.fbcdn.net/ad.jpg"><a href="https://shop.example/">Shop now</a></div></body>','text/html');
  const result=sanitizeEvidence(doc);expect(result.html).not.toContain('secret');expect(result.html).toContain('123456');expect(result.html).toContain('https://scontent.xx.fbcdn.net/ad.jpg');
 });
 it('distinguishes a usable public shell from challenge, blank document and real ad results',()=>{
  expect(accessState(403,'Meta Ad Library Search by keyword or advertiser Log in')).toBe('shell');
  expect(accessState(403,'Verify you are human')).toBe('restricted');
  expect(accessState(200,'')).toBe('loading');
  expect(accessState(200,'Library ID: 123456')).toBe('ready');
  expect(accessState(429,'Library ID: 123456')).toBe('restricted');
  expect(accessState(200,'Log in to Facebook')).toBe('login');
 });
});
import {browserErrorCode} from './evidence';
it('classifies a stale profile lock for service restart instead of retrying every keyword',()=>{
 expect(browserErrorCode(new Error('The profile appears to be in use by another Chromium process on another computer'))).toBe('META_PROFILE_LOCKED');
 expect(browserErrorCode(new Error('user data directory is already in use'))).toBe('META_PROFILE_LOCKED');
});
import {graphqlErrorCode} from './evidence';
it('detects source rate limits inside an HTTP 200 response and streamed response chunks',()=>{
 expect(graphqlErrorCode('{"errors":[{"message":"Rate limit exceeded","code":1675004}],"extensions":{}}')).toBe('META_RATE_LIMITED');
 expect(graphqlErrorCode('{"data":{}}\n{"errors":[{"message":"Rate limit exceeded","code":1675004}]}')).toBe('META_RATE_LIMITED');
 expect(graphqlErrorCode('{"data":{"ad_library_main":{}}}')).toBeNull();
 expect(graphqlErrorCode('{"errors":[{"message":"Unknown query"}]}')).toBe('META_QUERY_ERROR');
});
