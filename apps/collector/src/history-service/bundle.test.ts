import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, type BrowserContext, type Route } from 'playwright';
import { beforeAll, describe, expect, it } from 'vitest';
import type { collectTarget } from './collector';
import type { Target } from './types';

// Bundling all source parsers together changes their local function names.
// Source-module tests cannot verify the functions serialized into the browser.
const suite = process.env.HISTORY_BROWSER_TESTS === '1' ? describe : describe.skip;
suite('history collector bundled offline smoke', () => {
  let collect: typeof collectTarget;
  beforeAll(async () => {
    const output = await build({
      entryPoints: ['apps/collector/src/history-service/collector.ts'],
      bundle: true, platform: 'node', target: 'node24', format: 'esm',
      external: ['playwright', '@prisma/client'], write: false,
    });
    // A data URL has no node_modules parent; only resolve the external runtime
    // import. The bundled parser declarations remain exactly as emitted.
    const require = createRequire(import.meta.url);
    const playwright = pathToFileURL(join(dirname(require.resolve('playwright/package.json')), 'index.mjs')).href;
    const code = output.outputFiles[0].text.replaceAll('from "playwright"', 'from ' + JSON.stringify(playwright));
    const bundled = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64')) as { collectTarget: typeof collectTarget };
    collect = bundled.collectTarget;
  });

  async function context(handler: (route: Route) => Promise<unknown>): Promise<BrowserContext> {
    const browser = await chromium.launch({ channel: process.env.HISTORY_TEST_CHANNEL ?? 'chromium', headless: true, chromiumSandbox: true });
    const result = await browser.newContext({ locale: 'en-US' });
    result.on('close', () => { void browser.close().catch(() => {}); });
    await result.route('**/*', handler);
    return result;
  }
  const target = (sourceKey: Target['sourceKey'], sourceAdId: string, sourceUrl: string): Target => ({
    sourceKey, sourceAdId, sourceUrl, adId: 'bundle-synthetic', country: 'DE',
    attemptId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    leaseToken: '11111111-2222-3333-4444-555555555555',
    leaseUntil: new Date(Date.now() + 600000).toISOString(), publisherPlatforms: [],
    discoveryQuery: { country: 'DE', startDate: '2026-10-01', endDate: '2026-10-07' },
  });
  const options = (html: string | ((url: string) => string)) => ({
    settleMs: 0, maxMs: 15000,
    createContext: () => context(route => route.fulfill({
      status: 200, contentType: 'text/html',
      body: typeof html === 'function' ? html(route.request().url()) : html,
    })),
  });
  const metaHtml = readFileSync('apps/collector/src/fixtures/meta-cards.synthetic.html', 'utf8');
  const tikTokHtml = readFileSync('apps/collector/src/tiktok-service/fixtures/detail.redacted.html', 'utf8').replace(/<video[\s\S]*?<\/video>/g, '');
  const tikTokId = tikTokHtml.match(/Ad ID\s*[:：]\s*(\d{5,})/)![1];
  const googleUrl = 'https://adstransparency.google.com/advertiser/AR123456/creative/CR123456';
  const googleDetail = '<creative-details><div class="advertiser-name">Synthetic</div><p>Format: Text</p><creative><p>Current observed copy</p></creative></creative-details>';

  it('bundles Meta exact detail parsing', async () => {
    const result = await collect(target('meta_ad_library', '100001', 'https://www.facebook.com/ads/library/?id=100001'), options(metaHtml));
    expect(result).toMatchObject({ outcome: 'OBSERVED', batch: { ads: [{ sourceAdId: '100001' }] } });
  });
  it('bundles TikTok exact detail parsing', async () => {
    const result = await collect(target('tiktok_commercial_library', tikTokId, 'https://library.tiktok.com/ads/detail/?ad_id=' + tikTokId), options(tikTokHtml));
    expect(result).toMatchObject({ outcome: 'OBSERVED', batch: { ads: [{ sourceAdId: tikTokId }] } });
  });
  it('bundles Pinterest exact detail parsing', async () => {
    const html = readFileSync('apps/collector/src/pinterest/detail.fixture.html', 'utf8');
    const result = await collect(target('pinterest_ads_repository', '123456', 'https://ads.pinterest.com/ads-repository/123456/'), options(html));
    expect(result).toMatchObject({ outcome: 'OBSERVED', batch: { ads: [{ body: null, headline: null, sourceFields: { 'Advertiser name': 'Nike' } }] } });
  });
  it('bundles Google current platform listing and detail parsing', async () => {
    const listing = '<button aria-label="Platform filter button: selected Google Search"></button><creative-preview><a href="' + googleUrl + '">Current creative</a></creative-preview>';
    const result = await collect({ ...target('google_ads_transparency', 'CR123456', googleUrl), publisherPlatforms: ['SEARCH'] }, options(url => url.includes('/creative/') ? googleDetail : listing));
    expect(result).toMatchObject({ outcome: 'OBSERVED', batch: { ads: [{ sourceAdId: 'CR123456', sourceStatus: 'UNKNOWN', body: 'Current observed copy' }] } });
    expect(result.batch?.evidence.find((e: { kind: string }) => e.kind === 'listing').html).toContain(googleUrl);
  });
  it('bundles Snapchat native exact detail parsing', async () => {
    const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const result = await collect(target('snapchat_ads_gallery', id, 'https://adsgallery.snap.com/?adId=' + id), {
      request: async () => new Response(JSON.stringify({ request_status: 'SUCCESS', ad_preview: { id, paying_advertiser_name: 'Synthetic', status: 'ACTIVE' } }), { headers: { 'content-type': 'application/json' } }),
    });
    expect(result).toMatchObject({ outcome: 'OBSERVED', batch: { ads: [{ sourceAdId: id, sourceStatus: 'ACTIVE' }] } });
  });
  it('does not accept a hidden cached Google anchor as current listing evidence', async () => {
    const listing = '<button aria-label="Platform filter button: selected Google Search"></button><p>CR123456</p><creative-preview hidden><a href="' + googleUrl + '">Cached creative</a></creative-preview>';
    const result = await collect({ ...target('google_ads_transparency', 'CR123456', googleUrl), publisherPlatforms: ['SEARCH'] }, options(url => url.includes('/creative/') ? googleDetail : listing));
    expect(result.outcome).toBe('NOT_OBSERVED');
    expect(result.batch).toBeUndefined();
  });
  it('rejects TikTok navigation away from the fixed public library', async () => {
    let unrelatedRequests = 0;
    const result = await collect(target('tiktok_commercial_library', tikTokId, 'https://library.tiktok.com/ads/detail/?ad_id=' + tikTokId), {
      settleMs: 0, maxMs: 2000,
      createContext: () => context(route => {
        if (new URL(route.request().url()).origin === 'https://library.tiktok.com') {
          return route.fulfill({ status: 200, contentType: 'text/html', body: '<script>location.replace("https://shop.example/redirected")</script>' });
        }
        unrelatedRequests++;
        return route.fulfill({ status: 200, contentType: 'text/html', body: tikTokHtml });
      }),
    });
    expect(unrelatedRequests).toBe(0);
    expect(result.outcome).toBe('FAILED');
    expect(result.batch).toBeUndefined();
  });
});
