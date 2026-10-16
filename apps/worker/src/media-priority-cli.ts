/** Bounded rescue of Google signed video links already waiting in the download queue. */
import { PrismaClient } from '@prisma/client';
import { S3Storage } from '../../web/src/media/storage';
import { mediaWorkerTick } from './media';

const db = new PrismaClient();
const storage = new S3Storage({ bucket: process.env.S3_BUCKET!, region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  maxAttempts: 1, requestHandler: { requestTimeout: 10000, connectionTimeout: 5000 } });
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());
try {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT m.id FROM "MediaObject" m JOIN "Ad" a ON a.id=m."adId"
    JOIN "DataSource" s ON s.id=a."dataSourceId"
    WHERE s.key='google_ads_transparency' AND m.type='VIDEO' AND m."storageKey" IS NULL
      AND m.status IN('FAILED','UNAVAILABLE','PENDING')
    ORDER BY m."createdAt" DESC LIMIT 100`;
  let index = 0;
  const counts: Record<string, number> = {};
  console.log(JSON.stringify({ event: 'priority_plan', source: 'google_ads_transparency', count: rows.length }));
  await Promise.all([0, 1].map(async () => {
    while (index < rows.length && !controller.signal.aborted) {
      // The shared worker enforces due time, row ownership and attempt budget.
      const result = await mediaWorkerTick(db, storage, undefined,
        { mediaId: rows[index++].id, signal: controller.signal });
      const key = result.errorCode ?? result.status;
      counts[key] = (counts[key] ?? 0) + 1;
      console.log(JSON.stringify({ event: 'priority_result', ...result }));
    }
  }));
  console.log(JSON.stringify({ event: 'priority_complete', counts }));
} finally {
  await db.$disconnect();
}
