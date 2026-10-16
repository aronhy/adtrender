import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { locales } from '../client/landing/messages';
import { authMessages, type MessageKey } from './messages';
import { AuthLanguagePicker, AuthLocaleProvider, authHref, authLanguageSearch, useAuthLocale } from './locale';

describe('account page translations', () => {
  it('provides every English message with the same placeholders in all four languages', () => {
    const keys = Object.keys(authMessages.en).sort() as MessageKey[];
    for (const locale of locales) {
      expect(Object.keys(authMessages[locale]).sort(), locale).toEqual(keys);
      for (const key of keys) {
        const value = authMessages[locale][key];
        expect(value.trim().length, `${locale}: ${key}`).toBeGreaterThan(0);
        expect(value.match(/\{[a-zA-Z]+\}/g) ?? [], `${locale}: ${key}`).toEqual(authMessages.en[key].match(/\{[a-zA-Z]+\}/g) ?? []);
      }
    }
  });

  it('keeps English and Spanish free of Chinese copy and translates Spanish sentences', () => {
    for (const locale of ['en', 'es'] as const) {
      for (const value of Object.values(authMessages[locale])) expect(value).not.toMatch(/[\u3400-\u9fff]/);
    }
    for (const key of Object.keys(authMessages.en) as MessageKey[]) {
      if (key !== 'legal.after') expect(authMessages.es[key], key).not.toBe(authMessages.en[key]);
    }
  });

  it('uses the appropriate Chinese script for common account terminology', () => {
    expect(Object.values(authMessages['zh-TW']).join('')).not.toMatch(/[账帐发设验链邮码输显隐页欢请语网连这]/);
    expect(Object.values(authMessages['zh-CN']).join('')).not.toMatch(/[帳發設驗鏈郵碼輸顯隱頁歡請語網連這]/);
  });
});

describe('account language routing', () => {
  it('preserves explicit destination options and anchors while applying the current language', () => {
    expect(authHref('/login', 'zh-TW')).toBe('/login?lang=zh-TW');
    expect(authHref('/signup?plan=pro&lang=en#form', 'es')).toBe('/signup?plan=pro&lang=es#form');
    expect(authHref('/?utm_source=email', 'en')).toBe('/?utm_source=email&lang=en');
  });

  it('removes all sensitive callback values during language changes, preserving other query values', () => {
    const result = authLanguageSearch('?token=secret&lang=en&oauth_error=expired&plan=pro&token=duplicate', 'es');
    expect(result.toString()).toBe('lang=es&plan=pro');
    expect(result.has('token')).toBe(false);
    expect(result.has('oauth_error')).toBe(false);
    expect(authLanguageSearch('?lang=en', 'zh-TW').toString()).toBe('lang=zh-TW');
  });

  function LocaleProbe() {
    const { locale, t, href } = useAuthLocale();
    return createElement('a', { href: href('/login'), 'data-active-locale': locale }, t('login.submit'));
  }

  it('renders server-side from the query without needing browser globals or storage', () => {
    for (const locale of locales) {
      const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [`/login?lang=${locale}`] },
        createElement(AuthLocaleProvider, null, createElement(LocaleProbe), createElement(AuthLanguagePicker))));
      expect(html).toContain(`data-active-locale="${locale}"`);
      expect(html).toContain(`/login?lang=${locale}`);
      expect(html).toContain(authMessages[locale]['login.submit']);
      expect(html).toContain(`aria-label="${authMessages[locale]['nav.language']}"`);
      expect(html).toContain('class="auth-language"');
    }
  });

  it('uses simplified Chinese for server requests without a supported language', () => {
    for (const entry of ['/login', '/login?lang=__proto__']) {
      const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [entry] },
        createElement(AuthLocaleProvider, null, createElement(LocaleProbe))));
      expect(html).toContain('data-active-locale="zh-CN"');
      expect(html).toContain('登录');
    }
  });
});
