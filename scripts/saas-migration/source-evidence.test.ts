import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { createInventoryManifest } from './inventory';
import { buildPublicImportPlan, importPublicPlan } from './import-public';
import { prepareSourceEvidenceManifest, archiveSourceEvidence } from './source-evidence';
import type { LocalMediaProvider } from './local-media';

const targetUrl = process.env.SAAS_SOURCE_EVIDENCE_TEST_DATABASE_URL || 'postgresql://saas_local@127.0.0.1:55438/saas_source_evidence_test';
const destination = { endpoint: 'http://127.0.0.1:13991', bucket: 'saas-migration-test-evidence' };
const generatedAt = '2026-10-05T03:00:00.000Z';
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture(extra: Record<string, unknown> = {}) {
  const id = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const row = { libraryId: id, sourceUrl: `https://www.facebook.com/ads/library/?id=${id}`, copy: 'Synthetic public text', advertiser: 'Fixture', collectedAt: generatedAt, ...extra };
  const input = Buffer.from(JSON.stringify([row, row, { ...row, copy: 'Second public variant' }]));
  const inventory = createInventoryManifest(input, { ownership: 'public', generatedAt });
  const publicPlan = buildPublicImportPlan(input, inventory, { confirmManifestHash: inventory.manifestHash });
  const options = { confirmInventoryHash: inventory.manifestHash, publicPlan, targetUrl, destination, generatedAt };
  return { id, input, inventory, publicPlan, options };
}
class Provider implements LocalMediaProvider {
  objects = new Map<string, { bytes: Buffer; mimeType: string }>(); puts = 0; gets = 0; failKey: string | null = null;
  async get({ key }: { key: string; maxBytes: number }) { this.gets++; if (key === this.failKey) throw new Error('DO_NOT_LEAK_PROVIDER_SECRET'); return this.objects.get(key) ?? null; }
  async putIfAbsent({ key, bytes, mimeType }: Parameters<LocalMediaProvider['putIfAbsent']>[0]) {
    this.puts++; if (this.objects.has(key)) return 'EXISTS' as const;
    this.objects.set(key, { bytes: Buffer.from(bytes), mimeType }); return 'CREATED' as const;
  }
}

describe('source evidence approval boundary', () => {
  it('rejects unknown/private batches and changed plan before any database access', async () => {
    const db = new Proxy({}, { get() { throw new Error('DATABASE_MUST_NOT_BE_TOUCHED'); } });
    const privateInput = fixture({ workspaceId: 'private' });
    await expect(prepareSourceEvidenceManifest(db as never, privateInput.input, privateInput.inventory, privateInput.options)).rejects.toThrow('SOURCE_EVIDENCE_PUBLIC_BATCH_REQUIRED');
    const f = fixture();
    await expect(prepareSourceEvidenceManifest(db as never, f.input, f.inventory, { ...f.options, confirmInventoryHash: '0'.repeat(64) })).rejects.toThrow('IMPORT_MANIFEST_NOT_CONFIRMED');
    await expect(prepareSourceEvidenceManifest(db as never, f.input, f.inventory, { ...f.options, publicPlan: { ...f.publicPlan, planHash: '0'.repeat(64) } })).rejects.toThrow('SOURCE_EVIDENCE_PLAN_MISMATCH');
    await expect(prepareSourceEvidenceManifest(db as never, Buffer.concat([f.input, Buffer.from('\n')]), f.inventory, f.options)).rejects.toThrow('IMPORT_MANIFEST_MISMATCH');
  });
});

