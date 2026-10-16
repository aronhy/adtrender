import { createRequire } from 'node:module';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Prisma, PrismaClient } from '../../saas/app/node_modules/@prisma/client/index.js';
import { createInventoryManifest } from './inventory';
import { assertPublicImportIsolation, buildPublicImportPlan, importPublicPlan, validateImportTarget, type PublicImportPlan } from './import-public';
import { createLocalS3Provider, validateMediaDestination, type LocalMediaProvider } from './local-media';
import { advertiserReference, evidenceCanonical, evidenceDigest, evidenceObjects, hashEvidenceManifest, plannedEvidenceReferences, SOURCE_EVIDENCE_MAX_BYTES, variantEvidence, verifySourceEvidenceState, type SourceEvidenceManifest } from './source-evidence-contract';

type Inventory = ReturnType<typeof createInventoryManifest>;
type EvidenceOptions = { confirmInventoryHash: string; publicPlan: PublicImportPlan; targetUrl: string; destination: { endpoint: string; bucket: string } };
function fail(code: string): never { throw new Error(code); }
const code = (error: unknown) => error instanceof Error && /^(SOURCE_EVIDENCE|IMPORT|MEDIA)_[A-Z_]+$/.test(error.message) ? error.message : 'SOURCE_EVIDENCE_FAILED';
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/** Rebuild every public fact from the original input; supplied media hashes must
 * also match the previously imported planHash in the isolated database. */
function approvedPlan(input: string | Uint8Array, inventory: Inventory, options: EvidenceOptions) {
  const bytes = typeof input === 'string' ? Buffer.from(input) : Buffer.from(input);
  if (!bytes.length || bytes.length > SOURCE_EVIDENCE_MAX_BYTES) fail('SOURCE_EVIDENCE_SIZE_LIMIT');
  if (!inventory || inventory.classification !== 'public' || inventory.quarantined.count !== 0) fail('SOURCE_EVIDENCE_PUBLIC_BATCH_REQUIRED');
  const target = validateImportTarget(options.targetUrl), destination = validateMediaDestination(options.destination);
  const document = JSON.parse(bytes.toString('utf8')); const rows = Array.isArray(document) ? document : document.ads;
  const names = [...new Set<string>((Array.isArray(rows) ? rows : []).flatMap((row: Record<string, unknown>) => typeof row?.mediaUrl === 'string' && row.mediaUrl.startsWith('/local-media/') ? [row.mediaUrl.slice(13)] : []))].sort();
  const localMediaFiles = inventory.localMedia.checked ? names.slice(0, names.length - (inventory.localMedia.missingCount ?? 0)) : undefined;
  // Validate inventory/input before reading the untrusted supplied plan.
  buildPublicImportPlan(bytes, inventory, { confirmManifestHash: options.confirmInventoryHash, localMediaFiles });
  const mediaEvidence: Record<string, { sha256: string; sizeBytes: number }> = {};
  try {
    for (const ad of options.publicPlan.ads) for (const variant of ad.variants) {
      if (!variant.media?.localReferenceHash || variant.media.sha256 === null) continue;
      const name = names.find(value => evidenceDigest(value) === variant.media!.localReferenceHash);
      if (!name || variant.media.sizeBytes === null) fail('SOURCE_EVIDENCE_PLAN_MISMATCH');
      const evidence = { sha256: variant.media.sha256, sizeBytes: variant.media.sizeBytes };
      if (mediaEvidence[name] && evidenceCanonical(mediaEvidence[name]) !== evidenceCanonical(evidence)) fail('SOURCE_EVIDENCE_PLAN_MISMATCH');
      mediaEvidence[name] = evidence;
    }
    const plan = buildPublicImportPlan(bytes, inventory, { confirmManifestHash: options.confirmInventoryHash, localMediaFiles, mediaEvidence });
    if (plan.quarantined.length || evidenceCanonical(plan) !== evidenceCanonical(options.publicPlan)) fail('SOURCE_EVIDENCE_PLAN_MISMATCH');
    return { bytes, plan, target, destination };
  } catch { return fail('SOURCE_EVIDENCE_PLAN_MISMATCH'); }
}

