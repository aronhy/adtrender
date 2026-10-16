const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Internal grouping identities must not be presented as source advertiser IDs. */
export function publicSourceAdvertiserId(value: unknown, provenance?: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || /^(?:page-url-sha256|ad-local):/i.test(value.trim())) return null;
  const entry = object(provenance);
  const kind = object(entry.identifier).kind ?? entry.kind;
  return kind === 'observed-page-url-hash' || kind === 'source-ad-local' ? null : value;
}
