import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Prisma, PrismaClient } from '../../apps/web/node_modules/@prisma/client/index.js';
import { createInventoryManifest } from './inventory';
import { MEDIA_MAX_BYTES } from '../../apps/web/src/media/download';
import { checkedRoot, readApprovedFile } from './media-files';
import { verifySourceEvidenceState } from './source-evidence-contract';

type Manifest = ReturnType<typeof createInventoryManifest>;
type MediaEvidence = Record<string, { sha256: string; sizeBytes: number }>;
type PlanOptions = { confirmManifestHash: string; localMediaFiles?: string[]; mediaEvidence?: MediaEvidence };
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const sourceKey = 'legacy-meta-public-rehearsal';
const parserVersion = 'legacy-public-v1';
const platforms = new Set(['facebook', 'instagram', 'messenger', 'audience_network', 'threads']);
function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)) return null;
  const date = new Date(value); const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && day.toISOString().slice(0, 10) === value.slice(0, 10) ? date.toISOString() : null;
}
function remote(value: unknown): string | null {
  try { const url = new URL(text(value) || ''); if (url.protocol !== 'https:' || url.username || url.password || url.port) return null; url.hash = ''; return url.href; } catch { return null; }
}
function content(value: unknown): string | null { const result = text(value); if (result && result.length > 100_000) throw new Error('IMPORT_FIELD_TOO_LARGE'); return result; }

/** The target is explicit and isolated; credentials must come from the environment. */
export function validateImportTarget(value: string) {
  try {
    const url = new URL(value); const host = url.hostname.replace(/^\[|\]$/g, ''); const database = decodeURIComponent(url.pathname.slice(1));
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(host) || url.password || url.search || url.hash
      || !/^[a-z_][a-z0-9_-]{0,62}$/i.test(database) || !/(^|[_-])(test|rehearsal)([_-]|$)/i.test(database)) throw new Error();
    return { host, port: Number(url.port || 5432), database, url: url.href };
  } catch { throw new Error('IMPORT_UNSAFE_TARGET'); }
}

