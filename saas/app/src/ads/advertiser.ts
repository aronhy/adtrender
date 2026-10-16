import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { DomainError, requireWorkspaceRole } from '../team/access';
import { publicSourceAdvertiserId } from '../server/source-advertiser-id';

export type AdvertiserInput = { userId: string; workspaceId: string; adId: string };
export type RelatedAdsInput = AdvertiserInput & { cursor?: string; limit?: number };
const include = { dataSource: { select: { key: true } }, advertiser: true, media: { orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }] } } satisfies Prisma.AdInclude;
type RelatedAd = Prisma.AdGetPayload<{ include: typeof include }>;
const cursorSchema = z.object({ v: z.literal(1), scope: z.string().regex(/^[a-f0-9]{64}$/), asOf: z.iso.datetime(), at: z.iso.datetime(), id: z.string().min(1).max(100) }).strict();
type Cursor = z.infer<typeof cursorSchema>;

function decodeCursor(value: unknown, scope: string): Cursor {
  try {
    if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    if (cursor.scope !== scope || Date.parse(cursor.at) > Date.parse(cursor.asOf) || Date.parse(cursor.asOf) > Date.now()) throw new Error();
    return cursor;
  } catch { throw new DomainError(400, 'INVALID_RELATED_CURSOR'); }
}

async function advertiserForAd(tx: Prisma.TransactionClient, input: AdvertiserInput) {
  await requireWorkspaceRole(tx, input.userId, input.workspaceId);
  const ad = await tx.ad.findUnique({ where: { id: input.adId }, include: { dataSource: { select: { key: true } }, advertiser: true } });
  if (!ad) throw new DomainError(404, 'AD_NOT_FOUND');
  const advertiser = ad.advertiser;
  const sourceAdvertiserId = publicSourceAdvertiserId(advertiser?.sourceAdvertiserId, advertiser?.fieldProvenance);
  // A name, URL-derived grouping or per-ad placeholder cannot establish an
  // advertiser identity. Never merge unrelated source identities by label.
  if (!advertiser || advertiser.dataSourceId !== ad.dataSourceId || !sourceAdvertiserId) return null;
  return { ad, advertiser, sourceAdvertiserId };
}
type Identity = NonNullable<Awaited<ReturnType<typeof advertiserForAd>>>;

/** Independent detail/summary reads must never combine different source
 * identities if collection relinks the anchor between their transactions. */
export function matchesAdvertiserSummary(ad: { dataSource?: { key: string } | null; advertiser?: { sourceAdvertiserId: string; fieldProvenance?: unknown } | null }, summary: { sourceAdvertiserId: string; dataSourceKey: string | null } | null): boolean {
  if (!summary) return false;
  const sourceAdvertiserId = publicSourceAdvertiserId(ad.advertiser?.sourceAdvertiserId, ad.advertiser?.fieldProvenance);
  return Boolean(sourceAdvertiserId && sourceAdvertiserId === summary.sourceAdvertiserId && ad.dataSource?.key === summary.dataSourceKey);
}

function fingerprint(input: AdvertiserInput, identity: Identity) {
  return createHash('sha256').update(JSON.stringify({ workspaceId: input.workspaceId, adId: input.adId, advertiserId: identity.advertiser.id, dataSourceId: identity.ad.dataSourceId })).digest('hex');
}

async function relatedPage(tx: Prisma.TransactionClient, input: AdvertiserInput, identity: Identity, options: { limit: number; asOf: string; cursor?: Cursor | null }) {
  const base = { advertiserId: identity.advertiser.id, dataSourceId: identity.ad.dataSourceId, id: { not: input.adId }, createdAt: { lte: new Date(options.asOf) } };
  const boundary = options.cursor ? { OR: [{ createdAt: { lt: new Date(options.cursor.at) } }, { createdAt: new Date(options.cursor.at), id: { lt: options.cursor.id } }] } : {};
  const total = await tx.ad.count({ where: base });
  const rows: RelatedAd[] = await tx.ad.findMany({ where: { AND: [base, boundary] }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: options.limit + 1, include });
  const last = rows[options.limit - 1];
  const nextCursor = rows.length > options.limit && last ? Buffer.from(JSON.stringify({ v: 1, scope: fingerprint(input, identity), asOf: options.asOf, at: last.createdAt.toISOString(), id: last.id } satisfies Cursor)).toString('base64url') : null;
  return { ads: rows.slice(0, options.limit), total, asOf: options.asOf, nextCursor };
}