describe.skipIf(!process.env.SAAS_SOURCE_EVIDENCE_TEST_DATABASE_URL)('source evidence PostgreSQL boundaries', () => {
  async function imported() {
    const f = fixture(); const require = createRequire(new URL('../../saas/app/package.json', import.meta.url)); const { PrismaClient } = require('@prisma/client');
    const db = new PrismaClient({ datasources: { db: { url: targetUrl } } }); await importPublicPlan(db, f.publicPlan, targetUrl);
    const provider = new Provider(); const manifest = await prepareSourceEvidenceManifest(db, f.input, f.inventory, f.options);
    const archive = () => archiveSourceEvidence(db, f.input, f.inventory, manifest, { ...f.options, confirmManifestHash: manifest.manifestHash, provider });
    return { ...f, db, provider, manifest, archive };
  }
  it('archives exact input plus distinct variants, preserves hashes and makes repeats read-only', async () => {
    const f = await imported();
    try {
      expect(f.manifest.objects).toHaveLength(3); expect(f.manifest.references).toHaveLength(6);
      const later = await prepareSourceEvidenceManifest(f.db, f.input, f.inventory, { ...f.options, generatedAt: '2026-10-06T00:00:00Z' });
      expect(later.manifestHash).toBe(f.manifest.manifestHash);
      const before = await f.db.runItem.findMany({ where: { runId: f.manifest.runId }, orderBy: { itemKey: 'asc' } });
      expect(await f.archive()).toMatchObject({ status: 'ARCHIVED', uploaded: 3, objects: 3, references: 6 });
      for (const object of f.manifest.objects) { const stored = f.provider.objects.get(object.key)!; expect(sha(stored.bytes)).toBe(object.sha256); expect(stored.mimeType).toBe('application/json'); }
      const raw = f.manifest.objects.find(object => object.kind === 'SOURCE')!; expect(f.provider.objects.get(raw.key)!.bytes).toEqual(f.input);
      const run = await f.db.collectionRun.findUniqueOrThrow({ where: { id: f.manifest.runId } }); expect(run.evidenceReference).toBe(`s3:${raw.key}`);
      const after = await f.db.runItem.findMany({ where: { runId: run.id }, orderBy: { itemKey: 'asc' } });
      expect(after.map((row: { evidenceSha256: string }) => row.evidenceSha256)).toEqual(before.map((row: { evidenceSha256: string }) => row.evidenceSha256));
      const snapshots = JSON.stringify(after); expect(await f.archive()).toMatchObject({ status: 'REPLAY_VERIFIED_NO_WRITE', uploaded: 0, reverified: 3 }); expect(f.provider.puts).toBe(3);
      expect(JSON.stringify(await f.db.runItem.findMany({ where: { runId: run.id }, orderBy: { itemKey: 'asc' } }))).toBe(snapshots);
      expect((await f.db.collectionRun.findUniqueOrThrow({ where: { id: run.id } })).updatedAt).toEqual(run.updatedAt);
      expect((await importPublicPlan(f.db, f.publicPlan, targetUrl)).status).toBe('REPLAY_VERIFIED_NO_WRITE');
    } finally { await f.db.$disconnect(); }
  });
  it('keeps every DB reference unchanged after a partial object failure, then resumes without overwriting', async () => {
    const f = await imported();
    try {
      f.provider.failKey = f.manifest.objects[1].key;
      await expect(f.archive()).rejects.toThrow('SOURCE_EVIDENCE_PROVIDER_FAILED');
      expect((await f.db.collectionRun.findUniqueOrThrow({ where: { id: f.manifest.runId } })).evidenceReference).toBe(`legacy-json-sha256:${f.publicPlan.inputSha256}`);
      expect(await f.db.runItem.count({ where: { runId: f.manifest.runId, evidenceReference: { startsWith: 's3:' } } })).toBe(0);
      expect(f.provider.objects.size).toBe(1); f.provider.failKey = null;
      expect(await f.archive()).toMatchObject({ status: 'ARCHIVED', uploaded: 2, reverified: 1 }); expect(f.provider.puts).toBe(3);
    } finally { await f.db.$disconnect(); }
  });
  it('refuses conflicting existing bytes, missing replay objects and forged DB references', async () => {
    const f = await imported();
    try {
      const first = f.manifest.objects[0]; f.provider.objects.set(first.key, { bytes: Buffer.from('{}'), mimeType: 'application/json' });
      await expect(f.archive()).rejects.toThrow('SOURCE_EVIDENCE_OBJECT_MISMATCH'); expect(f.provider.puts).toBe(0);
      f.provider.objects.delete(first.key); await f.archive(); f.provider.objects.delete(first.key);
      await expect(f.archive()).rejects.toThrow('SOURCE_EVIDENCE_OBJECT_MISSING'); expect(f.provider.puts).toBe(3);
      await f.db.runItem.updateMany({ where: { runId: f.manifest.runId }, data: { evidenceReference: `s3:${first.key}` } });
      await expect(importPublicPlan(f.db, f.publicPlan, targetUrl)).rejects.toThrow('IMPORT_EVIDENCE_RECONCILIATION_FAILED');
    } finally { await f.db.$disconnect(); }
  });
  it('rejects changed approval/target/private database without object requests', async () => {
    const f = await imported();
    try {
      await expect(archiveSourceEvidence(f.db, f.input, f.inventory, f.manifest, { ...f.options, confirmManifestHash: '0'.repeat(64), provider: f.provider })).rejects.toThrow('SOURCE_EVIDENCE_MANIFEST_NOT_CONFIRMED');
      await expect(archiveSourceEvidence(f.db, f.input, f.inventory, f.manifest, { ...f.options, destination: { ...destination, bucket: 'saas-migration-test-other' }, confirmManifestHash: f.manifest.manifestHash, provider: f.provider })).rejects.toThrow('SOURCE_EVIDENCE_MANIFEST_MISMATCH');
      await expect(archiveSourceEvidence(f.db, f.input, f.inventory, { ...f.manifest, runId: '00000000-0000-0000-0000-000000000000' }, { ...f.options, confirmManifestHash: f.manifest.manifestHash, provider: f.provider })).rejects.toThrow('SOURCE_EVIDENCE_MANIFEST_MISMATCH');
      const user = await f.db.user.create({ data: { email: `source-${f.id}@example.test` } });
      try { await expect(f.archive()).rejects.toThrow('IMPORT_DATABASE_NOT_ISOLATED'); } finally { await f.db.user.delete({ where: { id: user.id } }); }
      expect(f.provider.gets + f.provider.puts).toBe(0);
    } finally { await f.db.$disconnect(); }
  });
  it('rechecks isolation after object transfer and publishes no partial DB references', async () => {
    const f = await imported(); let userId: string | undefined;
    try {
      const put = f.provider.putIfAbsent.bind(f.provider); const lastKey = f.manifest.objects.at(-1)!.key;
      f.provider.putIfAbsent = async args => {
        const result = await put(args);
        if (args.key === lastKey) userId = (await f.db.user.create({ data: { email: `during-${f.id}@example.test` } })).id;
        return result;
      };
      await expect(f.archive()).rejects.toThrow('IMPORT_DATABASE_NOT_ISOLATED');
      expect(await f.db.runItem.count({ where: { runId: f.manifest.runId, evidenceReference: { startsWith: 's3:' } } })).toBe(0);
      expect((await f.db.collectionRun.findUniqueOrThrow({ where: { id: f.manifest.runId } })).evidenceReference).toBe(`legacy-json-sha256:${f.publicPlan.inputSha256}`);
      await f.db.user.delete({ where: { id: userId! } }); userId = undefined;
      expect(await f.archive()).toMatchObject({ status: 'ARCHIVED', uploaded: 0, reverified: 3 });
    } finally { if (userId) await f.db.user.delete({ where: { id: userId } }); await f.db.$disconnect(); }
  });
  it('preserves advertiser evidence from a newer input while upgrading the older run and observations', async () => {
    const f = await imported();
    try {
      const rows = JSON.parse(f.input.toString()); for (const row of rows) { row.collectedAt = '2026-10-06T00:00:00Z'; row.advertiser = 'Later public advertiser'; }
      const laterInput = JSON.stringify(rows), laterInventory = createInventoryManifest(laterInput, { ownership: 'public', generatedAt });
      const laterPlan = buildPublicImportPlan(laterInput, laterInventory, { confirmManifestHash: laterInventory.manifestHash }); await importPublicPlan(f.db, laterPlan, targetUrl);
      const manifest = await prepareSourceEvidenceManifest(f.db, f.input, f.inventory, f.options); expect(manifest.references.filter(reference => reference.kind === 'AdAdvertiser')).toEqual([]);
      await archiveSourceEvidence(f.db, f.input, f.inventory, manifest, { ...f.options, confirmManifestHash: manifest.manifestHash, provider: f.provider });
      const ad = await f.db.ad.findFirstOrThrow({ where: { sourceAdId: f.id } }); expect(ad.fieldProvenance.advertiserName.evidenceReference).toBe(`legacy-json-sha256:${laterPlan.inputSha256}`);
      expect((await importPublicPlan(f.db, f.publicPlan, targetUrl)).status).toBe('REPLAY_VERIFIED_NO_WRITE');
      expect((await importPublicPlan(f.db, laterPlan, targetUrl)).status).toBe('REPLAY_VERIFIED_NO_WRITE');
    } finally { await f.db.$disconnect(); }
  });
  it('reverifies an already archived older input after a newer batch takes over advertiser provenance', async () => {
    const f = await imported();
    try {
      await f.archive();
      const rows = JSON.parse(f.input.toString()); for (const row of rows) { row.collectedAt = '2026-10-07T00:00:00Z'; row.advertiser = 'New source fact'; }
      const nextInput = JSON.stringify(rows), nextInventory = createInventoryManifest(nextInput, { ownership: 'public', generatedAt });
      const nextPlan = buildPublicImportPlan(nextInput, nextInventory, { confirmManifestHash: nextInventory.manifestHash }); await importPublicPlan(f.db, nextPlan, targetUrl);
      const before = await f.db.ad.findFirstOrThrow({ where: { sourceAdId: f.id } });
      expect(await f.archive()).toMatchObject({ status: 'REPLAY_VERIFIED_NO_WRITE', uploaded: 0, reverified: 3 });
      expect(f.provider.puts).toBe(3);
      const after = await f.db.ad.findUniqueOrThrow({ where: { id: before.id } }); expect(after.updatedAt).toEqual(before.updatedAt); expect(after.fieldProvenance).toEqual(before.fieldProvenance);
    } finally { await f.db.$disconnect(); }
  });
});
