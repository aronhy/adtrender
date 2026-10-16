import { describe, expect, it } from 'vitest';
import { publicAdvertiserAvatar } from './advertiser-avatar';

describe('public advertiser logo', () => {
  const logo = 'https://cf-st.sc-cdn.net/d/brand-logo';
  it('prefers an observed advertiser avatar over an older per-ad logo', () => {
    expect(publicAdvertiserAvatar({ advertiser: { fieldProvenance: { avatarUrl: { value: logo } } }, fieldProvenance: { advertiserAvatarUrl: { value: 'https://cdn.example/old' } } })).toBe(logo);
  });
  it('reads a Snapchat logo from an existing native observation without exposing the raw snapshot', () => {
    expect(publicAdvertiserAvatar({ dataSource: { key: 'snapchat_ads_gallery' }, observations: [{ snapshot: { raw: { profile_logo_url: logo, unrelated: 'private-source-data' } } }] })).toBe(logo);
    expect(publicAdvertiserAvatar({ dataSource: { key: 'snapchat_ads_gallery' }, observedAdvertiserAvatarUrl: logo })).toBe(logo);
  });
  it('rejects unsafe URLs and does not use a creative or landing page as the brand logo', () => {
    for (const value of ['javascript:alert(1)', 'http://cdn.example/logo', 'https://user:secret@cdn.example/logo']) {
      expect(publicAdvertiserAvatar({ fieldProvenance: { advertiserAvatarUrl: { value } } })).toBeNull();
    }
    expect(publicAdvertiserAvatar({ landingPageUrl: 'https://sephora.fr/', media: [{ sourceUrl: logo }] })).toBeNull();
  });
  it('does not interpret another platform snapshot as Snapchat logo evidence', () => {
    expect(publicAdvertiserAvatar({ dataSource: { key: 'meta_ad_library' }, observations: [{ snapshot: { raw: { profile_logo_url: logo } } }] })).toBeNull();
  });
  it.each(['meta_ad_library','tiktok_commercial_library'])('returns observed logo metadata for %s without exposing source data',sourceKey=>{
    expect(publicAdvertiserAvatar({dataSource:{key:sourceKey},observedAdvertiserAvatarUrl:logo})).toBe(logo);
    expect(publicAdvertiserAvatar({dataSource:{key:sourceKey},observations:[{snapshot:{advertiserAvatarUrl:logo,privateEvidence:'not returned'}}]})).toBe(logo);
  });
  it('keeps an older known observed logo when the latest source observation omits it',()=>{
    expect(publicAdvertiserAvatar({dataSource:{key:'snapchat_ads_gallery'},observations:[{snapshot:{}},{snapshot:{raw:{profile_logo_url:logo}}}]})).toBe(logo);
  });
});
