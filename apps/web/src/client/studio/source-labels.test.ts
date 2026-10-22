import {describe,expect,it} from 'vitest';
import {sourceLabel} from './source-labels';
describe('source labels',()=>{
 it('names providers separately from their publisher channels',()=>{expect(sourceLabel('bigspy')).toBe('BigSpy');expect(sourceLabel('adflex')).toBe('AdFlex');expect(sourceLabel('meta_ad_library')).toBe('Meta 广告资料库');});
 it('preserves an unknown source key instead of guessing a platform',()=>{expect(sourceLabel('future_provider')).toBe('future_provider');expect(sourceLabel(null)).toBe('来源未披露');});
});
