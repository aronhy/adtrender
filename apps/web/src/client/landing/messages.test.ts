import { describe, expect, it } from 'vitest';
import { locales, messages, resolveLocale } from './messages';

describe('homepage language contract', () => {
  it('ships complete, nonempty messages for every supported language', () => {
    const keys = Object.keys(messages['zh-CN']).sort();
    for (const locale of locales) {
      expect(Object.keys(messages[locale]).sort()).toEqual(keys);
      for (const value of Object.values(messages[locale])) expect(value.trim().length).toBeGreaterThan(0);
    }
  });
  it('keeps Chinese text out of English and Spanish content', () => {
    for (const locale of ['en', 'es'] as const) {
      for (const value of Object.values(messages[locale])) expect(value).not.toMatch(/[\u3400-\u9fff]/);
    }
  });
  it('prioritizes supported shared-link language, then stored preference, then simplified Chinese', () => {
    expect(resolveLocale('es', 'en')).toBe('es');
    expect(resolveLocale('zh-TW', null)).toBe('zh-TW');
    expect(resolveLocale(null, 'en')).toBe('en');
    expect(resolveLocale('unsupported', 'zh-TW')).toBe('zh-TW');
    expect(resolveLocale('__proto__', 'constructor')).toBe('zh-CN');
    expect(resolveLocale(null, null)).toBe('zh-CN');
  });
});