async function inspect(tx: Prisma.TransactionClient, plan: PublicImportPlan, targetUrl: string) {
  const source = await assertPublicImportIsolation(tx, targetUrl);
  const run = await tx.collectionRun.findUnique({ where: { idempotencyKey: `legacy-public:${plan.inputSha256}` } });
  const coverage = run?.coverage as Record<string, unknown> | undefined;
  if (!source || !run || run.dataSourceId !== source.id || run.status !== 'SUCCEEDED' || run.adapterVersion !== 'legacy-public-v1'
    || coverage?.planHash !== plan.planHash || coverage?.mappingHash !== plan.mappingHash || coverage?.inventoryManifestHash !== plan.inventoryManifestHash || coverage?.kind !== 'legacy-import') fail('IMPORT_APPROVED_RUN_REQUIRED');
  const [items, observations, ads] = await Promise.all([
    tx.runItem.findMany({ where: { runId: run.id, dataSourceId: source.id }, include: { ad: { select: { sourceAdId: true } } } }),
    tx.adObservation.findMany({ where: { collectionRunId: run.id, dataSourceId: source.id } }),
    tx.ad.findMany({ where: { dataSourceId: source.id, sourceAdId: { in: plan.ads.map(ad => ad.sourceAdId) } } }),
  ]);
  if (items.length !== plan.items.length || ads.length !== plan.ads.length || observations.length !== plan.ads.filter(ad => ad.lastObservedAt).length) fail('IMPORT_EVIDENCE_RECONCILIATION_FAILED');
  for (const expected of plan.items) {
    const item = items.find(value => value.itemKey === `row:${expected.rowIndex}`);
    if (!item || item.status !== 'INGESTED' || item.ad?.sourceAdId !== expected.sourceAdId || item.sourceAdId !== expected.sourceAdId || item.evidenceSha256 !== expected.variantHash) fail('IMPORT_EVIDENCE_RECONCILIATION_FAILED');
  }
  for (const expected of plan.ads) {
    const ad = ads.find(value => value.sourceAdId === expected.sourceAdId)!;
    const stored = (ad.fieldProvenance as { legacyVariants?: unknown[] }).legacyVariants;
    for (const variant of expected.variants) if (!Array.isArray(stored) || !stored.some(value => {
      if (!value || typeof value !== 'object') return false;
      const { rowIndex: _row, ...facts } = value as Record<string, unknown>; const { rowIndex: _expectedRow, ...expectedFacts } = variant;
      return evidenceCanonical(facts) === evidenceCanonical(expectedFacts);
    })) fail('IMPORT_EVIDENCE_RECONCILIATION_FAILED');
    if (observations.filter(value => value.adId === ad.id).length !== (expected.lastObservedAt ? 1 : 0)) fail('IMPORT_EVIDENCE_RECONCILIATION_FAILED');
  }
  const rows = { run, items, observations, ads }; const receipt = verifySourceEvidenceState(plan, rows);
  return { rows, receipt };
}

/** Read-only preparation. The run is resolved from the approved input, never from
 * an arbitrary caller-supplied run ID. No object service is contacted. */
export async function prepareSourceEvidenceManifest(db: PrismaClient, input: string | Uint8Array, inventory: Inventory, options: EvidenceOptions & { generatedAt: string }): Promise<SourceEvidenceManifest> {
  const { bytes, plan, target, destination } = approvedPlan(input, inventory, options);
  if (!Number.isFinite(new Date(options.generatedAt).valueOf())) fail('SOURCE_EVIDENCE_INVALID_TIME');
  await importPublicPlan(db, plan, options.targetUrl, { verifyOnly: true });
  return db.$transaction(async tx => {
    const { rows, receipt } = await inspect(tx, plan, options.targetUrl);
    const core = { schemaVersion: 1 as const, classification: 'public' as const, inputSha256: plan.inputSha256, inventoryManifestHash: plan.inventoryManifestHash, publicPlanHash: plan.planHash,
      target: { host: target.host, port: target.port, database: target.database }, destination, runId: rows.run.id,
      objects: evidenceObjects(plan, rows.run.id, bytes.length), references: receipt?.references ?? plannedEvidenceReferences(plan, rows) };
    return { ...core, manifestHash: hashEvidenceManifest(core), generatedAt: options.generatedAt };
  }, { timeout: 30_000, maxWait: 15_000 });
}

