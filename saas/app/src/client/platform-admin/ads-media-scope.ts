type MediaDateFilters = { sourceId?: string; dateFrom?: string; dateTo?: string };

export function adminMediaFilterScope(params: URLSearchParams, filters: MediaDateFilters): MediaDateFilters {
  return params.get('pending') === 'all' ? { sourceId: filters.sourceId } : filters;
}

export function adminAdsFilterParams(params: URLSearchParams, key: string, value: string): URLSearchParams {
  const next = new URLSearchParams(params);
  if (value) next.set(key, value); else next.delete(key);
  next.delete('cursor');
  if (['adsTab', 'adsRange', 'from', 'to'].includes(key)) next.delete('pending');
  if (key === 'adsTab') next.delete('tab');
  if (key === 'adsRange' && value !== 'custom') { next.delete('from'); next.delete('to'); }
  return next;
}
