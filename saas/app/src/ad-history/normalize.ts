import { createHash } from 'node:crypto';
import type { DailyProjection, HistoryChange, HistoryFact, HistoryScope, HistorySourceStatus } from './types';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const has = (value: ObjectValue, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.map(text).filter((s): s is string => s !== null))].sort() : [];
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const dayMilliseconds = 86_400_000;
const shanghaiOffset = 8 * 3_600_000;
const contentFields = ['body', 'headline', 'cta', 'landingPageUrl'] as const;
const changeTypes: Record<typeof contentFields[number], HistoryChange['type']> = {
  body: 'BODY_CHANGED', headline: 'HEADLINE_CHANGED', cta: 'CTA_CHANGED', landingPageUrl: 'LANDING_PAGE_CHANGED',
};
const sourceAliases: Record<string, string> = {
  meta: 'meta_ad_library', google: 'google_ads_transparency', tiktok: 'tiktok_commercial_library',
  pinterest: 'pinterest_ads_repository', snapchat: 'snapchat_ads_gallery',
};
const knownSource = (value: unknown): string | null => {
  const name = text(value)?.toLowerCase();
  return name && /^[a-z0-9_-]{1,100}$/.test(name) ? sourceAliases[name] ?? name : null;
};

/** Timestamps remain UTC; this interval is left closed and right open. */
export function dayWindow(day: string): { from: Date; to: Date } {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('INVALID_HISTORY_DAY');
  const midnight = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day) throw new Error('INVALID_HISTORY_DAY');
  return { from: new Date(midnight - shanghaiOffset), to: new Date(midnight - shanghaiOffset + dayMilliseconds) };
}

const sensitiveQuery = /(?:access[_-]?token|refresh[_-]?token|authorization|password|secret|signature|x-amz-|x-goog-|(?:^|[?&])(?:token|sig|key)=|\bbearer\s)/i;
function safeQueryText(value: unknown): string | null {
  const s = text(value);
  return s && s.length <= 500 && !/[\u0000-\u001f]/.test(s) && !s.includes('://') && !sensitiveQuery.test(s) ? s.replace(/\s+/g, ' ') : null;
}
function country(value: unknown): string | null {
  const s = text(value)?.toUpperCase();
  return s && /^[A-Z]{2}$/.test(s) ? s : null;
}
function language(value: unknown): string | null {
  const s = text(value)?.replaceAll('_', '-').toLowerCase();
  return s && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(s) ? s : null;
}
function sourceKey(observation: ObjectValue, run: ObjectValue, snapshot: ObjectValue): string {
  const explicit = knownSource(run.sourceKey) ?? knownSource(object(run.dataSource).key)
    ?? knownSource(object(object(run.task).dataSource).key) ?? knownSource(object(observation.dataSource).key) ?? knownSource(snapshot.source);
  if (explicit) return explicit;
  const version = text(observation.parserVersion) ?? text(run.adapterVersion) ?? '';
  for (const [prefix, key] of Object.entries(sourceAliases)) if (version.startsWith(`${prefix}-`)) return key;
  return knownSource(observation.dataSourceId) ?? knownSource(run.dataSourceId) ?? 'unknown';
}

