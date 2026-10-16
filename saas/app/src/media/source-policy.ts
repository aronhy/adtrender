import { META_MEDIA_HOSTS, MEDIA_MAX_BYTES, MEDIA_MIME_TYPES, type AllowedHost, type DownloadOptions } from './download';

type CreativeRule = { sourceKey: string; type: 'IMAGE' | 'VIDEO'; hostname: string; includeSubdomains?: boolean; pathPattern: string };

// Deliberately exact: these source hosts and creative paths were observed in
// imported ads. Avatar CDNs, HTML templates and watch pages are not media files.
const creativeRules: readonly CreativeRule[] = [
  { sourceKey: 'pinterest_ads_repository', type: 'IMAGE', hostname: 'i.pinimg.com', pathPattern: '^/([A-Za-z0-9_-]+/)+[A-Za-z0-9_-]+[.](jpg|jpeg|png|webp|gif)$' },
  // Public Pinterest Pin 564638872038308533 exposes this complete MP4 shape;
  // its CDN response was verified as video/mp4 with an MP4 ftyp signature.
  { sourceKey: 'pinterest_ads_repository', type: 'VIDEO', hostname: 'v.pinimg.com', pathPattern: '^/videos/mc/[0-9]+p/([a-f0-9]{2}/){3}[a-f0-9]{32}[.]mp4$' },
  { sourceKey: 'google_ads_transparency', type: 'IMAGE', hostname: 'tpc.googlesyndication.com', pathPattern: '^/archive/simgad/[0-9]+$' },
  ...['i.ytimg.com', 'i3.ytimg.com'].map(hostname => ({ sourceKey: 'google_ads_transparency', type: 'IMAGE' as const, hostname, pathPattern: '^/vi/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+[.](jpg|jpeg|png|webp)$' })),
  { sourceKey: 'google_ads_transparency', type: 'VIDEO', hostname: 'googlevideo.com', includeSubdomains: true, pathPattern: '^/videoplayback$' },
  { sourceKey: 'tiktok_commercial_library', type: 'VIDEO', hostname: 'library.tiktok.com', pathPattern: '^/api/v1/cdn/[0-9]+/video/[A-Za-z0-9_+/=-]+/[A-Za-z0-9-]+$' },
  // Exact buckets observed in ad image groups. Expired links stay FAILED;
  // only a complete, signature-checked image can become READY.
  { sourceKey: 'tiktok_commercial_library', type: 'IMAGE', hostname: 'p16-common-sign.tiktokcdn.com', pathPattern: '^/(tos-useast2a-i-photomode-euttp|tos-no1a-i-photomode-no|ad-site-i18n-sg|tos-alisg-i-photomode-sg|tos-no1a-i-t5fjg24jzw-no)/[a-f0-9]{32}~tplv-tiktokx-origin[.]jpeg$' },
  // Public Ads Gallery responses separate /d/ creative/product files from
  // /aps/bolt profile avatars and HTML rendering templates on other hosts.
  ...(['IMAGE', 'VIDEO'] as const).map(type => ({ sourceKey: 'snapchat_ads_gallery', type, hostname: 'cf-st.sc-cdn.net', pathPattern: '^/d/[A-Za-z0-9_-]+[.][0-9]+$' })),
];

export function mediaDownloadPolicy(sourceKey: string, type: string): DownloadOptions | null {
  const timeoutMs = type === 'VIDEO' ? 90_000 : 20_000;
  if (sourceKey === 'meta_ad_library') return { allowedHosts: META_MEDIA_HOSTS, allowedMimeTypes: MEDIA_MIME_TYPES, maxBytes: MEDIA_MAX_BYTES, timeoutMs };
  const rules = creativeRules.filter(rule => rule.sourceKey === sourceKey && rule.type === type);
  if (!rules.length) return null;
  const allowedHosts: AllowedHost[] = rules.map(({ hostname, includeSubdomains, pathPattern }) => ({ hostname, includeSubdomains, pathPattern }));
  if (sourceKey === 'tiktok_commercial_library' && type === 'VIDEO') {
    // Real library responses move between v16m and v77 nodes. Source-verified
    // redirects may follow that platform-owned CDN, with the same file path,
    // public DNS, MIME and byte checks; direct node URLs are never candidates.
    allowedHosts.push({ hostname: 'tiktokcdn.com', includeSubdomains: true, redirectOnly: true, pathPattern: '^/[a-f0-9]{32}/[a-f0-9]{8}/video/tos/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/$' });
  }
  return {
    allowedHosts,
    allowedMimeTypes: MEDIA_MIME_TYPES.filter(mime => mime.startsWith(type === 'IMAGE' ? 'image/' : 'video/')),
    maxBytes: MEDIA_MAX_BYTES, timeoutMs,
  };
}

// A bound JSON value feeds the worker's SQL eligibility check. Use the same
// exact rules as downloads so unsupported old rows cannot block the queue.
export const adapterPendingRules = creativeRules.map(({ sourceKey, type, hostname, includeSubdomains, pathPattern }) => ({
  sourceKey, type,
  urlPattern: `^https://${includeSubdomains ? '([a-z0-9-]+[.])*' : ''}${hostname.replaceAll('.', '[.]')}${pathPattern.slice(1, -1)}([?][A-Za-z0-9%_.~!$&'()*+,;=:@/?-]*)?$`,
}));
