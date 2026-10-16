import type { Locale } from '../client/landing/messages';
import en from './locales/en';
import es from './locales/es';
import zhCN from './locales/zh-CN';
import zhTW from './locales/zh-TW';

export type MessageKey = keyof typeof en;

export const authMessages: Record<Locale, Record<MessageKey, string>> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  en,
  es,
};
