import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { PrismaClient, Prisma } from '../../app/node_modules/@prisma/client';
import { seedCanonical, seedSourceKeys, type SourceKey } from '../../contracts/src/seeds';
import type { ArtifactStore } from './collector-evidence';
export interface CommittedDiscoveryRun {
  id: string; dataSourceId: string; sourceKey: string; status: string; finishedAt: Date | string | null; idempotencyKey: string;
  items: Array<{ sourceAdId: string | null; adId: string | null; dataSourceId: string; runId: string; status: string; evidenceSha256?: string | null }>;
  observations: Array<{ id: string; collectionRunId: string; adId: string; dataSourceId: string; observedAt: Date | string; evidenceSha256?: string | null; snapshot: unknown }>;
}
export type ClueEvidence = { kind: string; rawValue: string; normalizedValue: string; namespace: string; language: string; verificationStatus: string; role: string; sourceKey: string; dataSourceId: string; runId: string; adId: string | null; observationId: string | null; sourceAdId: string | null; observedAt: string; sourceUrl: string | null; extractionVersion: string; fieldPath: string; evidenceSha256: string | null; dedupeKey: string; originKind: string };
export type DiscoveryReport = { seedsCreated: number; evidenceCreated: number; relationsCreated: number; nativeVerified: number; clues: number };

