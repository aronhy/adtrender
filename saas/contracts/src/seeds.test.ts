import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateSeedManifest, validateSeedDefinitionInput, validateSeedScanPlanInput, validateSeedQuerySpec, validateOwnerBinding, seedManifestContentHash } from './seeds.js';

const id = '11111111-1111-4111-8111-111111111111';
const canonical = (value: any): string => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const query = () => ({ queryId: id, queryKey: 'a'.repeat(64), queryKeyVersion: 'seed-query-1', sourceKey: 'meta_ad_library', channel: 'PUBLIC_LIBRARY', mode: 'KEYWORD', params: { country: 'US', language: 'en', keyword: 'furniture', pageId: null, status: 'all', mediaType: 'all' }, legacyDims: {}, adapterVersion: 'meta-service-dom-1', capabilityVersion: 'fixture-1', desiredEnabled: true, nativeJobIds: [] });
const binding = () => ({ queryId: id, ownerKind: 'SEED', seedId: id, scanPlanId: null, legacyOwnerKey: null, ownerRevision: 1, participationStatus: 'ACTIVE', purposeSnapshot: [{ family: 'ECOMMERCE', category: 'furniture' }], validFromRevision: 1, validToRevision: null });
const manifest = () => {
  const body = { schemaVersion: 1, protocolMin: 1, protocolMax: 1, publicationId: id, revision: 1, parentRevision: null, compilerVersion: 'seed-compiler-1', capabilityVersion: 'fixture-1', createdAt: '2026-10-11T00:00:00.000Z', queries: [query()], bindings: [binding()], scanPlans: [], tombstones: [], schedulePolicyVersion: 'legacy-round-robin-1' };
  return { ...body, contentHash: createHash('sha256').update(canonical(body)).digest('hex') };
};
describe('seed configuration trust boundary', () => {
  it('accepts a complete versioned manifest and keeps shared query owners', () => {
    const input = manifest();
    input.bindings.push({ ...binding(), seedId: '22222222-2222-4222-8222-222222222222' });
    const { contentHash: ignored, ...body } = input;
    input.contentHash = createHash('sha256').update(canonical(body)).digest('hex');
    expect(validateSeedManifest(input).bindings).toHaveLength(2);
  });
  it('rejects missing versions, unsupported sources, mutated bytes and dangling owners', () => {
    const missing: any = manifest(); delete missing.schemaVersion;
    expect(() => validateSeedManifest(missing)).toThrow();
    const unknown = manifest(); unknown.queries[0].sourceKey = 'fake_platform';
    expect(() => validateSeedManifest(unknown)).toThrow();
    const changed = manifest(); changed.queries[0].params.keyword = 'changed';
    expect(() => validateSeedManifest(changed)).toThrow();
    const dangling = manifest(); dangling.bindings[0].queryId = '22222222-2222-4222-8222-222222222222';
    expect(() => validateSeedManifest(dangling)).toThrow();
  });
  it('requires exactly one owner matching its declared kind', () => {
    expect(validateOwnerBinding(binding()).ownerKind).toBe('SEED');
    expect(() => validateOwnerBinding({ ...binding(), scanPlanId: id })).toThrow();
    expect(() => validateOwnerBinding({ ...binding(), seedId: null })).toThrow();
    expect(() => validateOwnerBinding({ ...binding(), ownerKind: 'SCAN_PLAN' })).toThrow();
  });
  it('rejects duplicate owner bindings instead of multiplying their contribution', () => {
    const value = manifest(); value.bindings.push(binding()); value.contentHash = seedManifestContentHash(value);
    expect(() => validateSeedManifest(value)).toThrow();
  });
  it('rejects keyword targeting for scanning platforms and source identities on another source', () => {
    expect(() => validateSeedQuerySpec({ ...query(), sourceKey: 'tiktok_commercial_library' })).toThrow();
    expect(() => validateSeedQuerySpec({ ...query(), sourceKey: 'pinterest_ads_repository' })).toThrow();
    expect(() => validateSeedDefinitionInput({ kind: 'NATIVE_ADVERTISER', namespace: 'meta_ad_library', rawValue: '12345', normalizedValue: '12345', language: 'und', purposeTags: [], targetScope: { kind: 'CONFIGURED_MARKETS' }, targetPlatforms: ['google_ads_transparency'], status: 'DRAFT', priority: 0 })).toThrow();
  });
  it('accepts an explicit all-category scan plan and rejects invented industry classification', () => {
    const plan = { id, revision: 1, sourceKey: 'tiktok_commercial_library', targetScope: { kind: 'EXPLICIT_COUNTRIES', countries: ['DE'] }, datePolicy: { kind: 'ROLLING', windowDays: 7 }, category: 'ALL', status: 'ACTIVE', evidence: {} };
    expect(validateSeedScanPlanInput(plan).category).toBe('ALL');
    expect(() => validateSeedScanPlanInput({ ...plan, category: 'GAMES' })).toThrow();
  });
  it('accepts frozen native scanner date fields without pretending keyword support', () => {
    const tiktok = { ...query(), sourceKey: 'tiktok_commercial_library', mode: 'SWEEP', params: { country: 'DE', startDate: '2026-10-01', endDate: '2026-10-07', category: 'ALL' } };
    const pinterest = { ...query(), sourceKey: 'pinterest_ads_repository', mode: 'SWEEP', params: { country: 'DE', dateStart: '2026-10-01', dateEnd: '2026-10-07', keyword: '', category: 'ALL' } };
    expect(validateSeedQuerySpec(tiktok).mode).toBe('SWEEP'); expect(validateSeedQuerySpec(pinterest).mode).toBe('SWEEP');
    expect(() => validateSeedQuerySpec({ ...tiktok, params: { ...tiktok.params, endDate: '2026-02-30' } })).toThrow();
  });
  it('hashes unordered geography and query order consistently while preserving semantic arrays', () => {
    const first = manifest(), second = { ...query(), queryId: '22222222-2222-4222-8222-222222222222', queryKey: 'b'.repeat(64), params: { ...query().params, countries: ['FR', 'DE'] } };
    const body = { ...first, queries: [second, first.queries[0]] };
    const reordered = { ...body, queries: [first.queries[0], { ...second, params: { ...second.params, countries: ['DE', 'FR'] } }] };
    expect(seedManifestContentHash(body)).toBe(seedManifestContentHash(reordered));
    const orderedSteps = { ...second, params: { ...second.params, steps: ['first', 'second'] } };
    expect(seedManifestContentHash({ ...body, queries: [orderedSteps] })).not.toBe(seedManifestContentHash({ ...body, queries: [{ ...orderedSteps, params: { ...orderedSteps.params, steps: ['second', 'first'] } }] }));
  });
});
