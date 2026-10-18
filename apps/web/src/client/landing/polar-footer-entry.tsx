import './cloud-homepage.css';
import { createRoot, type Root } from 'react-dom/client';
import { PolarFooter } from './PolarFooter';
import { isLocale, localeStorageKey, resolveLocale, type Locale } from './messages';

// Transitional static release for Cloud's earlier homepage. Self-hosted builds
// use PolarFooter directly in LandingPage and never need this entry point.
const mounted = new Map<HTMLElement, { root: Root; locale: Locale }>();
function currentLocale(element?: Element): Locale {
  const query = new URL(window.location.href).searchParams.get('lang');
  const pageLocale = element?.closest('[data-locale]')?.getAttribute('data-locale') ?? document.documentElement.lang;
  let stored: string | null = null;
  try { stored = localStorage.getItem(localeStorageKey); } catch { /* Storage is optional. */ }
  return resolveLocale(query, isLocale(pageLocale) ? pageLocale : stored);
}
function changeLocale(locale: Locale) {
  // Delegate to the current homepage provider so the header, body, URL and
  // stored preference continue to switch together without a forced reload.
  const existing = document.querySelector<HTMLAnchorElement>(`.pp-navbar a[data-locale="${locale}"]`);
  if (existing) { existing.click(); return; }
  try { localStorage.setItem(localeStorageKey, locale); } catch { /* URL is sufficient. */ }
  const url = new URL(window.location.href);
  url.searchParams.set('lang', locale);
  window.location.assign(url.toString());
}
function reconcile() {
  for (const [node, instance] of mounted) {
    if (!node.isConnected || window.location.pathname !== '/') {
      instance.root.unmount(); mounted.delete(node); continue;
    }
    const locale = currentLocale(node);
    if (locale !== instance.locale) {
      instance.locale = locale;
      instance.root.render(<PolarFooter locale={locale} onLocaleChange={changeLocale} />);
    }
  }
  if (window.location.pathname !== '/') return;
  const previous = document.querySelector<HTMLElement>('.adthrender-pipi-layout footer.footer');
  if (!previous) return;
  const locale = currentLocale(previous);
  const node = document.createElement('div');
  node.dataset.polarFooterMount = 'true';
  previous.replaceWith(node);
  const root = createRoot(node);
  mounted.set(node, { root, locale });
  root.render(<PolarFooter locale={locale} onLocaleChange={changeLocale} />);
}
let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; reconcile(); });
}
const observer = new MutationObserver(schedule);
observer.observe(document.getElementById('root') ?? document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['lang', 'data-locale'] });
window.addEventListener('popstate', schedule);
schedule();
