import { isLocale } from '../landing/messages';
import { createGrowthCapture } from './growth';
import { isFreeToolPath, readyFreeTools } from '../../shared/free-tools';

const origin = 'https://adtrender.com';
const pages: Record<string, string> = { '/': 'AdTrender', '/pricing': 'AdTrender · Pricing', '/help': 'AdTrender · Help', '/terms': 'AdTrender · Terms', '/privacy': 'AdTrender · Privacy', '/tools': 'AdTrender · 免费工具', ...Object.fromEntries(readyFreeTools.map(tool => [`/tools/${tool.slug}`, `AdTrender · ${tool.title}`])) };
const homeAnchors = new Set(['landing-nav', 'main', 'explore', 'details', 'analysis', 'analysis-example', 'collections', 'team', 'how', 'faq']);
const consentKey = 'adtrender.website-analytics.v2';
export type Choice = 'accepted' | 'rejected' | null;
type Tag = ((...args: unknown[]) => void) & { q?: IArguments[] };
type AnalyticsWindow = Window & { dataLayer?: IArguments[]; gtag?: Tag; clarity?: Tag };

export function publicPage(value: string): { path: string; title: string; url: string } | null {
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password || !Object.hasOwn(pages, url.pathname)) return null;
    return { path: url.pathname, title: pages[url.pathname]!, url: `${origin}${url.pathname}` };
  } catch { return null; }
}
/** Preserve public navigation state without carrying arbitrary parameters into
 * third-party scripts. GA page_location still uses publicPage's canonical URL. */
export function safePublicAddress(value: string): string | null {
  const page = publicPage(value);
  if (!page) return null;
  const original = new URL(value), safe = new URL(page.url);
  if (page.path === '/') {
    const locale = original.searchParams.get('lang');
    if (isLocale(locale)) safe.searchParams.set('lang', locale);
    if (homeAnchors.has(original.hash.slice(1))) safe.hash = original.hash;
  }
  return safe.href;
}
export function safeAttribution(value: string, referrer: string): Record<string, string> {
  const result: Record<string, string> = { page_referrer: '' };
  try {
    const source = new URL(referrer);
    if (['http:', 'https:'].includes(source.protocol) && !source.username && !source.password) result.page_referrer = `${source.origin}/`;
  } catch { /* Direct visit. */ }
  try {
    const url = new URL(value);
    // Tools never turn URL parameters into campaign metadata: callers may put
    // brand queries, financial assumptions or creative text in those fields.
    if (isFreeToolPath(url.pathname)) return result;
    for (const [key, field] of [['utm_source', 'campaign_source'], ['utm_medium', 'campaign_medium'], ['utm_campaign', 'campaign_name'], ['utm_content', 'campaign_content']]) {
      const label = url.searchParams.get(key!);
      // Campaign labels only: no free-form keywords, URLs, emails or long tokens.
      if (label && /^[a-z][a-z\d._-]{0,79}$/i.test(label) && !/[a-f\d]{24,}/i.test(label)) result[field!] = label;
    }
  } catch { /* Invalid URLs do not become provider metadata. */ }
  return result;
}
function safeClarityReferrer(value: string) {
  if (!value) return true;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password; } catch { return false; }
}
/** Match the first-party API's origin rules without importing server modules.
 * URL canonicalizes alternate IPv4 forms; bracketed hosts cover IPv6. */
