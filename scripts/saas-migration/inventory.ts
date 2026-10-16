import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Ownership = 'public' | 'unknown';
type InventoryOptions = {
  generatedAt: string;
  /** A reviewed input classification, not proof of permission to publish. */
  ownership?: Ownership;
  /** Regular filenames only. Omission means media existence was not checked. */
  localMediaFiles?: readonly string[];
};
const reasonNames = ['invalidRecord', 'missingStableId', 'nonMetaSource', 'conflictingStableId',
  'unknownOwnership', 'unsafeLocalMediaReference'] as const;
type QuarantineReason = typeof reasonNames[number];
const knownPlatforms = new Set(['facebook', 'instagram', 'messenger', 'audience_network', 'threads']);
const scopeFields = ['tenantId', 'tenant_id', 'workspaceId', 'workspace_id', 'organizationId',
  'organization_id', 'ownerId', 'owner_id', 'userId', 'user_id', 'owner'];
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const stableId = (value: unknown) => /^\d+$/.test(text(value)) ? text(value) : '';

function validTimestamp(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)) return false;
  const calendarDate = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(calendarDate.valueOf()) && calendarDate.toISOString().slice(0, 10) === value.slice(0, 10)
    && Number.isFinite(Date.parse(value));
}

function hasPrivateOrUnresolvedScope(record: Record<string, unknown>): boolean {
  return scopeFields.some(key => record[key] !== undefined && record[key] !== null && record[key] !== '')
    || record.isPublic === false || record.isPrivate === true
    || ['visibility', 'ownership', 'scope'].some(key => record[key] !== undefined && record[key] !== 'public');
}

