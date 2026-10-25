import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { freeTools, freeToolPaths, getFreeTool, isFreeToolPath } from './free-tools';
import { publicPage } from '../client/site-analytics/analytics';
import { consentInput, eventInput } from '../growth/contract';

const legacySlugs = ['roas-calculator', 'ecommerce-profit-calculator', 'profit-margin-calculator', 'roi-calculator', 'customer-lifetime-value-calculator', 'shopify-cost-calculator', 'hook-generator', 'ad-finder'];
const readyPaths = ['/tools', '/tools/guide', '/tools/roas-calculator', '/tools/ecommerce-profit-calculator', '/tools/profit-margin-calculator', '/tools/roi-calculator', '/tools/customer-lifetime-value-calculator', '/tools/shopify-cost-calculator', '/tools/cpa-calculator', '/tools/traffic-goal-calculator', '/tools/ad-budget-calculator', '/tools/hook-generator', '/tools/ad-finder', '/tools/utm-link-builder', '/tools/privacy-policy-generator', '/tools/refund-policy-generator', '/tools/terms-and-conditions-generator', '/tools/returns-policy-generator', '/tools/shipping-policy-generator'];
const nonce = 'c5712813-5554-4c30-a3b7-f8244c936def';

function crawled(path: string) {
  const robots = readFileSync(new URL('../../public/robots.txt', import.meta.url), 'utf8');
  const matches = [...robots.matchAll(/^(Allow|Disallow): (.+)$/gm)].flatMap(([, type, rule]) => {
    const regex = new RegExp(`^${rule!.split('*').map(value => value.replace(/[.+?^{}()|[\]\\]/g, '\\$&')).join('.*')}`);
    return regex.test(path) ? [{ type, length: rule!.replace(/\$$/, '').length }] : [];
  }).sort((a, b) => b.length - a.length || (a.type === 'Allow' ? -1 : 1));
  return matches[0]?.type === 'Allow';
}

describe('free-tool discoverability contracts', () => {
  it('has exactly seventeen ready tools and nineteen public paths across analytics and crawl discovery', () => {
    expect(freeTools.filter(tool => tool.status === 'ready')).toHaveLength(17);
    expect(freeTools.filter(tool => tool.status === 'planned')).toHaveLength(6);
    expect(new Set(freeTools.map(tool => tool.slug)).size).toBe(23);
    expect(freeToolPaths).toEqual(readyPaths);
    expect(new Set(freeToolPaths).size).toBe(19);
    const sitemap = readFileSync(new URL('../../public/sitemap.xml', import.meta.url), 'utf8');
    const toolUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, value]) => new URL(value!)).filter(url => url.pathname.startsWith('/tools'));
    expect(toolUrls.map(url => url.href)).toEqual(readyPaths.map(path => `https://adtrender.com${path}`));
    for (const path of readyPaths) {
      expect(publicPage(`https://adtrender.com${path}`)?.path).toBe(path);
      expect(consentInput.safeParse({ choice: 'accepted', attribution: { landingPath: path } }).success).toBe(true);
      expect(eventInput.safeParse({ name: 'PAGE_VIEW', pathname: path, requestNonce: nonce }).success).toBe(true);
      expect(crawled(path)).toBe(true);
    }
  });
  it('preserves all eight original slugs and their public URLs', () => {
    for (const slug of legacySlugs) {
      expect(getFreeTool(slug)?.status).toBe('ready');
      expect(freeToolPaths).toContain(`/tools/${slug}`);
      expect(isFreeToolPath(`/tools/${slug}`)).toBe(true);
      expect(publicPage(`https://adtrender.com/tools/${slug}`)?.path).toBe(`/tools/${slug}`);
    }
  });
  it('allows the bundled tool fonts and icons while keeping assets outside page analytics', () => {
    for (const path of ['/free-tools/assets/fonts/poppins-700.woff', '/free-tools/assets/icons/phosphor/regular/check.svg']) {
      expect(crawled(path)).toBe(true);
      expect(isFreeToolPath(path)).toBe(false);
      expect(publicPage(`https://adtrender.com${path}`)).toBeNull();
    }
  });
  it('uses one page component for the directory, guide and original dynamic route', () => {
    const routes = readFileSync(new URL('../../main.wasp.ts', import.meta.url), 'utf8');
    expect(routes).toContain("route('ToolsIndexRoute','/tools',page(FreeToolsPage))");
    expect(routes).toContain("route('FreeToolsGuideRoute','/tools/guide',page(FreeToolsPage))");
    expect(routes).toContain("route('FreeToolRoute','/tools/:slug',page(FreeToolsPage))");
  });
  it('keeps planned, unknown and noncanonical tool routes outside public contracts', () => {
    for (const path of [...freeTools.filter(tool => tool.status === 'planned').map(tool => `/tools/${tool.slug}`), '/tools/evil', '/tools/', '/tools/guide/', '/tools/roas-calculator/', '/tools/privacy-policy-generator/', '/tools/ad-finder?brand=PRIVATE', '/tools/ad-finder#PRIVATE']) {
      expect(isFreeToolPath(path)).toBe(false);
      expect(consentInput.safeParse({ choice: 'accepted', attribution: { landingPath: path } }).success).toBe(false);
      expect(eventInput.safeParse({ name: 'PAGE_VIEW', pathname: path, requestNonce: nonce }).success).toBe(false);
      if (!/[?#]/.test(path)) {
        expect(publicPage(`https://adtrender.com${path}`)).toBeNull();
        expect(crawled(path)).toBe(false);
      }
    }
    for (const path of ['/login', '/signup', '/app', '/app/ads', '/auth/google/callback']) expect(crawled(path)).toBe(false);
  });
});
