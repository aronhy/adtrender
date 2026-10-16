export type AdminAdsTranslate = (text: string, values?: Record<string, string | number>) => string;

export function formatAdminAdsDate(value: Date | string | null | undefined, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Hong_Kong' }).format(date) + ' (Asia/Hong_Kong)';
}

export function verifiedScopeLabel(value: string, t: AdminAdsTranslate, locale: string): string {
  const match = value.match(/^(.*) · (.*) · (.*) · 最多 (\d+) 条 · 有效至 (.*)$/);
  if (!match) return value;
  // Legacy display hints may only have a calendar date. Preserve those rather
  // than inventing an expiry time; current service responses carry full ISO.
  const date = /^\d{4}-\d{2}-\d{2}T/.test(match[5]) ? formatAdminAdsDate(match[5], locale) : match[5];
  return t('{query} · {country} · {type} · 最多 {count} 条 · 有效至 {date}', { query: match[1], country: match[2], type: match[3], count: match[4], date });
}
