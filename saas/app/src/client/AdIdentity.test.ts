// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdvertiserLogo, AdPlatformLogos, PlatformLogo } from './AdIdentity';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('advertiser and publisher identities', () => {
  it('renders all seven logos with the same assets in filters and matched ads', async () => {
    const platforms = ['facebook', 'instagram', 'google', 'youtube', 'tiktok', 'pinterest', 'snapchat'];
    await act(async () => root.render(createElement('div', null,
      createElement('nav', null, ...platforms.map(platform => createElement('button', { key: platform }, createElement(PlatformLogo, { platform, decorative: true }), platform))),
      createElement(AdPlatformLogos, { platforms, unknownLabel: 'Unknown' }))));
    const filters = [...container.querySelectorAll('nav img')];
    const results = [...container.querySelectorAll('.ad-platform-logos img')];
    expect(filters).toHaveLength(7);
    expect(results.map(img => img.getAttribute('src'))).toEqual(filters.map(img => img.getAttribute('src')));
    expect(results.map(img => img.getAttribute('alt'))).toEqual(['Facebook', 'Instagram', 'Google', 'YouTube', 'TikTok', 'Pinterest', 'Snapchat']);
    expect(filters.every(img => img.getAttribute('alt') === '')).toBe(true);
  });
  it('preserves YouTube as the publisher even when Google provides the data', async () => {
    await act(async () => root.render(createElement(AdPlatformLogos, { platforms: ['YOUTUBE'], sourceKey: 'google_ads_transparency', unknownLabel: 'Unknown' })));
    expect(container.querySelector('img')?.alt).toBe('YouTube');
    await act(async () => root.render(createElement(AdPlatformLogos, { platforms: ['SEARCH'], sourceKey: 'google_ads_transparency', unknownLabel: 'Unknown' })));
    expect(container.querySelector('img')?.alt).toBe('Google');
  });
  it('shows both Meta publisher logos and does not guess Facebook from an unknown Meta channel', async () => {
    await act(async () => root.render(createElement(AdPlatformLogos, { platforms: ['Facebook', 'INSTAGRAM', 'facebook'], sourceKey: 'meta_ad_library', unknownLabel: 'Unknown' })));
    expect([...container.querySelectorAll('img')].map(img => img.alt)).toEqual(['Facebook', 'Instagram']);
    await act(async () => root.render(createElement(AdPlatformLogos, { platforms: [], sourceKey: 'meta_ad_library', unknownLabel: 'Unknown' })));
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('Unknown');
  });
  it('uses confirmed single-platform sources for missing channels and preserves other unknown labels', async () => {
    for (const [sourceKey, label] of [['google_ads_transparency', 'Google'], ['tiktok_commercial_library', 'TikTok'], ['pinterest_ads_repository', 'Pinterest']]) {
      await act(async () => root.render(createElement(AdPlatformLogos, { platforms: ['UNKNOWN'], sourceKey, unknownLabel: 'Unknown' })));
      expect(container.querySelector('img')?.alt).toBe(label);
    }
    await act(async () => root.render(createElement(AdPlatformLogos, { platforms: ['OTHER'], sourceKey: 'google_ads_transparency', unknownLabel: 'Unknown' })));
    expect(container.querySelector('img')?.alt).toBe('Google');
    await act(async () => root.render(createElement(AdPlatformLogos, { platforms: ['MESSENGER'], sourceKey: 'meta_ad_library', unknownLabel: 'Unknown' })));
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('MESSENGER');
  });
  it('shows two independent images for the brand and Snapchat platform', async () => {
    await act(async () => root.render(createElement('header', null,
      createElement(AdvertiserLogo, { name: 'SEPHORA', url: 'https://cf-st.sc-cdn.net/d/logo' }),
      createElement(AdPlatformLogos, { platforms: ['SNAPCHAT'], unknownLabel: 'Unknown' }))));
    const images = [...container.querySelectorAll('img')];
    expect(images.map(img => img.alt)).toEqual(['SEPHORA logo', 'Snapchat']);
    expect(images[0].getAttribute('src')).toBe('https://cf-st.sc-cdn.net/d/logo');
    expect(images[1].getAttribute('src')).toBe('/platforms/snapchat.svg');
  });
  it('keeps the platform visible when the brand logo fails, and retries a different source', async () => {
    const view = (url: string) => createElement('header', null, createElement(AdvertiserLogo, { name: 'SEPHORA', url }), createElement(AdPlatformLogos, { platforms: ['Snapchat'], unknownLabel: 'Unknown' }));
    await act(async () => root.render(view('https://cdn.example/old')));
    await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.textContent).toContain('S');
    expect(container.querySelector('img')?.alt).toBe('Snapchat');
    await act(async () => root.render(view('https://cdn.example/new')));
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/new');
  });
  it('normalizes and deduplicates platform labels and falls back to the confirmed source', async () => {
    await act(async () => root.render(createElement(AdPlatformLogos, { platforms: [' snapchat ', 'Snapchat'], unknownLabel: 'Unknown' })));
    expect(container.querySelectorAll('img')).toHaveLength(1);
    await act(async () => root.render(createElement(AdPlatformLogos, { platforms: [], sourceKey: 'snapchat_ads_gallery', unknownLabel: 'Unknown' })));
    expect(container.querySelector('img')?.alt).toBe('Snapchat');
    await act(async () => root.render(createElement(AdPlatformLogos, { platforms: [], unknownLabel: 'Unknown' })));
    expect(container.textContent).toBe('Unknown');
    expect(container.querySelector('img')).toBeNull();
  });
  it('does not treat a missing or unsafe brand URL as a platform logo', async () => {
    await act(async () => root.render(createElement(AdvertiserLogo, { name: 'SEPHORA', url: 'javascript:alert(1)' })));
    expect(container.textContent).toBe('S');
    expect(container.querySelector('img')).toBeNull();
  });
});
