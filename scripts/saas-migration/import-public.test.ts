import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { createInventoryManifest } from './inventory';
import { buildPublicImportPlan, importPublicPlan, validateImportTarget } from './import-public';

const when = '2026-10-04T00:00:00.000Z';
const row = (extra: Record<string, unknown> = {}) => ({ libraryId: '123456789', id: '123456789-0', variantIndex: 0,
  sourceUrl: 'https://www.facebook.com/ads/library/?id=123456789', advertiser: 'Public maker', copy: 'Public source copy',
  mediaType: 'image', mediaUrl: '/local-media/image.jpg', sourceMediaUrl: 'https://scontent.fbcdn.net/image.jpg?token=NOT_FOR_REPORT', status: 'active', ...extra });
function fixture(rows: unknown[], ownership: 'public' | 'unknown' = 'public') {
  const input = JSON.stringify({ version: 2, ads: rows });
  const manifest = createInventoryManifest(input, { generatedAt: when, ownership, localMediaFiles: ['image.jpg'] });
  return { input, manifest, options: { confirmManifestHash: manifest.manifestHash, localMediaFiles: ['image.jpg'], mediaEvidence: { 'image.jpg': { sha256: 'a'.repeat(64), sizeBytes: 123 } } } };
}
describe('public legacy import mapping', () => {
  it('merges source IDs while preserving variants, nullable observation time and unknown platforms', () => {
    const f = fixture([row(), row({ id: '123456789-1', variantIndex: 1, copy: 'Second public variant' })]);
    const plan = buildPublicImportPlan(f.input, f.manifest, f.options);
    expect(plan.ads).toHaveLength(1); expect(plan.ads[0].variants).toHaveLength(2);
    expect(plan.ads[0]).toMatchObject({ sourceAdId: '123456789', firstObservedAt: null, lastObservedAt: null, publisherPlatforms: [] });
    expect(plan.ads[0].media[0]).toMatchObject({ status: 'PENDING', storageKey: null, sha256: 'a'.repeat(64), errorCode: 'LEGACY_MEDIA_NOT_UPLOADED' });
    expect(plan.summary).toMatchObject({ inputCount: 2, eligibleRows: 2, ads: 1, variants: 2, repeatedStableIdRows: 1, unknownObservationRows: 2 });
    expect(JSON.stringify(plan.summary)).not.toMatch(/Public maker|Public source copy|NOT_FOR_REPORT|image\.jpg|123456789/);
  });
  it('preserves only observed facts and refuses inferred legacy targeting or dates', () => {
    const f = fixture([row({ country: 'US', startDate: '2026-01-01', collectedAt: '2026-09-04T10:00:00Z', platforms: ['Instagram'], notes: 'PRIVATE_NOTE' })]);
    const ad = buildPublicImportPlan(f.input, f.manifest, f.options).ads[0];
    expect(ad.firstObservedAt).toBe('2026-09-04T10:00:00.000Z'); expect(ad.publisherPlatforms).toEqual(['instagram']);
    expect(ad.reportedCountries).toEqual([]); expect(ad.sourceStartedAt).toBeNull();
    expect(JSON.stringify(ad)).not.toContain('PRIVATE_NOTE');
  });
  it('uses the same trimmed string identity rules as the reviewed inventory', () => {
    const numeric = fixture([row({ libraryId: 999999 })]);
    expect(buildPublicImportPlan(numeric.input, numeric.manifest, numeric.options).ads[0].sourceAdId).toBe('123456789');
    const padded = fixture([row({ libraryId: ' 123456789 ', sourceUrl: 'https://www.facebook.com/ads/library/' })]);
    expect(buildPublicImportPlan(padded.input, padded.manifest, padded.options).ads[0].sourceAdId).toBe('123456789');
  });
  it('quarantines private scope, unknown source and missing IDs without preserving their content', () => {
    const f = fixture([row({ tenantId: 'PRIVATE_TENANT', copy: 'PRIVATE_CONTENT' }), row({ sourceUrl: 'https://example.test/ad', copy: 'UNTRUSTED_CONTENT' }), row({ libraryId: '', sourceUrl: 'https://www.facebook.com/ads/library/' })]);
    const plan = buildPublicImportPlan(f.input, f.manifest, f.options);
    expect(plan.ads).toEqual([]); expect(plan.quarantined).toHaveLength(3);
    expect(JSON.stringify(plan)).not.toMatch(/PRIVATE_TENANT|PRIVATE_CONTENT|UNTRUSTED_CONTENT/);
  });
  it('requires an explicit public manifest confirmation and binds exact input bytes', () => {
    const f = fixture([row()]);
    expect(() => buildPublicImportPlan(f.input, f.manifest, { ...f.options, confirmManifestHash: '0'.repeat(64) })).toThrow('IMPORT_MANIFEST_NOT_CONFIRMED');
    expect(() => buildPublicImportPlan(f.input + '\n', f.manifest, f.options)).toThrow('IMPORT_MANIFEST_MISMATCH');
    const unknown = fixture([row()], 'unknown');
    expect(() => buildPublicImportPlan(unknown.input, unknown.manifest, unknown.options)).toThrow('IMPORT_PUBLIC_CLASSIFICATION_REQUIRED');
    expect(() => buildPublicImportPlan('{bad', f.manifest, f.options)).toThrow();
  });
  it('deduplicates exact variant content without dropping distinct duplicate-index variants', () => {
    const f = fixture([row(), row(), row({ copy: 'Different creative with same variant index' })]);
    const plan = buildPublicImportPlan(f.input, f.manifest, f.options);
    expect(plan.ads[0].variants).toHaveLength(2); expect(plan.items).toHaveLength(3);
    expect(plan.summary.exactDuplicateRows).toBe(1);
    const later = { ...f.manifest, generatedAt: '2026-10-05T00:00:00.000Z' };
    expect(buildPublicImportPlan(f.input, later, f.options).planHash).toBe(plan.planHash);
  });
  it('does not use unverified local files as ready media', () => {
    const f = fixture([row({ sourceMediaUrl: undefined })]);
    const ad = buildPublicImportPlan(f.input, f.manifest, { ...f.options, mediaEvidence: {} }).ads[0];
    expect(ad.media[0].sourceUrl).toMatch(/^legacy-local-sha256:/); expect(ad.media[0].status).toBe('PENDING'); expect(ad.media[0].storageKey).toBeNull();
  });
  it.each(['postgresql://u@remote.test/saas_migration_test', 'postgresql://u@127.0.0.1/saas_dev', 'postgresql://u:p@127.0.0.1/saas_migration_test', 'postgresql://u@127.0.0.1/saas_migration_test?host=remote.test'])('rejects unsafe import targets', url => {
    expect(() => validateImportTarget(url)).toThrow(/^IMPORT_UNSAFE_TARGET$/);
  });
  it('accepts only explicitly isolated local test database names', () => {
    expect(validateImportTarget('postgresql://saas_local@127.0.0.1:55438/saas_migration_test')).toMatchObject({ database: 'saas_migration_test', port: 55438 });
  });
});