/** Every object is verified before publishing any DB reference. Partial object
 * writes stay available for safe retry; source files/objects are never deleted. */
export async function archiveSourceEvidence(db: PrismaClient, input: string | Uint8Array, inventory: Inventory, manifest: SourceEvidenceManifest, options: EvidenceOptions & { confirmManifestHash: string; provider: LocalMediaProvider }) {
  if (!manifest || !/^[a-f0-9]{64}$/.test(options.confirmManifestHash) || options.confirmManifestHash !== manifest.manifestHash) fail('SOURCE_EVIDENCE_MANIFEST_NOT_CONFIRMED');
  const prepared = await prepareSourceEvidenceManifest(db, input, inventory, { ...options, generatedAt: manifest.generatedAt });
  if (evidenceCanonical(manifest) !== evidenceCanonical(prepared)) fail('SOURCE_EVIDENCE_MANIFEST_MISMATCH');
  const { bytes, plan } = approvedPlan(input, inventory, options);
  const before = await db.$transaction(tx => inspect(tx, plan, options.targetUrl), { timeout: 30_000, maxWait: 15_000 });
  if (before.receipt && before.receipt.manifestHash !== manifest.manifestHash) fail('SOURCE_EVIDENCE_MANIFEST_MISMATCH');
  const variants = variantEvidence(plan); let uploaded = 0, reverified = 0;
  for (const expected of manifest.objects) {
    const content = expected.kind === 'SOURCE' ? bytes : variants.get(expected.sha256)!;
    const verify = (stored: Awaited<ReturnType<LocalMediaProvider['get']>>) => {
      if (!stored || stored.mimeType !== 'application/json' || stored.bytes.byteLength !== expected.sizeBytes || evidenceDigest(stored.bytes) !== expected.sha256) fail('SOURCE_EVIDENCE_OBJECT_MISMATCH');
    };
    try {
      const existing = await options.provider.get({ key: expected.key, maxBytes: expected.sizeBytes });
      if (existing) { verify(existing); reverified++; }
      else {
        if (before.receipt) fail('SOURCE_EVIDENCE_OBJECT_MISSING');
        const status = await options.provider.putIfAbsent({ key: expected.key, bytes: content, mimeType: 'application/json', sha256: expected.sha256 });
        verify(await options.provider.get({ key: expected.key, maxBytes: expected.sizeBytes }));
        if (status === 'CREATED') uploaded++; else reverified++;
      }
    } catch (error) {
      if (error instanceof Error && ['SOURCE_EVIDENCE_OBJECT_MISSING', 'SOURCE_EVIDENCE_OBJECT_MISMATCH'].includes(error.message)) throw error;
      fail('SOURCE_EVIDENCE_PROVIDER_FAILED');
    }
  }
  const published = await db.$transaction(async tx => {
    const { rows, receipt } = await inspect(tx, plan, options.targetUrl);
    if (receipt) { if (receipt.manifestHash !== manifest.manifestHash) fail('SOURCE_EVIDENCE_MANIFEST_MISMATCH'); return false; }
    if (evidenceCanonical(plannedEvidenceReferences(plan, rows)) !== evidenceCanonical(manifest.references)) fail('SOURCE_EVIDENCE_REFERENCE_CHANGED');
    const legacy = `legacy-json-sha256:${plan.inputSha256}`;
    for (const reference of manifest.references) {
      const evidenceReference = `s3:${reference.key}`;
      if (reference.kind === 'CollectionRun') await tx.collectionRun.update({ where: { id: rows.run.id }, data: { evidenceReference, coverage: json({ ...(rows.run.coverage as Record<string, unknown>), sourceEvidenceArchive: manifest }) } });
      else if (reference.kind === 'RunItem') await tx.runItem.update({ where: { id: reference.id }, data: { evidenceReference } });
      else if (reference.kind === 'AdObservation') await tx.adObservation.update({ where: { id: reference.id }, data: { evidenceReference } });
      else {
        const ad = rows.ads.find(value => value.id === reference.id)!;
        if (advertiserReference(ad) !== legacy) fail('SOURCE_EVIDENCE_REFERENCE_CHANGED');
        const provenance = ad.fieldProvenance as Record<string, unknown>;
        await tx.ad.update({ where: { id: ad.id }, data: { fieldProvenance: json({ ...provenance, advertiserName: { ...(provenance.advertiserName as Record<string, unknown>), evidenceReference } }) } });
      }
    }
    await inspect(tx, plan, options.targetUrl);
    return true;
  }, { timeout: 120_000, maxWait: 15_000 });
  return { status: published ? 'ARCHIVED' as const : 'REPLAY_VERIFIED_NO_WRITE' as const, uploaded, reverified, objects: manifest.objects.length, references: manifest.references.length, manifestHash: manifest.manifestHash, inputSha256: manifest.inputSha256, publicPlanHash: manifest.publicPlanHash };
}

