import { describe, expect, it } from 'vitest';
import { adFinderLinks } from './ad-finder';

describe('official ad library navigation', () => {
  it.each(['', ' \n '])('does not produce navigation for an empty query %j', query => {
    expect(adFinderLinks(query, 'meta')).toEqual([]);
  });
  it('accepts a 200 character query and rejects 201 characters without truncation', () => {
    expect(adFinderLinks('字'.repeat(200), 'meta')).toHaveLength(2);
    expect(adFinderLinks('字'.repeat(201), 'meta')).toEqual([]);
    expect(adFinderLinks('😀'.repeat(100), 'meta')).toHaveLength(2);
    expect(adFinderLinks('😀'.repeat(101), 'meta')).toEqual([]);
  });
  it.each([
    ['meta', 'https://www.facebook.com/ads/library/', 'facebook'],
    ['google', 'https://adstransparency.google.com/', 'google'],
    ['tiktok', 'https://library.tiktok.com/ads', 'tiktok'],
    ['pinterest', 'https://ads.pinterest.com/ads-repository/', 'pinterest'],
  ] as const)('offers the fixed %s official entry and separately labels the workspace', (platform, officialUrl, workspacePlatform) => {
    const links = adFinderLinks('shoes', platform);
    expect(links.find(link => link.kind === 'official')?.url).toBe(officialUrl);
    expect(links.find(link => link.kind === 'workspace')).toMatchObject({ url: `/app/ads?q=shoes&platform=${workspacePlatform}` });
    expect(links.find(link => link.kind === 'workspace')?.label).toContain('AdTrender');
  });
  it('encodes reserved characters as one query value on the existing workspace route', () => {
    const links = adFinderLinks('  & ? # 中文  ', 'google');
    expect(links.find(link => link.kind === 'workspace')?.url).toBe('/app/ads?q=%26+%3F+%23+%E4%B8%AD%E6%96%87&platform=google');
    expect(links.find(link => link.kind === 'official')?.url).toBe('https://adstransparency.google.com/');
  });
  it.each(['https://evil.test/admin?workspace=secret', '//evil.test', 'javascript:alert(1)', '<script>alert(1)</script>'])('cannot inject a redirect target with %s', query => {
    const links = adFinderLinks(query, 'meta');
    expect(links).toHaveLength(2);
    const official = new URL(links.find(link => link.kind === 'official')!.url);
    const workspace = new URL(links.find(link => link.kind === 'workspace')!.url, 'https://adtrender.example');
    expect(official.hostname).toBe('www.facebook.com');
    expect(workspace.origin).toBe('https://adtrender.example');
    expect(workspace.pathname).toBe('/app/ads');
    expect([...workspace.searchParams.keys()]).toEqual(['q', 'platform']);
    expect(workspace.searchParams.get('q')).toBe(query);
  });
  it('rejects unknown platform values rather than converting them into a destination', () => {
    expect(adFinderLinks('shoes', 'https://evil.test' as 'meta')).toEqual([]);
  });
});
