import { describe, expect, it } from 'vitest';
import { isMediaUrlAllowed } from './download';
import { adapterPendingRules, mediaDownloadPolicy } from './source-policy';

const creativeSamples = [
  ['snapchat_ads_gallery', 'VIDEO', 'https://cf-st.sc-cdn.net/d/1oVXl3SGc2CUwdXIWEVIN.67?token=synthetic'],
  ['snapchat_ads_gallery', 'IMAGE', 'https://cf-st.sc-cdn.net/d/cH2MlwPoqnYoek6dFzQ7U.385'],
  ['snapchat_ads_gallery', 'IMAGE', 'https://cf-st.sc-cdn.net/d/KRvdWssx1Z2fhF5eLXIlM.1023'],
  ['google_ads_transparency', 'VIDEO', 'https://rr5---sn-a5mekn6z.googlevideo.com/videoplayback?expire=1790000000&id=synthetic'],
  ['pinterest_ads_repository', 'VIDEO', 'https://v.pinimg.com/videos/mc/720p/19/a9/95/19a995a4ff00397bf8f88cbb0b86ffd0.mp4'],
  ...['tos-useast2a-i-photomode-euttp','tos-no1a-i-photomode-no','ad-site-i18n-sg','tos-alisg-i-photomode-sg','tos-no1a-i-t5fjg24jzw-no'].map(bucket => ['tiktok_commercial_library', 'IMAGE', `https://p16-common-sign.tiktokcdn.com/${bucket}/${'a'.repeat(32)}~tplv-tiktokx-origin.jpeg?x-expires=1790000000`] as const),
] as const;

describe('creative source policy', () => {
  it.each(creativeSamples)('accepts the public file shape for %s %s', (sourceKey, type, url) => {
    const policy = mediaDownloadPolicy(sourceKey, type);
    expect(policy).not.toBeNull();
    expect(isMediaUrlAllowed(url, policy?.allowedHosts ?? [])).toBe(true);
  });

  it.each(creativeSamples)('makes adapter-pending public files eligible for %s %s', (sourceKey, type, url) => {
    const eligible = adapterPendingRules.some(rule => rule.sourceKey === sourceKey && rule.type === type && new RegExp(rule.urlPattern).test(url));
    expect(eligible).toBe(true);
  });

  it.each([
    ['snapchat_ads_gallery', 'IMAGE', 'https://cf-st.sc-cdn.net/aps/bolt/profile-avatar'],
    ['snapchat_ads_gallery', 'VIDEO', 'https://ads-interfaces.sc-cdn.net/d/template.67'],
    ['snapchat_ads_gallery', 'VIDEO', 'https://cf-st.sc-cdn.net/d/template.html'],
    ['snapchat_ads_gallery', 'VIDEO', 'https://cf-st.sc-cdn.net.evil.test/d/asset.67'],
    ['google_ads_transparency', 'VIDEO', 'https://www.youtube.com/watch?v=AbCdEf12345'],
    ['google_ads_transparency', 'VIDEO', 'https://rr5---sn-a5mekn6z.googlevideo.com/player'],
    ['google_ads_transparency', 'VIDEO', 'https://rr5---sn-a5mekn6z.googlevideo.com.evil.test/videoplayback'],
    ['pinterest_ads_repository', 'VIDEO', 'https://v.pinimg.com/videos/mc/hls/19/a9/95/19a995a4ff00397bf8f88cbb0b86ffd0.m3u8'],
    ['pinterest_ads_repository', 'VIDEO', 'https://v.pinimg.com/profile/avatar.mp4'],
    ['pinterest_ads_repository', 'VIDEO', 'https://v.pinimg.com/videos/mc/720p/19/a9/95/template.html'],
    ['tiktok_commercial_library', 'IMAGE', 'https://p16-common-sign.tiktokcdn.com/tos-alisg-avt-0068/avatar~tplv-tiktokx-cropcenter:168:168.jpeg'],
  ])('rejects non-creative source %s %s %s', (sourceKey, type, url) => {
    const policy = mediaDownloadPolicy(sourceKey, type);
    expect(isMediaUrlAllowed(url, policy?.allowedHosts ?? [])).toBe(false);
    expect(adapterPendingRules.some(rule => rule.sourceKey === sourceKey && rule.type === type && new RegExp(rule.urlPattern).test(url))).toBe(false);
  });

  it('preserves an unsupported media type instead of expanding all platform URLs', () => {
    expect(mediaDownloadPolicy('snapchat_ads_gallery', 'HTML')).toBeNull();
    expect(mediaDownloadPolicy('unknown_source', 'VIDEO')).toBeNull();
  });

  it.each(['meta_ad_library', 'google_ads_transparency', 'snapchat_ads_gallery', 'pinterest_ads_repository', 'tiktok_commercial_library'])('gives %s video files time to complete without extending image transfers', sourceKey => {
    expect(mediaDownloadPolicy(sourceKey, 'VIDEO')?.timeoutMs).toBe(90_000);
    expect(mediaDownloadPolicy(sourceKey, 'IMAGE')?.timeoutMs).toBe(20_000);
  });
});