function sourceEvidence(value: unknown): { isMeta: boolean; id: string; ambiguousId: boolean } {
  try {
    const url = new URL(text(value));
    const isMeta = url.protocol === 'https:' && ['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(url.hostname)
      && /^\/ads\/library\/?$/.test(url.pathname) && !url.username && !url.password && !url.port;
    const ids = url.searchParams.getAll('id');
    return { isMeta, id: isMeta && ids.length === 1 ? stableId(ids[0]) : '', ambiguousId: isMeta && ids.length > 1 };
  } catch { return { isMeta: false, id: '', ambiguousId: false }; }
}

/** Pure, offline aggregate inventory. No record identifiers, source text, URLs or paths leave this function. */
export function createInventoryManifest(input: string | Uint8Array, options: InventoryOptions) {
  if (!validTimestamp(options.generatedAt) || (options.ownership !== undefined && !['public', 'unknown'].includes(options.ownership))) {
    throw new Error('INVENTORY_INVALID_OPTIONS');
  }
  let document: unknown;
  try { document = JSON.parse(typeof input === 'string' ? input : Buffer.from(input).toString('utf8')); }
  catch { throw new Error('INVENTORY_INVALID_INPUT'); }
  const rows = Array.isArray(document) ? document : isRecord(document) ? document.ads : undefined;
  if (!Array.isArray(rows)) throw new Error('INVENTORY_INVALID_INPUT');
  const ownership = options.ownership ?? 'unknown';
  const rootHasScope = isRecord(document) && hasPrivateOrUnresolvedScope(document);
  const reasons = Object.fromEntries(reasonNames.map(reason => [reason, 0])) as Record<QuarantineReason, number>;
  const groups = new Map<string, { rows: number; variants: Set<string> }>();
  const mediaReferences: string[] = [];
  let quarantinedCount = 0, missingObservationTimeCount = 0, unknownPlatformCount = 0, duplicateVariantRows = 0;
  for (const row of rows) {
    const rowReasons = new Set<QuarantineReason>();
    if (!isRecord(row)) {
      reasons.invalidRecord++; quarantinedCount++;
      missingObservationTimeCount++; unknownPlatformCount++;
      continue;
    }
    const source = sourceEvidence(row.sourceUrl);
    const explicitId = stableId(row.libraryId);
    const id = explicitId || source.id;
    if (!id) rowReasons.add('missingStableId');
    if (!source.isMeta) rowReasons.add('nonMetaSource');
    if (source.ambiguousId || (explicitId && source.id && explicitId !== source.id)) rowReasons.add('conflictingStableId');
    if (ownership !== 'public' || rootHasScope || hasPrivateOrUnresolvedScope(row)) rowReasons.add('unknownOwnership');
    if (![row.collectedAt, row.lastCollectedAt, row.firstCollectedAt].some(validTimestamp)) missingObservationTimeCount++;
    if (!Array.isArray(row.platforms) || !row.platforms.some(value => knownPlatforms.has(text(value).toLowerCase()))) unknownPlatformCount++;
    if (id) {
      const group = groups.get(id) ?? { rows: 0, variants: new Set<string>() };
      group.rows++;
      // Missing variant indexes stay unknown; do not guess that they are duplicate variants.
      if (typeof row.variantIndex === 'number' && Number.isInteger(row.variantIndex) && row.variantIndex >= 0) {
        const variant = String(row.variantIndex);
        if (group.variants.has(variant)) duplicateVariantRows++;
        group.variants.add(variant);
      }
      groups.set(id, group);
    }
    const media = text(row.mediaUrl);
    if (media.startsWith('/local-media/')) {
      const filename = media.slice('/local-media/'.length);
      // Legacy local media uses a single filename. Reject traversal, escaped separators and query strings.
      if (!filename || filename === '.' || filename === '..' || /[\\/%?#\u0000-\u001f]/.test(filename)) rowReasons.add('unsafeLocalMediaReference');
      else mediaReferences.push(filename);
    }
    if (rowReasons.size) quarantinedCount++;
    for (const reason of rowReasons) reasons[reason]++;
  }
  const mediaNames = new Set(mediaReferences);
  const localFiles = options.localMediaFiles === undefined ? undefined : new Set(options.localMediaFiles);
  const payload = {
    schemaVersion: 1,
    classification: ownership,
    sha256: sha256(input),
    inputCount: rows.length,
    eligibleCount: rows.length - quarantinedCount,
    uniqueStableIds: groups.size,
    variants: {
      repeatedStableIdRows: [...groups.values()].reduce((count, group) => count + group.rows - 1, 0),
      multiVariantGroups: [...groups.values()].filter(group => group.variants.size > 1).length,
      duplicateVariantRows,
    },
    missingObservationTimeCount,
    unknownPlatformCount,
    localMedia: {
      references: mediaReferences.length,
      uniqueReferences: mediaNames.size,
      checked: localFiles !== undefined,
      missingCount: localFiles === undefined ? null : [...mediaNames].filter(name => !localFiles.has(name)).length,
    },
    quarantined: { count: quarantinedCount, reasons },
  };
  return { ...payload, manifestHash: sha256(JSON.stringify(payload)), generatedAt: options.generatedAt };
}

/** Reads only the requested source and media directory; creates exactly one new output file. */
export async function runInventoryCli(args: string[]): Promise<void> {
  const allowed = new Set(['--input', '--output', '--ownership', '--media-root']);
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!allowed.has(key) || flags.has(key) || !value || value.startsWith('--')) throw new Error('INVENTORY_USAGE');
    flags.set(key, value);
  }
  if (!flags.has('--input') || !flags.has('--output')) throw new Error('INVENTORY_USAGE');
  const ownership = flags.get('--ownership') ?? 'unknown';
  if (ownership !== 'public' && ownership !== 'unknown') throw new Error('INVENTORY_USAGE');
  let input: Buffer, localMediaFiles: string[] | undefined;
  try {
    input = await readFile(flags.get('--input')!);
    if (flags.has('--media-root')) localMediaFiles = (await readdir(flags.get('--media-root')!, { withFileTypes: true }))
      .filter(entry => entry.isFile()).map(entry => entry.name);
  } catch { throw new Error('INVENTORY_READ_FAILED'); }
  const manifest = createInventoryManifest(input, { generatedAt: new Date().toISOString(), ownership, localMediaFiles });
  try {
    await writeFile(flags.get('--output')!, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    throw new Error((error as NodeJS.ErrnoException).code === 'EEXIST' ? 'INVENTORY_OUTPUT_EXISTS' : 'INVENTORY_WRITE_FAILED');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runInventoryCli(process.argv.slice(2)).catch(error => {
    // Only fixed error codes: never print an input value, filesystem path or native exception.
    const code = error instanceof Error && /^INVENTORY_[A-Z_]+$/.test(error.message) ? error.message : 'INVENTORY_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
