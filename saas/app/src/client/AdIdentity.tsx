import { useState } from 'react';
import { Building2 } from 'lucide-react';
import { mediaUrl } from './ad-media';
import './ad-identity.css';

export function AdvertiserLogo({ name, url, className = 'ws-ad-avatar' }: { name?: string | null; url?: string | null; className?: string }) {
  const safeUrl = mediaUrl(url);
  const [failedUrl, setFailedUrl] = useState<string>();
  const label = name?.trim();
  return <span className={`${className} ad-brand-logo`} title={label || undefined}>
    {safeUrl && safeUrl !== failedUrl
      ? <img src={safeUrl} alt={label ? `${label} logo` : 'Advertiser logo'} referrerPolicy="no-referrer" onError={() => setFailedUrl(safeUrl)} />
      : <span aria-hidden="true">{label ? Array.from(label)[0].toUpperCase() : <Building2 size={18} />}</span>}
  </span>;
}

const platformMarks: Record<string, { label: string; src: string }> = {
  FACEBOOK: { label: 'Facebook', src: '/platforms/facebook.png' },
  INSTAGRAM: { label: 'Instagram', src: '/platforms/instagram.png' },
  GOOGLE: { label: 'Google', src: '/platforms/google.png' },
  YOUTUBE: { label: 'YouTube', src: '/platforms/youtube.png' },
  TIKTOK: { label: 'TikTok', src: '/platforms/tiktok.png' },
  PINTEREST: { label: 'Pinterest', src: '/platforms/pinterest.svg' },
  SNAPCHAT: { label: 'Snapchat', src: '/platforms/snapchat.svg' },
};

function normalizePlatform(value: string): string {
  const name = value.trim().toUpperCase();
  if (['SEARCH', 'DISPLAY', 'SHOPPING', 'MAPS'].includes(name)) return 'GOOGLE';
  if (name === 'PIN') return 'PINTEREST';
  return name;
}

export function PlatformLogo({ platform, decorative = false, className = '' }: { platform: string; decorative?: boolean; className?: string }) {
  const name = normalizePlatform(platform);
  const mark = platformMarks[name];
  return mark ? <img className={`ad-platform-logo ${className}`.trim()} data-platform={name.toLowerCase()} src={mark.src} alt={decorative ? '' : mark.label} /> : null;
}

export function AdPlatformLogos({ platforms, sourceKey, unknownLabel, className = 'ws-card-platform' }: { platforms: string[]; sourceKey?: string | null; unknownLabel: string; className?: string }) {
  const names = [...new Set(platforms.map(value => {
    const name = normalizePlatform(value);
    return name === 'OTHER' && sourceKey === 'google_ads_transparency' ? 'GOOGLE' : name;
  }).filter(name => name && name !== 'UNKNOWN'))];
  const sourcePlatform: Record<string, string> = {
    google_ads_transparency: 'GOOGLE',
    snapchat_ads_gallery: 'SNAPCHAT',
    tiktok_commercial_library: 'TIKTOK',
    pinterest_ads_repository: 'PINTEREST',
  };
  const fallback = sourceKey ? sourcePlatform[sourceKey] : undefined;
  const displayed = names.length ? names : fallback ? [fallback] : [];
  const title = displayed.map(name => platformMarks[name]?.label || name).join(' · ') || unknownLabel;
  return <span className={`${className} ad-platform-logos`} title={title}>
    {displayed.length ? displayed.map(name => platformMarks[name]
      ? <PlatformLogo key={name} platform={name} />
      : <span key={name}>{name}</span>) : <span>{unknownLabel}</span>}
  </span>;
}