const hashes = /^[a-f0-9]{64}$/;
const prefixes: Record<string, string> = { meta_ad_library: 'meta-service', google_ads_transparency: 'google-service', tiktok_commercial_library: 'tiktok-service', pinterest_ads_repository: 'pinterest-service', snapchat_ads_gallery: 'snapchat-service' };
const sharedHosts = new Set(['apps.apple.com', 'itunes.apple.com', 'play.google.com', 'appgallery.huawei.com', 'www.microsoft.com', 'store.steampowered.com']);
type Row = Record<string, unknown>;
function row(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function rows(value: unknown): Row[] { return Array.isArray(value) ? value.map(row) : []; }
function string(value: unknown): string | null { return typeof value === 'string' && value.length > 0 ? value : null; }
function fail(code: string): never { throw new Error(code); }
function iso(value: Date | string | null): string { const date = value == null ? NaN : new Date(value).getTime(); if (!Number.isFinite(date)) fail('DISCOVERY_DATE_INVALID'); return new Date(date).toISOString(); }
function finalRun(run: CommittedDiscoveryRun) {
  if (!['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'RESTRICTED'].includes(run.status) || run.finishedAt == null) fail('DISCOVERY_RUN_NOT_COMMITTED');
  iso(run.finishedAt);
  if (!seedSourceKeys.includes(run.sourceKey as SourceKey)) fail('DISCOVERY_SOURCE_MISMATCH');
  for (const item of run.items) if (item.runId !== run.id || item.dataSourceId !== run.dataSourceId) fail('DISCOVERY_FACT_BINDING_MISMATCH');
  for (const observation of run.observations) if (observation.collectionRunId !== run.id || observation.dataSourceId !== run.dataSourceId) fail('DISCOVERY_FACT_BINDING_MISMATCH');
}
function batchHash(run: CommittedDiscoveryRun, supplied?: string): string | null {
  const nativeHash = new RegExp('^' + prefixes[run.sourceKey] + ':([a-f0-9]{64})$').exec(run.idempotencyKey)?.[1];
  if (supplied !== undefined && !hashes.test(supplied)) fail('DISCOVERY_BATCH_BINDING_MISMATCH');
  if (nativeHash && supplied && nativeHash !== supplied) fail('DISCOVERY_BATCH_BINDING_MISMATCH');
  const sha = supplied ?? nativeHash ?? null;
  const evidence = [...run.items, ...run.observations].map(value => value.evidenceSha256).filter((value): value is string => !!value);
  if (sha && (evidence.some(value => value !== sha) || (!nativeHash && !evidence.includes(sha)))) fail('DISCOVERY_BATCH_BINDING_MISMATCH');
  return sha;
}
function normalized(kind: string, value: string): string | null {
  const text = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!text || text.length > (kind === 'DOMAIN' ? 253 : 200) || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return kind === 'NATIVE_ADVERTISER' ? text : text.toLowerCase();
}
function publicUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 8000) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home)$/.test(url.hostname)) return null;
    return url;
  } catch { return null; }
}
function sourceUrl(source: string, value: unknown): string | null {
  const url = publicUrl(value); if (!url || url.protocol !== 'https:') return null;
  const hosts: Record<string, string[]> = { meta_ad_library: ['www.facebook.com', 'facebook.com'], google_ads_transparency: ['adstransparency.google.com'], snapchat_ads_gallery: ['adsgallery.snap.com'], tiktok_commercial_library: ['library.tiktok.com'], pinterest_ads_repository: ['ads.pinterest.com', 'www.pinterest.com'] };
  if (!hosts[source]?.includes(url.hostname)) return null;
  const kept = new URLSearchParams();
  for (const key of source === 'meta_ad_library' ? ['id'] : source === 'snapchat_ads_gallery' ? ['adId'] : source === 'tiktok_commercial_library' ? ['ad_id'] : []) { const id = url.searchParams.get(key); if (id && /^[A-Za-z0-9_-]{1,200}$/.test(id)) kept.set(key, id); }
  url.search = kept.toString(); url.hash = ''; return url.href;
}
function googleIdentity(value: unknown): { id: string; creative: string | null } | null {
  const url = publicUrl(value); if (!url || url.protocol !== 'https:' || url.hostname !== 'adstransparency.google.com') return null;
  const match = /^\/advertiser\/(AR\d{5,})(?:\/creative\/(CR\d{5,}))?\/?$/.exec(url.pathname);
  return match ? { id: match[1], creative: match[2] ?? null } : null;
}
/** Original embedded JSON must pair both identities in the same object. Parsed Page rows alone are insufficient. */
function metaPair(value: unknown, adId: string, pageId: string, rootPath: string): string | null {
  const pending: Array<{ value: unknown; path: string }> = [{ value, path: rootPath }];
  while (pending.length) {
    const { value: node, path } = pending.pop()!;
    if (path.length > 8192) continue;
    if (Array.isArray(node)) { node.forEach((value, index) => pending.push({ value, path: `${path}[${index}]` })); continue; }
    if (node && typeof node === 'object') {
      const object = row(node);
      if (String(object.ad_archive_id ?? '') === adId && String(object.page_id ?? '') === pageId) return path + '.page_id';
      for (const [key, value] of Object.entries(object)) pending.push({ value, path: /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? path + '.' + key : path + '[' + JSON.stringify(key) + ']' });
    }
  }
  return null;
}
function metaProof(archive: Row, adId: string, pageId: string): string | null {
  const evidenceRows = rows(archive.evidence);
  for (let index = 0; index < evidenceRows.length; index++) {
    const evidence = evidenceRows[index];
    if (evidence.kind !== 'embedded-listing' || evidence.httpStatus !== 200) continue;
    const url = publicUrl(evidence.url); if (!url || url.protocol !== 'https:' || !['www.facebook.com', 'facebook.com'].includes(url.hostname) || url.pathname !== '/ads/library/') continue;
    const path = metaPair(evidence.payload, adId, pageId, `archive.evidence[${index}].payload`); if (path) return path;
    // Future capture versions may preserve a JSON script verbatim in this field.
    if (typeof evidence.rawPayload !== 'string') continue;
    try { const path = metaPair(JSON.parse(evidence.rawPayload), adId, pageId, `archive.evidence[${index}].rawPayload`); if (path) return path; } catch { /* Invalid original JSON cannot verify an identity. */ }
  }
  return null;
}