/** Offline allowlist mapping. Unknown or private fields are never copied into the plan. */
export function buildPublicImportPlan(input: string | Uint8Array, manifest: Manifest, options: PlanOptions) {
  if (!manifest || manifest.classification !== 'public') throw new Error('IMPORT_PUBLIC_CLASSIFICATION_REQUIRED');
  if (!/^[a-f0-9]{64}$/.test(options.confirmManifestHash) || options.confirmManifestHash !== manifest.manifestHash) throw new Error('IMPORT_MANIFEST_NOT_CONFIRMED');
  if (manifest.localMedia.checked && options.localMediaFiles === undefined) throw new Error('IMPORT_MEDIA_CHECK_REQUIRED');
  const verified = createInventoryManifest(input, { generatedAt: manifest.generatedAt, ownership: 'public', localMediaFiles: manifest.localMedia.checked ? options.localMediaFiles : undefined });
  if (verified.manifestHash !== manifest.manifestHash || verified.sha256 !== manifest.sha256) throw new Error('IMPORT_MANIFEST_MISMATCH');
  const document = JSON.parse(typeof input === 'string' ? input : Buffer.from(input).toString('utf8')) as unknown;
  const rows = (Array.isArray(document) ? document : (document as Record<string, unknown>).ads) as unknown[];
  if (rows.length > 100_000) throw new Error('IMPORT_INPUT_TOO_LARGE');
  const rootScope = !Array.isArray(document) && object(document) && createInventoryManifest(JSON.stringify({ ...document, ads: [{}] }), { generatedAt: manifest.generatedAt, ownership: 'public' }).quarantined.reasons.unknownOwnership > 0;
  const items: Array<{ rowIndex: number; sourceAdId: string; variantHash: string }> = [];
  const quarantined: Array<{ rowIndex: number; reasons: string[]; rowHash: string }> = [];
  const groups = new Map<string, ReturnType<typeof mapVariant>[]>();
  function mapVariant(row: Record<string, unknown>, rowIndex: number) {
    const source = new URL(String(row.sourceUrl)); const declaredId = text(row.libraryId);
    const sourceAdId = declaredId && /^\d+$/.test(declaredId) ? declaredId : text(source.searchParams.get('id'))!;
    const observedAt = timestamp(row.collectedAt) || timestamp(row.lastCollectedAt) || timestamp(row.firstCollectedAt);
    const times = [timestamp(row.firstCollectedAt), timestamp(row.collectedAt), timestamp(row.lastCollectedAt)].filter((v): v is string => Boolean(v)).sort();
    const localName = typeof row.mediaUrl === 'string' && row.mediaUrl.startsWith('/local-media/') ? row.mediaUrl.slice(13) : null;
    const sourceMedia = remote(row.sourceMediaUrl) || remote(row.mediaUrl) || (localName ? `legacy-local-sha256:${digest(localName)}` : null);
    const evidence = localName ? options.mediaEvidence?.[localName] : undefined;
    if (evidence && (!/^[a-f0-9]{64}$/.test(evidence.sha256) || !Number.isSafeInteger(evidence.sizeBytes) || evidence.sizeBytes < 0)) throw new Error('IMPORT_INVALID_MEDIA_EVIDENCE');
    const variant = { sourceAdId, legacyId: content(row.id), variantIndex: typeof row.variantIndex === 'number' && Number.isInteger(row.variantIndex) && row.variantIndex >= 0 ? row.variantIndex : null,
      sourceUrl: `https://www.facebook.com/ads/library/?id=${sourceAdId}`, advertiserName: content(row.advertiser), body: content(row.copy), headline: content(row.headline), description: content(row.description), cta: content(row.cta), landingPageUrl: remote(row.landingPageUrl),
      observedAt, firstObservedAt: times[0] ?? null, lastObservedAt: times.at(-1) ?? null,
      publisherPlatforms: Array.isArray(row.platforms) ? [...new Set(row.platforms.map(v => text(v)?.toLowerCase()).filter((v): v is string => Boolean(v && platforms.has(v))))].sort() : [],
      sourceStatus: ['active', 'inactive'].includes(String(row.status)) ? String(row.status).toUpperCase() : 'UNKNOWN',
      media: sourceMedia ? { sourceUrl: sourceMedia, type: ['image', 'video'].includes(String(row.mediaType)) ? String(row.mediaType).toUpperCase() : 'UNKNOWN',
        status: 'PENDING', storageKey: null, sha256: evidence?.sha256 ?? null, sizeBytes: evidence?.sizeBytes ?? null,
        errorCode: 'LEGACY_MEDIA_NOT_UPLOADED', localReferenceHash: localName ? digest(localName) : null } : null };
    return { ...variant, variantHash: digest(JSON.stringify(variant)), rowIndex };
  }
  for (const [rowIndex, row] of rows.entries()) {
    const check = createInventoryManifest(JSON.stringify([row]), { generatedAt: manifest.generatedAt, ownership: 'public' });
    if (check.quarantined.count || rootScope) {
      quarantined.push({ rowIndex, reasons: [...new Set([...Object.entries(check.quarantined.reasons).filter(([, n]) => n > 0).map(([reason]) => reason), ...(rootScope ? ['unknownOwnership'] : [])])], rowHash: digest(JSON.stringify(row)) }); continue;
    }
    const variant = mapVariant(row as Record<string, unknown>, rowIndex);
    items.push({ rowIndex, sourceAdId: variant.sourceAdId, variantHash: variant.variantHash });
    const group = groups.get(variant.sourceAdId) ?? []; if (!group.some(existing => existing.variantHash === variant.variantHash)) group.push(variant); groups.set(variant.sourceAdId, group);
  }
  const ads = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sourceAdId, variants]) => {
    const sorted = [...variants].sort((a, b) => (b.lastObservedAt || '').localeCompare(a.lastObservedAt || '') || a.rowIndex - b.rowIndex);
    const primary = sorted[0]; const dates = variants.flatMap(v => [v.firstObservedAt, v.lastObservedAt]).filter((v): v is string => Boolean(v)).sort();
    const media = [...new Map(variants.filter(v => v.media).map(v => [v.media!.sourceUrl, v.media!])).values()]; const types = [...new Set(media.map(m => m.type))];
    return { sourceAdId, sourceUrl: primary.sourceUrl, advertiserName: primary.advertiserName, body: primary.body, headline: primary.headline, cta: primary.cta, landingPageUrl: primary.landingPageUrl,
      publisherPlatforms: [...new Set(variants.flatMap(v => v.publisherPlatforms))].sort(), reportedCountries: [] as string[], sourceStartedAt: null, sourceEndedAt: null,
      firstObservedAt: dates[0] ?? null, lastObservedAt: dates.at(-1) ?? null, sourceStatus: primary.sourceStatus, statusObservedAt: primary.observedAt,
      mediaType: types.length > 1 ? 'MIXED' : types[0] ?? 'UNKNOWN', variants, media };
  });
  const summary = { inputCount: rows.length, eligibleRows: items.length, quarantinedRows: quarantined.length, ads: ads.length, variants: ads.reduce((n, ad) => n + ad.variants.length, 0),
    repeatedStableIdRows: items.length - ads.length, exactDuplicateRows: items.length - ads.reduce((n, ad) => n + ad.variants.length, 0), unknownObservationRows: verified.missingObservationTimeCount,
    unknownPlatformRows: verified.unknownPlatformCount, adsWithoutObservation: ads.filter(ad => !ad.lastObservedAt).length, media: ads.reduce((n, ad) => n + ad.media.length, 0), mediaUploaded: 0,
    localMediaHashed: Object.keys(options.mediaEvidence ?? {}).length };
  const mappingHash = digest(JSON.stringify(items));
  const core = { version: 1, inputSha256: verified.sha256, inventoryManifestHash: verified.manifestHash, mappingHash, ads, items, quarantined, summary };
  return { ...core, planHash: digest(JSON.stringify(core)) };
}
export type PublicImportPlan = ReturnType<typeof buildPublicImportPlan>;

