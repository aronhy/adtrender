import { createHash } from 'node:crypto';
import type { PublicImportPlan } from './import-public';

export const SOURCE_EVIDENCE_MAX_BYTES = 100 * 1024 * 1024;
export const evidenceDigest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const evidenceCanonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export type EvidenceObject = { kind: 'SOURCE' | 'VARIANT'; key: string; sha256: string; sizeBytes: number; mimeType: 'application/json' };
export type EvidenceReference = { kind: 'CollectionRun' | 'AdObservation' | 'RunItem' | 'AdAdvertiser'; id: string; key: string; itemKey?: string };
export type SourceEvidenceManifest = {
  schemaVersion: 1; classification: 'public'; inputSha256: string; inventoryManifestHash: string; publicPlanHash: string;
  target: { host: string; port: number; database: string }; destination: { endpoint: string; bucket: string };
  runId: string; objects: EvidenceObject[]; references: EvidenceReference[]; manifestHash: string; generatedAt: string;
};
type EvidenceRun = { id: string; evidenceReference: string | null; coverage: unknown };
type EvidenceItem = { id: string; itemKey: string; evidenceReference: string | null; evidenceSha256: string | null };
type EvidenceObservation = { id: string; adId: string; evidenceReference: string | null; evidenceSha256: string | null };
type EvidenceAd = { id: string; fieldProvenance: unknown };
export type EvidenceRows = { run: EvidenceRun; items: EvidenceItem[]; observations: EvidenceObservation[]; ads: EvidenceAd[] };
function fail(): never { throw new Error('IMPORT_EVIDENCE_RECONCILIATION_FAILED'); }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export function evidenceKey(runId: string, kind: 'SOURCE' | 'VARIANT', digest: string) {
  if (!uuidPattern.test(runId) || !/^[a-f0-9]{64}$/.test(digest)) fail();
  const hex = evidenceDigest(`legacy-public-evidence-v1:${kind}:${digest}`);
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return `private-source-evidence/${runId}/${id}.json`;
}
export function variantEvidence(plan: PublicImportPlan) {
  const result = new Map<string, Buffer>();
  for (const ad of plan.ads) for (const variant of ad.variants) {
    const { variantHash, rowIndex: _rowIndex, ...facts } = variant;
    const bytes = Buffer.from(JSON.stringify(facts));
    if (evidenceDigest(bytes) !== variantHash || bytes.length > SOURCE_EVIDENCE_MAX_BYTES) fail();
    result.set(variantHash, bytes);
  }
  return result;
}
export function evidenceObjects(plan: PublicImportPlan, runId: string, sourceSize: number): EvidenceObject[] {
  if (!Number.isSafeInteger(sourceSize) || sourceSize < 1 || sourceSize > SOURCE_EVIDENCE_MAX_BYTES) fail();
  const result: EvidenceObject[] = [{ kind: 'SOURCE', key: evidenceKey(runId, 'SOURCE', plan.inputSha256), sha256: plan.inputSha256, sizeBytes: sourceSize, mimeType: 'application/json' }];
  for (const [sha256, bytes] of [...variantEvidence(plan)].sort(([a], [b]) => a.localeCompare(b))) result.push({ kind: 'VARIANT', key: evidenceKey(runId, 'VARIANT', sha256), sha256, sizeBytes: bytes.length, mimeType: 'application/json' });
  return result;
}
export function advertiserReference(ad: EvidenceAd): string | undefined {
  const provenance = ad.fieldProvenance;
  return object(provenance) && object(provenance.advertiserName) && typeof provenance.advertiserName.evidenceReference === 'string' ? provenance.advertiserName.evidenceReference : undefined;
}
export function plannedEvidenceReferences(plan: PublicImportPlan, rows: EvidenceRows): EvidenceReference[] {
  const rawKey = evidenceKey(rows.run.id, 'SOURCE', plan.inputSha256), legacy = `legacy-json-sha256:${plan.inputSha256}`;
  const result: EvidenceReference[] = [{ kind: 'CollectionRun', id: rows.run.id, key: rawKey }];
  const byRow = new Map(plan.items.map(item => [`row:${item.rowIndex}`, item]));
  for (const item of rows.items) {
    const expected = byRow.get(item.itemKey); if (!expected || item.evidenceSha256 !== expected.variantHash) fail();
    result.push({ kind: 'RunItem', id: item.id, itemKey: item.itemKey, key: evidenceKey(rows.run.id, 'VARIANT', expected.variantHash) });
  }
  if (rows.items.length !== plan.items.length || rows.observations.length !== plan.ads.filter(ad => ad.lastObservedAt).length) fail();
  for (const observation of rows.observations) { if (observation.evidenceSha256 !== plan.inputSha256 || !rows.ads.some(ad => ad.id === observation.adId)) fail(); result.push({ kind: 'AdObservation', id: observation.id, key: rawKey }); }
  for (const ad of rows.ads) if ([legacy, `s3:${rawKey}`].includes(advertiserReference(ad) ?? '')) result.push({ kind: 'AdAdvertiser', id: ad.id, key: rawKey });
  return result.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
}
export function hashEvidenceManifest(manifest: Omit<SourceEvidenceManifest, 'manifestHash' | 'generatedAt'>) { return evidenceDigest(evidenceCanonical(manifest)); }

