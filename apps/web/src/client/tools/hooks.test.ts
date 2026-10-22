import { describe, expect, it } from 'vitest';
import { generateHooks, validateHookInput, type HookInput } from './hooks';

const input: HookInput = { product: '便携咖啡杯', audience: '通勤者', benefit: '单手开合', language: 'zh-CN' };

describe('original hook templates', () => {
  it.each(['product', 'audience', 'benefit'] as const)('rejects a blank %s before producing any hooks', field => {
    const invalid = { ...input, [field]: ' \n ' };
    expect(validateHookInput(invalid)[field]).toBeTruthy();
    expect(() => generateHooks(invalid)).toThrow();
  });
  it('returns ten distinct, categorized hooks containing the supplied product, audience and benefit', () => {
    const hooks = generateHooks(input);
    expect(hooks).toHaveLength(10);
    expect(new Set(hooks.map(hook => hook.id)).size).toBe(10);
    expect(new Set(hooks.map(hook => hook.text)).size).toBe(10);
    for (const hook of hooks) {
      expect(hook.category).not.toBe('');
      expect(hook.text).toContain('便携咖啡杯');
      expect(hook.text).toContain('通勤者');
      expect(hook.text).toContain('单手开合');
    }
    expect(generateHooks(input)).toEqual(hooks);
  });
  it('uses English templates without pretending to translate the supplied words', () => {
    const hooks = generateHooks({ product: 'Travel mug', audience: 'commuters', benefit: 'one-handed opening', language: 'en' });
    expect(hooks).toHaveLength(10);
    expect(hooks.every(hook => hook.text.includes('Travel mug') && hook.text.includes('commuters') && hook.text.includes('one-handed opening'))).toBe(true);
    expect(hooks.some(hook => /[\u3400-\u9fff]/u.test(hook.text))).toBe(false);
    expect(generateHooks({ ...input, language: 'en' })[0].text).toContain('便携咖啡杯');
  });
  it.each(['product', 'audience', 'benefit'] as const)('accepts 200 Unicode characters in %s and rejects 201', field => {
    expect(validateHookInput({ ...input, [field]: '😀'.repeat(200) })[field]).toBeUndefined();
    const invalid = { ...input, [field]: '字'.repeat(201) };
    expect(validateHookInput(invalid)[field]).toBeTruthy();
    expect(() => generateHooks(invalid)).toThrow();
  });
  it('treats quotes, line breaks and HTML as literal text without interpolating code', () => {
    const product = '<img src=x onerror=alert(1)> "cup"\n新款';
    expect(generateHooks({ ...input, product }).every(hook => hook.text.includes(product))).toBe(true);
  });
  it.each(['zh-CN', 'en'] as const)('does not add invented evidence or guarantees to %s hooks', language => {
    const hooks = generateHooks({ product: 'Cup', audience: 'commuters', benefit: 'easy opening', language });
    expect(hooks.map(hook => hook.text).join('\n')).not.toMatch(/\d|销量|用户评价|保证|保证有效|见证|testimonial|guarantee|proven|customers say|best.selling/iu);
  });
});