const databaseUrl = process.env.SAAS_MIGRATION_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('public import PostgreSQL rehearsal', () => {
  it('persists public facts, repeats without writes, retains unknowns and rejects a private database', async () => {
    const require = createRequire(new URL('../../saas/app/package.json', import.meta.url)); const { PrismaClient } = require('@prisma/client');
    const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } }); const sourceId = String(Date.now());
    try {
      const f = fixture([row({ libraryId: sourceId, sourceUrl: `https://www.facebook.com/ads/library/?id=${sourceId}` }), row({ libraryId: sourceId, sourceUrl: `https://www.facebook.com/ads/library/?id=${sourceId}`, variantIndex: 1, copy: 'Second' })]);
      const plan = buildPublicImportPlan(f.input, f.manifest, f.options);
      const first = await importPublicPlan(db, plan, databaseUrl!); expect(first.status).toBe('IMPORTED');
      const ad = await db.ad.findFirstOrThrow({ where: { sourceAdId: sourceId }, include: { observations: true, media: true } });
      expect(ad.firstObservedAt).toBeNull(); expect(ad.lastObservedAt).toBeNull(); expect(ad.publisherPlatforms).toEqual([]); expect(ad.observations).toEqual([]);
      expect(ad.media[0].status).toBe('PENDING'); expect(ad.media[0].storageKey).toBeNull();
      const again = await importPublicPlan(db, plan, databaseUrl!); expect(again.status).toBe('REPLAY_VERIFIED_NO_WRITE');
      expect((await db.ad.findUniqueOrThrow({ where: { id: ad.id } })).updatedAt).toEqual(ad.updatedAt);
      const dated = fixture([row({ libraryId: sourceId, sourceUrl: `https://www.facebook.com/ads/library/?id=${sourceId}`, copy: 'Latest observed copy', collectedAt: '2026-09-04T00:00:00Z', platforms: ['Instagram'] })]);
      const datedPlan = buildPublicImportPlan(dated.input, dated.manifest, dated.options);
      await importPublicPlan(db, datedPlan, databaseUrl!);
      const earlier = fixture([row({ libraryId: sourceId, sourceUrl: `https://www.facebook.com/ads/library/?id=${sourceId}`, copy: 'Older observed copy', collectedAt: '2026-08-01T00:00:00Z' })]);
      await importPublicPlan(db, buildPublicImportPlan(earlier.input, earlier.manifest, earlier.options), databaseUrl!);
      const preserved = await db.ad.findUniqueOrThrow({ where: { id: ad.id } });
      expect(preserved.body).toBe('Latest observed copy'); expect(preserved.lastObservedAt.toISOString()).toBe('2026-09-04T00:00:00.000Z'); expect(preserved.firstObservedAt.toISOString()).toBe('2026-08-01T00:00:00.000Z');
      expect(await db.ad.count({ where: { sourceAdId: sourceId } })).toBe(1);
      expect((await importPublicPlan(db, plan, databaseUrl!)).status).toBe('REPLAY_VERIFIED_NO_WRITE');
      expect((await importPublicPlan(db, datedPlan, databaseUrl!)).status).toBe('REPLAY_VERIFIED_NO_WRITE');
      const user = await db.user.create({ data: { email: `private-${randomUUID()}@example.test` } });
      try { await expect(importPublicPlan(db, plan, databaseUrl!)).rejects.toThrow('IMPORT_DATABASE_NOT_ISOLATED'); }
      finally { await db.user.delete({ where: { id: user.id } }); }
    } finally { await db.$disconnect(); }
  });
});
