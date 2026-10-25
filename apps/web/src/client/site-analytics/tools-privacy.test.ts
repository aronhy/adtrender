import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { createSiteAnalytics, publicPage, safeAttribution, safePublicAddress } from './analytics';
import { createGrowthCapture } from './growth';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const tool = '/tools/roas-calculator';
function fixture(path = tool, referrer = '') {
  const dom = new JSDOM('<!doctype html><html><head></head><body><input value="PRIVATE-HOOK"><a href="/signup">Sign up</a></body></html>', { url: `https://adtrender.com${path}`, ...(referrer ? { referrer } : {}) });
  const navigations: Array<{ url: string; replace: boolean }> = [];
  const requests: Array<{ path: string; body: any }> = [];
  dom.window.fetch = async (path: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string); requests.push({ path, body });
    return { ok: true, json: async () => path.endsWith('/consent') ? { consent: body.choice, recording: body.choice === 'accepted' } : { recorded: true } };
  };
  const runtime = createSiteAnalytics(dom.window, { ga4: 'G-TEST123456', clarity: 'abc123xyz', growth: true }, (url, replace) => navigations.push({ url, replace }));
  const data = () => dom.window.dataLayer?.map((entry: IArguments) => Array.from(entry)) ?? [];
  return { dom, runtime, navigations, requests, data };
}

