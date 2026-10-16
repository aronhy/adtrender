import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Globe } from 'lucide-react';
import { isLocale, locales, localeNames, localeStorageKey, resolveLocale, type Locale } from '../landing/messages';
import { translate, workspaceErrorKey, workspaceLanguageSearch, workspaceLink, workspaceStatusKey, type MessageValues } from './messages';

function localeValue(locale: Locale) {
  const t = (key: string, values?: MessageValues) => translate(locale, key, values);
  return { locale, t, href: (path: string) => workspaceLink(path, locale),
    error: (reason: unknown) => t(workspaceErrorKey(reason)), status: (value?: string | null) => t(workspaceStatusKey(value)),
    date: (value?: string | Date | null, withTime = false) => {
      if (!value) return t('common.noDate');
      const date = new Date(value);
      return Number.isFinite(date.valueOf()) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', ...(withTime ? { timeStyle: 'short' as const } : {}) }).format(date) : t('common.unknownDate');
    },
    money: (amount: number | null | undefined, currency?: string | null) => {
      if (amount == null || !currency) return t('common.noPrice');
      try { const format = new Intl.NumberFormat(locale, { style: 'currency', currency }); return format.format(amount / (10 ** (format.resolvedOptions().maximumFractionDigits ?? 2))); }
      catch { return t('common.unknownPrice'); }
    },
  };
}
const WorkspaceLocaleContext = createContext({ ...localeValue('zh-CN'), setLocale: (_next: Locale) => {} });
export function WorkspaceLocaleProvider({ children }: { children: ReactNode }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const requested = params.get('lang');
  const [locale, update] = useState<Locale>(() => resolveLocale(requested, null));
  useEffect(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem(localeStorageKey); } catch { /* Storage can be disabled. */ }
    update(resolveLocale(requested, stored));
  }, [requested]);
  useEffect(() => { const original = document.documentElement.lang; return () => { document.documentElement.lang = original; }; }, []);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const value = useMemo(() => localeValue(locale), [locale]);
  return <WorkspaceLocaleContext.Provider value={{ ...value, setLocale: next => {
    update(next);
    try { localStorage.setItem(localeStorageKey, next); } catch { /* Query keeps selection usable. */ }
    navigate({ search: workspaceLanguageSearch(window.location.search, next).toString(), hash: window.location.hash }, { replace: true, preventScrollReset: true });
  } }}>{children}</WorkspaceLocaleContext.Provider>;
}
export function useWorkspaceLocale() { return useContext(WorkspaceLocaleContext); }
export function WorkspaceLanguagePicker() {
  const { locale, setLocale, t } = useWorkspaceLocale();
  return <label className="workspace-language"><Globe size={15} aria-hidden="true" /><select aria-label={t('nav.language')} value={locale} onChange={event => { if (isLocale(event.target.value)) setLocale(event.target.value); }}>{locales.map(value => <option key={value} value={value} lang={value}>{localeNames[value]}</option>)}</select></label>;
}
