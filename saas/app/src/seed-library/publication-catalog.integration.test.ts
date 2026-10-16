import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { seedCanonical, seedManifestContentHash, validateSeedManifest, type SeedQuerySpec } from '@ad-research/contracts/seeds';
import { legacyQueryIdentity } from './legacy-query-key';
import { previewPublication, readNativeCapabilities } from './publications';

const url = process.env.SAAS_TEST_DATABASE_URL;
describe.skipIf(!url)('bounded large publication catalog compilation', () => {
  it('compiles 16,000 additional registered runtimes with exact legacy owners, native references and catalog digest', async () => {
    const location = new URL(url!);
    if (!['localhost', '127.0.0.1'].includes(location.hostname) || !location.pathname.includes('_test_')) throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
    const { PrismaClient } = createRequire(new URL('../../package.json', import.meta.url))('@prisma/client');
    const db = new PrismaClient({ datasources: { db: { url } } }), rollback = Error('ROLLBACK_CATALOG_SCALE');
    try {
      await db.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended('seed-publication-head',0))");
        const suffix = randomUUID(), admin = await tx.user.create({ data: { email: `catalog-${suffix}@example.test`, isAdmin: true } });
        const head = await tx.seedPublication.findFirst({ where: { status: 'PUBLISHED' }, orderBy: { revision: 'desc' } });
        const provisional = (await tx.seedQueryBinding.aggregate({ _max: { validFromRevision: true } }))._max.validFromRevision ?? 0;
        const epoch = Math.max(head?.revision ?? 0, provisional) + 1, revision = epoch + 3;
        await tx.seedDefinition.updateMany({ data: { status: 'ARCHIVED' } });
        await tx.seedScanPlan.updateMany({ data: { status: 'ARCHIVED' } });
        const source = await tx.dataSource.findUniqueOrThrow({ where: { key: 'meta_ad_library' } });
        await tx.dataSource.update({ where: { id: source.id }, data: { capabilities: { seedDispatch: { verification: 'VERIFIED', profiles: [{ sourceKey: source.key,
          channel: 'META', modes: ['KEYWORD'], countries: ['US'], version: 'catalog-fixture-1', adapterVersion: 'meta-service-dom-1' }] } } } });
        const queries: SeedQuerySpec[] = Array.from({ length: 16_000 }, (_, index) => {
          const params = { country: 'US', language: 'en', keyword: `catalog-${suffix}-${index}`, status: 'all', mediaType: 'all' };
          return { queryId: randomUUID(), queryKey: legacyQueryIdentity(source.key, params).key, queryKeyVersion: 'legacy-1', sourceKey: 'meta_ad_library', channel: 'META', mode: 'KEYWORD', params,
            legacyDims: {}, adapterVersion: 'meta-service-dom-1', capabilityVersion: 'catalog-fixture-1', desiredEnabled: true, nativeJobIds: [`old-${suffix}-${index}`, `alias-${suffix}-${index}`] };
        });
        for (let index = 0; index < queries.length; index += 500) {
          const page = queries.slice(index, index + 500);
          await tx.seedQuery.createMany({ data: page.map(q => ({ id: q.queryId, dataSourceId: source.id, sourceKey: source.key, channel: q.channel, mode: q.mode, normalizedParams: q.params,
            queryKey: q.queryKey, queryKeyVersion: q.queryKeyVersion, adapterVersion: q.adapterVersion, capabilityVersion: q.capabilityVersion, desiredEnabled: true })) });
          await tx.seedRuntimeState.createMany({ data: page.map(q => ({ queryId: q.queryId, dataSourceId: source.id, sourceKey: source.key,
            nativeJobId: q.queryId === queries[3].queryId ? `runtime-${suffix}` : null, nextAllowedAt: new Date('2099-01-01T00:00:00Z') })) });
        }
        const ownerA = `owner-a-${suffix}`, ownerB = `owner-b-${suffix}`, ownerC = `owner-c-${suffix}`, ownerD = `owner-d-${suffix}`;
        await tx.seedQueryBinding.createMany({ data: [
          { queryId: queries[0].queryId, legacyOwnerKey: ownerA, ownerRevision: 1, validFromRevision: epoch, validToRevision: epoch + 1 },
          { queryId: queries[0].queryId, legacyOwnerKey: ownerA, ownerRevision: 2, validFromRevision: epoch + 1, validToRevision: null },
          { queryId: queries[0].queryId, legacyOwnerKey: ownerB, ownerRevision: 1, validFromRevision: epoch, validToRevision: null },
          { queryId: queries[1].queryId, legacyOwnerKey: ownerC, ownerRevision: 1, validFromRevision: epoch, validToRevision: null },
          { queryId: queries[2].queryId, legacyOwnerKey: ownerD, ownerRevision: 1, validFromRevision: epoch, validToRevision: epoch + 1 },
        ].map(binding => ({ ...binding, ownerKind: 'LEGACY', purposeSnapshot: [], participationStatus: 'ACTIVE' })) });
        await tx.legacyJobMapping.createMany({ data: [queries[0], queries[0], queries[1], queries[2]].map((q, index) => ({ queryId: q.queryId, dataSourceId: source.id,
          sourceKey: source.key, nativeJobId: `${index === 1 ? 'extra-alias' : 'legacy'}-${suffix}-${index}`, legacyKeyVersion: 'legacy-1' })) });
        const tieIds = [randomUUID(), randomUUID()].sort();
        await tx.auditEvent.createMany({ data: [
          ...Array.from({ length: 501 }, (_, index) => ({ id: randomUUID(), createdAt: new Date('2098-01-01T00:00:00Z'), result: { sourceKey: source.key, legacyOwnerKey: `unused-${suffix}-${index}`, status: 'ACTIVE', ownerRevision: 1 } })),
          { id: tieIds[0], createdAt: new Date('2099-01-01T00:00:00Z'), result: { sourceKey: source.key, legacyOwnerKey: ownerC, status: 'ACTIVE', ownerRevision: 2 } },
          { id: tieIds[1], createdAt: new Date('2099-01-01T00:00:00Z'), result: { sourceKey: source.key, legacyOwnerKey: ownerC, status: 'PAUSED', ownerRevision: 3 } },
          { id: randomUUID(), createdAt: new Date('2099-01-01T00:00:00Z'), result: { sourceKey: source.key, legacyOwnerKey: ownerA, status: 'ACTIVE', ownerRevision: 7 } },
        ].map(({ result, ...event }) => ({ ...event, actorUserId: admin.id, action: 'SEED_LEGACY_OWNER_STATUS_SET', targetType: 'SeedLibrary', metadata: { result } })) });
        const seeds = [];
        for (const q of [queries[3], queries[4]]) seeds.push(await tx.seedDefinition.create({ data: { kind: 'KEYWORD', namespace: 'catalog-scale', rawValue: q.params.keyword,
          normalizedValue: q.params.keyword, language: 'en', purposeTags: [], targetScope: { kind: 'EXPLICIT_COUNTRIES', countries: ['US'] }, targetPlatforms: [source.key], status: 'ACTIVE', priority: 0, createdByUserId: admin.id } }));
        const body = { schemaVersion: 1 as const, protocolMin: 1, protocolMax: 1, publicationId: randomUUID(), revision, parentRevision: head?.revision ?? null,
          compilerVersion: 'catalog-fixture-1', capabilityVersion: 'catalog-fixture-1', createdAt: new Date().toISOString(), queries: [queries[3], queries[4]], bindings: [], scanPlans: [], tombstones: [], schedulePolicyVersion: 'catalog-fixture-1' };
        const previous = validateSeedManifest({ ...body, contentHash: seedManifestContentHash(body) });
        await tx.seedPublication.create({ data: { id: previous.publicationId, revision, parentRevision: previous.parentRevision, status: 'PUBLISHED', manifestHash: previous.contentHash,
          configSnapshot: { manifest: previous }, reason: 'Rollback-only native reference fixture' } });
        // Build the previous algorithm's digest from real rows. Its joined
        // mapping relation is small; the 16,000 query/runtime relation is not.
        const [allSeeds, allPlans, allSources, mappings, intents] = await Promise.all([
          tx.seedDefinition.findMany({ orderBy: { id: 'asc' } }), tx.seedScanPlan.findMany({ orderBy: { id: 'asc' } }), tx.dataSource.findMany({ orderBy: { id: 'asc' } }),
          tx.legacyJobMapping.findMany({ include: { query: { include: { bindings: { where: { ownerKind: 'LEGACY' }, orderBy: [{ validFromRevision: 'desc' }, { id: 'desc' }] } } } }, orderBy: { id: 'asc' } }),
          tx.auditEvent.findMany({ where: { action: 'SEED_LEGACY_OWNER_STATUS_SET' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
        ]);
        const legacy = mappings.flatMap((mapping: any) => {
          const owners = [...new Map<string, any>(mapping.query.bindings.map((binding: any) => [binding.legacyOwnerKey, binding]).reverse()).values()];
          return (owners.length ? owners : [null]).map((binding: any) => {
            const intent = intents.find((event: any) => event.metadata?.result?.sourceKey === mapping.sourceKey && event.metadata?.result?.legacyOwnerKey === binding?.legacyOwnerKey)?.metadata?.result;
            return { queryId: mapping.queryId, nativeJobId: mapping.nativeJobId, legacyOwnerKey: binding?.legacyOwnerKey,
              legacyOwnerStatus: intent?.status ?? (binding?.validToRevision ? 'REMOVED' : binding?.participationStatus), legacyOwnerRevision: intent?.ownerRevision ?? binding?.ownerRevision };
          });
        });
        const expectedDigest = createHash('sha256').update(seedCanonical({ seeds: allSeeds.map((seed: any) => ({ id: seed.id, revision: seed.revision, status: seed.status })),
          plans: allPlans.map((plan: any) => ({ id: plan.id, revision: plan.revision, status: plan.status })), capabilities: readNativeCapabilities(allSources), legacy })).digest('hex');
        let compiling = false, headReads = 0;
        const reads: Array<{ model: string; args: any; count: number }> = [];
        const collections = new Set(['seedDefinition', 'seedScanPlan', 'dataSource', 'legacyJobMapping', 'seedQuery', 'seedQueryBinding', 'seedRuntimeState', 'auditEvent']);
        const api = new Proxy(tx, { get(target, key) {
          if (key === '$transaction') return (run: (database: any) => Promise<unknown>) => run(api);
          const model = Reflect.get(target, key);
          if (key === 'seedPublication') return new Proxy(model, { get(value, operation) {
            if (operation !== 'findFirst') return Reflect.get(value, operation);
            return async (args: any) => { const result = await value.findFirst(args); headReads++; compiling = headReads === 1; return result; };
          } });
          if (typeof key !== 'string' || !collections.has(key)) return model;
          return new Proxy(model, { get(value, operation) {
            if (operation !== 'findMany') return Reflect.get(value, operation);
            return async (args: any) => { const inCatalog = compiling, result = await value.findMany(args); if (inCatalog) reads.push({ model: key, args, count: result.length }); return result; };
          } });
        } });
        const result = await previewPublication(api, { actorUserId: admin.id, parentRevision: revision, idempotencyKey: 'catalog-preview', reason: 'Rollback-only large catalog regression' });
        expect(reads.every(read => read.args.take === 500 && read.count <= 500 && !read.args.include)).toBe(true);
        for (const model of collections) expect(reads.some(read => read.model === model)).toBe(true);
        for (const model of ['seedQuery', 'seedRuntimeState', 'auditEvent']) expect(reads.filter(read => read.model === model).length).toBeGreaterThan(1);
        expect(reads.filter(read => read.model === 'seedQuery').reduce((count, read) => count + read.count, 0)).toBeGreaterThanOrEqual(16_000);
        const preview = await tx.seedImportJob.findUniqueOrThrow({ where: { id: result.targetId } }), compiled = preview.rowResults.manifest;
        expect(preview.rowResults.catalogDigest).toBe(expectedDigest);
        expect(compiled.bindings.find((binding: any) => binding.legacyOwnerKey === ownerA)).toMatchObject({ ownerRevision: 7, participationStatus: 'ACTIVE' });
        expect(compiled.bindings.find((binding: any) => binding.legacyOwnerKey === ownerB)).toMatchObject({ ownerRevision: 1, validFromRevision: epoch });
        expect(compiled.bindings.find((binding: any) => binding.legacyOwnerKey === ownerC)).toMatchObject({ ownerRevision: 3, participationStatus: 'PAUSED' });
        expect(compiled.bindings.some((binding: any) => binding.legacyOwnerKey === ownerD)).toBe(false);
        expect(compiled.queries.find((q: any) => q.queryId === queries[0].queryId).nativeJobIds).toEqual(expect.arrayContaining([`legacy-${suffix}-0`, `extra-alias-${suffix}-1`]));
        expect(compiled.queries.find((q: any) => q.queryId === queries[3].queryId).nativeJobIds).toEqual([`runtime-${suffix}`]);
        expect(compiled.queries.find((q: any) => q.queryId === queries[4].queryId).nativeJobIds).toEqual([queries[4].nativeJobIds[0]]);
        for (const seed of seeds) expect(compiled.bindings.some((binding: any) => binding.seedId === seed.id)).toBe(true);
        expect(await tx.seedRuntimeState.count({ where: { queryId: { in: queries.map(q => q.queryId) }, nextAllowedAt: new Date('2099-01-01T00:00:00Z') } })).toBe(16_000);
        expect(await tx.seedPublication.findUnique({ where: { id: previous.publicationId } })).toMatchObject({ manifestHash: previous.contentHash, configSnapshot: { manifest: previous } });
        throw rollback;
      }, { timeout: 180_000, maxWait: 30_000 });
    } catch (error) { if (error !== rollback) throw error; }
    finally { await db.$disconnect(); }
  }, 180_000);
});
