import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { seedManifestContentHash, validateSeedManifest, type OwnerBinding, type SeedConfigManifest, type SeedQuerySpec } from '@ad-research/contracts/seeds';
import { acceptConfigReceipt, scopeManifest } from './publications';

const url = process.env.SAAS_TEST_DATABASE_URL;
describe.skipIf(!url)('large applied config receipts', () => {
  it('applies 16,000 registered queries in bounded SQL pages without changing ownership or lowering revisions', async () => {
    const location = new URL(url!);
    if (!['localhost', '127.0.0.1'].includes(location.hostname) || !location.pathname.includes('_test_')) throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
    const { PrismaClient } = createRequire(new URL('../../package.json', import.meta.url))('@prisma/client');
    const db = new PrismaClient({ datasources: { db: { url } }, log: [{ emit: 'event', level: 'query' }] });
    let updates: Array<{ parameterBytes: number; queryIds: number }> = [];
    db.$on('query', (event: { query: string; params: string }) => {
      if (/^UPDATE\s+"public"\."SeedRuntimeState"/.test(event.query)) {
        const parameters: unknown[] = JSON.parse(event.params);
        updates.push({ parameterBytes: Buffer.byteLength(event.params, 'utf8'), queryIds: parameters.filter(p => typeof p === 'string' && /^[a-f0-9-]{36}$/.test(p)).length });
      }
    });
    const rollback = Error('ROLLBACK_LARGE_RECEIPT_FIXTURE');
    try {
      await db.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', 'seed-publication-head');
        const head = await tx.seedPublication.findFirst({ orderBy: { revision: 'desc' } });
        const oldRevision = (head?.revision ?? 0) + 1, revision = oldRevision + 1, suffix = randomUUID();
        const sources = await tx.dataSource.findMany({ where: { key: { in: ['meta_ad_library', 'google_ads_transparency'] } } });
        const sourceIds = new Map<string, string>(sources.map((source: any) => [source.key, source.id]));
        expect(sourceIds.size).toBe(2);
        const makeQuery = (index: number, google = false): SeedQuerySpec => ({
          queryId: randomUUID(), queryKey: createHash('sha256').update(`${suffix}:${index}`).digest('hex'), queryKeyVersion: 'legacy-1',
          sourceKey: google ? 'google_ads_transparency' : 'meta_ad_library', channel: google ? 'ATC' : 'META', mode: google ? 'DISCOVER' : 'KEYWORD',
          params: google ? { country: 'US', lang: 'en', kind: 'DISCOVER', term: suffix } : { country: 'US', language: 'en', keyword: `${suffix}-${index}`, status: 'all', mediaType: 'all' },
          legacyDims: {}, adapterVersion: 'receipt-fixture-1', capabilityVersion: 'receipt-fixture-1', desiredEnabled: true, nativeJobIds: [`native-${suffix}-${index}`],
        });
        const meta = Array.from({ length: 16_000 }, (_, index) => makeQuery(index)), google = makeQuery(16_000, true), extra = makeQuery(16_001);
        const queries = [...meta, google], bindings: OwnerBinding[] = queries.map((q, index) => ({
          queryId: q.queryId, ownerKind: 'LEGACY', seedId: null, scanPlanId: null, legacyOwnerKey: `receipt-${suffix}-${index}`, ownerRevision: 1,
          participationStatus: 'ACTIVE', purposeSnapshot: [{ family: 'ECOMMERCE', category: 'fixture' }], validFromRevision: oldRevision, validToRevision: null,
        }));
        for (let index = 0; index < queries.length; index += 500) {
          const page = queries.slice(index, index + 500);
          await tx.seedQuery.createMany({ data: page.map(q => ({ id: q.queryId, dataSourceId: sourceIds.get(q.sourceKey), sourceKey: q.sourceKey, channel: q.channel, mode: q.mode,
            normalizedParams: q.params, queryKey: q.queryKey, queryKeyVersion: q.queryKeyVersion, adapterVersion: q.adapterVersion, capabilityVersion: q.capabilityVersion, desiredEnabled: true })) });
          await tx.seedQueryBinding.createMany({ data: bindings.slice(index, index + 500) });
          await tx.legacyJobMapping.createMany({ data: page.map(q => ({ dataSourceId: sourceIds.get(q.sourceKey), sourceKey: q.sourceKey, nativeJobId: q.nativeJobIds[0], queryId: q.queryId, legacyKeyVersion: 'legacy-1' })) });
        }
        await tx.seedQuery.create({ data: { id: extra.queryId, dataSourceId: sourceIds.get(extra.sourceKey), sourceKey: extra.sourceKey, channel: extra.channel, mode: extra.mode,
          normalizedParams: extra.params, queryKey: extra.queryKey, queryKeyVersion: extra.queryKeyVersion, adapterVersion: extra.adapterVersion, capabilityVersion: extra.capabilityVersion, desiredEnabled: true } });
        const manifest = (value: number, parentRevision: number | null): SeedConfigManifest => {
          const body = { schemaVersion: 1 as const, protocolMin: 1, protocolMax: 1, publicationId: randomUUID(), revision: value, parentRevision,
            compilerVersion: 'receipt-fixture-1', capabilityVersion: 'receipt-fixture-1', createdAt: new Date().toISOString(), queries, bindings, scanPlans: [], tombstones: [], schedulePolicyVersion: 'receipt-fixture-1' };
          return validateSeedManifest({ ...body, contentHash: seedManifestContentHash(body) });
        };
        const old = manifest(oldRevision, head?.revision ?? null), current = manifest(revision, oldRevision);
        for (const value of [old, current]) await tx.seedPublication.create({ data: { id: value.publicationId, revision: value.revision, parentRevision: value.parentRevision,
          manifestHash: value.contentHash, configSnapshot: { manifest: value }, status: 'PUBLISHED', reason: 'Rollback-only registered 16,000-query receipt regression' } });
        const nodeId = `receipt-${suffix}`, otherNode = `other-${suffix}`, incarnationId = randomUUID();
        await tx.collectorNode.createMany({ data: [nodeId, otherNode].map(value => ({ nodeId: value, incarnationId: value === nodeId ? incarnationId : randomUUID(),
          registryRevision: 1, enabled: true, status: 'STANDBY_READY', codeRevision: 'fixture', protocolVersions: [1] })) });
        const owned = [meta[0], meta[499], meta[500], meta[7_999], meta[15_999]];
        const runtimes = [...owned.map(q => ({ q, collectorId: nodeId })), { q: meta[1], collectorId: otherNode }, { q: meta[2], collectorId: null },
          { q: google, collectorId: nodeId }, { q: extra, collectorId: nodeId }];
        await tx.seedRuntimeState.createMany({ data: runtimes.map(({ q, collectorId }) => ({ queryId: q.queryId, dataSourceId: sourceIds.get(q.sourceKey),
          sourceKey: q.sourceKey, collectorId, desiredRevision: revision, appliedRevision: 0, nextAllowedAt: new Date('2099-01-01T00:00:00Z'), checkpointSequence: 3,
          checkpointRef: `fixture/${q.queryId}`, checkpointSha: 'a'.repeat(64) })) });
        const proxy = new Proxy(tx, { get(target, property) { return property === '$transaction' ? async (run: (database: any) => Promise<unknown>) => run(tx) : Reflect.get(target, property); } });
        const receipt = (value: SeedConfigManifest, sequence: number) => ({ nodeId, incarnationId, sequence, publicationId: value.publicationId,
          publicationRevision: value.revision, manifestHash: scopeManifest(value, ['meta_ad_library']).contentHash, applyStatus: 'APPLIED',
          nativeJobMappings: [...meta.map(q => ({ queryId: q.queryId, nativeJobId: q.nativeJobIds[0] })), { queryId: meta[0].queryId, nativeJobId: 'unused-native-alias' }] });
        const input = { trustedNodeId: nodeId, sourceScopes: ['meta_ad_library'], receipt: receipt(current, 1) };
        updates = [];
        await expect(acceptConfigReceipt(proxy, { ...input, receipt: { ...input.receipt, incarnationId: randomUUID() } })).rejects.toMatchObject({ code: 'SEED_RECEIPT_STALE' });
        const wrongMappings = input.receipt.nativeJobMappings.map((mapping, index) => index === meta.length - 1 ? { ...mapping, nativeJobId: 'wrong' } : mapping);
        await expect(acceptConfigReceipt(proxy, { ...input, receipt: { ...input.receipt, nativeJobMappings: wrongMappings } })).rejects.toMatchObject({ code: 'SEED_RECEIPT_MAPPING' });
        expect(updates).toHaveLength(0);
        const startedAt = performance.now(), applied = await acceptConfigReceipt(proxy, input), elapsedMs = performance.now() - startedAt;
        expect(applied.status).toBe('APPLIED');
        const rows = await tx.seedRuntimeState.findMany({ where: { queryId: { in: runtimes.map(({ q }) => q.queryId) } } });
        for (const { q, collectorId } of runtimes) {
          const row = rows.find((value: any) => value.queryId === q.queryId);
          expect(row.collectorId).toBe(collectorId);
          expect(row.appliedRevision).toBe(owned.includes(q) ? revision : 0);
          expect(row).toMatchObject({ desiredRevision: revision, checkpointSequence: 3, nextAllowedAt: new Date('2099-01-01T00:00:00Z') });
        }
        // Count emitted PostgreSQL UPDATE statements, including pages with zero matches.
        expect(updates.length, `Actual runtime UPDATE SQL count: ${updates.length}`).toBeLessThanOrEqual(50);
        expect(updates).toHaveLength(32);
        expect(updates.every(page => page.queryIds <= 500 && page.parameterBytes <= 4 * 1024 * 1024)).toBe(true);
        expect(elapsedMs, 'APPLIED must fit the unchanged default five-second production transaction').toBeLessThan(5_000);
        console.info(`APPLIED_SCALE queries=16000 runtimeUpdateSql=${updates.length} maxIds=${Math.max(...updates.map(page => page.queryIds))} maxParameterBytes=${Math.max(...updates.map(page => page.parameterBytes))} elapsedMs=${Math.ceil(elapsedMs)}`);
        updates = [];
        expect(await acceptConfigReceipt(proxy, input)).toEqual(applied);
        expect(updates).toHaveLength(0);
        const older = await acceptConfigReceipt(proxy, { ...input, receipt: receipt(old, 2) });
        expect(older.status).toBe('APPLIED');
        expect(updates).toHaveLength(32);
        expect(await tx.seedRuntimeState.count({ where: { queryId: { in: owned.map(q => q.queryId) }, appliedRevision: revision, collectorId: nodeId } })).toBe(owned.length);
        const saved = await tx.seedCollectorReceipt.findUniqueOrThrow({ where: { id: applied.receiptId } });
        expect(saved.queryCounts.queryIds).toHaveLength(16_000);
        expect(saved.queryCounts.sourceScopes).toEqual(['meta_ad_library']);
        expect(await tx.seedCollectorReceipt.count({ where: { nodeId } })).toBe(2);
        throw rollback;
      }, { timeout: 180_000, maxWait: 30_000 });
    } catch (error) { if (error !== rollback) throw error; }
    finally { await db.$disconnect(); }
  }, 180_000);
});
