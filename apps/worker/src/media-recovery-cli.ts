import { PrismaClient } from '@prisma/client';
import { mediaWorkerTick } from './media';
import { S3Storage } from '../../web/src/media/storage';
import { MEDIA_DOWNLOAD_ELIGIBILITY_SQL, mediaEligibilityParameters } from './media-retry';

// Bounded recovery uses the same eligible due retries and source policies as the
// daemon; it never rewrites source URLs or bypasses retry timing and budgets.
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('media-recovery [--limit=2500] [--ad-id=UUID] [--execute] — dry-run by default; at most 2 simultaneous transfers, 15 minutes');
  process.exit(0);
}
if (args.some(arg => !/^(--execute|--limit=\d+|--ad-id=[a-f0-9-]{36})$/.test(arg))) throw new Error('Unsupported recovery argument');
const limit = Number(args.find(arg => arg.startsWith('--limit='))?.slice(8) ?? 2500);
if (!Number.isInteger(limit) || limit < 1 || limit > 2500) throw new Error('Recovery limit must be 1–2500');
const adId = args.find(arg => arg.startsWith('--ad-id='))?.slice(8);
const db = new PrismaClient();
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
const deadline = setTimeout(() => controller.abort(), 15 * 60_000);
try {
  const eligible = await db.$queryRawUnsafe<Array<{ id: string; sourceKey: string }>>(`
    SELECT m.id,s.key AS "sourceKey" FROM "MediaObject" m
    JOIN "Ad" a ON a.id=m."adId" JOIN "DataSource" s ON s.id=a."dataSourceId"
    WHERE (${MEDIA_DOWNLOAD_ELIGIBILITY_SQL})
      AND (m."expiresAt" IS NULL OR m."expiresAt">CURRENT_TIMESTAMP)
      AND ($5::text IS NULL OR m."adId"=$5)
    ORDER BY m."createdAt" DESC,m.id LIMIT $6`, ...mediaEligibilityParameters(), adId ?? null, limit);
  const bySource: Record<string, number> = {};
  for (const row of eligible) bySource[row.sourceKey] = (bySource[row.sourceKey] ?? 0) + 1;
  console.log(JSON.stringify({ event: 'media_recovery_plan', execute: args.includes('--execute'), count: eligible.length, bySource }));
  if (args.includes('--execute')) {
    if (!process.env.S3_BUCKET || !process.env.S3_REGION) throw new Error('Storage configuration required');
    const storage = new S3Storage({ bucket: process.env.S3_BUCKET, region: process.env.S3_REGION, endpoint: process.env.S3_ENDPOINT, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true', maxAttempts: 1, requestHandler: { requestTimeout: 10000, connectionTimeout: 5000 } });
    const counts: Record<string, number> = {};
    let next = 0, completed = 0;
    await Promise.all([0, 1].map(async () => {
      while (next < eligible.length && !controller.signal.aborted) {
        const row = eligible[next++];
        const result = await mediaWorkerTick(db, storage, undefined, { mediaId: row.id, signal: controller.signal });
        const key = result.errorCode ?? result.status;
        counts[key] = (counts[key] ?? 0) + 1;
        if (++completed % 50 === 0) console.log(JSON.stringify({ event: 'media_recovery_progress', completed, total: eligible.length, counts }));
      }
    }));
    console.log(JSON.stringify({ event: 'media_recovery_finished', completed, total: eligible.length, stopped: controller.signal.aborted, counts }));
    if (controller.signal.aborted || Object.keys(counts).some(key => !['READY', 'IDLE'].includes(key))) process.exitCode = 2;
  }
} catch {
  console.error(JSON.stringify({ event: 'media_recovery_failed' }));
  process.exitCode = 1;
} finally { clearTimeout(deadline); await db.$disconnect(); }