/** Server worker API. Frozen observations produce candidates; source identity verification additionally requires exact archived bytes. */
export function extractPublicClues(input: { run: CommittedDiscoveryRun; archiveBytes?: Uint8Array; batchSha256?: string; extractionVersion: string }): ClueEvidence[] {
  const { run } = input; finalRun(run);
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(input.extractionVersion)) fail('DISCOVERY_VERSION_INVALID');
  let archive: Row = {};
  if (input.archiveBytes) {
    if (input.archiveBytes.byteLength > 25_000_000) fail('DISCOVERY_ARCHIVE_TOO_LARGE');
    const sha = createHash('sha256').update(input.archiveBytes).digest('hex');
    if (!input.batchSha256 || sha !== input.batchSha256) fail('DISCOVERY_ARCHIVE_HASH_MISMATCH');
    try { archive = row(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.archiveBytes))); } catch { fail('DISCOVERY_ARCHIVE_INVALID'); }
    if (archive.sourceKey !== run.sourceKey) fail('DISCOVERY_SOURCE_MISMATCH');
  }
  const sha = batchHash(run, input.batchSha256);
  const clues: ClueEvidence[] = [];
  const add = (kind: string, rawValue: unknown, context: Omit<ClueEvidence, 'kind' | 'rawValue' | 'normalizedValue' | 'language' | 'extractionVersion' | 'dedupeKey'>) => {
    if (typeof rawValue !== 'string') return;
    const value = normalized(kind, rawValue); if (!value) return;
    const clue = { ...context, kind, rawValue, normalizedValue: value, language: 'und', extractionVersion: input.extractionVersion };
    const dedupeKey = createHash('sha256').update(seedCanonical({ source: run.sourceKey, batch: sha, run: run.id, observation: clue.observationId, ad: clue.adId, sourceAd: clue.sourceAdId, version: input.extractionVersion, fieldPath: clue.fieldPath, rawValue, value, role: clue.role })).digest('hex');
    if (!clues.some(existing => existing.dedupeKey === dedupeKey)) clues.push({ ...clue, dedupeKey });
  };
  type Context = Parameters<typeof add>[2];
  const base = (observedAt: string): Context => ({ sourceKey: run.sourceKey, dataSourceId: run.dataSourceId, runId: run.id, adId: null, observationId: null, sourceAdId: null, observedAt, sourceUrl: null, evidenceSha256: sha, namespace: 'public', verificationStatus: 'CANDIDATE', role: 'PUBLIC_NAME', fieldPath: '', originKind: 'COMMITTED_OBSERVATION' });
  const landing = (value: unknown, context: Context, path: string, role = 'LANDING_HOST') => {
    const url = publicUrl(value); if (!url) return;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return;
    add('DOMAIN', host, { ...context, namespace: sharedHosts.has(host) ? 'shared-platform' : 'public', role: sharedHosts.has(host) ? 'SHARED_PLATFORM_HOST' : role, fieldPath: path });
  };
  const committed = new Map<string, Context>();
  for (const observation of run.observations) {
    const snapshot = row(observation.snapshot);
    const item = run.items.find(item => item.adId === observation.adId && ['INGESTED', 'INSERTED', 'UPDATED'].includes(item.status) && item.sourceAdId && item.sourceAdId === snapshot.sourceAdId);
    if (!item) continue;
    const context: Context = { ...base(iso(observation.observedAt)), adId: observation.adId, observationId: observation.id, sourceAdId: item.sourceAdId, sourceUrl: sourceUrl(run.sourceKey, snapshot.sourceUrl), evidenceSha256: observation.evidenceSha256 ?? sha };
    committed.set(item.sourceAdId!, context);
    const snap = run.sourceKey === 'snapchat_ads_gallery';
    add('NAME', snapshot.advertiserName, { ...context, namespace: snap ? 'payer:snapchat_ads_gallery' : 'public', role: snap ? 'PAYING_ADVERTISER' : 'PUBLIC_NAME', fieldPath: 'observation.snapshot.advertiserName' });
    if (snap) add('NAME', snapshot.brand, { ...context, role: 'DISPLAY_NAME', fieldPath: 'observation.snapshot.brand' });
    landing(snapshot.landingPageUrl, context, 'observation.snapshot.landingPageUrl');
    if (Array.isArray(snapshot.landingPageUrls)) snapshot.landingPageUrls.forEach((url, i) => landing(url, context, `observation.snapshot.landingPageUrls[${i}]`));
    if (run.sourceKey === 'google_ads_transparency') {
      const identity = googleIdentity(snapshot.sourceUrl);
      const archiveIndex = rows(archive.ads).findIndex(ad => ad.sourceAdId === item.sourceAdId && ad.advertiserId === snapshot.advertiserId && googleIdentity(ad.sourceUrl)?.id === identity?.id && googleIdentity(ad.sourceUrl)?.creative === item.sourceAdId);
      const verified = archiveIndex >= 0;
      if (identity && identity.id === snapshot.advertiserId && identity.creative === item.sourceAdId) add('NATIVE_ADVERTISER', identity.id, { ...context, namespace: run.sourceKey, verificationStatus: verified ? 'VERIFIED' : 'CANDIDATE', role: 'SOURCE_IDENTITY', fieldPath: verified ? `archive.ads[${archiveIndex}].advertiserId` : 'observation.snapshot.advertiserId', originKind: verified ? 'ORIGINAL_SOURCE_IDENTITY' : 'PARSED_SOURCE_IDENTITY' });
    }
  }
  if (input.archiveBytes && run.sourceKey === 'meta_ad_library') {
    rows(archive.advertisers).forEach((advertiser, index) => {
      const adId = string(advertiser.sourceAdId); const pageId = string(advertiser.pageId);
      const context = adId ? committed.get(adId) : null;
      if (!context || !pageId || !/^\d{5,}$/.test(pageId) || !rows(archive.ads).some(ad => ad.sourceAdId === adId)) return;
      const verified = metaProof(archive, adId!, pageId);
      add('NATIVE_ADVERTISER', pageId, { ...context, namespace: run.sourceKey, verificationStatus: verified ? 'VERIFIED' : 'CANDIDATE', role: 'SOURCE_IDENTITY', fieldPath: verified ?? `archive.advertisers[${index}].pageId`, originKind: verified ? 'ORIGINAL_SOURCE_IDENTITY' : 'PARSED_SOURCE_IDENTITY' });
    });
  }
  if (input.archiveBytes && run.sourceKey === 'google_ads_transparency') {
    const observedAt = iso(string(archive.observedAt));
    rows(archive.advertisers).forEach((advertiser, index) => {
      const id = string(advertiser.advertiserId); const identity = googleIdentity(advertiser.sourceUrl);
      if (!id || !/^AR\d{5,}$/.test(id) || identity?.id !== id || identity.creative) return;
      const url = sourceUrl(run.sourceKey, advertiser.sourceUrl);
      const proof = rows(archive.evidence).some(evidence => evidence.kind === 'advertiser' && evidence.httpStatus === 200 && googleIdentity(evidence.url)?.id === id && !googleIdentity(evidence.url)?.creative && typeof evidence.text === 'string' && evidence.text.trim().length > 0);
      if (!proof) return;
      const context = { ...base(observedAt), originKind: 'ORIGINAL_SOURCE_IDENTITY', sourceUrl: url };
      add('NATIVE_ADVERTISER', id, { ...context, namespace: run.sourceKey, verificationStatus: 'VERIFIED', role: 'SOURCE_IDENTITY', fieldPath: `archive.advertisers[${index}].advertiserId` });
      add('NAME', advertiser.name, { ...context, fieldPath: `archive.advertisers[${index}].name` });
    });
    if (row(archive.query).kind === 'SERP') rows(archive.searchObservations).forEach((search, index) => landing(search.landingPageUrl, { ...base(observedAt), originKind: 'COMMITTED_DISCOVERY' }, `archive.searchObservations[${index}].landingPageUrl`, 'SPONSORED_RESULT_HOST'));
  }
  return clues;
}