function historyScope(observation: ObjectValue, run: ObjectValue, snapshot: ObjectValue): HistoryScope {
  const query = object(run.querySnapshot);
  const coverage = object(run.coverage);
  const source = sourceKey(observation, run, snapshot);
  const declaredKind = text(run.historyKind) ?? text(run.kind) ?? text(query.historyKind) ?? text(query.purpose) ?? text(query.kind);
  let kind: HistoryScope['kind'];
  if (declaredKind === 'MEDIA_REFRESH' || coverage.reason === 'MEDIA_REFRESH_DETAIL') kind = 'MEDIA_REFRESH';
  else if (declaredKind === 'HISTORY_RECHECK') kind = 'HISTORY_RECHECK';
  else if (declaredKind === 'LEGACY_UNKNOWN' || String(observation.parserVersion??run.adapterVersion??'').startsWith('legacy-') || !Object.keys(query).length) kind = 'LEGACY_UNKNOWN';
  else kind = 'DISCOVERY';
  const queryCountry = country(has(observation, 'queryCountry') ? observation.queryCountry : query.country);
  const queryLanguage = language(query.language ?? query.queryLanguage);
  // Pagination, limits, URLs, tokens and customer notes do not define coverage.
  const allowed: ObjectValue = {};
  for (const key of ['keyword', 'term', 'pageId', 'advertiserId', 'publisher', 'domain', 'status', 'mediaType', 'category', 'kind', 'platform', 'dateStart', 'dateEnd', 'startDate', 'endDate'] as const) {
    const value = safeQueryText(query[key]);
    if (!value) continue;
    if (key === 'kind' && ['HISTORY_RECHECK', 'MEDIA_REFRESH', 'LEGACY_UNKNOWN', 'DISCOVERY'].includes(value)) continue;
    allowed[key] = ['status', 'mediaType', 'category', 'kind', 'platform'].includes(key) ? value.toUpperCase() : key === 'domain' ? value.toLowerCase() : value;
  }
  allowed.country = queryCountry; allowed.language = queryLanguage;
  const queryIdentity = JSON.stringify(Object.fromEntries(Object.entries(allowed).sort(([a], [b]) => compareId(a, b))));
  return { kind, sourceKey: source, queryCountry, queryLanguage, queryIdentity, hash: sha(JSON.stringify([kind, source, queryIdentity])) };
}

function sourceStatus(observation: ObjectValue, snapshot: ObjectValue, source: string): HistorySourceStatus {
  // These current adapters explicitly do not disclose a delivery state.
  if (['google_ads_transparency', 'tiktok_commercial_library', 'pinterest_ads_repository'].includes(source)) return 'UNKNOWN';
  const value = text(has(observation, 'sourceStatus') ? observation.sourceStatus : snapshot.sourceStatus ?? snapshot.status)?.toUpperCase();
  return value === 'ACTIVE' || value === 'INACTIVE' ? value : 'UNKNOWN';
}
function safeLanding(value: unknown): string | null {
  const s = text(value);
  if (!s) return null;
  try {
    const url = new URL(s);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || sensitiveQuery.test(url.search)) return null;
    url.hash = '';
    url.searchParams.sort();
    return url.toString();
  } catch { return null; }
}
function unavailable(snapshot: ObjectValue, provenance: ObjectValue, key: string, value: string | null): boolean {
  const entry = object(provenance[key]);
  return value === null || /\[\s*redacted\s*\]|^<redacted>$|^\*{3,}$/i.test(value)
    || /(?:…|\.\.\.)$/.test(value)
    || snapshot[`${key}Truncated`] === true || provenance[`${key}Truncated`] === true
    || snapshot[`${key}Redacted`] === true || entry.truncated === true || entry.redacted === true
    || entry.comparable === false || entry.complete === false
    || ['MISSING', 'TRUNCATED', 'REDACTED', 'UNAVAILABLE', 'PARSE_ERROR'].includes(String(entry.status ?? entry.availability).toUpperCase())
    || strings(snapshot.truncatedFields).includes(key) || strings(snapshot.redactedFields).includes(key)
    || ['SOURCE_UNAVAILABLE', 'EMPTY_RENDER', 'REDACTED', 'PARSE_ERROR'].includes(String(snapshot.contentAvailability).toUpperCase());
}
function sourceDate(value: unknown): string | null {
  const s = text(value);
  if (!s) return null;
  if (/^\d{4}-\d\d-\d\d$/.test(s)) { try { dayWindow(s); return s; } catch { return null; } }
  return /^\d{4}-\d\d-\d\dT/.test(s) && Number.isFinite(Date.parse(s)) ? s : null;
}

