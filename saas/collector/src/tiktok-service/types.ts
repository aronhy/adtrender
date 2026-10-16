export interface TikTokAd {
  sourceAdId: string;
  sourceUrl: string;
  sourceAdvertiserId: string | null;
  advertiserName: string | null;
  advertiserAvatarUrl?: string | null;
  body: string | null;
  headline: null;
  cta: string | null;
  landingPageUrl: string | null;
  firstShown: string | null;
  lastShown: string | null;
  reportedCountries: string[];
  media: Array<{url: string; type: 'IMAGE' | 'VIDEO'}>;
  sourceFields: Record<string, string>;
  observedAt: string;
}
export interface Evidence {
  url: string;
  httpStatus: number | null;
  kind: 'listing' | 'detail';
  adId?: string;
  text: string;
  html: string;
  observedAt: string;
}
export interface Batch {
  version: 'tiktok-public-dom-1';
  sourceKey: 'tiktok_commercial_library';
  platform: 'TIKTOK';
  observedAt: string;
  query: {country: string; startDate: string; endDate: string};
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'NO_RESULTS';
  errorCode: string | null;
  ads: TikTokAd[];
  evidence: Evidence[];
  completedIds: string[];
  coverage: {completeSourceCoverage: false; exhausted: boolean; reason: string; observedCards: number};
  nextPage: number;
  retryAfterMs?: number;
  diagnostics: Array<{status: number; path: string}>;
}
