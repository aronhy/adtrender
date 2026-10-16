import { Prisma } from '@prisma/client';

export interface ArchivedMediaCapture {
  id: string;
  mediaObjectId: string;
  objectKey: string;
  sha256: string;
  type: string;
  mimeType: string;
  sizeBytes: bigint;
  downloadedAt: Date | null;
  recordedAt: Date;
  captureKind: 'READY_CAPTURE' | 'READY_BEFORE_CHANGE_CAPTURE' | 'LEGACY_READY_CAPTURE';
  /** URL matching finds stored bytes; it does not prove bytes at observation time. */
  association: 'SOURCE_URL_MATCH';
}
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};

/** Only saved media fields are read; page URLs and current MediaObject rows are not evidence. */
export function snapshotMediaSourceUrls(snapshot: unknown): string[] {
  const saved = object(snapshot), raw = object(saved.raw), urls = new Set<string>();
  for (const value of [saved.media, raw.media]) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const media = object(item), source = media.url ?? media.sourceUrl;
      if (typeof source !== 'string' || source.length > 8192 || /[\u0000-\u0020]/.test(source)) continue;
      try {
        const url = new URL(source);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
        // Exact source identity is deliberately retained internally. Normalizing
        // or dropping a source signature could associate unrelated downloads.
        urls.add(source);
      } catch { /* Malformed saved media is unavailable, never guessed. */ }
      if (urls.size > 100) throw new Error('HISTORY_MEDIA_LIMIT');
    }
  }
  return [...urls];
}

/** Internal pure read. Call only after account/workspace authorization, then
 * sign objectKey through the existing storage adapter and omit it from API DTOs.
 * Neither raw source URLs, buckets nor source signatures are returned. All byte
 * versions matching a saved URL stay separate, with their actual capture times. */
export async function lookupArchivedMedia(db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  input: { adId: string; snapshot: unknown }): Promise<ArchivedMediaCapture[]> {
  if (typeof input.adId !== 'string' || !input.adId.trim() || input.adId.length > 200) throw new Error('INVALID_HISTORY_AD_ID');
  const urls = snapshotMediaSourceUrls(input.snapshot);
  if (!urls.length) return [];
  const captures = await db.$queryRaw<Omit<ArchivedMediaCapture, 'association'>[]>(Prisma.sql`
    SELECT id, "mediaObjectId", "objectKey", sha256, type, "mimeType", "sizeBytes", "downloadedAt", "recordedAt", "captureKind"
    FROM public."ArchiveMediaCapture"
    WHERE "adId"=${input.adId} AND "sourceUrl" IN (${Prisma.join(urls)})
    ORDER BY "recordedAt" ASC, id ASC LIMIT 201`);
  if (captures.length > 200) throw new Error('HISTORY_MEDIA_CAPTURE_LIMIT');
  return captures.map(capture => ({ ...capture, association: 'SOURCE_URL_MATCH' }));
}