/** Read historical evidence only. No current Ad or unassociated media fallback. */
export function normalizeHistoryFact(input: { observation: unknown; run: unknown; media: unknown[] }): HistoryFact {
  const observation = object(input.observation), run = object(input.run);
  const snapshot = object(observation.snapshot), provenance = object(observation.fieldProvenance);
  const observationId = text(observation.id), runId = text(observation.collectionRunId) ?? text(run.id);
  if (!observationId || !runId) throw new Error('INVALID_HISTORY_OBSERVATION_ID');
  const time = observation.observedAt;
  const observedAt = time instanceof Date ? new Date(time.getTime())
    : typeof time === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(time) ? new Date(time) : new Date(NaN);
  if (!Number.isFinite(observedAt.getTime())) throw new Error('INVALID_OBSERVATION_TIME');
  const scope = historyScope(observation, run, snapshot);
  const values = { body: text(snapshot.body), headline: text(snapshot.headline), cta: text(snapshot.cta), landingPageUrl: safeLanding(snapshot.landingPageUrl) };
  if(scope.sourceKey==='meta_ad_library' && observation.parserVersion==='meta-service-dom-1' && ['Platforms','EU transparency','This ad has multiple versions'].includes(values.headline??'')) values.headline=null;
  const explicit = has(observation, 'comparableFields') ? strings(observation.comparableFields)
    : has(snapshot, 'comparableFields') ? strings(snapshot.comparableFields) : null;
  const pinterestEvidence = scope.sourceKey === 'pinterest_ads_repository' && provenance.source === 'pinterest-public-dom';
  const googleIncomplete = scope.sourceKey === 'google_ads_transparency' && (snapshot.variantsComplete !== true || !object(snapshot.variant).index);
  const comparableFields: string[] = contentFields.filter(key => !googleIncomplete && !unavailable(snapshot, provenance, key, values[key])
    && (explicit !== null ? explicit.includes(key) : has(object(provenance[key]), 'value') || pinterestEvidence));
  const associated = input.media.map(object).filter(m => m.observationId === observationId && /^[a-f0-9]{64}$/i.test(text(m.sha256) ?? '')
    && (!m.status || m.status === 'READY'));
  const mediaHashes = [...new Set(associated.map(m => String(m.sha256).toLowerCase()))].sort();
  const snapshotMedia = Array.isArray(snapshot.media) ? snapshot.media.map(object) : null;
  // Comparing a partial downloaded set creates fake removals. Require a complete
  // URL association, or an explicit media-comparability assertion with hashes.
  const allMediaLinked = snapshotMedia !== null && snapshotMedia.length > 0 && snapshotMedia.every(m =>
    text(m.url) !== null && associated.some(a => a.sourceUrl === m.url));
  const mediaDeclared = explicit === null || explicit.includes('media') || explicit.includes('mediaHashes');
  if (!googleIncomplete && mediaDeclared && mediaHashes.length && (allMediaLinked || (explicit !== null && !snapshotMedia))) comparableFields.push('mediaHashes');
  const adLanguages = strings(snapshot.languages ?? snapshot.adLanguages ?? (snapshot.language ? [snapshot.language] : []));
  const variant = object(snapshot.variant);
  const comparisonContext = JSON.stringify([adLanguages, variant.index ?? null, variant.total ?? null]);
  const content = comparableFields.map(key => [key, key === 'mediaHashes' ? mediaHashes : values[key as typeof contentFields[number]]]);
  return {
    observationId, runId, observedAt, scope, sourceStatus: sourceStatus(observation, snapshot, scope.sourceKey), ...values,
    comparableFields, contentKey: content.length ? sha(JSON.stringify([comparisonContext, content])) : null, mediaHashes,
    sourceStartedAt: sourceDate(snapshot.sourceStartedAt ?? (scope.sourceKey === 'meta_ad_library' ? snapshot.startDate : null)),
    sourceEndedAt: sourceDate(snapshot.sourceEndedAt ?? (scope.sourceKey === 'meta_ad_library' ? snapshot.endDate : null)),
    sourceFirstShown: text(snapshot.firstShown ?? snapshot.sourceFirstShown), sourceLastShown: text(snapshot.lastShown ?? snapshot.sourceLastShown),
    reportedCountries: [...new Set(strings(snapshot.reportedCountries).map(country).filter((s): s is string => s !== null))].sort(),
    publisherPlatforms: strings(snapshot.publisherPlatforms ?? snapshot.platforms ?? (snapshot.publisherPlatform ? [snapshot.publisherPlatform] :
      ({ tiktok_commercial_library: ['TIKTOK'], pinterest_ads_repository: ['PINTEREST'], snapchat_ads_gallery: ['SNAPCHAT'] } as Record<string, string[]>)[scope.sourceKey])),
    adLanguages, comparisonContext,
  };
}

