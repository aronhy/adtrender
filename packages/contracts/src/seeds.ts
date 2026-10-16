import { createHash } from 'node:crypto';

export const seedSourceKeys = ['meta_ad_library', 'google_ads_transparency', 'snapchat_ads_gallery', 'tiktok_commercial_library', 'pinterest_ads_repository'] as const;
export const SOURCE_KEYS = seedSourceKeys;
export type SourceKey = typeof seedSourceKeys[number];
export type SeedKind = 'KEYWORD' | 'NAME' | 'DOMAIN' | 'NATIVE_ADVERTISER' | 'APP_REFERENCE';
export type SeedStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | 'MERGED';
export type PurposeTag = { family: 'ECOMMERCE' | 'GAMES' | 'COMICS'; category: string };
export type TargetScope = { kind: 'CONFIGURED_MARKETS' } | { kind: 'EXPLICIT_COUNTRIES'; countries: string[] } | { kind: 'SOURCE_GLOBAL' };
export type VerificationStatus = 'CANDIDATE' | 'VERIFIED' | 'CONFLICT' | 'REJECTED' | 'NOT_APPLICABLE';
export interface SeedDefinitionInput {
  id?: string; kind: SeedKind; namespace: string; rawValue: string; normalizedValue?: string; language: string;
  purposeTags: PurposeTag[]; targetScope: TargetScope; targetPlatforms: SourceKey[]; status: SeedStatus;
  priority: number; revision?: number; createdByUserId?: string; mergedIntoSeedId?: string | null;
  verificationStatus?: VerificationStatus;
}
export interface SeedScanPlanInput {
  id: string; revision: number; sourceKey: SourceKey; targetScope: TargetScope;
  datePolicy: { kind: 'ROLLING'; windowDays: number } | { kind: 'FIXED'; start: string; end: string };
  category: 'ALL'; status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED'; evidence: Record<string, unknown>;
}
export type ScanPlan = SeedScanPlanInput;
export interface SeedQuerySpec {
  queryId: string; queryKey: string; queryKeyVersion: string; sourceKey: SourceKey; channel: string; mode: string;
  params: Record<string, unknown>; legacyDims: Record<string, unknown>; adapterVersion: string; capabilityVersion: string;
  desiredEnabled: boolean; nativeJobIds: string[];
}
export interface OwnerBinding {
  queryId: string; ownerKind: 'SEED' | 'SCAN_PLAN' | 'LEGACY'; seedId: string | null; scanPlanId: string | null;
  legacyOwnerKey: string | null; ownerRevision: number; participationStatus: 'ACTIVE' | 'PAUSED' | 'REMOVED';
  purposeSnapshot: PurposeTag[]; validFromRevision: number; validToRevision: number | null;
}
export interface SeedConfigManifest {
  schemaVersion: 1; protocolMin: number; protocolMax: number; publicationId: string; revision: number;
  parentRevision: number | null; compilerVersion: string; capabilityVersion: string; contentHash: string; createdAt: string;
  queries: SeedQuerySpec[]; bindings: OwnerBinding[]; scanPlans: SeedScanPlanInput[];
  tombstones: Array<{ queryId: string; reason: string }>; schedulePolicyVersion: string;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
function check(value: unknown, label: string): asserts value { if (!value) throw new Error('INVALID_SEED_' + label); }
function object(value: unknown): Record<string, any> { check(value && typeof value === 'object' && !Array.isArray(value) && [null, Object.prototype].includes(Object.getPrototypeOf(value)), 'OBJECT'); return value as Record<string, any>; }
function fields(value: Record<string, unknown>, names: string[]) { check(Object.keys(value).every(key => names.includes(key)), 'FIELD'); }
function text(value: unknown, max = 200): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value); }
function integer(value: unknown, min = 1): value is number { return Number.isSafeInteger(value) && Number(value) >= min; }
function purposes(value: unknown): asserts value is PurposeTag[] { check(Array.isArray(value), 'PURPOSE'); for (const item of value) { const p = object(item); fields(p, ['family', 'category']); check(['ECOMMERCE', 'GAMES', 'COMICS'].includes(p.family) && text(p.category), 'PURPOSE'); } }
function target(value: unknown): asserts value is TargetScope { const scope = object(value); fields(scope, ['kind', 'countries']); check(['CONFIGURED_MARKETS', 'EXPLICIT_COUNTRIES', 'SOURCE_GLOBAL'].includes(scope.kind), 'SCOPE'); if (scope.kind === 'EXPLICIT_COUNTRIES') check(Array.isArray(scope.countries) && scope.countries.length > 0 && scope.countries.every((c: unknown) => typeof c === 'string' && /^[A-Z]{2}$/.test(c)) && new Set(scope.countries).size === scope.countries.length, 'COUNTRIES'); else check(scope.countries === undefined, 'SCOPE'); }
function json(value: unknown): Record<string, unknown> { const parsed = object(value); const encoded = JSON.stringify(parsed); check(encoded.length <= 1_000_000, 'SIZE'); return JSON.parse(encoded); }
function date(value: unknown) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
export function validateSeedDefinitionInput(value: unknown): SeedDefinitionInput {
  const v = object(value); fields(v, ['id', 'kind', 'namespace', 'rawValue', 'normalizedValue', 'language', 'purposeTags', 'targetScope', 'targetPlatforms', 'status', 'priority', 'revision', 'createdByUserId', 'mergedIntoSeedId', 'verificationStatus']);
  check(['KEYWORD', 'NAME', 'DOMAIN', 'NATIVE_ADVERTISER', 'APP_REFERENCE'].includes(v.kind) && text(v.namespace) && text(v.rawValue, 2000) && (v.normalizedValue === undefined || text(v.normalizedValue, 2000)), 'DEFINITION');
  check(text(v.language, 35) && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(v.language), 'LANGUAGE'); purposes(v.purposeTags); target(v.targetScope);
  check(Array.isArray(v.targetPlatforms) && v.targetPlatforms.length > 0 && v.targetPlatforms.every((p: SourceKey) => seedSourceKeys.includes(p)) && new Set(v.targetPlatforms).size === v.targetPlatforms.length, 'PLATFORMS');
  check(['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED', 'MERGED'].includes(v.status) && integer(v.priority, 0), 'STATUS');
  for (const key of ['id', 'createdByUserId', 'mergedIntoSeedId']) check(v[key] == null || (typeof v[key] === 'string' && uuid.test(v[key])), 'ID');
  check(v.revision === undefined || integer(v.revision), 'REVISION');
  check(v.verificationStatus === undefined || ['CANDIDATE', 'VERIFIED', 'CONFLICT', 'REJECTED', 'NOT_APPLICABLE'].includes(v.verificationStatus), 'VERIFICATION');
  if (v.kind === 'NATIVE_ADVERTISER') check(seedSourceKeys.includes(v.namespace as SourceKey) && v.targetPlatforms.length === 1 && v.targetPlatforms[0] === v.namespace && !/^(?:page-url-sha256|ad-local|name-hash):/i.test(v.rawValue), 'NATIVE_IDENTITY');
  return JSON.parse(JSON.stringify(v));
}
export function validateSeedScanPlanInput(value: unknown): SeedScanPlanInput {
  const v = object(value); fields(v, ['id', 'revision', 'sourceKey', 'targetScope', 'datePolicy', 'category', 'status', 'evidence']);
  check(uuid.test(v.id) && integer(v.revision) && ['tiktok_commercial_library', 'pinterest_ads_repository'].includes(v.sourceKey), 'SCAN_PLAN'); target(v.targetScope);
  check(v.category === 'ALL' && ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'].includes(v.status), 'SCAN_PLAN');
  const policy = object(v.datePolicy); fields(policy, ['kind', 'windowDays', 'start', 'end']);
  check(policy.kind === 'ROLLING' ? integer(policy.windowDays) && policy.start === undefined && policy.end === undefined : policy.kind === 'FIXED' && policy.windowDays === undefined && date(policy.start) && date(policy.end) && policy.start <= policy.end, 'DATE_POLICY');
  json(v.evidence); return JSON.parse(JSON.stringify(v));
}
export function validateSeedQuerySpec(value: unknown): SeedQuerySpec {
  const v = object(value); fields(v, ['queryId', 'queryKey', 'queryKeyVersion', 'sourceKey', 'channel', 'mode', 'params', 'legacyDims', 'adapterVersion', 'capabilityVersion', 'desiredEnabled', 'nativeJobIds']);
  check(uuid.test(v.queryId) && digest.test(v.queryKey) && text(v.queryKeyVersion) && seedSourceKeys.includes(v.sourceKey) && text(v.channel) && text(v.mode) && text(v.adapterVersion) && text(v.capabilityVersion) && typeof v.desiredEnabled === 'boolean', 'QUERY');
  const allowed: Record<SourceKey, string[]> = { meta_ad_library: ['KEYWORD', 'NAME', 'PAGE_ID', 'NATIVE_ADVERTISER'], google_ads_transparency: ['DISCOVER', 'SEARCH', 'YOUTUBE', 'SERP'], snapchat_ads_gallery: ['PUBLISHER', 'NAME'], tiktok_commercial_library: ['SWEEP', 'DATE_SWEEP', 'MEDIA_REFRESH'], pinterest_ads_repository: ['SWEEP', 'DATE_SWEEP'] };
  check(allowed[v.sourceKey as SourceKey].includes(v.mode), 'UNSUPPORTED_MODE');
  const params = json(v.params); json(v.legacyDims);
  check(typeof params.country === 'string' && (/^[A-Z]{2}$/.test(params.country) || (v.sourceKey === 'snapchat_ads_gallery' && params.country === 'ALL')), 'QUERY_COUNTRY');
  if (['tiktok_commercial_library', 'pinterest_ads_repository'].includes(v.sourceKey)) {
    check(params.keyword == null || params.keyword === '', 'UNSUPPORTED_MODE');
    if (v.mode !== 'MEDIA_REFRESH') {
      const start = params.startDate ?? params.dateStart ?? params.start, end = params.endDate ?? params.dateEnd ?? params.end;
      check(date(start) && date(end) && String(start) <= String(end) && ['startDate', 'dateStart', 'start'].every(key => params[key] === undefined || params[key] === start) && ['endDate', 'dateEnd', 'end'].every(key => params[key] === undefined || params[key] === end), 'QUERY_DATE');
    }
  }
  check(Array.isArray(v.nativeJobIds) && v.nativeJobIds.every((key: unknown) => text(key, 2000)) && new Set(v.nativeJobIds).size === v.nativeJobIds.length, 'LEGACY_JOBS');
  return JSON.parse(JSON.stringify(v));
}
export function validateOwnerBinding(value: unknown): OwnerBinding {
  const v = object(value); fields(v, ['queryId', 'ownerKind', 'seedId', 'scanPlanId', 'legacyOwnerKey', 'ownerRevision', 'participationStatus', 'purposeSnapshot', 'validFromRevision', 'validToRevision']);
  check(uuid.test(v.queryId) && ['SEED', 'SCAN_PLAN', 'LEGACY'].includes(v.ownerKind) && [v.seedId, v.scanPlanId, v.legacyOwnerKey].filter(owner => owner != null).length === 1, 'BINDING_OWNER');
  check(v.ownerKind === 'SEED' ? typeof v.seedId === 'string' && uuid.test(v.seedId) : v.ownerKind === 'SCAN_PLAN' ? typeof v.scanPlanId === 'string' && uuid.test(v.scanPlanId) : text(v.legacyOwnerKey, 2000), 'BINDING_OWNER');
  check(integer(v.ownerRevision) && integer(v.validFromRevision) && (v.validToRevision === null || integer(v.validToRevision) && v.validToRevision > v.validFromRevision) && ['ACTIVE', 'PAUSED', 'REMOVED'].includes(v.participationStatus), 'BINDING_REVISION'); purposes(v.purposeSnapshot);
  return JSON.parse(JSON.stringify(v));
}
/** seed-canonical-1: sort object keys and unordered country sets only. */
export function seedCanonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(seedCanonical).join(',') + ']';
  if (value && typeof value === 'object') { const v = object(value); return '{' + Object.keys(v).filter(key => v[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + seedCanonical(key === 'countries' && Array.isArray(v[key]) ? [...v[key]].sort() : v[key])).join(',') + '}'; }
  const result = JSON.stringify(value); check(result !== undefined, 'CANONICAL'); return result;
}
export function seedManifestContentHash(value: Omit<SeedConfigManifest, 'contentHash'> | SeedConfigManifest): string {
  const { contentHash: ignored, ...body } = value as SeedConfigManifest;
  const key = (b: OwnerBinding) => [b.queryId, b.ownerKind, b.seedId ?? b.scanPlanId ?? b.legacyOwnerKey, b.ownerRevision].join(':');
  const ordered = { ...body, queries: [...body.queries].sort((a, b) => a.queryKey.localeCompare(b.queryKey)), bindings: [...body.bindings].sort((a, b) => key(a).localeCompare(key(b))) };
  return createHash('sha256').update(seedCanonical(ordered)).digest('hex');
}
export function validateSeedManifest(value: unknown): SeedConfigManifest {
  const v = object(value); fields(v, ['schemaVersion', 'protocolMin', 'protocolMax', 'publicationId', 'revision', 'parentRevision', 'compilerVersion', 'capabilityVersion', 'contentHash', 'createdAt', 'queries', 'bindings', 'scanPlans', 'tombstones', 'schedulePolicyVersion']);
  check(v.schemaVersion === 1 && integer(v.protocolMin) && integer(v.protocolMax) && v.protocolMin <= v.protocolMax && uuid.test(v.publicationId) && integer(v.revision) && (v.parentRevision === null || integer(v.parentRevision) && v.parentRevision < v.revision), 'MANIFEST_VERSION');
  check(text(v.compilerVersion) && text(v.capabilityVersion) && text(v.schedulePolicyVersion) && digest.test(v.contentHash) && typeof v.createdAt === 'string' && Number.isFinite(Date.parse(v.createdAt)), 'MANIFEST');
  check(Array.isArray(v.queries) && Array.isArray(v.bindings) && Array.isArray(v.scanPlans) && Array.isArray(v.tombstones), 'MANIFEST_ARRAYS');
  const queries = v.queries.map(validateSeedQuerySpec), bindings = v.bindings.map(validateOwnerBinding), plans = v.scanPlans.map(validateSeedScanPlanInput);
  check(new Set(queries.map((q: SeedQuerySpec) => q.queryId)).size === queries.length && new Set(queries.map((q: SeedQuerySpec) => q.sourceKey + ':' + q.channel + ':' + q.queryKey)).size === queries.length, 'DUPLICATE_QUERY');
  const ids = new Set(queries.map((q: SeedQuerySpec) => q.queryId)); check(bindings.every((b: OwnerBinding) => ids.has(b.queryId)), 'DANGLING_BINDING');
  const ownerKeys = bindings.map((b: OwnerBinding) => [b.queryId, b.ownerKind, b.seedId ?? b.scanPlanId ?? b.legacyOwnerKey].join(':'));
  check(new Set(ownerKeys).size === ownerKeys.length, 'DUPLICATE_BINDING');
  check(new Set(plans.map((p: SeedScanPlanInput) => p.id)).size === plans.length, 'DUPLICATE_SCAN_PLAN');
  const planIds = new Set(plans.map((p: SeedScanPlanInput) => p.id)); check(bindings.every((b: OwnerBinding) => b.ownerKind !== 'SCAN_PLAN' || planIds.has(b.scanPlanId!)), 'DANGLING_SCAN_PLAN');
  for (const item of v.tombstones) { const t = object(item); fields(t, ['queryId', 'reason']); check(uuid.test(t.queryId) && text(t.reason), 'TOMBSTONE'); }
  check(v.contentHash === seedManifestContentHash(v as SeedConfigManifest), 'MANIFEST_HASH'); return JSON.parse(JSON.stringify(v));
}
export const validateSeedDefinition = validateSeedDefinitionInput;
export const validateSeedScanPlan = validateSeedScanPlanInput;

/** Config transport pages are byte chunks of one immutable, scoped manifest.
 * Message sizes bound transfer resources, never the total number of seeds. */
export interface SeedManifestDescriptor {
  schemaVersion: 1;
  type: 'SEED_MANIFEST_DESCRIPTOR';
  publicationId: string;
  publicationRevision: number;
  manifestHash: string;
  byteSha256: string;
  byteLength: number;
  chunkBytes: number;
  totalChunks: number;
}
export interface SeedManifestChunk {
  schemaVersion: 1;
  type: 'SEED_MANIFEST_CHUNK';
  publicationId: string;
  publicationRevision: number;
  manifestHash: string;
  chunkIndex: number;
  byteSha256: string;
  byteLength: number;
  dataBase64: string;
}
export const SEED_MANIFEST_CHUNK_BYTES = 1024 * 1024;
export function validateSeedManifestDescriptor(value: unknown): SeedManifestDescriptor {
  const v = object(value);
  fields(v, ['schemaVersion', 'type', 'publicationId', 'publicationRevision', 'manifestHash', 'byteSha256', 'byteLength', 'chunkBytes', 'totalChunks']);
  check(v.schemaVersion === 1 && v.type === 'SEED_MANIFEST_DESCRIPTOR' && uuid.test(v.publicationId) && integer(v.publicationRevision), 'TRANSFER_VERSION');
  check(digest.test(v.manifestHash) && digest.test(v.byteSha256) && integer(v.byteLength) && v.chunkBytes === SEED_MANIFEST_CHUNK_BYTES && integer(v.totalChunks) && v.totalChunks === Math.ceil(v.byteLength / v.chunkBytes), 'TRANSFER_SIZE');
  return { ...v } as SeedManifestDescriptor;
}
export function validateSeedManifestChunk(value: unknown): SeedManifestChunk {
  const v = object(value);
  fields(v, ['schemaVersion', 'type', 'publicationId', 'publicationRevision', 'manifestHash', 'chunkIndex', 'byteSha256', 'byteLength', 'dataBase64']);
  check(v.schemaVersion === 1 && v.type === 'SEED_MANIFEST_CHUNK' && uuid.test(v.publicationId) && integer(v.publicationRevision) && integer(v.chunkIndex, 0), 'TRANSFER_VERSION');
  check(digest.test(v.manifestHash) && digest.test(v.byteSha256) && integer(v.byteLength) && v.byteLength <= SEED_MANIFEST_CHUNK_BYTES && typeof v.dataBase64 === 'string' && v.dataBase64.length === Math.ceil(v.byteLength / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(v.dataBase64), 'TRANSFER_SIZE');
  const bytes = Buffer.from(v.dataBase64, 'base64');
  check(bytes.length === v.byteLength && bytes.toString('base64') === v.dataBase64 && createHash('sha256').update(bytes).digest('hex') === v.byteSha256, 'TRANSFER_BYTES');
  return { ...v } as SeedManifestChunk;
}