describe('free-tool analytics privacy', () => {
  it('uses only the canonical registered tool URL and drops every query attribution field', () => {
    const url = `https://adtrender.com${tool}?revenue=87654.321&hook=PRIVATE-HOOK&brand=PRIVATE-BRAND&utm_source=privatebrand#PRIVATE-RESULT`;
    expect(publicPage(url)).toEqual({ path: tool, title: 'AdTrender · ROAS 与盈亏平衡计算器', url: `https://adtrender.com${tool}` });
    expect(safePublicAddress(url)).toBe(`https://adtrender.com${tool}`);
    expect(safeAttribution(url, 'https://external.test/search?brand=PRIVATE-BRAND')).toEqual({ page_referrer: 'https://external.test/' });
  });
  it('sends only first-party events after consent without loading third-party scripts or sending input', async () => {
    const f = fixture(`${tool}?revenue=87654.321&hook=PRIVATE-HOOK&brand=PRIVATE-BRAND&utm_source=privatebrand#PRIVATE-RESULT`, 'https://external.test/search?brand=PRIVATE-BRAND');
    try {
      f.runtime.install(); f.runtime.choose('accepted'); await f.runtime.growth!.flush();
      expect(f.dom.window.document.scripts.length).toBe(0);
      expect(f.dom.window.clarity).toBeUndefined();
      expect(f.dom.window.gtag).toBeUndefined();
      expect(f.dom.window.location.href).toBe(`https://adtrender.com${tool}`);
      expect(f.requests.map(row => row.body.choice ?? row.body.name)).toEqual(['accepted', 'PAGE_VIEW']);
      expect(f.requests[0]!.body.attribution).toEqual({ landingPath: tool, referrerOrigin: 'https://external.test' });
      expect(f.data()).toEqual([]);
      expect(JSON.stringify([f.requests, f.data()])).not.toMatch(/87654\.321|PRIVATE|privatebrand|revenue|hook=|brand=/);
    } finally { f.runtime.dispose(); f.dom.window.close(); }
  });
  it('keeps tool-to-tool navigation in one document with canonical first-party pageviews', async () => {
    const f = fixture();
    try {
      f.runtime.install(); f.runtime.choose('accepted');
      f.dom.window.history.pushState({}, '', '/tools/hook-generator?product=PRIVATE-HOOK#PRIVATE-RESULT'); f.runtime.page();
      await f.runtime.growth!.flush();
      expect(f.navigations).toEqual([]);
      expect(f.dom.window.location.href).toBe('https://adtrender.com/tools/hook-generator');
      expect(f.requests.filter(row => row.body.name === 'PAGE_VIEW').map(row => row.body.pathname)).toEqual([tool, '/tools/hook-generator']);
      expect(f.data()).toEqual([]);
      expect(f.dom.window.document.scripts.length).toBe(0);
      expect(f.dom.window.clarity).toBeUndefined();
      expect(JSON.stringify([f.requests, f.data()])).not.toContain('PRIVATE');
    } finally { f.runtime.dispose(); f.dom.window.close(); }
  });
  it.each([
    ['/', '/tools/hook-generator?product=PRIVATE-HOOK#PRIVATE-RESULT', 'https://adtrender.com/tools/hook-generator'],
    [tool, '/pricing?revenue=PRIVATE-RESULT', 'https://adtrender.com/pricing'],
    [tool, '/login?returnTo=%2Fapp&code=business-token', 'https://adtrender.com/login?returnTo=%2Fapp&code=business-token'],
    ['/login', tool, `https://adtrender.com${tool}`],
    ['/app', tool, `https://adtrender.com${tool}`],
    [tool, '/tools/evil', 'https://adtrender.com/tools/evil'],
    [tool, '/tools/roas-calculator/', 'https://adtrender.com/tools/roas-calculator/'],
  ])('requires a new document from %s to %s', async (from, to, expected) => {
    const f = fixture(from);
    try {
      f.runtime.install(); f.runtime.choose('accepted');
      if (from === '/') expect(f.dom.window.clarity).toBeDefined();
      expect(f.runtime.mustReload(to)).toBe(true);
      f.dom.window.history.pushState({}, '', to); await f.runtime.growth!.handoff();
      expect(f.dom.window.location.pathname).toBe(from);
      expect(f.navigations).toEqual([{ url: expected, replace: false }]);
      expect(f.dom.window.document.scripts.length).toBe(0);
    } finally { f.runtime.dispose(); f.dom.window.close(); }
  });
  it('allows tool use after rejection and revokes first-party consent before a fresh-document reload', async () => {
    const f = fixture();
    try {
      f.runtime.install(); f.runtime.choose('rejected'); f.runtime.start(); await f.runtime.growth!.flush();
      expect(f.dom.window.document.querySelector('input')!.value).toBe('PRIVATE-HOOK');
      expect(f.dom.window.document.scripts.length).toBe(0);
      expect(f.requests.some(row => row.body.name)).toBe(false);
      f.runtime.choose('accepted'); await f.runtime.growth!.flush();
      f.runtime.choose('rejected'); await f.runtime.growth!.flush();
      expect(f.dom.window.gtag).toBeUndefined();
      expect(f.dom.window.document.scripts.length).toBe(0);
      expect(f.navigations).toEqual([{ url: `https://adtrender.com${tool}`, replace: true }]);
      expect(f.requests.at(-1)!.body).toEqual({ choice: 'rejected' });
    } finally { f.runtime.dispose(); f.dom.window.close(); }
  });
  it('never enables an unused third-party-only configuration on tool documents', () => {
    const f = fixture();
    const runtime = createSiteAnalytics(f.dom.window, { ga4: 'G-TEST123456', clarity: 'abc123xyz' });
    try {
      runtime.choose('accepted'); runtime.start();
      expect(runtime.enabled()).toBe(false);
      expect(f.dom.window.document.scripts.length).toBe(0);
      expect(f.dom.window.gtag).toBeUndefined();
      expect(f.dom.window.clarity).toBeUndefined();
    } finally { f.dom.window.close(); }
  });
  it('records a tool signup CTA without collecting tool state or the authentication query', async () => {
    const f = fixture('/tools/ad-finder?brand=PRIVATE-BRAND');
    try {
      f.runtime.install(); f.runtime.choose('accepted');
      const anchor = f.dom.window.document.querySelector('a')!;
      anchor.href = '/signup?code=PRIVATE-TOKEN';
      anchor.dispatchEvent(new f.dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      await f.runtime.growth!.flush();
      expect(f.requests.map(row => row.body.choice ?? row.body.name)).toEqual(['accepted', 'PAGE_VIEW', 'CTA_CLICK']);
      expect(f.requests.at(-1)!.body).toMatchObject({ name: 'CTA_CLICK', pathname: '/tools/ad-finder', target: 'signup' });
      expect(JSON.stringify(f.requests)).not.toContain('PRIVATE');
      expect(f.dom.window.document.scripts.length).toBe(0);
    } finally { f.runtime.dispose(); f.dom.window.close(); }
  });
  it('admits exact registered tool events and refuses unknown, planned and parameterized paths', async () => {
    const f = fixture();
    const capture = createGrowthCapture(f.dom.window, { landingPath: tool });
    try {
      capture.start();
      for (const path of [tool, '/tools', '/tools/evil', `${tool}/`, `${tool}?revenue=12345`, '/tools/shopify-app-detector']) capture.event('PAGE_VIEW', path);
      await capture.flush();
      expect(f.requests.filter(row => row.body.name).map(row => row.body.pathname)).toEqual([tool, '/tools']);
    } finally { f.dom.window.close(); }
  });
});
