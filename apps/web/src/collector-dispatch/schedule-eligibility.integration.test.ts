import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCollectorDispatchService } from './service';
import type { DispatchOptions } from './types';

const url = process.env.SAAS_TEST_DATABASE_URL;
let db: any, clusterDb: any, databaseName: string | undefined;
beforeAll(async () => {
  if (!url) return;
  const target = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.includes('_test_')) throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const { PrismaClient } = createRequire(new URL('../../package.json', import.meta.url))('@prisma/client');
  clusterDb = new PrismaClient({ datasources: { db: { url } } });
  databaseName = 'saas_test_schedule_eligibility_' + randomUUID().replaceAll('-', '');
  await clusterDb.$executeRawUnsafe('CREATE DATABASE "' + databaseName + '"');
  target.pathname = '/' + databaseName;
  const isolated = target.toString();
  await promisify(execFile)('apps/web/node_modules/.bin/prisma', ['migrate', 'deploy', '--schema', 'apps/web/schema.prisma'], { env: { ...process.env, DATABASE_URL: isolated }, maxBuffer: 1024 * 1024 });
  db = new PrismaClient({ datasources: { db: { url: isolated } } });
}, 30000);
afterAll(async () => {
  await db?.$disconnect();
  if (databaseName) await clusterDb.$executeRawUnsafe('DROP DATABASE "' + databaseName + '"');
  await clusterDb?.$disconnect();
});

async function isolated(run: (tx: any, f: any) => Promise<void>) {
  const rollback = Error('TEST_ROLLBACK');
  try {
    await db.$transaction(async (tx: any) => {
      const counts = { transactions: 0, adminReads: 0, controlUpserts: 0 }, suffix = randomUUID();
      let api: any;
      api = new Proxy(tx, { get(target, key) {
        if (key === '$transaction') return (fn: (inner: any) => unknown) => { counts.transactions++; return fn(api); };
        if (key === 'user') return new Proxy(target.user, { get(model, method) { return method === 'findUnique' ? (args: any) => { counts.adminReads++; return model.findUnique(args); } : Reflect.get(model, method); } });
        if (key === 'collectorSourceControl') return new Proxy(target.collectorSourceControl, { get(model, method) { return method === 'upsert' ? (args: any) => { counts.controlUpserts++; return model.upsert(args); } : Reflect.get(model, method); } });
        return Reflect.get(target, key);
      } });
      const options: DispatchOptions = { tokenSecret: 'schedule-eligibility-private-fixture-secret', leaseMs: 3000, requestBudgetMs: 200, exitMarginMs: 100, requestSpacingMs: 0, cycleMs: 60000, unknownOutcomeBackoffMs: 60000, evidencePrefix: 'private-schedule-fixture', evidenceScheme: 'local-private', storeForSource: () => ({ putIfAbsent: async () => 'CREATED', get: async () => new Uint8Array() }) };
      const service = createCollectorDispatchService(api, options), admin = await tx.user.create({ data: { email: suffix + '@schedule.example.test', isAdmin: true } });
      const source = await tx.dataSource.create({ data: { key: 'meta_ad_library', name: 'Scheduler eligibility fixture', adapterVersion: 'meta-service-dom-1', status: 'ACTIVE' } });
      const addQueries = async (channel: string, count: number) => {
        const queries = Array.from({ length: count }, (_, i) => ({ id: randomUUID(), dataSourceId: source.id, sourceKey: source.key, channel, mode: 'KEYWORD', normalizedParams: { keyword: suffix + '-' + i, country: 'US', language: 'en' }, queryKey: createHash('sha256').update(suffix + '-' + channel + '-' + i).digest('hex'), queryKeyVersion: 'legacy-1', adapterVersion: 'meta-service-dom-1', capabilityVersion: 'fixture', desiredEnabled: true }));
        await tx.seedQuery.createMany({ data: queries });
        await tx.seedRuntimeState.createMany({ data: queries.map(q => ({ queryId: q.id, dataSourceId: source.id, sourceKey: source.key, desiredRevision: 1 })) });
        await tx.seedQueryBinding.createMany({ data: queries.map(q => ({ queryId: q.id, ownerKind: 'LEGACY', legacyOwnerKey: q.queryKey, ownerRevision: 1, validFromRevision: 1 })) });
        return queries;
      };
      await run(tx, { service, admin, source, counts, addQueries });
      throw rollback;
    }, { timeout: 30000 });
  } catch (error) { if (error !== rollback) throw error; }
}