export async function runSourceEvidenceCli(args: string[]) {
  const allowed = new Set(['--mode', '--input', '--inventory', '--confirm-inventory', '--public-plan', '--target-url', '--endpoint', '--bucket', '--output', '--manifest', '--confirm-manifest']); const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) { if (!allowed.has(args[i]) || flags.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) fail('SOURCE_EVIDENCE_USAGE'); flags.set(args[i], args[i + 1]); }
  for (const name of ['--mode', '--input', '--inventory', '--confirm-inventory', '--public-plan', '--target-url', '--endpoint', '--bucket', '--output']) if (!flags.has(name)) fail('SOURCE_EVIDENCE_USAGE');
  const mode = flags.get('--mode'); if (!['prepare', 'archive'].includes(mode!) || (mode === 'archive' && (!flags.has('--manifest') || !flags.has('--confirm-manifest'))) || (mode === 'prepare' && (flags.has('--manifest') || flags.has('--confirm-manifest')))) fail('SOURCE_EVIDENCE_USAGE');
  const input = await readFile(flags.get('--input')!), inventory = JSON.parse(await readFile(flags.get('--inventory')!, 'utf8')) as Inventory, publicPlan = JSON.parse(await readFile(flags.get('--public-plan')!, 'utf8')) as PublicImportPlan;
  const options = { confirmInventoryHash: flags.get('--confirm-inventory')!, publicPlan, targetUrl: flags.get('--target-url')!, destination: { endpoint: flags.get('--endpoint')!, bucket: flags.get('--bucket')! } };
  approvedPlan(input, inventory, options);
  const target = validateImportTarget(options.targetUrl), url = new URL(target.url); if (process.env.SAAS_MIGRATION_DATABASE_PASSWORD) url.password = process.env.SAAS_MIGRATION_DATABASE_PASSWORD;
  const require = createRequire(new URL('../../saas/app/package.json', import.meta.url)); const { PrismaClient } = require('@prisma/client') as { PrismaClient: typeof import('../../saas/app/node_modules/@prisma/client/index.js').PrismaClient };
  const output = await open(flags.get('--output')!, 'wx', 0o600); const db = new PrismaClient({ datasources: { db: { url: url.href } } }); let provider: ReturnType<typeof createLocalS3Provider> | undefined;
  try {
    let result;
    if (mode === 'prepare') result = await prepareSourceEvidenceManifest(db, input, inventory, { ...options, generatedAt: new Date().toISOString() });
    else { const manifest = JSON.parse(await readFile(flags.get('--manifest')!, 'utf8')) as SourceEvidenceManifest;
      provider = createLocalS3Provider(options.destination, { accessKeyId: process.env.SAAS_MIGRATION_S3_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.SAAS_MIGRATION_S3_SECRET_ACCESS_KEY ?? '' });
      result = await archiveSourceEvidence(db, input, inventory, manifest, { ...options, confirmManifestHash: flags.get('--confirm-manifest')!, provider }); }
    await output.writeFile(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { const errorCode = code(error); await output.writeFile(`${JSON.stringify({ status: 'FAILED', errorCode })}\n`); throw new Error(errorCode); }
  finally { await db.$disconnect(); provider?.close(); await output.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runSourceEvidenceCli(process.argv.slice(2)).catch(error => { process.stderr.write(`${code(error)}\n`); process.exitCode = 1; });
