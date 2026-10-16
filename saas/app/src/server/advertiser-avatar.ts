type Facts = Record<string, any>;
const object = (value: unknown): Facts => value && typeof value === 'object' && !Array.isArray(value) ? value as Facts : {};

/** Only return an observed identity image; creative and destination URLs are not logos. */
export function publicAdvertiserAvatar(value: unknown): string | null {
  const ad = object(value);
  const advertiser = object(object(ad.advertiser).fieldProvenance);
  const provenance = object(ad.fieldProvenance);
  const candidates: unknown[] = [object(advertiser.avatarUrl).value, object(provenance.advertiserAvatarUrl).value];
  const sourceKey = object(ad.dataSource).key;
  if (['meta_ad_library', 'tiktok_commercial_library', 'snapchat_ads_gallery'].includes(sourceKey)) {
    candidates.push(ad.observedAdvertiserAvatarUrl);
    for (const item of Array.isArray(ad.observations) ? ad.observations : []) {
      const observation = object(item), snapshot = object(observation.snapshot);
      candidates.push(object(object(observation.fieldProvenance).advertiserAvatarUrl).value, snapshot.advertiserAvatarUrl);
      if (sourceKey === 'snapchat_ads_gallery') candidates.push(object(snapshot.raw).profile_logo_url);
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch { /* A missing or malformed identity image remains unavailable. */ }
  }
  return null;
}
