import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverCommittedRun, extractPublicClues, upsertDiscoveredClues, type CommittedDiscoveryRun } from './seed-discovery';

const sourcePrefixes: Record<string, string> = { meta_ad_library: 'meta-service', google_ads_transparency: 'google-service', tiktok_commercial_library: 'tiktok-service', pinterest_ads_repository: 'pinterest-service', snapchat_ads_gallery: 'snapchat-service' };
function fixture(sourceKey = 'meta_ad_library', snapshot: Record<string, unknown> = {}, archiveFields: Record<string, unknown> = {}) {
  const ad = { sourceAdId: '11111', sourceUrl: 'https://www.facebook.com/ads/library/?id=11111', advertiserName: '  Café Coffee  ', landingPageUrl: 'https://shop.example.com/item?signature=private', ...snapshot };
  const batch = { sourceKey, observedAt: '2026-10-10T01:00:00Z', ads: [ad], advertisers: [], evidence: [], ...archiveFields };
  const bytes = Buffer.from(JSON.stringify(batch)); const sha = createHash('sha256').update(bytes).digest('hex');
  const run: CommittedDiscoveryRun = {
    id: 'run', dataSourceId: 'source', sourceKey, status: 'SUCCEEDED', finishedAt: '2026-10-10T02:00:00Z', idempotencyKey: `${sourcePrefixes[sourceKey]}:${sha}`,
    items: [{ sourceAdId: String(ad.sourceAdId), adId: 'ad', dataSourceId: 'source', runId: 'run', status: 'INGESTED', evidenceSha256: sha }],
    observations: [{ id: 'observation', collectionRunId: 'run', adId: 'ad', dataSourceId: 'source', observedAt: '2026-10-10T01:00:00Z', evidenceSha256: sha, snapshot: ad }],
  };
  return { run, bytes, sha };
}
const input = (f: ReturnType<typeof fixture>, version = 'public-clues-1') => ({ run: f.run, archiveBytes: f.bytes, batchSha256: f.sha, extractionVersion: version });
describe('committed public clue extraction', () => {
  it('uses frozen observations, preserving original names and normalized search keys', () => {
    const f = fixture(); const clues = extractPublicClues(input(f));
    const name = clues.find(clue => clue.kind === 'NAME')!;
    expect(name).toMatchObject({ rawValue: '  Café Coffee  ', normalizedValue: 'café coffee', namespace: 'public', language: 'und', verificationStatus: 'CANDIDATE', role: 'PUBLIC_NAME', observationId: 'observation', runId: 'run', sourceAdId: '11111', observedAt: '2026-10-10T01:00:00.000Z' });
    expect(clues.find(clue => clue.kind === 'DOMAIN')).toMatchObject({ rawValue: 'shop.example.com', normalizedValue: 'shop.example.com', role: 'LANDING_HOST' });
    expect(JSON.stringify(clues)).not.toContain('signature=private');
  });
  it.each([{ status: 'RUNNING', finishedAt: null }, { status: 'QUEUED', finishedAt: null }])('rejects an uncommitted run', change => {
    const f = fixture(); Object.assign(f.run, change); expect(() => extractPublicClues(input(f))).toThrow('DISCOVERY_RUN_NOT_COMMITTED');
  });
  it('rejects a mismatched archive hash before interpreting any fields', () => {
    const f = fixture(); expect(() => extractPublicClues({ ...input(f), archiveBytes: Buffer.concat([f.bytes, Buffer.from(' ')]) })).toThrow('DISCOVERY_ARCHIVE_HASH_MISMATCH');
  });
  it('rejects a hash that is not bound to the committed batch', () => {
    const f = fixture(); f.run.idempotencyKey = 'meta-service:' + '0'.repeat(64);
    expect(() => extractPublicClues(input(f))).toThrow('DISCOVERY_BATCH_BINDING_MISMATCH');
  });
  it('rejects source and run/observation identity mismatches', () => {
    const f = fixture(); f.run.sourceKey = 'google_ads_transparency'; expect(() => extractPublicClues(input(f))).toThrow('DISCOVERY_SOURCE_MISMATCH');
    const g = fixture(); g.run.observations[0].collectionRunId = 'another-run'; expect(() => extractPublicClues(input(g))).toThrow('DISCOVERY_FACT_BINDING_MISMATCH');
  });
  it('does not consume quarantined or pending ad items', () => {
    const f = fixture(); f.run.items[0].status = 'QUARANTINED'; expect(extractPublicClues(input(f))).toEqual([]);
  });
  it('keeps an old Meta parsed Page ID as a candidate without embedded payload proof', () => {
    const f = fixture('meta_ad_library', {}, { advertisers: [{ sourceAdId: '11111', pageId: '123456', pageName: 'Café Coffee' }] });
    expect(extractPublicClues(input(f)).find(clue => clue.kind === 'NATIVE_ADVERTISER')).toMatchObject({ rawValue: '123456', namespace: 'meta_ad_library', verificationStatus: 'CANDIDATE', role: 'SOURCE_IDENTITY' });
  });
  it('verifies a Meta Page ID only when original embedded payload and committed ad agree', () => {
    const f = fixture('meta_ad_library', {}, { advertisers: [{ sourceAdId: '11111', pageId: '123456', pageName: 'Café Coffee' }], evidence: [{ kind: 'embedded-listing', url: 'https://www.facebook.com/ads/library/', httpStatus: 200, payload: { ad_archive_id: '11111', page_id: '123456' } }] });
    expect(extractPublicClues(input(f)).find(clue => clue.kind === 'NATIVE_ADVERTISER')).toMatchObject({ rawValue: '123456', verificationStatus: 'VERIFIED', fieldPath: 'archive.evidence[0].payload.page_id' });
  });
  it('does not verify or invent an identity from a mismatched Meta payload or missing run item', () => {
    const f = fixture('meta_ad_library', {}, { advertisers: [{ sourceAdId: '22222', pageId: '123456' }], evidence: [{ kind: 'embedded-listing', url: 'https://www.facebook.com/ads/library/', httpStatus: 200, payload: { ad_archive_id: '11111', page_id: '999999' } }] });
    expect(extractPublicClues(input(f)).filter(clue => clue.kind === 'NATIVE_ADVERTISER')).toEqual([]);
  });
  it('does not promote hashed or ad-local placeholders into source identities', () => {
    const f = fixture('meta_ad_library', { sourceAdvertiserId: 'page-url-sha256:' + 'a'.repeat(64) }, { advertisers: [{ sourceAdId: '11111', pageId: 'ad-local:11111' }] });
    expect(extractPublicClues(input(f)).filter(clue => clue.kind === 'NATIVE_ADVERTISER')).toEqual([]);
  });
  it('verifies Google native identity from the frozen official creative identity', () => {
    const f = fixture('google_ads_transparency', { sourceAdId: 'CR123456', sourceUrl: 'https://adstransparency.google.com/advertiser/AR654321/creative/CR123456', advertiserId: 'AR654321' });
    expect(extractPublicClues(input(f)).find(clue => clue.kind === 'NATIVE_ADVERTISER')).toMatchObject({ rawValue: 'AR654321', namespace: 'google_ads_transparency', verificationStatus: 'VERIFIED' });
  });
  it('keeps Snapchat paying advertiser and displayed profile in different roles and namespaces', () => {
    const f = fixture('snapchat_ads_gallery', { sourceAdId: '4a59f44d-49f2-42d8-8faf-de3d7ec98a18', sourceUrl: 'https://adsgallery.snap.com/?adId=4a59f44d-49f2-42d8-8faf-de3d7ec98a18', advertiserName: 'Funding Corp', brand: 'Game Studio', sourceAdvertiserId: 'ad-local:fake' });
    const clues = extractPublicClues(input(f));
    expect(clues.find(clue => clue.rawValue === 'Funding Corp')).toMatchObject({ role: 'PAYING_ADVERTISER', namespace: 'payer:snapchat_ads_gallery' });
    expect(clues.find(clue => clue.rawValue === 'Game Studio')).toMatchObject({ role: 'DISPLAY_NAME', namespace: 'public' });
    expect(clues.some(clue => clue.kind === 'NATIVE_ADVERTISER')).toBe(false);
  });
  it('records app-store landing hosts as shared platform evidence, not owned brand domains', () => {
    const f = fixture('meta_ad_library', { landingPageUrl: 'https://apps.apple.com/us/app/game/id123456?utm_source=private' });
    expect(extractPublicClues(input(f)).find(clue => clue.kind === 'DOMAIN')).toMatchObject({ rawValue: 'apps.apple.com', namespace: 'shared-platform', role: 'SHARED_PLATFORM_HOST', verificationStatus: 'CANDIDATE' });
  });
  it.each(['https://user:secret@shop.example.com/', 'http://127.0.0.1/', 'http://[::1]/', 'http://localhost/', 'javascript:alert(1)'])('rejects unsafe landing hosts: %s', landingPageUrl => {
    const f = fixture('meta_ad_library', { landingPageUrl }); expect(extractPublicClues(input(f)).filter(clue => clue.kind === 'DOMAIN')).toEqual([]);
  });
  it('makes extraction replays stable and retains a new extractor version as separate evidence', () => {
    const f = fixture(); const first = extractPublicClues(input(f)); const again = extractPublicClues(input(f)); const changed = extractPublicClues(input(f, 'public-clues-2'));
    expect(again).toEqual(first); expect(first[0].dedupeKey).not.toBe(changed[0].dedupeKey);
  });
  it('extracts an identity-only Google discovery without claiming a matching source ad', () => {
    const f = fixture('google_ads_transparency', {}, { ads: [], advertisers: [{ advertiserId: 'AR123456', name: 'Coffee', sourceUrl: 'https://adstransparency.google.com/advertiser/AR123456' }], evidence: [{ kind: 'advertiser', url: 'https://adstransparency.google.com/advertiser/AR123456', httpStatus: 200, text: 'Coffee' }] });
    f.run.items = []; f.run.observations = [];
    const clue = extractPublicClues(input(f)).find(clue => clue.kind === 'NATIVE_ADVERTISER')!;
    expect(clue).toMatchObject({ verificationStatus: 'VERIFIED', runId: 'run', adId: null, observationId: null });
  });
  it('extracts committed Google sponsored search domains as clues without attributing ads', () => {
    const f = fixture('google_ads_transparency', {}, { ads: [], query: { kind: 'SERP' }, searchObservations: [{ text: 'Sponsored', landingPageUrl: 'https://shop.example.com/item?token=secret', domain: 'shop.example.com' }] });
    f.run.items = []; f.run.observations = [];
    expect(extractPublicClues(input(f)).find(clue => clue.kind === 'DOMAIN')).toMatchObject({ rawValue: 'shop.example.com', role: 'SPONSORED_RESULT_HOST', adId: null });
  });
  it('retains a Google native candidate when exact archived bytes are unavailable', () => {
    const f = fixture('google_ads_transparency', { sourceAdId: 'CR123456', sourceUrl: 'https://adstransparency.google.com/advertiser/AR654321/creative/CR123456', advertiserId: 'AR654321' });
    const clue = extractPublicClues({ run: f.run, extractionVersion: 'public-clues-1' }).find(clue => clue.kind === 'NATIVE_ADVERTISER');
    expect(clue).toMatchObject({ rawValue: 'AR654321', verificationStatus: 'CANDIDATE' });
  });
  it('appends independently addressable original proof when an archive arrives after a Google candidate', () => {
    const f = fixture('google_ads_transparency', { sourceAdId: 'CR123456', sourceUrl: 'https://adstransparency.google.com/advertiser/AR654321/creative/CR123456', advertiserId: 'AR654321' });
    const candidate = extractPublicClues({ run: f.run, extractionVersion: 'public-clues-1' }).find(clue => clue.kind === 'NATIVE_ADVERTISER')!;
    const proof = extractPublicClues(input(f)).find(clue => clue.kind === 'NATIVE_ADVERTISER')!;
    expect(proof.fieldPath).toBe('archive.ads[0].advertiserId'); expect(proof.dedupeKey).not.toBe(candidate.dedupeKey);
  });
  it('does not verify Google identity when the original creative URL contradicts the frozen observation', () => {
    const ad = { sourceAdId: 'CR123456', sourceUrl: 'https://adstransparency.google.com/advertiser/AR654321/creative/CR999999', advertiserId: 'AR654321' };
    const f = fixture('google_ads_transparency', { ...ad, sourceUrl: 'https://adstransparency.google.com/advertiser/AR654321/creative/CR123456' }, { ads: [ad] });
    expect(extractPublicClues(input(f)).some(clue => clue.kind === 'NATIVE_ADVERTISER' && clue.verificationStatus === 'VERIFIED')).toBe(false);
  });
  it('does not guess a source ad match for an observation that has no committed item', () => {
    const f = fixture(); f.run.items[0].sourceAdId = '99999'; expect(extractPublicClues(input(f))).toEqual([]);
  });
  it('retains the TikTok public ad identity URL without carrying unrelated query parameters', () => {
    const f = fixture('tiktok_commercial_library', { sourceAdId: '1234567890', sourceUrl: 'https://library.tiktok.com/ads/detail/?ad_id=1234567890&signature=private', sourceAdvertiserId: 'ad-local:1234567890' });
    const clues = extractPublicClues(input(f)); expect(clues[0].sourceUrl).toBe('https://library.tiktok.com/ads/detail/?ad_id=1234567890');
    expect(clues.some(clue => clue.kind === 'NATIVE_ADVERTISER')).toBe(false);
  });
  it('keeps Pinterest public names as candidates without guessing an advertiser ID', () => {
    const f = fixture('pinterest_ads_repository', { sourceAdId: '1234567890', sourceUrl: 'https://ads.pinterest.com/ads-repository/1234567890/', advertiserName: 'Coffee Shop' });
    const clues = extractPublicClues(input(f)); expect(clues.find(clue => clue.kind === 'NAME')).toMatchObject({ rawValue: 'Coffee Shop', namespace: 'public', verificationStatus: 'CANDIDATE' });
    expect(clues.some(clue => clue.kind === 'NATIVE_ADVERTISER')).toBe(false);
  });
});