/** Shared guard for the explicit local-only rehearsal commands. Never provisions a source. */
export async function assertPublicImportIsolation(tx: Prisma.TransactionClient, targetUrl: string) {
  const target = validateImportTarget(targetUrl);
  const connection = await tx.$queryRawUnsafe<Array<{ database: string; port: number; address: string }>>('SELECT current_database() AS database, inet_server_port() AS port, host(inet_server_addr()) AS address');
  if (connection[0]?.database !== target.database || connection[0]?.port !== target.port || !['127.0.0.1', '::1'].includes(connection[0]?.address)) throw new Error('IMPORT_TARGET_CONNECTION_MISMATCH');
  await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended('saas-public-migration', 0))");
  const privateCounts = await Promise.all([tx.user.count(), tx.organization.count(), tx.workspace.count(), tx.savedAd.count(), tx.note.count(), tx.privateFile.count(), tx.analysisJob.count(), tx.analysisResult.count(), tx.emailDelivery.count(), tx.feedback.count(), tx.productEvent.count(), tx.auditEvent.count(), tx.subscription.count(), tx.billingEvent.count(), tx.entitlement.count(), tx.usageLedger.count(), tx.folder.count(), tx.invitation.count(), tx.authLink.count(), tx.rateLimitBucket.count(), tx.dataSource.count({ where: { key: { not: sourceKey } } })]);
  if (privateCounts.some(Boolean)) throw new Error('IMPORT_DATABASE_NOT_ISOLATED');
  const source = await tx.dataSource.findUnique({ where: { key: sourceKey } });
  if (source && source.status !== 'PAUSED') throw new Error('IMPORT_SOURCE_NOT_PAUSED');
  return source;
}

