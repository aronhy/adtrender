/** Bounded real-source acceptance using the same transfer and retry policy. */
import { PrismaClient } from '@prisma/client';
import { S3Storage } from '../../app/src/media/storage';
import { mediaWorkerTick } from './media';
import { MEDIA_DOWNLOAD_ELIGIBILITY_SQL, mediaEligibilityParameters } from './media-retry';

const db = new PrismaClient();
const storage = new S3Storage({ bucket: process.env.S3_BUCKET!, region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  maxAttempts: 1, requestHandler: { requestTimeout: 10000, connectionTimeout: 5000 } });
try {
  for (const [source, type, error] of [
    ['snapchat_ads_gallery', 'IMAGE', 'PLATFORM_MEDIA_ADAPTER_PENDING'],
    ['snapchat_ads_gallery', 'VIDEO', 'PLATFORM_MEDIA_ADAPTER_PENDING'],
    ['tiktok_commercial_library', 'IMAGE', 'PLATFORM_MEDIA_ADAPTER_PENDING'],
    ['meta_ad_library', 'VIDEO', 'MEDIA_TOO_LARGE'],
  ]) {
    const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(`
      SELECT m.id FROM "MediaObject" m JOIN "Ad" a ON a.id=m."adId"
      JOIN "DataSource" s ON s.id=a."dataSourceId"
      WHERE (${MEDIA_DOWNLOAD_ELIGIBILITY_SQL}) AND s.key=$5 AND m.type=$6 AND m."errorCode"=$7
      ORDER BY m."createdAt" DESC LIMIT 1`, ...mediaEligibilityParameters(), source, type, error);
    if (!rows.length) {
      console.log(JSON.stringify({ source, type, status: 'NO_CANDIDATE' }));
      continue;
    }
    const result = await mediaWorkerTick(db, storage, undefined, { mediaId: rows[0].id });
    console.log(JSON.stringify({ source, type, ...result }));
  }
} finally {
  await db.$disconnect();
}
