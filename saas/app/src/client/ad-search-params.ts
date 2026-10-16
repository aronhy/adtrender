import type { Locale } from './landing/messages';
import type { DateValue, SearchFilters } from './types';

const searchKeys = ['q', 'advertiser', 'platform', 'media', 'country', 'status', 'startedFrom', 'startedTo', 'from', 'to', 'sort', 'source', 'channel', 'domain', 'business', 'category', 'content', 'exact', 'exclude'] as const;

export function readAdSearchFilters(params: URLSearchParams, workspaceId: string): SearchFilters {
  const get = (key: string) => params.get(key)?.trim() || undefined;
  const source=get('source')==='google'||get('platform')==='google'?'google':undefined;
  return { workspaceId, source, channel:get('channel') as SearchFilters['channel'], domain:get('domain'), business:get('business') as SearchFilters['business'], category:get('category'), contentStatus:(get('content')||'available') as SearchFilters['contentStatus'], exact:get('exact')==='true', exclude:get('exclude'), query: get('q'), advertiser: get('advertiser'), platform: get('platform') as SearchFilters['platform'],
    country: get('country')?.toUpperCase(), mediaType: get('media') === 'ALL' ? undefined : get('media') || (source==='google'?'TEXT':undefined), status: get('status'),
    startedFrom: get('startedFrom'), startedTo: get('startedTo'), observedFrom: get('from'), observedTo: get('to'),
    sort: 'recent', cursor: get('cursor'), limit: 24 };
}

export function adSearchParams(form: FormData, workspaceId: string, locale: Locale) {
  const next = new URLSearchParams({ workspace: workspaceId, lang: locale });
  for (const key of searchKeys) {
    const value = String(form.get(key) ?? '').trim();
    if (value) next.set(key, key === 'country' ? value.toUpperCase() : value);
  }
  return next;
}

/** Details may restore search context, never a foreign workspace or arbitrary URL. */
export function searchReturnHref(returnTo: string | null, workspaceId: string) {
  const next = new URLSearchParams({ workspace: workspaceId });
  if (returnTo?.startsWith('?')) {
    const previous = new URLSearchParams(returnTo.slice(1));
    for (const key of [...searchKeys, 'cursor']) { const value = previous.get(key); if (value) next.set(key, value); }
  }
  return `/app/ads?${next}`;
}

export function startedDateRange(days: 7 | 30 | 90, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - days + 1);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

/** Match the UTC calendar used by source-date search bounds in every viewer timezone. */
export function sourceDateLabel(value: DateValue | undefined, locale: Locale, missing: string) {
  if (!value) return missing;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(date) : missing;
}