function observedWebsite(domain: string | null): string | null {
  if (!domain) return null;
  try {
    const url = new URL(domain.includes('://') ? domain : `https://${domain}`);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')) return null;
    return url.origin;
  } catch { return null; }
}

/** Local-library counts for one linked source identity, never performance or
 * full-platform coverage. Future status observations cannot inflate the cutoff. */
export async function getAdvertiserSummary(db: PrismaClient, input: AdvertiserInput) {
  return db.$transaction(async tx => {
    const identity = await advertiserForAd(tx, input);
    if (!identity) return null;
    const asOf = new Date().toISOString();
    const counts = await tx.$queryRawUnsafe<Array<{ collectedAds: bigint; activeAds: bigint; newAds7Days: bigint }>>(`
      SELECT count(*) AS "collectedAds",
        count(*) FILTER (WHERE CASE
          WHEN COALESCE(a."statusObservedAt",a."lastObservedAt",a."createdAt") <= $3::timestamp THEN a."sourceStatus"
          ELSE COALESCE((SELECT o."sourceStatus" FROM "AdObservation" o
            WHERE o."adId"=a.id AND o."dataSourceId"=a."dataSourceId" AND o."observedAt" <= $3::timestamp AND o."createdAt" <= $3::timestamp
            ORDER BY o."observedAt" DESC,o.id DESC LIMIT 1),'UNKNOWN')
          END = 'ACTIVE') AS "activeAds",
        count(*) FILTER (WHERE a."firstObservedAt" >= $3::timestamp - interval '7 days' AND a."firstObservedAt" <= $3::timestamp) AS "newAds7Days"
      FROM "Ad" a WHERE a."advertiserId"=$1 AND a."dataSourceId"=$2 AND a."createdAt" <= $3::timestamp`, identity.advertiser.id, identity.ad.dataSourceId, asOf);
    const preview = await relatedPage(tx, input, identity, { limit: 3, asOf });
    const aggregate = counts[0];
    return { name: identity.advertiser.name?.trim() || null, sourceAdvertiserId: identity.sourceAdvertiserId, dataSourceKey: identity.ad.dataSource.key, websiteUrl: observedWebsite(identity.advertiser.pageDomain), collectedAds: Number(aggregate.collectedAds), activeAds: Number(aggregate.activeAds), newAds7Days: Number(aggregate.newAds7Days), asOf, recentAds: preview.ads };
  }, { isolationLevel: 'RepeatableRead' });
}

/** Immutable import-date keyset order excludes new imports until refresh.
 * Mutable source facts and media still represent their latest stored values. */
export async function getRelatedAds(db: PrismaClient, input: RelatedAdsInput) {
  const limit = input.limit ?? 12;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError(400, 'INVALID_RELATED_LIMIT');
  return db.$transaction(async tx => {
    const identity = await advertiserForAd(tx, input);
    if (!identity) return { ads: [] as RelatedAd[], nextCursor: null, asOf: new Date().toISOString(), total: 0, anchorIdentity: null };
    const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor, fingerprint(input, identity));
    const page = await relatedPage(tx, input, identity, { limit, cursor, asOf: cursor?.asOf ?? new Date().toISOString() });
    return { ...page, anchorIdentity: { sourceAdvertiserId: identity.sourceAdvertiserId, dataSourceKey: identity.ad.dataSource.key } };
  }, { isolationLevel: 'RepeatableRead' });
}