function growthReferrerOrigin(value: string): string | undefined {
  try {
    const url = new URL(value), host = url.hostname;
    if (url.protocol !== 'https:' || url.username || url.password || url.origin.length > 253
      || !host.includes('.') || host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return undefined;
    return url.origin;
  } catch { return undefined; }
}

type DocumentType = 'marketing' | 'tools' | 'private';
function documentType(value: string): DocumentType {
  const page = publicPage(value);
  return !page ? 'private' : isFreeToolPath(page.path) ? 'tools' : 'marketing';
}
/** Replay-capable marketing, tools and private pages each own a document.
 * Stopping/removing a loaded script cannot remove its installed observers. */
export function createSiteAnalytics(window: Window, config: { ga4?: string; clarity?: string; growth?: boolean }, navigate = (url: string, replace: boolean) => replace ? window.location.replace(url) : window.location.assign(url)) {
  const win = window as AnalyticsWindow, document = win.document;
  const initialDocumentType = documentType(win.location.href);
  const documentPublic = initialDocumentType !== 'private';
  const attribution = safeAttribution(win.location.href, document.referrer);
  const landing = publicPage(win.location.href);
  const referrerOrigin = growthReferrerOrigin(attribution.page_referrer ?? '');
  const growth = config.growth ? createGrowthCapture(win, landing ? { landingPath: landing.path,
    ...(attribution.campaign_source ? { source: attribution.campaign_source } : {}),
    ...(attribution.campaign_medium ? { medium: attribution.campaign_medium } : {}),
    ...(attribution.campaign_name ? { campaign: attribution.campaign_name } : {}),
    ...(attribution.campaign_content ? { content: attribution.campaign_content } : {}),
    ...(referrerOrigin ? { referrerOrigin } : {}) } : null) : null;
  // A Google tag may collect automatic outbound/form events configured outside
  // this app. Tool documents therefore use only our bounded first-party API.
  const ga4 = initialDocumentType === 'marketing' && /^G-[A-Z\d]{4,20}$/.test(config.ga4 ?? '') ? config.ga4! : '';
  const clarity = initialDocumentType === 'marketing' && /^[a-z\d]{5,30}$/i.test(config.clarity ?? '') ? config.clarity! : '';
  const originalPush = win.history.pushState, originalReplace = win.history.replaceState;
  let started = false, leaving = false, installed = false, lastPath: string | null = null;
  const scripts: HTMLScriptElement[] = [];
  let currentChoice: Choice = null;
  try { const value = win.localStorage.getItem(consentKey); if (value === 'accepted' || value === 'rejected') currentChoice = value; } catch { /* Default remains denied. */ }
  const enabled = () => documentPublic && Boolean(ga4 || clarity || growth);
  const mustReload = (value: string) => {
    try { const target = new URL(value, win.location.href); return target.origin === win.location.origin && documentType(target.href) !== initialDocumentType; } catch { return false; }
  };
  const sanitizeAddress = () => {
    const address = safePublicAddress(win.location.href);
    if (address && win.location.href !== address) originalReplace.call(win.history, win.history.state, '', address);
  };
  function disable() {
    if (ga4) (win as unknown as Record<string, unknown>)[`ga-disable-${ga4}`] = true;
    win.gtag?.('consent', 'update', { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    win.clarity?.('consentv2', { analytics_Storage: 'denied', ad_Storage: 'denied' });
    win.clarity?.('stop');
    for (const script of scripts) script.remove();
  }
  function leave(value: string, replace = false) {
    if (leaving) return;
    leaving = true; disable();
    const target = new URL(value, win.location.href).href;
    const destination = safePublicAddress(target) ?? target;
    if (!growth) { navigate(destination, replace); return; }
    // Allow the same-origin consent response to set its HttpOnly cookie before
    // signup/OAuth starts. Analytics failure must never block the business flow.
    const complete = () => navigate(destination, replace);
    void growth.handoff().then(complete, complete);
  }
  function page() {
    if (!started || leaving || currentChoice !== 'accepted') return;
    const current = publicPage(win.location.href);
    if (!current || !documentPublic) return;
    sanitizeAddress();
    if (current.path === lastPath) return;
    const previous = lastPath;
    lastPath = current.path;
    growth?.event('PAGE_VIEW', current.path);
    if (ga4) win.gtag?.('event', 'page_view', { page_location: current.url, page_path: current.path, page_title: current.title, ...attribution, ...(previous ? { page_referrer: `${origin}/` } : {}) });
  }
  function script(src: string) {
    const element = document.createElement('script'); element.async = true; element.src = src; element.referrerPolicy = 'no-referrer'; scripts.push(element); document.head.append(element);
  }
  function start() {
    if (started || leaving || !enabled() || currentChoice !== 'accepted' || !publicPage(win.location.href)) return;
    sanitizeAddress(); started = true; growth?.start();
    if (ga4) {
      win.dataLayer = win.dataLayer ?? [];
      win.gtag = function () { win.dataLayer!.push(arguments); };
      win.gtag('consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
      win.gtag('js', new Date());
      win.gtag('config', ga4, { send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false, page_location: publicPage(win.location.href)!.url, page_referrer: attribution.page_referrer });
      script(`https://www.googletagmanager.com/gtag/js?id=${ga4}`);
    }
    if (clarity && safeClarityReferrer(document.referrer)) {
      const tag: Tag = function () { tag.q!.push(arguments); }; tag.q = [];
      win.clarity = tag;
      tag('consentv2', { analytics_Storage: 'granted', ad_Storage: 'denied' });
      script(`https://www.clarity.ms/tag/${clarity}`);
    }
    page();
  }
  function choose(value: Exclude<Choice, null>) {
    currentChoice = value;
    try { win.localStorage.setItem(consentKey, value); } catch { /* Consent remains in memory for this document. */ }
    if (value === 'accepted') {
      if (started && growth?.status() === 'unavailable') { growth.start(); const current = publicPage(win.location.href); if (current) growth.event('PAGE_VIEW', current.path); }
      else start();
    }
    else { growth?.revoke(); if (started) leave(safePublicAddress(win.location.href) ?? win.location.href, true); }
  }
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const target = event.target as Element | null;
    const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return;
    const destination = new URL(anchor.href), current = publicPage(win.location.href);
    const action = ({ '/signup': 'signup', '/login': 'login', '/pricing': 'pricing' } as const)[destination.pathname as '/signup' | '/login' | '/pricing'];
    if (current && started && !leaving && currentChoice === 'accepted' && destination.origin === origin && action) {
      growth?.event('CTA_CLICK', current.path, action);
      if (ga4) win.gtag?.('event', `${action}_click`, { page_location: current.url, page_title: current.title, ...attribution });
    }
    if (!mustReload(anchor.href)) return;
    // Cancel only the SPA/default navigation. React Link still needs to run its
    // business onClick (for example saving a selected plan before login).
    // History interception + the render guard protect programmatic navigation
    // during that callback; leave after the synchronous event has completed.
    event.preventDefault();
    const href = anchor.href;
    win.queueMicrotask(() => leave(href));
  };
  const onPop = () => { if (mustReload(win.location.href)) leave(win.location.href, true); else if (started) { sanitizeAddress(); page(); } };
  const onStorage = (event: StorageEvent) => { if (event.key === consentKey && event.newValue !== 'accepted') choose('rejected'); };
  function install() {
    if (installed) return; installed = true;
    if (currentChoice !== 'accepted') growth?.restore();
    win.history.pushState = function (data, unused, url) {
      if (url != null && mustReload(String(url))) { leave(String(url)); return; }
      const safe = started && url != null ? safePublicAddress(new URL(String(url), win.location.href).href) : null;
      originalPush.call(this, data, unused, safe ?? url);
    };
    win.history.replaceState = function (data, unused, url) {
      if (url != null && mustReload(String(url))) { leave(String(url), true); return; }
      const safe = started && url != null ? safePublicAddress(new URL(String(url), win.location.href).href) : null;
      originalReplace.call(this, data, unused, safe ?? url);
    };
    document.addEventListener('click', onClick, true);
    win.addEventListener('popstate', onPop, true); win.addEventListener('hashchange', onPop, true); win.addEventListener('storage', onStorage);
  }
  function dispose() {
    if (!installed) return; installed = false;
    win.history.pushState = originalPush; win.history.replaceState = originalReplace;
    document.removeEventListener('click', onClick, true);
    win.removeEventListener('popstate', onPop, true); win.removeEventListener('hashchange', onPop, true); win.removeEventListener('storage', onStorage);
  }
  return { start, page, choose, choice: () => currentChoice, enabled, install, dispose, mustReload, leave, growth, documentType: initialDocumentType };
}