describe.skipIf(!url)('database task scheduling eligibility', () => {
  it('excludes hundreds of CONFIG and LEGACY queries before per-query administration or source upserts', () => isolated(async (tx, f) => {
    for (const [channel, controlMode] of [['CONFIG', 'CONFIG_QUEUE'], ['LEGACY', 'LEGACY_QUEUE'], ['*', 'TASK_CLAIM']]) await tx.collectorSourceControl.create({ data: { dataSourceId: f.source.id, sourceKey: f.source.key, channel, scopeKey: 'SOURCE', controlMode, notBefore: new Date(0) } });
    // A TASK owner scope and TASK wildcard cannot override an exact CONFIG SOURCE control.
    await tx.collectorSourceControl.create({ data: { dataSourceId: f.source.id, sourceKey: f.source.key, channel: 'CONFIG', scopeKey: 'OWNER:fixture', controlMode: 'TASK_CLAIM', notBefore: new Date(0) } });
    await f.addQueries('CONFIG', 500); await f.addQueries('LEGACY', 100);
    expect(await f.service.scheduleDueQueries({ actorUserId: f.admin.id })).toEqual({ created: 0, failed: 0 });
    expect(await tx.seedExecutionTask.count()).toBe(0);
    expect(f.counts).toEqual({ transactions: 0, adminReads: 1, controlUpserts: 0 });
  }));
  it('inherits TASK mode and generation for a new default-LEGACY query only under its exact SOURCE control', () => isolated(async (tx, f) => {
    await tx.collectorSourceControl.create({ data: { dataSourceId: f.source.id, sourceKey: f.source.key, channel: 'META', scopeKey: 'SOURCE', controlMode: 'TASK_CLAIM', assignmentGeneration: 9, notBefore: new Date(0) } });
    const [query] = await f.addQueries('META', 1);
    expect(await tx.seedQuery.findUnique({ where: { id: query.id } })).toMatchObject({ controlMode: 'LEGACY_QUEUE', assignmentGeneration: 0 });
    expect(await f.service.scheduleDueQueries({ actorUserId: f.admin.id, queryIds: [query.id] })).toEqual({ created: 1, failed: 0 });
    expect(await tx.seedQuery.findUnique({ where: { id: query.id } })).toMatchObject({ controlMode: 'TASK_CLAIM', assignmentGeneration: 9 });
    expect(await tx.seedRuntimeState.findUnique({ where: { queryId: query.id } })).toMatchObject({ assignmentGeneration: 9 });
    expect(await tx.seedExecutionTask.findMany({ where: { queryId: query.id } })).toMatchObject([{ state: 'READY', publicationRevision: 1 }]);
    expect(f.counts).toEqual({ transactions: 1, adminReads: 2, controlUpserts: 1 });
    expect(await f.service.scheduleDueQueries({ actorUserId: f.admin.id, queryIds: [] })).toEqual({ created: 0, failed: 0 });
  }));
  it('inherits a TASK SOURCE wildcard when the exact SOURCE control is absent', () => isolated(async (tx, f) => {
    await tx.collectorSourceControl.create({ data: { dataSourceId: f.source.id, sourceKey: f.source.key, channel: '*', scopeKey: 'SOURCE', controlMode: 'TASK_CLAIM', assignmentGeneration: 12, notBefore: new Date(0) } });
    const [query] = await f.addQueries('META', 1);
    expect(await f.service.scheduleDueQueries({ actorUserId: f.admin.id, queryIds: [query.id] })).toEqual({ created: 1, failed: 0 });
    expect(await tx.seedQuery.findUnique({ where: { id: query.id } })).toMatchObject({ controlMode: 'TASK_CLAIM', assignmentGeneration: 12 });
    expect(await tx.seedRuntimeState.findUnique({ where: { queryId: query.id } })).toMatchObject({ assignmentGeneration: 12 });
    expect(await tx.collectorSourceControl.findUnique({ where: { sourceKey_channel_scopeKey: { sourceKey: f.source.key, channel: 'META', scopeKey: 'SOURCE' } } })).toMatchObject({ controlMode: 'TASK_CLAIM', assignmentGeneration: 12 });
    expect(await tx.seedExecutionTask.count({ where: { queryId: query.id, state: 'READY' } })).toBe(1);
    expect(f.counts).toEqual({ transactions: 1, adminReads: 2, controlUpserts: 1 });
  }));
  it('does not inherit another source TASK wildcard or an OWNER TASK control', () => isolated(async (tx, f) => {
    const other = await tx.dataSource.create({ data: { key: 'snapchat_ads_gallery', name: 'Other scheduling source', adapterVersion: 'snap-service-dom-1', status: 'ACTIVE' } });
    for (const channel of ['META', '*']) await tx.collectorSourceControl.create({ data: { dataSourceId: other.id, sourceKey: other.key, channel, scopeKey: 'SOURCE', controlMode: 'TASK_CLAIM', assignmentGeneration: 23, notBefore: new Date(0) } });
    await tx.collectorSourceControl.create({ data: { dataSourceId: f.source.id, sourceKey: f.source.key, channel: 'META', scopeKey: 'OWNER:fixture', controlMode: 'TASK_CLAIM', notBefore: new Date(0) } });
    const [query] = await f.addQueries('META', 1);
    expect(await f.service.scheduleDueQueries({ actorUserId: f.admin.id, queryIds: [query.id] })).toEqual({ created: 0, failed: 0 });
    expect(await tx.seedExecutionTask.count()).toBe(0);
    expect(f.counts).toEqual({ transactions: 0, adminReads: 1, controlUpserts: 0 });
  }));
});