const importedMimes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm']);
const uploadErrors = new Set(['LEGACY_MEDIA_PROVIDER_FAILED', 'LEGACY_MEDIA_OBJECT_MISMATCH', 'LEGACY_MEDIA_SIZE_LIMIT']);
/** DB reconciliation only. Object content is independently checked by local-media.ts. */
export function isImportedMediaStateValid(stored: { id: string; sourceUrl: string; status: string; storageKey: string | null; sha256: string | null; sizeBytes: bigint | null; mimeType: string | null; downloadedAt: Date | null; expiresAt: Date | null; errorCode: string | null }, expected: { sourceUrl: string; sha256: string | null; sizeBytes: number | null }) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(stored.id)) return false;
  if (stored.sourceUrl !== expected.sourceUrl || stored.sha256 !== expected.sha256 || stored.sizeBytes !== (expected.sizeBytes === null ? null : BigInt(expected.sizeBytes))) return false;
  if (stored.status === 'PENDING') return stored.storageKey === null && stored.errorCode === 'LEGACY_MEDIA_NOT_UPLOADED';
  if (!expected.sha256 || !/^[a-f0-9]{64}$/.test(expected.sha256) || !expected.sizeBytes || stored.expiresAt !== null) return false;
  const key = `public-media/${stored.id}`;
  if (stored.status === 'FAILED') return uploadErrors.has(stored.errorCode ?? '') && (stored.storageKey === null || stored.storageKey === key) && (stored.mimeType === null || importedMimes.has(stored.mimeType));
  return stored.status === 'READY' && stored.storageKey === key && importedMimes.has(stored.mimeType ?? '') && stored.downloadedAt !== null && stored.errorCode === null;
}

