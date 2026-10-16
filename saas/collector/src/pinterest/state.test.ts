import { describe, expect, it } from 'vitest';
import { classifyPinterestPage, validatePinterestOptions } from './state';

describe('Pinterest source outcomes',()=>{
 it('does not confuse an empty application shell with zero ads',()=>{
  expect(classifyPinterestPage({status:200,text:'',adCount:0})).toBe('EMPTY_PAGE');
 });
 it('stops on access restrictions even with residual ad content',()=>{
  expect(classifyPinterestPage({status:403,text:'ad',adCount:1})).toBe('ACCESS_BLOCKED');
  expect(classifyPinterestPage({status:200,text:'Please verify you are human',adCount:1})).toBe('CHALLENGE');
 });
 it('requires explicit no-results evidence',()=>{
  expect(classifyPinterestPage({status:200,text:'No ads found',adCount:0})).toBe('NO_RESULTS');
  expect(classifyPinterestPage({status:200,text:'Ads repository Search',adCount:0})).toBe('SOURCE_CHANGED');
 });
 it('distinguishes login from a working page',()=>{
  expect(classifyPinterestPage({status:200,text:'Log in to continue',adCount:0})).toBe('LOGIN_REQUIRED');
  expect(classifyPinterestPage({status:200,text:'Ad details',adCount:1})).toBe('READY');
 });
 it('limits the scope before launching or writing to the database',()=>{
  expect(()=>validatePinterestOptions({keyword:'',limit:2})).toThrow();
  expect(()=>validatePinterestOptions({keyword:'nike',limit:21})).toThrow();
  expect(validatePinterestOptions({keyword:'nike',limit:2})).toEqual({keyword:'nike',limit:2});
 });
});