function definitionIdentity(clue: ClueEvidence) { return { kind: clue.kind, namespace: clue.namespace, language: clue.language, normalizedValue: clue.normalizedValue }; }
function relationGroup(clue: ClueEvidence): string { return seedCanonical({ source: clue.sourceKey, run: clue.runId, observation: clue.observationId, ad: clue.adId, sourceAd: clue.sourceAdId }); }
/** Accept only worker-derived clues. This API is never exposed as a client mutation. */
export async function upsertDiscoveredClues(db: PrismaClient | Prisma.TransactionClient, clues: ClueEvidence[]): Promise<DiscoveryReport> {
  if ('$transaction' in db) return db.$transaction(tx => upsertDiscoveredClues(tx, clues), { timeout: 30_000 });
  const report: DiscoveryReport = { seedsCreated: 0, evidenceCreated: 0, relationsCreated: 0, nativeVerified: 0, clues: clues.length };
  if (!clues.length) return report;
  const runs = await db.collectionRun.findMany({ where: { id: { in: [...new Set(clues.map(clue => clue.runId))] } }, include: { task: { include: { dataSource: true } }, items: true, observations: true } });
  const committedRuns = new Map(runs.map(run => [run.id, { ...run, sourceKey: run.task.dataSource.key }]));
  for (const clue of clues) {
    const run = committedRuns.get(clue.runId);
    if (!run || run.sourceKey !== clue.sourceKey || run.dataSourceId !== clue.dataSourceId) fail('DISCOVERY_FACT_BINDING_MISMATCH');
    finalRun(run); batchHash(run, clue.evidenceSha256 ?? undefined);
    if (clue.observationId) {
      const observation = run.observations.find(value => value.id === clue.observationId);
      if (!observation || observation.adId !== clue.adId || iso(observation.observedAt) !== clue.observedAt || row(observation.snapshot).sourceAdId !== clue.sourceAdId || !run.items.some(item => item.adId === clue.adId && item.sourceAdId === clue.sourceAdId && ['INGESTED', 'INSERTED', 'UPDATED'].includes(item.status))) fail('DISCOVERY_FACT_BINDING_MISMATCH');
      if (observation.evidenceSha256 && observation.evidenceSha256 !== clue.evidenceSha256) fail('DISCOVERY_BATCH_BINDING_MISMATCH');
    } else if (clue.adId || clue.sourceAdId) fail('DISCOVERY_FACT_BINDING_MISMATCH');
  }
  // Same lock order as catalog/publication commands, then sorted identities for concurrent extractors.
  await db.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended('seed-publication-head',0))");
  const identities = [...new Set(clues.map(clue => 'seed-definition:' + seedCanonical(definitionIdentity(clue))))].sort();
  for (const identity of identities) await db.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', identity);
  const projected: Array<{ clue: ClueEvidence; seedId: string; evidenceId: string }> = [];
  for (const clue of clues) {
    if (!seedSourceKeys.includes(clue.sourceKey as SourceKey) || !hashes.test(clue.dedupeKey) || normalized(clue.kind, clue.rawValue) !== clue.normalizedValue || !['NAME', 'DOMAIN', 'NATIVE_ADVERTISER'].includes(clue.kind) || !['CANDIDATE', 'VERIFIED'].includes(clue.verificationStatus)) fail('DISCOVERY_CLUE_INVALID');
    if (clue.verificationStatus === 'VERIFIED' && (clue.kind !== 'NATIVE_ADVERTISER' || clue.namespace !== clue.sourceKey || clue.originKind !== 'ORIGINAL_SOURCE_IDENTITY' || !clue.evidenceSha256 || !hashes.test(clue.evidenceSha256))) fail('DISCOVERY_PROOF_REQUIRED');
    const where = { kind_namespace_language_normalizedValue: definitionIdentity(clue) };
    let seed = await db.seedDefinition.findUnique({ where });
    if (!seed) {
      seed = await db.seedDefinition.create({ data: { ...definitionIdentity(clue), rawValue: clue.rawValue, purposeTags: [], targetScope: { kind: 'CONFIGURED_MARKETS' }, targetPlatforms: [clue.sourceKey], status: 'DRAFT', priority: 0, verificationStatus: clue.verificationStatus } });
      report.seedsCreated++; if (clue.verificationStatus === 'VERIFIED') report.nativeVerified++;
    } else if (seed.verificationStatus === 'CANDIDATE' && clue.verificationStatus === 'VERIFIED') {
      seed = await db.seedDefinition.update({ where: { id: seed.id }, data: { verificationStatus: 'VERIFIED', revision: { increment: 1 } } }); report.nativeVerified++;
    }
    let evidence = await db.seedEvidence.findUnique({ where: { dedupeKey: clue.dedupeKey } });
    if (!evidence) {
      const { kind: ignoredKind, namespace: ignoredNamespace, language: ignoredLanguage, verificationStatus: ignoredStatus, sourceKey: ignoredSource, ...data } = clue;
      evidence = await db.seedEvidence.create({ data: { ...data, seedId: seed.id, observedAt: new Date(clue.observedAt) } }); report.evidenceCreated++;
    } else if (evidence.seedId !== seed.id) fail('DISCOVERY_EVIDENCE_CONFLICT');
    projected.push({ clue, seedId: seed.id, evidenceId: evidence.id });
  }
  for (const from of projected) {
    if (from.clue.kind !== 'NATIVE_ADVERTISER' && (from.clue.kind !== 'DOMAIN' || from.clue.role === 'SHARED_PLATFORM_HOST')) continue;
    for (const to of projected) {
      if (to.clue.kind !== 'NAME' || to.clue.role === 'PAYING_ADVERTISER' || relationGroup(from.clue) !== relationGroup(to.clue)) continue;
      // Identity-only discovery rows must refer to the same advertiser record, not just the same batch.
      if (!from.clue.observationId && from.clue.fieldPath.replace(/\.[^.]+$/, '') !== to.clue.fieldPath.replace(/\.[^.]+$/, '')) continue;
      const relationType = from.clue.kind === 'NATIVE_ADVERTISER' ? 'IDENTITY_ON_SOURCE' : 'DOMAIN_OF';
      const key = { fromSeedId: from.seedId, toSeedId: to.seedId, relationType };
      const prior = await db.seedRelation.findUnique({ where: { fromSeedId_toSeedId_relationType: key } });
      const evidenceIds = [...new Set([...(prior?.evidenceIds ?? []), from.evidenceId, to.evidenceId])].sort();
      if (!prior) { await db.seedRelation.create({ data: { ...key, status: 'PENDING', evidenceIds } }); report.relationsCreated++; }
      else if (evidenceIds.length !== prior.evidenceIds.length) await db.seedRelation.update({ where: { id: prior.id }, data: { evidenceIds } });
    }
  }
  return report;
}

