export type HistorySourceStatus = 'ACTIVE' | 'INACTIVE' | 'UNKNOWN';

export type HistoryScope = {
  kind: 'DISCOVERY' | 'HISTORY_RECHECK' | 'MEDIA_REFRESH' | 'LEGACY_UNKNOWN';
  sourceKey: string;
  queryCountry: string | null;
  queryLanguage: string | null;
  /** Internal canonical allowlisted query. Never return this in an API view. */
  queryIdentity: string;
  hash: string;
};

export type HistoryFact = {
  observationId: string;
  runId: string;
  observedAt: Date;
  scope: HistoryScope;
  sourceStatus: HistorySourceStatus;
  body: string | null;
  headline: string | null;
  cta: string | null;
  landingPageUrl: string | null;
  comparableFields: string[];
  contentKey: string | null;
  mediaHashes: string[];
  // Source disclosures, never inferred from query country or observation time.
  sourceStartedAt?: string | null;
  sourceEndedAt?: string | null;
  sourceFirstShown?: string | null;
  sourceLastShown?: string | null;
  reportedCountries?: string[];
  publisherPlatforms?: string[];
  adLanguages?: string[];
  /** Prevent comparison across source languages or rendered creative variants. */
  comparisonContext?: string;
};

export type DailyProjection = {
  adId: string;
  day: string;
  timezone: 'Asia/Shanghai';
  scopeHash: string;
  observationIds: string[];
  observationCount: number;
  activeObservationCount: number;
  inactiveObservationCount: number;
  firstObservedAt: Date;
  lastObservedAt: Date;
  latestObservationId: string;
  latestSourceStatus: HistorySourceStatus;
  hasStateConflict: boolean;
  contentKey: string | null;
};

export type HistoryChange = {
  type: 'STATUS_CHANGED' | 'BODY_CHANGED' | 'HEADLINE_CHANGED' | 'CTA_CHANGED' | 'LANDING_PAGE_CHANGED' | 'MEDIA_CHANGED';
  beforeObservationId: string;
  afterObservationId: string;
  observedAt: Date;
  scopeHash: string;
};

export type HistoryScopeView = Pick<HistoryScope, 'hash' | 'kind' | 'sourceKey' | 'queryCountry' | 'queryLanguage'>;

export type AdHistoryDayView = {
  day: string;
  scopeHash: string;
  observationState: 'OBSERVED' | 'NO_OBSERVATION';
  checkState: 'UNKNOWN'|'NO_ATTEMPT'|'RUNNING'|'OBSERVED'|'NOT_OBSERVED'|'FAILED'|'UNSUPPORTED'|'ABANDONED';
  checkedAt?:string|null;
  checkAttemptCount?:number;
  sourceStatus: HistorySourceStatus;
  hasStateConflict: boolean;
  observationCount: number;
  lastObservedAt: string | null;
  latestObservationId: string | null;
  body: string | null;
  headline: string | null;
  cta: string | null;
};

export type AdHistoryEventView = {
  id: string;
  type: HistoryChange['type'];
  observedAt: string;
  scopeHash: string;
  beforeObservationId: string;
  afterObservationId: string;
};

export type AdHistoryResult = {
  timezone: 'Asia/Shanghai';
  asOf: string;
  from: string;
  to: string;
  scopes: HistoryScopeView[];
  days: AdHistoryDayView[];
  events: AdHistoryEventView[];
  nextEventCursor: string | null;
};
