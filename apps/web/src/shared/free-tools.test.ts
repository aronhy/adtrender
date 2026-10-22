import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { freeTools, freeToolPaths, isFreeToolPath } from './free-tools';
import { publicPage } from '../client/site-analytics/analytics';
import { consentInput, eventInput } from '../growth/contract';

const readyPaths = ['/tools', '/tools/roas-calculator', '/tools/ecommerce-profit-calculator', '/tools/profit-margin-calculator', '/tools/roi-calculator', '/tools/customer-lifetime-value-calculator', '/tools/shopify-cost-calculator', '/tools/hook-generator', '/tools/ad-finder'];
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
  it('has exactly eight ready tools and exposes their exact public paths across analytics and crawl discovery', () => {
    expect(freeTools.filter(tool => tool.status === 'ready')).toHaveLength(8);
    expect(freeTools.filter(tool => tool.status === 'planned')).toHaveLength(6);
    expect(new Set(freeTools.map(tool => tool.slug)).size).toBe(14);
    expect(freeToolPaths).toEqual(readyPaths);
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
  it('keeps planned, unknown and noncanonical tool routes outside public contracts', () => {
    for (const path of [...freeTools.filter(tool => tool.status === 'planned').map(tool => `/tools/${tool.slug}`), '/tools/evil', '/tools/', '/tools/roas-calculator/', '/tools/ad-finder?brand=PRIVATE', '/tools/ad-finder#PRIVATE']) {
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