/** Only this importer source is allowed in the target; every private/business table stays empty. */
export async function importPublicPlan(db: PrismaClient, plan: PublicImportPlan, targetUrl: string, options: { verifyOnly?: boolean } = {}) {
  validateImportTarget(targetUrl);
  return db.$transaction(async tx => {
    const source = await assertPublicImportIsolation(tx, targetUrl);
    const existingRun = await tx.collectionRun.findUnique({ where: { idempotencyKey: `legacy-public:${plan.inputSha256}` } });
    const evidenceReference = `legacy-json-sha256:${plan.inputSha256}`;
    const verify = async (runId: string, dataSourceId: string) => {
      const stored = await tx.runItem.findMany({ where: { runId }, include: { ad: { select: { sourceAdId: true } } } });
      if (stored.length !== plan.summary.inputCount) throw new Error('IMPORT_RECONCILIATION_FAILED');
      const byRow = new Map(stored.map(item => [item.itemKey, item]));
      for (const item of plan.items) {
        const found = byRow.get(`row:${item.rowIndex}`);
        if (!found || found.status !== 'INGESTED' || found.ad?.sourceAdId !== item.sourceAdId || found.evidenceSha256 !== item.variantHash) throw new Error('IMPORT_RECONCILIATION_FAILED');
      }
      for (const item of plan.quarantined) if (byRow.get(`row:${item.rowIndex}`)?.status !== 'QUARANTINED') throw new Error('IMPORT_RECONCILIATION_FAILED');
      const savedAds = await tx.ad.findMany({ where: { dataSourceId, sourceAdId: { in: plan.ads.map(ad => ad.sourceAdId) } }, include: { media: true, observations: { where: { collectionRunId: runId } } } });
      if (savedAds.length !== plan.ads.length) throw new Error('IMPORT_RECONCILIATION_FAILED');
      for (const expected of plan.ads) {
        const saved = savedAds.find(ad => ad.sourceAdId === expected.sourceAdId)!; const provenance = saved.fieldProvenance as Record<string, unknown>;
        const variants = Array.isArray(provenance.legacyVariants) ? provenance.legacyVariants as Array<Record<string, unknown>> : [];
        for (const variant of expected.variants) if (!variants.some(storedVariant => { const { rowIndex: _storedRow, ...storedFacts } = storedVariant; const { rowIndex: _row, ...expectedFacts } = variant; return canonical(storedFacts) === canonical(expectedFacts); })) throw new Error('IMPORT_RECONCILIATION_FAILED');
        if (saved.observations.length !== (expected.lastObservedAt ? 1 : 0)) throw new Error('IMPORT_RECONCILIATION_FAILED');
        for (const media of expected.media) if (!saved.media.some(m => isImportedMediaStateValid(m, media))) throw new Error('IMPORT_RECONCILIATION_FAILED');
      }
      const run = await tx.collectionRun.findUniqueOrThrow({ where: { id: runId } });
      const observations = await tx.adObservation.findMany({ where: { collectionRunId: runId } });
      verifySourceEvidenceState(plan, { run, items: stored, observations, ads: savedAds });
      return digest(JSON.stringify({ inputSha256: plan.inputSha256, planHash: plan.planHash, mappingHash: plan.mappingHash, counts: plan.summary }));
    };
    if (existingRun) {
      if (!source || existingRun.dataSourceId !== source.id || existingRun.status !== 'SUCCEEDED' || (existingRun.coverage as Record<string, unknown>).planHash !== plan.planHash) throw new Error('IMPORT_EXISTING_RUN_CONFLICT');
      return { status: 'REPLAY_VERIFIED_NO_WRITE' as const, ...plan.summary, inputSha256: plan.inputSha256, inventoryManifestHash: plan.inventoryManifestHash, planHash: plan.planHash, mappingHash: plan.mappingHash, reconciliationHash: await verify(existingRun.id, source.id) };
    }
    if (options.verifyOnly) throw new Error('IMPORT_APPROVED_RUN_REQUIRED');
    const dataSource = source ?? await tx.dataSource.create({ data: { key: sourceKey, name: '旧公开广告迁移演练', status: 'PAUSED', adapterVersion: parserVersion, configuration: { rehearsalOnly: true }, capabilities: { liveCollection: false } } });
    const task = await tx.collectionTask.create({ data: { dataSourceId: dataSource.id, name: '公开历史数据导入（不执行实时抓取）', status: 'PAUSED', query: { kind: 'legacy-public-import', inputSha256: plan.inputSha256 }, maxItems: 20 } });
    const run = await tx.collectionRun.create({ data: { taskId: task.id, dataSourceId: dataSource.id, idempotencyKey: `legacy-public:${plan.inputSha256}`, querySnapshot: { kind: 'legacy-public-import', inventoryManifestHash: plan.inventoryManifestHash }, adapterVersion: parserVersion, status: 'RUNNING', startedAt: new Date(), evidenceReference } });
    const ids = new Map<string, string>(); let insertedCount = 0; let updatedCount = 0;
    for (const ad of plan.ads) {
      const existing = await tx.ad.findUnique({ where: { dataSourceId_sourceAdId: { dataSourceId: dataSource.id, sourceAdId: ad.sourceAdId } } });
      const previous = existing?.fieldProvenance as Record<string, unknown> | undefined;
      const priorVariants = Array.isArray(previous?.legacyVariants) ? previous!.legacyVariants as Array<Record<string, unknown>> : [];
      const variants = [...new Map([...priorVariants, ...ad.variants].map(v => [v.variantHash, v])).values()];
      const first = [existing?.firstObservedAt?.toISOString(), ad.firstObservedAt].filter((v): v is string => Boolean(v)).sort()[0] ?? null;
      const last = [existing?.lastObservedAt?.toISOString(), ad.lastObservedAt].filter((v): v is string => Boolean(v)).sort().at(-1) ?? null;
      const latest = !existing?.lastObservedAt || Boolean(ad.lastObservedAt && ad.lastObservedAt >= existing.lastObservedAt.toISOString());
      const data = { sourceUrl: ad.sourceUrl, body: latest ? ad.body : existing!.body, headline: latest ? ad.headline : existing!.headline, cta: latest ? ad.cta : existing!.cta, landingPageUrl: latest ? ad.landingPageUrl : existing!.landingPageUrl, publisherPlatforms: [...new Set([...(existing?.publisherPlatforms ?? []), ...ad.publisherPlatforms])].sort(), reportedCountries: [], mediaType: existing && existing.mediaType !== 'UNKNOWN' && ad.mediaType !== 'UNKNOWN' && existing.mediaType !== ad.mediaType ? 'MIXED' : ad.mediaType === 'UNKNOWN' ? existing?.mediaType ?? 'UNKNOWN' : ad.mediaType, sourceStatus: latest ? ad.sourceStatus : existing!.sourceStatus, statusObservedAt: latest ? ad.statusObservedAt ? new Date(ad.statusObservedAt) : null : existing!.statusObservedAt, firstObservedAt: first ? new Date(first) : null, lastObservedAt: last ? new Date(last) : null,
        fieldProvenance: json({ source: 'legacy-meta-public', advertiserName: latest ? { value: ad.advertiserName, evidenceReference } : previous?.advertiserName ?? { value: ad.advertiserName, evidenceReference }, legacyVariants: variants, importedFileHashes: [...new Set([...(Array.isArray(previous?.importedFileHashes) ? previous!.importedFileHashes as string[] : []), plan.inputSha256])] }) };
      const saved = await tx.ad.upsert({ where: { dataSourceId_sourceAdId: { dataSourceId: dataSource.id, sourceAdId: ad.sourceAdId } }, create: { dataSourceId: dataSource.id, sourceAdId: ad.sourceAdId, ...data }, update: data });
      ids.set(ad.sourceAdId, saved.id); if (existing) updatedCount++; else insertedCount++;
      const observation = ad.lastObservedAt ? await tx.adObservation.create({ data: { adId: saved.id, dataSourceId: dataSource.id, collectionRunId: run.id, observedAt: new Date(ad.lastObservedAt), sourceStatus: ad.sourceStatus, snapshot: json({ legacyVariants: ad.variants }), fieldProvenance: { imported: true, unknownDatesPreserved: true }, parserVersion, evidenceReference, evidenceSha256: plan.inputSha256 } }) : null;
      for (const [displayOrder, media] of ad.media.entries()) await tx.mediaObject.upsert({ where: { adId_sourceUrl: { adId: saved.id, sourceUrl: media.sourceUrl } }, create: { adId: saved.id, observationId: observation?.id, sourceUrl: media.sourceUrl, type: media.type, displayOrder, status: 'PENDING', sha256: media.sha256, sizeBytes: media.sizeBytes === null ? null : BigInt(media.sizeBytes), errorCode: media.errorCode }, update: {} });
    }
    for (const item of plan.items) await tx.runItem.create({ data: { runId: run.id, dataSourceId: dataSource.id, itemKey: `row:${item.rowIndex}`, sourceAdId: item.sourceAdId, adId: ids.get(item.sourceAdId), status: 'INGESTED', parserVersion, evidenceReference: `${evidenceReference}#row=${item.rowIndex}`, evidenceSha256: item.variantHash } });
    for (const item of plan.quarantined) await tx.runItem.create({ data: { runId: run.id, dataSourceId: dataSource.id, itemKey: `row:${item.rowIndex}`, status: 'QUARANTINED', errorCode: 'LEGACY_RECORD_QUARANTINED', parserVersion, evidenceReference: `${evidenceReference}#row=${item.rowIndex}`, evidenceSha256: item.rowHash } });
    await tx.collectionRun.update({ where: { id: run.id }, data: { status: 'SUCCEEDED', finishedAt: new Date(), fetchedCount: plan.summary.inputCount, insertedCount, updatedCount, quarantinedCount: plan.summary.quarantinedRows, coverage: { kind: 'legacy-import', planHash: plan.planHash, mappingHash: plan.mappingHash, inventoryManifestHash: plan.inventoryManifestHash } } });
    return { status: 'IMPORTED' as const, ...plan.summary, inputSha256: plan.inputSha256, inventoryManifestHash: plan.inventoryManifestHash, planHash: plan.planHash, mappingHash: plan.mappingHash, reconciliationHash: await verify(run.id, dataSource.id) };
  }, { timeout: 120_000, maxWait: 15_000 });
}

