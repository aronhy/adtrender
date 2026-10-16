import zhCN from './locales/zh-CN';
import zhTW from './locales/zh-TW';
import en from './locales/en';
import es from './locales/es';

export const locales = ['zh-CN', 'zh-TW', 'en', 'es'] as const;
export type Locale = typeof locales[number];
export type MessageKey = keyof typeof zhCN;
export const localeNames: Record<Locale, string> = {
  'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', es: 'Español',
};
export const messages: Record<Locale, Record<MessageKey, string>> = {
  'zh-CN': zhCN, 'zh-TW': zhTW, en, es,
};
export const localeStorageKey = 'ad-research.locale';
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && locales.some(locale => locale === value);
}
export function resolveLocale(query: string | null, stored: string | null): Locale {
  return isLocale(query) ? query : isLocale(stored) ? stored : 'zh-CN';
}