/** Strict DB receipt/reference reconciliation; deliberately performs no S3 I/O. */
export function verifySourceEvidenceState(plan: PublicImportPlan, rows: EvidenceRows): SourceEvidenceManifest | null {
  const legacy = `legacy-json-sha256:${plan.inputSha256}`;
  const receipt = object(rows.run.coverage) ? rows.run.coverage.sourceEvidenceArchive : undefined;
  if (receipt === undefined) {
    if (rows.run.evidenceReference !== legacy) fail();
    for (const item of rows.items) if (item.evidenceReference !== `${legacy}#${item.itemKey.replace(':', '=')}`) fail();
    for (const observation of rows.observations) if (observation.evidenceReference !== legacy || observation.evidenceSha256 !== plan.inputSha256) fail();
    return null;
  }
  if (!object(receipt) || plan.quarantined.length || receipt.schemaVersion !== 1 || receipt.classification !== 'public' || receipt.runId !== rows.run.id
    || receipt.inputSha256 !== plan.inputSha256 || receipt.inventoryManifestHash !== plan.inventoryManifestHash || receipt.publicPlanHash !== plan.planHash
    || typeof receipt.generatedAt !== 'string' || !Number.isFinite(new Date(receipt.generatedAt).valueOf()) || !Array.isArray(receipt.objects) || !Array.isArray(receipt.references)
    || !object(receipt.target) || !object(receipt.destination)) fail();
  const value = receipt as unknown as SourceEvidenceManifest;
  const { manifestHash, generatedAt: _generatedAt, ...core } = value;
  if (manifestHash !== hashEvidenceManifest(core)) fail();
  const { host, port, database } = value.target;
  if (!['localhost', '127.0.0.1', '::1'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-z_][a-z0-9_-]{0,62}$/i.test(database) || !/(^|[_-])(test|rehearsal)([_-]|$)/i.test(database)) fail();
  try {
    const url = new URL(value.destination.endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.origin !== value.destination.endpoint || !/^saas-migration-test-[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/.test(value.destination.bucket)) fail();
  } catch { fail(); }
  const sourceSize = value.objects.find(item => item?.kind === 'SOURCE')?.sizeBytes;
  if (sourceSize === undefined || evidenceCanonical(evidenceObjects(plan, rows.run.id, sourceSize)) !== evidenceCanonical(value.objects)) fail();
  const expected = plannedEvidenceReferences(plan, rows);
  const currentRequired = expected.filter(ref => ref.kind !== 'AdAdvertiser');
  const receiptRequired = value.references.filter(ref => ref?.kind !== 'AdAdvertiser');
  if (evidenceCanonical(currentRequired) !== evidenceCanonical(receiptRequired)) fail();
  const rawKey = evidenceKey(rows.run.id, 'SOURCE', plan.inputSha256);
  const seen = new Set<string>();
  for (const ref of value.references) {
    const identity = `${ref.kind}:${ref.id}`;
    if (seen.has(identity) || !uuidPattern.test(ref.id)) fail(); seen.add(identity);
    if (ref.kind === 'AdAdvertiser' && (!rows.ads.some(ad => ad.id === ref.id) || ref.key !== rawKey || Object.keys(ref).length !== 3)) fail();
  }
  if (rows.run.evidenceReference !== `s3:${rawKey}`) fail();
  for (const ref of currentRequired) {
    const actual = ref.kind === 'RunItem' ? rows.items.find(item => item.id === ref.id)?.evidenceReference : ref.kind === 'AdObservation' ? rows.observations.find(item => item.id === ref.id)?.evidenceReference : rows.run.evidenceReference;
    if (actual !== `s3:${ref.key}`) fail();
  }
  for (const ad of rows.ads) {
    const current = advertiserReference(ad);
    if (current === legacy || (current === `s3:${rawKey}` && !value.references.some(ref => ref.kind === 'AdAdvertiser' && ref.id === ad.id))) fail();
  }
  return value;
}