/** Fetch a server-owned artifact reference after checking committed run/source identity. No network URL is accepted. */
export async function discoverCommittedRun(db: PrismaClient, input: { runId: string; sourceKey: string; batchSha256?: string; archiveKey?: string; extractionVersion: string }, store?: ArtifactStore): Promise<DiscoveryReport> {
  const run = await db.collectionRun.findUnique({ where: { id: input.runId }, include: { task: { include: { dataSource: true } }, items: true, observations: true } });
  if (!run) fail('DISCOVERY_RUN_NOT_FOUND');
  const source = run.task.dataSource.key;
  if (source !== input.sourceKey || run.dataSourceId !== run.task.dataSourceId) fail('DISCOVERY_SOURCE_MISMATCH');
  const committed: CommittedDiscoveryRun = { ...run, sourceKey: source };
  finalRun(committed);
  const sha = batchHash(committed, input.batchSha256);
  let archiveBytes: Uint8Array | undefined;
  if (input.archiveKey !== undefined) {
    if (!store || !sha || !new RegExp('^[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*/' + source + '/' + sha + '\\.bin$').test(input.archiveKey)) fail('DISCOVERY_ARCHIVE_REFERENCE_INVALID');
    archiveBytes = await store.get(input.archiveKey);
  }
  const clues = extractPublicClues({ run: committed, archiveBytes, batchSha256: sha ?? undefined, extractionVersion: input.extractionVersion });
  return upsertDiscoveredClues(db, clues);
}
