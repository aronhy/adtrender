import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createSiteAnalytics, publicPage, safeAttribution, safePublicAddress } from './analytics';
import { consentInput } from '../../growth/contract';
// jsdom is already supplied by the test runner; keep its small browser fixture
// boundary typed without adding a production dependency for test-only types.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options: { url: string; referrer?: string }) => { window: Window & typeof globalThis } };

function browser(path = '/', referrer = '') {
  const dom = new JSDOM('<!doctype html><html><head></head><body><a id="private" href="/login?code=secret">Sign in</a><a id="public" href="/pricing">Pricing</a></body></html>', { url: /^https?:/.test(path) ? path : `https://adtrender.com${path}`, ...(referrer ? { referrer } : {}) });
  const navigations: Array<{ url: string; replace: boolean }> = [];
  const runtime = createSiteAnalytics(dom.window as unknown as Window, { ga4: 'G-TEST123456', clarity: 'abc123xyz' }, (url, replace) => navigations.push({ url, replace }));
  const data = () => (dom.window as any).dataLayer?.map((entry: IArguments) => Array.from(entry)) ?? [];
  const scripts = () => Array.from(dom.window.document.scripts).map(script => script.src);
  return { dom, runtime, navigations, data, scripts };
}

describe('production website analytics boundaries', () => {
  it.each([
    ['https://192.0.2.1/private?token=secret', undefined],
    ['https://127.1/private', undefined],
    ['https://[2001:db8::1]/private', undefined],
    ['https://[::ffff:192.0.2.1]/private', undefined],
    ['https://localhost/private', undefined],
    ['https://internal/private', undefined],
    [`https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(54)}/`, undefined],
    ['https://cn.bing.com/search?q=private', 'https://cn.bing.com'],
    ['https://example.test:8443/private', 'https://example.test:8443'],
    [`https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(53)}/`, `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(53)}`],
  ])('keeps first-party consent valid for referrer %s without changing GA attribution', async (referrer, expected) => {
    const f = browser('/?utm_source=google&utm_medium=organic', referrer!);
    const requests: any[] = [];
    (f.dom.window as any).fetch = async (path: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string); requests.push(body);
      const valid = !path.endsWith('/consent') || consentInput.safeParse(body).success;
      return { ok: valid, json: async () => path.endsWith('/consent') ? { consent: body.choice, recording: valid } : { recorded: true } };
    };
    const runtime = createSiteAnalytics(f.dom.window as unknown as Window, { ga4: 'G-TEST123456', growth: true });
    try {
      runtime.choose('accepted'); await runtime.growth!.handoff();
      expect(requests[0].attribution).toMatchObject({ landingPath: '/', source: 'google', medium: 'organic' });
      expect(requests[0].attribution.referrerOrigin).toBe(expected);
      expect(consentInput.safeParse(requests[0]).success).toBe(true);
      expect(requests.some(body => body.name === 'PAGE_VIEW')).toBe(true);
      expect(f.data().find((row: any[]) => row[0] === 'config')[2].page_referrer).toBe(`${new URL(referrer!).origin}/`);
    } finally { runtime.dispose(); f.dom.window.close(); }
  });
  it('asks again instead of treating the former public-page consent as consent to registration attribution', () => {
    const f = browser(); f.dom.window.localStorage.setItem('adtrender.website-analytics.v1', 'accepted');
    const runtime = createSiteAnalytics(f.dom.window as unknown as Window, { ga4: 'G-TEST123456' });
    runtime.start(); expect(runtime.choice()).toBeNull(); expect(f.scripts()).toEqual([]); f.dom.window.close();
  });
  it('records a separate signup click and settles the first-party handoff before navigating', async () => {
    const f = browser('/?utm_source=x&utm_medium=social&utm_campaign=launch-202610');
    const requests: any[] = [];
    (f.dom.window as any).fetch = async (path: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string); requests.push(body);
      return { ok: true, json: async () => path.endsWith('/consent') ? { consent: body.choice, recording: true } : { recorded: true } };
    };
    const runtime = createSiteAnalytics(f.dom.window as unknown as Window, { ga4: 'G-TEST123456', growth: true }, (url, replace) => f.navigations.push({ url, replace }));
    const anchor = f.dom.window.document.getElementById('private') as HTMLAnchorElement; anchor.href = '/signup';
    runtime.install(); runtime.choose('accepted');
    anchor.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(requests.map(row => row.choice ?? row.name)).toEqual(['accepted', 'PAGE_VIEW', 'CTA_CLICK']);
    expect(requests[0].attribution).toMatchObject({ source: 'x', medium: 'social', campaign: 'launch-202610' });
    expect(requests[2].target).toBe('signup');
    expect(f.data().filter((row: any[]) => row[1] === 'signup_click')).toHaveLength(1);
    expect(f.navigations).toEqual([{ url: 'https://adtrender.com/signup', replace: false }]);
    runtime.dispose(); f.dom.window.close();
  });
  it.each(['http://adtrender.com/', 'https://www.adtrender.com/', 'https://adtrender.com.evil.test/', 'http://localhost:3000/', 'https://adtrender.com/app', 'https://adtrender.com/login', 'https://adtrender.com/password-reset?token=secret'])('never enables an unapproved origin or route: %s', url => {
    expect(publicPage(url)).toBeNull();
  });
  it('extracts only bounded campaign labels and referrer origin, never raw sensitive URLs', () => {
    expect(safeAttribution('https://adtrender.com/?utm_source=linkedin&utm_medium=social&utm_campaign=launch-2026&email=private@example.test&token=secret&utm_content=user%40example.test#code=secret', 'https://www.google.com/search?q=private@example.test')).toEqual({ campaign_source: 'linkedin', campaign_medium: 'social', campaign_name: 'launch-2026', page_referrer: 'https://www.google.com/' });
  });
  it('preserves only supported homepage language and known public section anchors', () => {
    expect(safePublicAddress('https://adtrender.com/?lang=es&email=private@example.test#analysis')).toBe('https://adtrender.com/?lang=es#analysis');
    expect(safePublicAddress('https://adtrender.com/?lang=unsupported#token=secret')).toBe('https://adtrender.com/');
    expect(safePublicAddress('https://adtrender.com/pricing?lang=es#analysis')).toBe('https://adtrender.com/pricing');
  });
  it('keeps valid language and anchors through initial consent, same-page navigation and withdrawal', () => {
    const f = browser('/?lang=es&token=secret#analysis'); f.runtime.install(); f.runtime.choose('accepted');
    expect(f.dom.window.location.href).toBe('https://adtrender.com/?lang=es#analysis');
    f.dom.window.history.pushState({}, '', '/?lang=en&workspace=private#explore'); f.runtime.page();
    expect(f.dom.window.location.href).toBe('https://adtrender.com/?lang=en#explore');
    expect(f.data().filter((row: any[]) => row[1] === 'page_view')).toHaveLength(1);
    expect(JSON.stringify(f.data())).not.toMatch(/lang=|#analysis|workspace|private|token/);
    f.runtime.choose('rejected');
    expect(f.navigations).toEqual([{ url: 'https://adtrender.com/?lang=en#explore', replace: true }]);
    f.runtime.dispose(); f.dom.window.close();
  });
  it('requires explicit consent and refuses providers after rejection', () => {
    const f = browser(); f.runtime.start(); f.runtime.page();
    expect(f.scripts()).toEqual([]); expect(f.data()).toEqual([]);
    f.runtime.choose('rejected'); f.runtime.start(); f.runtime.page();
    expect(f.scripts()).toEqual([]); expect(f.runtime.choice()).toBe('rejected');
    f.runtime.dispose(); f.dom.window.close();
  });
  it('loads once after acceptance and sends sanitized manual pageviews without ad signals', () => {
    const f = browser('/?utm_source=linkedin&utm_medium=social&utm_campaign=launch&token=secret#private', 'https://www.google.com/');
    f.runtime.choose('accepted'); f.runtime.start(); f.runtime.start(); f.runtime.page();
    expect(f.scripts()).toEqual(['https://www.googletagmanager.com/gtag/js?id=G-TEST123456', 'https://www.clarity.ms/tag/abc123xyz']);
    expect(Object.prototype.toString.call((f.dom.window as any).dataLayer[0])).toBe('[object Arguments]');
    expect(Object.prototype.toString.call((f.dom.window as any).clarity.q[0])).toBe('[object Arguments]');
    expect(f.dom.window.location.href).toBe('https://adtrender.com/');
    expect(f.data().find((row: any[]) => row[0] === 'config')).toEqual(['config', 'G-TEST123456', { send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false, page_location: 'https://adtrender.com/', page_referrer: 'https://www.google.com/' }]);
    const views = f.data().filter((row: any[]) => row[1] === 'page_view');
    expect(views).toHaveLength(1);
    expect(views[0][2]).toEqual({ page_location: 'https://adtrender.com/', page_path: '/', page_title: 'AdTrender', page_referrer: 'https://www.google.com/', campaign_source: 'linkedin', campaign_medium: 'social', campaign_name: 'launch' });
    expect(JSON.stringify(f.data())).not.toMatch(/token|secret|private/);
    f.runtime.dispose(); f.dom.window.close();
  });
  it('does not count language or hash changes as new pages but counts returning public pages', () => {
    const f = browser(); f.runtime.choose('accepted'); f.runtime.start();
    f.dom.window.history.pushState({}, '', '/?lang=es#details'); f.runtime.page();
    f.dom.window.history.pushState({}, '', '/pricing'); f.runtime.page();
    f.dom.window.history.pushState({}, '', '/'); f.runtime.page();
    expect(f.data().filter((row: any[]) => row[1] === 'page_view').map((row: any[]) => row[2].page_path)).toEqual(['/', '/pricing', '/']);
    expect(f.data().filter((row: any[]) => row[1] === 'page_view').at(-1)[2].page_referrer).toBe('https://adtrender.com/');
    f.runtime.dispose(); f.dom.window.close();
  });
  it('does not load any scripts on a preview host even if consent was accepted', () => {
    const f = browser('http://localhost:3000/'); f.runtime.choose('accepted'); f.runtime.start();
    expect(f.scripts()).toEqual([]); expect(f.data()).toEqual([]);
    f.runtime.dispose(); f.dom.window.close();
  });
  it('blocks programmatic private history navigation before location and DOM can change, including pending scripts', () => {
    const f = browser(); f.runtime.install(); f.runtime.choose('accepted'); f.runtime.start();
    f.dom.window.history.pushState({}, '', '/app/settings?workspace=private');
    expect(f.dom.window.location.pathname).toBe('/');
    expect(f.navigations).toEqual([{ url: 'https://adtrender.com/app/settings?workspace=private', replace: false }]);
    expect(f.runtime.mustReload('/app/settings')).toBe(true);
    expect((f.dom.window as any)['ga-disable-G-TEST123456']).toBe(true);
    f.runtime.dispose(); f.dom.window.close();
  });
  it('captures public-to-auth clicks and preserves the original private target in a full navigation', async () => {
    const f = browser(); f.runtime.install();
    const event = new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    f.dom.window.document.getElementById('private')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(f.navigations).toEqual([{ url: 'https://adtrender.com/login?code=secret', replace: false }]);
    f.runtime.dispose(); f.dom.window.close();
  });
  it('removes sensitive public history parameters before provider observers can see the new URL', () => {
    const f = browser(); f.runtime.install(); f.runtime.choose('accepted');
    f.dom.window.history.pushState({}, '', '/pricing?email=private@example.test&code=secret#private');
    expect(f.dom.window.location.href).toBe('https://adtrender.com/pricing');
    f.runtime.page(); expect(JSON.stringify(f.data())).not.toMatch(/email|private|secret/);
    f.runtime.dispose(); f.dom.window.close();
  });
  it('uses a fresh document when browser history enters a private route', () => {
    const f = browser(), nativeReplace = f.dom.window.history.replaceState;
    f.runtime.install(); f.runtime.choose('accepted');
    nativeReplace.call(f.dom.window.history, {}, '', '/app?workspace=private');
    f.dom.window.dispatchEvent(new f.dom.window.PopStateEvent('popstate'));
    expect(f.navigations).toEqual([{ url: 'https://adtrender.com/app?workspace=private', replace: true }]);
    expect((f.dom.window as any)['ga-disable-G-TEST123456']).toBe(true);
    f.runtime.dispose(); f.dom.window.close();
  });
  it('also uses a full navigation from a private document to public pages and never loads on private routes', () => {
    const f = browser('/app'); f.runtime.install(); f.runtime.choose('accepted'); f.runtime.start();
    expect(f.scripts()).toEqual([]);
    f.dom.window.history.replaceState({}, '', '/pricing');
    expect(f.dom.window.location.pathname).toBe('/app');
    expect(f.navigations).toEqual([{ url: 'https://adtrender.com/pricing', replace: true }]);
    f.runtime.dispose(); f.dom.window.close();
  });
  it('withdrawal disables GA, stops Clarity, persists refusal and forces a fresh public document', () => {
    const f = browser(); f.runtime.choose('accepted'); f.runtime.start(); f.runtime.choose('rejected');
    expect((f.dom.window as any)['ga-disable-G-TEST123456']).toBe(true);
    expect((f.dom.window as any).clarity.q.map((entry: IArguments) => Array.from(entry))).toContainEqual(['stop']);
    expect(f.runtime.choice()).toBe('rejected');
    expect(f.navigations).toEqual([{ url: 'https://adtrender.com/', replace: true }]);
    f.runtime.dispose(); f.dom.window.close();
  });
  it('keeps Clarity unloaded when its native referrer would expose a path or query', () => {
    const f = browser('/', 'https://external.test/account/private?email=private@example.test'); f.runtime.choose('accepted'); f.runtime.start();
    expect(f.scripts()).toEqual(['https://www.googletagmanager.com/gtag/js?id=G-TEST123456']);
    expect(JSON.stringify(f.data())).not.toMatch(/account|private|email/);
    f.runtime.dispose(); f.dom.window.close();
  });
  it('honors refusal from another tab while provider scripts are still pending', () => {
    const f = browser(); f.runtime.install(); f.runtime.choose('accepted');
    f.dom.window.dispatchEvent(new f.dom.window.StorageEvent('storage', { key: 'adtrender.website-analytics.v2', newValue: 'rejected' }));
    expect(f.runtime.choice()).toBe('rejected'); expect(f.scripts()).toEqual([]);
    expect(f.navigations).toEqual([{ url: 'https://adtrender.com/', replace: true }]);
    f.runtime.dispose(); f.dom.window.close();
  });
});
