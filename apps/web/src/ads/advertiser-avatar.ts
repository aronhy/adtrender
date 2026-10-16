import type { Prisma } from '@prisma/client';

export async function backfillObservedAdvertiserLogos(tx: Prisma.TransactionClient, { dryRun = true, limit = 1000 }: { dryRun?: boolean; limit?: number } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw Error('ADVERTISER_LOGO_BACKFILL_LIMIT');
  const rows = await tx.$queryRawUnsafe<Array<{ id: string; sourceKey: string; provenance: Record<string, unknown> }>>(`
    SELECT a.id, d.key AS "sourceKey", jsonb_build_object('value', observed.url,
      'source', d.key, 'observedAt', observed."observedAt", 'evidenceSha256', observed."evidenceSha256",
      'observationId', observed.id, 'backfilledAt', now()) AS provenance
    FROM "Ad" a JOIN "DataSource" d ON d.id = a."dataSourceId"
    CROSS JOIN LATERAL (
      SELECT o.id, o."observedAt", o."evidenceSha256", logo.url FROM "AdObservation" o
      CROSS JOIN LATERAL (
        SELECT value AS url FROM (VALUES
          (1, o."fieldProvenance" #>> '{advertiserAvatarUrl,value}'),
          (2, o.snapshot ->> 'advertiserAvatarUrl'),
          (3, CASE WHEN d.key = 'snapchat_ads_gallery' THEN o.snapshot #>> '{raw,profile_logo_url}' END)
        ) candidates(priority, value)
        WHERE value ~ CASE d.key
          WHEN 'meta_ad_library' THEN '^https://([a-z0-9-]+[.])*(fbcdn[.]net|facebook[.]com|fbsbx[.]com|cdninstagram[.]com)/[^[:space:]]*$'
          WHEN 'tiktok_commercial_library' THEN '^https://([a-z0-9-]+[.])*tiktokcdn(-(us|eu))?[.]com/[^[:space:]]*$'
          WHEN 'snapchat_ads_gallery' THEN '^https://([a-z0-9-]+[.])*sc-cdn[.]net/[^[:space:]]*$' END
        ORDER BY priority LIMIT 1
      ) logo
      WHERE o."adId" = a.id AND o."dataSourceId" = a."dataSourceId" AND o."evidenceSha256" IS NOT NULL
      ORDER BY o."observedAt" DESC, o.id DESC LIMIT 1
    ) observed
    WHERE d.key IN ('meta_ad_library', 'tiktok_commercial_library', 'snapchat_ads_gallery')
      AND NULLIF(a."fieldProvenance" #>> '{advertiserAvatarUrl,value}', '') IS NULL
    ORDER BY a.id LIMIT $1
  `, limit);
  const bySource: Record<string, number> = {};
  for (const row of rows) bySource[row.sourceKey] = (bySource[row.sourceKey] || 0) + 1;
  if (dryRun || !rows.length) return { candidates: rows.length, updated: 0, bySource };
  const updated = await tx.$executeRawUnsafe(`
    UPDATE "Ad" a SET "fieldProvenance" = a."fieldProvenance" || jsonb_build_object('advertiserAvatarUrl', candidate->'provenance')
    FROM jsonb_array_elements($1::jsonb) candidate
    WHERE a.id = candidate->>'id' AND NULLIF(a."fieldProvenance" #>> '{advertiserAvatarUrl,value}', '') IS NULL
  `, JSON.stringify(rows));
  return { candidates: rows.length, updated, bySource };
}

/** Project only identity images from source-scoped observations, including older known logos. */
export async function withObservedAdvertiserAvatars<T extends { id: string; dataSource?: { key: string } | null }>(tx: Prisma.TransactionClient, ads: T[]) {
  const ids = ads.filter(ad => ['meta_ad_library', 'tiktok_commercial_library', 'snapchat_ads_gallery'].includes(ad.dataSource?.key ?? '')).map(ad => ad.id);
  if (!ids.length) return ads;
  const logos = await tx.$queryRawUnsafe<Array<{ adId: string; logoUrl: string | null }>>(`
    SELECT a.id AS "adId", (
      SELECT logo.url
      FROM "AdObservation" o
      CROSS JOIN LATERAL (SELECT COALESCE(NULLIF(o."fieldProvenance" #>> '{advertiserAvatarUrl,value}', ''),
                      NULLIF(o.snapshot ->> 'advertiserAvatarUrl', ''), CASE WHEN d.key = 'snapchat_ads_gallery' THEN NULLIF(o.snapshot #>> '{raw,profile_logo_url}', '') END) AS url) logo
      WHERE o."adId" = a.id AND logo.url ~ '^https://[^[:space:]/@]+/[^[:space:]]*$'
      ORDER BY o."observedAt" DESC, o.id DESC LIMIT 1
    ) AS "logoUrl"
    FROM "Ad" a JOIN "DataSource" d ON d.id = a."dataSourceId" WHERE a.id = ANY($1::text[])
  `, ids);
  const byId = new Map(logos.map(row => [row.adId, row.logoUrl]));
  return ads.map(ad => ({ ...ad, observedAdvertiserAvatarUrl: byId.get(ad.id) ?? null }));
}