describe('server-owned committed discovery boundary', () => {
  const loaded = (f: ReturnType<typeof fixture>) => ({ ...f.run, task: { dataSourceId: f.run.dataSourceId, dataSource: { key: f.run.sourceKey } } });
  it('checks run/source identity before reading an artifact', async () => {
    const f = fixture(); let reads = 0;
    const db = { collectionRun: { findUnique: async () => loaded(f) } } as any;
    const store = { putIfAbsent: async () => 'CREATED' as const, get: async () => { reads++; return f.bytes; } };
    await expect(discoverCommittedRun(db, { runId: f.run.id, sourceKey: 'google_ads_transparency', batchSha256: f.sha, archiveKey: `private-batches/meta_ad_library/${f.sha}.bin`, extractionVersion: 'public-clues-1' }, store)).rejects.toThrow('DISCOVERY_SOURCE_MISMATCH');
    expect(reads).toBe(0);
  });
  it.each(['https://example.com/archive.bin', '../meta_ad_library/hash.bin', 'private-batches/google_ads_transparency/hash.bin'])('rejects an arbitrary URL or mismatched artifact namespace: %s', async archiveKey => {
    const f = fixture(); let reads = 0;
    const db = { collectionRun: { findUnique: async () => loaded(f) } } as any;
    const store = { putIfAbsent: async () => 'CREATED' as const, get: async () => { reads++; return f.bytes; } };
    await expect(discoverCommittedRun(db, { runId: f.run.id, sourceKey: f.run.sourceKey, batchSha256: f.sha, archiveKey, extractionVersion: 'public-clues-1' }, store)).rejects.toThrow('DISCOVERY_ARCHIVE_REFERENCE_INVALID'); expect(reads).toBe(0);
  });
});