/** Rebuildable and replay-safe; only actual observation days become projections. */
export function projectAdHistory(input: { adId: string; facts: HistoryFact[] }): { days: DailyProjection[]; changes: HistoryChange[] } {
  const ordered = [...input.facts].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime() || compareId(a.observationId, b.observationId));
  const seen = new Set<string>();
  const unique = ordered.filter(fact => {
    if (seen.has(fact.observationId)) return false;
    seen.add(fact.observationId); return true;
  });
  const groups = new Map<string, HistoryFact[]>(), scopeFacts = new Map<string, HistoryFact[]>();
  for (const fact of unique) {
    const day = new Date(fact.observedAt.getTime() + shanghaiOffset).toISOString().slice(0, 10);
    const key = `${day}:${fact.scope.hash}`;
    const group = groups.get(key) ?? []; group.push(fact); groups.set(key, group);
    const scope = scopeFacts.get(fact.scope.hash) ?? []; scope.push(fact); scopeFacts.set(fact.scope.hash, scope);
  }
  const days: DailyProjection[] = [...groups.values()].map<DailyProjection>(facts => {
    const latest = facts[facts.length - 1];
    const statuses = new Set(facts.map(f => f.sourceStatus).filter(s => s !== 'UNKNOWN'));
    return { adId: input.adId, day: new Date(latest.observedAt.getTime() + shanghaiOffset).toISOString().slice(0, 10), timezone: 'Asia/Shanghai',
      scopeHash: latest.scope.hash, observationIds: facts.map(f => f.observationId), observationCount: facts.length,
      activeObservationCount: facts.filter(f => f.sourceStatus === 'ACTIVE').length,
      inactiveObservationCount: facts.filter(f => f.sourceStatus === 'INACTIVE').length,
      firstObservedAt: new Date(facts[0].observedAt.getTime()), lastObservedAt: new Date(latest.observedAt.getTime()), latestObservationId: latest.observationId, latestSourceStatus: latest.sourceStatus,
      hasStateConflict: statuses.size > 1, contentKey: latest.contentKey };
  }).sort((a, b) => compareId(a.day, b.day) || compareId(a.scopeHash, b.scopeHash));
  const changes: HistoryChange[] = [];
  for (const facts of scopeFacts.values()) {
    for (let index = 1; index < facts.length; index++) {
      const before = facts[index - 1], after = facts[index];
      const emit = (type: HistoryChange['type']) => changes.push({ type, beforeObservationId: before.observationId, afterObservationId: after.observationId,
        observedAt: new Date(after.observedAt.getTime()), scopeHash: after.scope.hash });
      if (before.sourceStatus !== 'UNKNOWN' && after.sourceStatus !== 'UNKNOWN' && before.sourceStatus !== after.sourceStatus) emit('STATUS_CHANGED');
      if ((before.comparisonContext ?? '') !== (after.comparisonContext ?? '')) continue;
      for (const key of contentFields) if (before.comparableFields.includes(key) && after.comparableFields.includes(key) && before[key] !== null && after[key] !== null && before[key] !== after[key]) emit(changeTypes[key]);
      if (before.comparableFields.includes('mediaHashes') && after.comparableFields.includes('mediaHashes') && JSON.stringify([...before.mediaHashes].sort()) !== JSON.stringify([...after.mediaHashes].sort())) emit('MEDIA_CHANGED');
    }
  }
  changes.sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime() || compareId(a.afterObservationId, b.afterObservationId) || compareId(a.scopeHash, b.scopeHash));
  return { days, changes };
}
