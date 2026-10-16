import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Globe } from 'lucide-react';
import { isLocale, locales, localeNames, localeStorageKey, resolveLocale, type Locale } from '../client/landing/messages';
import { authMessages, type MessageKey } from './messages';

const AuthLocaleContext = createContext<{
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey) => string;
  href: (path: string) => string;
} | null>(null);

/** Read the live address when switching: callback pages may already have removed credentials. */
export function authLanguageSearch(search: string, locale: Locale): URLSearchParams {
  const updated = new URLSearchParams(search);
  updated.delete('token');
  updated.delete('oauth_error');
  updated.set('lang', locale);
  return updated;
}

export function authHref(path: string, locale: Locale): string {
  const hashIndex = path.indexOf('#');
  const hash = hashIndex < 0 ? '' : path.slice(hashIndex);
  const destination = hashIndex < 0 ? path : path.slice(0, hashIndex);
  const queryIndex = destination.indexOf('?');
  const pathname = queryIndex < 0 ? destination : destination.slice(0, queryIndex);
  const query = new URLSearchParams(queryIndex < 0 ? '' : destination.slice(queryIndex + 1));
  query.set('lang', locale);
  return `${pathname}?${query.toString()}${hash}`;
}

export function AuthLocaleProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const requested = params.get('lang');
  // The server and initial browser render share the same state; storage is read after hydration.
  const [locale, updateLocale] = useState<Locale>(() => resolveLocale(requested, null));

  useEffect(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem(localeStorageKey); } catch { /* Storage may be disabled. */ }
    updateLocale(resolveLocale(requested, stored));
  }, [requested]);

  useEffect(() => {
    const originalLang = document.documentElement.lang;
    return () => { document.documentElement.lang = originalLang; };
  }, []);

  useEffect(() => { document.documentElement.lang = locale; }, [locale]);

  const setLocale = (next: Locale) => {
    updateLocale(next);
    try { localStorage.setItem(localeStorageKey, next); } catch { /* Switching still works without storage. */ }
    // A search-only navigation also drops any OAuth fragment; never use the router's stale query.
    setParams(authLanguageSearch(window.location.search, next), { replace: true, preventScrollReset: true });
  };

  return <AuthLocaleContext.Provider value={{ locale, setLocale, t: key => authMessages[locale][key], href: path => authHref(path, locale) }}>
    <div lang={locale} data-locale={locale}>{children}</div>
  </AuthLocaleContext.Provider>;
}

export function useAuthLocale() {
  const context = useContext(AuthLocaleContext);
  if (!context) throw new Error('useAuthLocale requires AuthLocaleProvider');
  return context;
}

export function AuthLanguagePicker() {
  const { locale, setLocale, t } = useAuthLocale();
  return <label className="auth-language"><Globe size={15} aria-hidden="true" />
    <select aria-label={t('nav.language')} value={locale} onChange={event => { if (isLocale(event.target.value)) setLocale(event.target.value); }}>
      {locales.map(value => <option key={value} value={value} lang={value}>{localeNames[value]}</option>)}
    </select>
  </label>;
}
