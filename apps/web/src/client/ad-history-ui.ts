import type { AdHistoryEventView } from '../ad-history/types';

const dayMs = 86_400_000;
export const historyTimezone = 'Asia/Shanghai';

/** Inclusive calendar dates in the projection timezone, independent of the browser timezone. */
export function historyDateRange(days: 7 | 30 | 90, now = new Date()) {
  const today = new Date(now.valueOf() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { from: new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * dayMs).toISOString().slice(0, 10), to: today };
}

export function historyDateLabel(value: string | Date | null | undefined, locale: string, fallback: string, withTime = false) {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', ...(withTime ? { timeStyle: 'short' as const } : {}), timeZone: historyTimezone }).format(parsed) : fallback;
}

/** Event pages may overlap after late arriving observations; one evidence event is shown once. */
export function mergeHistoryEvents(existing: AdHistoryEventView[], incoming: AdHistoryEventView[]) {
  const byId = new Map(existing.map(event => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id));
}

export function historyEventKey(type: string) {
  const keys: Record<string, string> = { STATUS_CHANGED: 'ads.history.statusChanged', BODY_CHANGED: 'ads.history.bodyChanged', HEADLINE_CHANGED: 'ads.history.headlineChanged', CTA_CHANGED: 'ads.history.ctaChanged', LANDING_PAGE_CHANGED: 'ads.history.landingChanged', MEDIA_CHANGED: 'ads.history.mediaChanged' };
  return keys[type] ?? 'ads.history.changed';
}