export async function runImportPublicCli(args: string[]) {
  const allowed = new Set(['--input', '--manifest', '--confirm-manifest', '--target-url', '--output', '--media-root']); const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) { if (!allowed.has(args[i]) || flags.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('IMPORT_USAGE'); flags.set(args[i], args[i + 1]); }
  for (const name of ['--input', '--manifest', '--confirm-manifest', '--target-url', '--output']) if (!flags.has(name)) throw new Error('IMPORT_USAGE');
  const target = validateImportTarget(flags.get('--target-url')!); const input = await readFile(flags.get('--input')!); const manifest = JSON.parse(await readFile(flags.get('--manifest')!, 'utf8')) as Manifest;
  // Confirm input and all inventory facts before accessing even the media root.
  if (manifest.classification !== 'public') throw new Error('IMPORT_PUBLIC_CLASSIFICATION_REQUIRED');
  if (flags.get('--confirm-manifest') !== manifest.manifestHash || !/^[a-f0-9]{64}$/.test(manifest.manifestHash)) throw new Error('IMPORT_MANIFEST_NOT_CONFIRMED');
  const { manifestHash: _hash, generatedAt: _time, ...facts } = createInventoryManifest(input, { generatedAt: manifest.generatedAt, ownership: 'public' });
  const missing = manifest.localMedia?.missingCount, checked = manifest.localMedia?.checked;
  if (typeof checked !== 'boolean' || (checked ? !Number.isSafeInteger(missing) || missing! < 0 || missing! > facts.localMedia.uniqueReferences : missing !== null)) throw new Error('IMPORT_MANIFEST_MISMATCH');
  facts.localMedia = { ...facts.localMedia, checked, missingCount: missing };
  if (digest(JSON.stringify(facts)) !== manifest.manifestHash) throw new Error('IMPORT_MANIFEST_MISMATCH');
  let files: string[] | undefined; const mediaEvidence: MediaEvidence = {};
  if (flags.has('--media-root')) {
    if (facts.quarantined.count) throw new Error('IMPORT_PUBLIC_MEDIA_BATCH_REQUIRED');
    const root = flags.get('--media-root')!; await checkedRoot(root); files = (await readdir(root, { withFileTypes: true })).filter(e => e.isFile()).map(e => e.name);
    buildPublicImportPlan(input, manifest, { confirmManifestHash: flags.get('--confirm-manifest')!, localMediaFiles: files });
    const document = JSON.parse(input.toString('utf8')); const rows = Array.isArray(document) ? document : document.ads;
    const referenced = new Set<string>((Array.isArray(rows) ? rows : []).filter(object).map(row => text(row.mediaUrl)).filter((url): url is string => Boolean(url?.startsWith('/local-media/'))).map(url => url.slice(13)));
    for (const name of referenced) if (files.includes(name) && name !== '.' && name !== '..' && !/[\\/%?#\u0000-\u001f]/.test(name)) {
      const data = await readApprovedFile(root, name, MEDIA_MAX_BYTES); mediaEvidence[name] = { sha256: data.sha256, sizeBytes: data.sizeBytes };
    }
  }
  const plan = buildPublicImportPlan(input, manifest, { confirmManifestHash: flags.get('--confirm-manifest')!, localMediaFiles: files, mediaEvidence });
  const output = await open(flags.get('--output')!, 'wx', 0o600);
  const url = new URL(target.url); if (process.env.SAAS_MIGRATION_DATABASE_PASSWORD) url.password = process.env.SAAS_MIGRATION_DATABASE_PASSWORD;
  const require = createRequire(new URL('../../apps/web/package.json', import.meta.url)); const { PrismaClient } = require('@prisma/client') as { PrismaClient: typeof import('../../apps/web/node_modules/@prisma/client/index.js').PrismaClient };
  const db = new PrismaClient({ datasources: { db: { url: url.href } } });
  try { const report = await importPublicPlan(db, plan, target.url); await output.writeFile(`${JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2)}\n`); }
  catch (error) { const code = error instanceof Error && /^IMPORT_[A-Z_]+$/.test(error.message) ? error.message : 'IMPORT_FAILED'; await output.writeFile(`${JSON.stringify({ status: 'FAILED', errorCode: code, inputSha256: plan.inputSha256, planHash: plan.planHash }, null, 2)}\n`); throw new Error(code); }
  finally { await db.$disconnect(); await output.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runImportPublicCli(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error instanceof Error && /^IMPORT_[A-Z_]+$/.test(error.message) ? error.message : 'IMPORT_FAILED'}\n`); process.exitCode = 1;
});
