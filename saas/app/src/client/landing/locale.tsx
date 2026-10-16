import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Globe } from 'lucide-react';
import { isLocale, locales, localeNames, localeStorageKey, messages, resolveLocale, type Locale, type MessageKey } from './messages';

const LocaleContext = createContext<{
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey) => string;
} | null>(null);

/** Homepage scope for now; the same message contract can be used by other page groups. */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const requested = params.get('lang');
  // Keep the server and initial browser render identical. Storage is read after hydration.
  const [locale, updateLocale] = useState<Locale>(() => resolveLocale(requested, null));
  useEffect(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem(localeStorageKey); } catch { /* Storage may be disabled. */ }
    updateLocale(resolveLocale(requested, stored));
  }, [requested]);
  useEffect(() => {
    const originalLang = document.documentElement.lang;
    const originalTitle = document.title;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const originalDescription = description?.content;
    return () => {
      document.documentElement.lang = originalLang;
      document.title = originalTitle;
      if (description && originalDescription !== undefined) description.content = originalDescription;
    };
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = messages[locale]['meta.title'];
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description) description.content = `${messages[locale]['hero.description']} ${messages[locale]['hero.outcome']}`;
  }, [locale]);
  const setLocale = (next: Locale) => {
    updateLocale(next);
    try { localStorage.setItem(localeStorageKey, next); } catch { /* Switching still works without storage. */ }
    setParams(previous => { const updated = new URLSearchParams(previous); updated.set('lang', next); return updated; }, { replace: true, preventScrollReset: true });
  };
  return <LocaleContext.Provider value={{ locale, setLocale, t: key => messages[locale][key] }}>
    <div lang={locale} data-locale={locale}>{children}</div>
  </LocaleContext.Provider>;
}
export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) throw new Error('useLocale requires LocaleProvider');
  return context;
}
export function LanguagePicker() {
  const { locale, setLocale, t } = useLocale();
  return <label className="lp-language"><Globe size={15} aria-hidden="true" />
    <select aria-label={t('locale.label')} value={locale} onChange={event => { if (isLocale(event.target.value)) setLocale(event.target.value); }}>
      {locales.map(value => <option key={value} value={value} lang={value}>{localeNames[value]}</option>)}
    </select>
  </label>;
}
