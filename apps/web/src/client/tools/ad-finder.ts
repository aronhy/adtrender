import { buildHomeSearchHref } from '../home-search-intent';

export type AdFinderPlatform = 'meta' | 'google' | 'tiktok' | 'pinterest';
export type AdFinderLink = { label: string; url: string; kind: 'official' | 'workspace' };

export const adFinderPlatforms: Record<AdFinderPlatform, { label: string; url: string; workspacePlatform: string }> = {
  meta: { label: 'Meta 广告资料库', url: 'https://www.facebook.com/ads/library/', workspacePlatform: 'facebook' },
  google: { label: 'Google 广告透明度中心', url: 'https://adstransparency.google.com/', workspacePlatform: 'google' },
  tiktok: { label: 'TikTok 商业内容库', url: 'https://library.tiktok.com/ads', workspacePlatform: 'tiktok' },
  pinterest: { label: 'Pinterest 广告资料库', url: 'https://ads.pinterest.com/ads-repository/', workspacePlatform: 'pinterest' },
};

export function adFinderQueryError(query: string): string | null {
  if (!query.trim()) return '请输入品牌或关键词。';
  // Match the existing workspace search's JavaScript string-length limit.
  if (query.trim().length > 200) return '品牌或关键词最多 200 字符。';
  return null;
}

/** Official search parameters are not assumed; keywords can be copied into each library. */
export function adFinderLinks(query: string, platform: AdFinderPlatform): AdFinderLink[] {
  if (adFinderQueryError(query) || !Object.hasOwn(adFinderPlatforms, platform)) return [];
  const selected = adFinderPlatforms[platform];
  return [
    { label: `打开 ${selected.label}`, url: selected.url, kind: 'official' },
    { label: '搜索 AdTrender 已收录广告（需登录及工作区权限）', url: buildHomeSearchHref(new URLSearchParams({ q: query.trim(), platform: selected.workspacePlatform })), kind: 'workspace' },
  ];
}
