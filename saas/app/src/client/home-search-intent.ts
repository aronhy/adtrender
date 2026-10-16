type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = 'ad-research:home-search';
const lifetimeMs = 30 * 60000;
const filters: Record<string, ReadonlySet<string>> = {
  platform: new Set(['facebook', 'instagram', 'messenger', 'audience_network', 'pinterest', 'google', 'youtube', 'tiktok', 'snapchat']),
  source: new Set(['google']),
  media: new Set(['ALL', 'IMAGE', 'VIDEO', 'TEXT']),
  lang: new Set(['zh-CN', 'zh-TW', 'en', 'es']),
};
const defaultStorage = (): IntentStorage | undefined => { try { return window.sessionStorage; } catch { return undefined; } };

function publicSearchParams(params: URLSearchParams) {
  const safe = new URLSearchParams();
  const query = params.get('q')?.trim();
  if (query) safe.set('q', query);
  for (const [name, allowed] of Object.entries(filters)) {
    const value = params.get(name)?.trim();
    if (value && allowed.has(value)) safe.set(name, value);
  }
  return safe;
}

/** A homepage may carry public filters across login, never a workspace or arbitrary destination. */
export function buildHomeSearchHref(params: URLSearchParams): string {
  const query = publicSearchParams(params).toString();
  return '/app/ads' + (query ? '?' + query : '');
}

export function rememberHomeSearchIntent(params: URLSearchParams, storage = defaultStorage(), now = Date.now()) {
  try { storage?.setItem(key, JSON.stringify({ query: publicSearchParams(params).toString(), createdAt: now })); } catch { /* Login remains available without browser storage. */ }
}

export function clearHomeSearchIntent(storage = defaultStorage()) {
  try { storage?.removeItem(key); } catch { /* Optional navigation preference. */ }
}

/** Consume once; expired, malformed, or unavailable storage falls back to the existing login destination. */
export function consumeHomeSearchIntent(storage = defaultStorage(), now = Date.now()): string | null {
  try {
    const raw = storage?.getItem(key);
    storage?.removeItem(key);
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== 'object' || !('query' in value) || typeof value.query !== 'string'
      || !('createdAt' in value) || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
      || now < value.createdAt || now - value.createdAt >= lifetimeMs) return null;
    return buildHomeSearchHref(new URLSearchParams(value.query));
  } catch { return null; }
}