const url = process.env.SAAS_TEST_DATABASE_URL;
const localDatabase = url && (() => { try { const target = new URL(url); return ['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname.includes('_test_'); } catch { return false; } })();
let db: any;
beforeAll(async () => { if (!localDatabase) return; const require = createRequire(new URL('../../web/package.json', import.meta.url)); const { PrismaClient } = require('@prisma/client'); db = new PrismaClient({ datasources: { db: { url } } }); });
afterAll(async () => { await db?.$disconnect(); });
describe.skipIf(!localDatabase)('discovered clues project to isolated PostgreSQL atomically', () => {
  async function isolated(body: (tx: any, f: ReturnType<typeof fixture>) => Promise<void>) {
    const stop = new Error('TEST_ROLLBACK');
    try { await db.$transaction(async (tx: any) => {
      const suffix = randomUUID(); const sourceAdId = BigInt('0x' + suffix.replaceAll('-', '')).toString();
      const f = fixture('meta_ad_library', { sourceAdId, advertiserName: `Synthetic ${suffix}`, landingPageUrl: null });
      const source = await tx.dataSource.upsert({ where: { key: f.run.sourceKey }, create: { key: f.run.sourceKey, name: 'Synthetic discovery source', adapterVersion: 'fixture' }, update: {} });
      const task = await tx.collectionTask.create({ data: { dataSourceId: source.id, name: 'Synthetic discovery', query: {}, status: 'PAUSED' } });
      const run = await tx.collectionRun.create({ data: { dataSourceId: source.id, taskId: task.id, querySnapshot: {}, adapterVersion: 'fixture', idempotencyKey: `${sourcePrefixes[f.run.sourceKey]}:${f.sha}`, status: 'SUCCEEDED', finishedAt: new Date() } });
      const ad = await tx.ad.create({ data: { dataSourceId: source.id, sourceAdId, sourceUrl: 'https://example.com/public' } });
      await tx.runItem.create({ data: { runId: run.id, dataSourceId: source.id, sourceAdId, adId: ad.id, itemKey: sourceAdId, status: 'INGESTED', parserVersion: 'fixture', evidenceSha256: f.sha } });
      const observation = await tx.adObservation.create({ data: { dataSourceId: source.id, adId: ad.id, collectionRunId: run.id, observedAt: new Date('2026-10-10T01:00:00Z'), snapshot: f.run.observations[0].snapshot, parserVersion: 'fixture', evidenceSha256: f.sha } });
      f.run.id = run.id; f.run.dataSourceId = source.id; Object.assign(f.run.items[0], { runId: run.id, dataSourceId: source.id, adId: ad.id }); Object.assign(f.run.observations[0], { id: observation.id, collectionRunId: run.id, dataSourceId: source.id, adId: ad.id });
      await body(tx, f); throw stop;
    }); } catch (error) { if (error !== stop) throw error; }
  }
  it('writes one draft with evidence, while replay never creates ad matches or duplicates', () => isolated(async (tx, f) => {
    const clues = extractPublicClues(input(f)); const first = await upsertDiscoveredClues(tx, clues); const replay = await upsertDiscoveredClues(tx, clues);
    expect(first.seedsCreated).toBe(1); expect(first.evidenceCreated).toBe(1); expect(replay.evidenceCreated).toBe(0);
    const seed = await tx.seedDefinition.findUnique({ where: { kind_namespace_language_normalizedValue: { kind: 'NAME', namespace: 'public', language: 'und', normalizedValue: clues[0].normalizedValue } } });
    expect(seed.status).toBe('DRAFT'); expect(seed.verificationStatus).toBe('CANDIDATE');
    expect(await tx.seedEvidence.count({ where: { runId: f.run.id } })).toBe(1); expect(await tx.seedAttemptMatch.count({ where: { adId: f.run.items[0].adId } })).toBe(0);
  }));
  it('preserves a paused operator configuration on a later discovery replay', () => isolated(async (tx, f) => {
    const clues = extractPublicClues(input(f)); await upsertDiscoveredClues(tx, clues);
    const seed = await tx.seedDefinition.findFirst({ where: { normalizedValue: clues[0].normalizedValue } }); await tx.seedDefinition.update({ where: { id: seed.id }, data: { status: 'PAUSED', priority: 9 } });
    await upsertDiscoveredClues(tx, extractPublicClues(input(f, 'public-clues-2')));
    expect(await tx.seedDefinition.findUnique({ where: { id: seed.id } })).toMatchObject({ status: 'PAUSED', priority: 9 });
  }));
  it('reads the real committed run, items and frozen observations through the worker entry point', () => isolated(async (tx, f) => {
    let reads = 0;
    const store = { putIfAbsent: async () => 'CREATED' as const, get: async () => { reads++; return f.bytes; } };
    const args = { runId: f.run.id, sourceKey: f.run.sourceKey, batchSha256: f.sha, archiveKey: `private-batches/${f.run.sourceKey}/${f.sha}.bin`, extractionVersion: 'public-clues-1' };
    expect(await discoverCommittedRun(tx, args, store)).toMatchObject({ seedsCreated: 1, evidenceCreated: 1 });
    expect(await discoverCommittedRun(tx, args, store)).toMatchObject({ seedsCreated: 0, evidenceCreated: 0 }); expect(reads).toBe(2);
  }));
  it('stores PENDING domain relationships, and preserves a rejected decision when new evidence arrives', () => isolated(async (tx, f) => {
    Object.assign(f.run.observations[0].snapshot as object, { landingPageUrl: 'https://synthetic-' + randomUUID() + '.example.com/landing' });
    await upsertDiscoveredClues(tx, extractPublicClues({ run: f.run, extractionVersion: 'public-clues-1' }));
    const relation = await tx.seedRelation.findFirst({ where: { evidenceIds: { isEmpty: false }, fromSeed: { evidence: { some: { runId: f.run.id } } } } });
    expect(relation.status).toBe('PENDING'); expect(relation.relationType).toBe('DOMAIN_OF');
    await tx.seedRelation.update({ where: { id: relation.id }, data: { status: 'REJECTED', decisionReason: 'Synthetic manual decision' } });
    await upsertDiscoveredClues(tx, extractPublicClues({ run: f.run, extractionVersion: 'public-clues-2' }));
    expect(await tx.seedRelation.findUnique({ where: { id: relation.id } })).toMatchObject({ status: 'REJECTED', decisionReason: 'Synthetic manual decision' });
    expect(await tx.seedAttemptMatch.count({ where: { adId: f.run.items[0].adId } })).toBe(0);
  }));
  it('promotes only a native candidate with paired original proof while retaining paused intent', () => isolated(async (tx, f) => {
    const sourceAdId = f.run.items[0].sourceAdId!; const pageId = BigInt('0x' + randomUUID().replaceAll('-', '')).toString();
    const ad = f.run.observations[0].snapshot;
    const archive = { sourceKey: f.run.sourceKey, observedAt: '2026-10-10T01:00:00Z', ads: [ad], advertisers: [{ sourceAdId, pageId }], evidence: [{ kind: 'embedded-listing', url: 'https://www.facebook.com/ads/library/', httpStatus: 200, payload: { ad_archive_id: sourceAdId, page_id: pageId } }] };
    const bytes = Buffer.from(JSON.stringify(archive)); const sha = createHash('sha256').update(bytes).digest('hex');
    f.bytes = bytes; f.sha = sha; f.run.idempotencyKey = `meta-service:${sha}`; f.run.items[0].evidenceSha256 = sha; f.run.observations[0].evidenceSha256 = sha;
    await tx.collectionRun.update({ where: { id: f.run.id }, data: { idempotencyKey: f.run.idempotencyKey } });
    await tx.runItem.updateMany({ where: { runId: f.run.id }, data: { evidenceSha256: sha } });
    await tx.adObservation.update({ where: { id: f.run.observations[0].id }, data: { evidenceSha256: sha } });
    await tx.seedDefinition.create({ data: { kind: 'NATIVE_ADVERTISER', namespace: f.run.sourceKey, rawValue: pageId, normalizedValue: pageId, language: 'und', targetScope: { kind: 'CONFIGURED_MARKETS' }, targetPlatforms: [f.run.sourceKey], status: 'PAUSED', priority: 11, verificationStatus: 'CANDIDATE' } });
    const report = await upsertDiscoveredClues(tx, extractPublicClues(input(f))); expect(report.nativeVerified).toBe(1);
    expect(await tx.seedDefinition.findUnique({ where: { kind_namespace_language_normalizedValue: { kind: 'NATIVE_ADVERTISER', namespace: f.run.sourceKey, language: 'und', normalizedValue: pageId } } })).toMatchObject({ status: 'PAUSED', priority: 11, verificationStatus: 'VERIFIED', revision: 2 });
  }));
  it('rejects clues whose asserted hash is not the persisted committed batch', () => isolated(async (tx, f) => {
    const clues = extractPublicClues(input(f)); clues[0].evidenceSha256 = '0'.repeat(64);
    await expect(upsertDiscoveredClues(tx, clues)).rejects.toThrow('DISCOVERY_BATCH_BINDING_MISMATCH');
    expect(await tx.seedEvidence.count({ where: { runId: f.run.id } })).toBe(0);
  }));
});
