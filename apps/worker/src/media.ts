import type { PrismaClient, MediaObject } from '@prisma/client';
import { safeDownload, isMediaUrlAllowed } from '../../web/src/media/download';
import { mediaDownloadPolicy } from '../../web/src/media/source-policy';
import type { S3Storage } from '../../web/src/media/storage';
import { MEDIA_DOWNLOAD_ELIGIBILITY_SQL, mediaEligibilityParameters, nextMediaDownloadAttempt } from './media-retry';

export interface MediaWorkerOptions { mediaId?: string; signal?: AbortSignal }
export interface MediaWorkerResult {
  status: 'CONFIGURATION_REQUIRED' | 'CANCELED' | 'IDLE' | 'FAILED' | 'READY';
  mediaId?: string;
  errorCode?: string;
}
type TransferMedia = MediaObject & { sourceKey: string; downloadAttempts: number; lastDownloadAttemptAt: Date | null; nextDownloadAttemptAt: Date | null };
/** A row lock covers the bounded transfer and durable retry bookkeeping. */
export async function mediaWorkerTick(db: PrismaClient, storage?: Pick<S3Storage, 'put' | 'delete'>, download = safeDownload, options: MediaWorkerOptions = {}): Promise<MediaWorkerResult> {
  if (!storage) return { status: 'CONFIGURATION_REQUIRED', errorCode: 'STORAGE_NOT_CONFIGURED' };
  if (options.signal?.aborted) return { status: 'CANCELED' };
  let uploadedKey: string | undefined;
  let uploadedMediaId: string | undefined;
  try {
    return await db.$transaction<MediaWorkerResult>(async tx => {
      const rows = await tx.$queryRawUnsafe<TransferMedia[]>(`
        WITH recent_attempts AS (
          SELECT "createdAt">="lastDownloadAttemptAt"-INTERVAL '15 minutes' AS fresh
          FROM "MediaObject" WHERE "lastDownloadAttemptAt" IS NOT NULL
          ORDER BY "lastDownloadAttemptAt" DESC,id DESC LIMIT 3
        ), lane AS (SELECT COUNT(*)=3 AND COALESCE(BOOL_AND(fresh),false) AS backfill FROM recent_attempts)
        SELECT m.*, s.key AS "sourceKey" FROM "MediaObject" m
        JOIN "Ad" a ON a.id=m."adId" JOIN "DataSource" s ON s.id=a."dataSourceId"
        CROSS JOIN lane
        WHERE (${MEDIA_DOWNLOAD_ELIGIBILITY_SQL}) AND ($5::text IS NULL OR m.id=$5)
        ORDER BY CASE WHEN (m."createdAt"<CURRENT_TIMESTAMP-INTERVAL '15 minutes')=lane.backfill THEN 0 ELSE 1 END,
          CASE WHEN m."createdAt">=CURRENT_TIMESTAMP-INTERVAL '15 minutes' THEN -EXTRACT(EPOCH FROM m."createdAt") ELSE EXTRACT(EPOCH FROM m."createdAt") END,
          m.id
        LIMIT 1 FOR UPDATE OF m SKIP LOCKED`, ...mediaEligibilityParameters(), options.mediaId ?? null);
      const media = rows[0];
      if (!media) return { status: 'IDLE' };
      if (options.signal?.aborted) return { status: 'CANCELED', mediaId: media.id };
      let attempts = media.downloadAttempts;
      const fail = async (errorCode: string): Promise<MediaWorkerResult> => {
        await tx.mediaObject.update({ where: { id: media.id }, data: { status: 'FAILED', errorCode } });
        const next = attempts > media.downloadAttempts ? nextMediaDownloadAttempt(errorCode, attempts, new Date()) : null;
        await tx.$executeRaw`UPDATE "MediaObject" SET "nextDownloadAttemptAt"=${next} WHERE id=${media.id}`;
        return { status: 'FAILED', mediaId: media.id, errorCode };
      };
      if (media.expiresAt && media.expiresAt <= new Date()) return fail('MEDIA_EXPIRED');
      const policy = mediaDownloadPolicy(media.sourceKey, media.type);
      if (!policy) return fail('MEDIA_SOURCE_UNSUPPORTED');
      if (!isMediaUrlAllowed(media.sourceUrl, policy.allowedHosts)) return fail('MEDIA_URL_REJECTED');
      attempts++;
      await tx.$executeRaw`UPDATE "MediaObject" SET "downloadAttempts"=${attempts}, "lastDownloadAttemptAt"=${new Date()}, "nextDownloadAttemptAt"=NULL WHERE id=${media.id}`;
      const cancel = async (): Promise<MediaWorkerResult> => {
        // Graceful shutdown consumes no failure budget and preserves a due retry.
        await tx.$executeRaw`UPDATE "MediaObject" SET "downloadAttempts"=${media.downloadAttempts}, "lastDownloadAttemptAt"=${media.lastDownloadAttemptAt}, "nextDownloadAttemptAt"=${media.nextDownloadAttemptAt} WHERE id=${media.id}`;
        return { status: 'CANCELED', mediaId: media.id };
      };
      let result: Awaited<ReturnType<typeof safeDownload>>;
      try { result = await download(media.sourceUrl, policy); }
      catch { return fail('MEDIA_NETWORK_FAILED'); }
      if (options.signal?.aborted) return cancel();
      if (!result.ok) {
        return fail(result.errorCode);
      }
      let object: Awaited<ReturnType<S3Storage['put']>>;
      try { object = await storage.put({ bytes: result.bytes, mimeType: result.mimeType, scope: { kind: 'public' } }); }
      catch { return fail('MEDIA_STORAGE_FAILED'); }
      uploadedKey = object.storageKey;
      uploadedMediaId = media.id;
      if (options.signal?.aborted) {
        try { await storage.delete(uploadedKey); uploadedKey = undefined; }
        catch {
          // Keep the uploaded key durably, but never expose an aborted transfer
          // as READY. The retention worker retries this idempotent deletion.
          const errorCode='MEDIA_CANCELED_CLEANUP_FAILED';
          await tx.mediaObject.update({where:{id:media.id},data:{...object,status:'EXPIRED',expiresAt:new Date(),errorCode}});
          return {status:'FAILED',mediaId:media.id,errorCode};
        }
        return cancel();
      }
      await tx.mediaObject.update({ where: { id: media.id }, data: { ...object, type: result.mimeType.startsWith('video/') ? 'VIDEO' : 'IMAGE', status: 'READY', downloadedAt: new Date(), errorCode: null } });
      return { status: 'READY', mediaId: media.id };
    }, { timeout: 150000, maxWait: 5000 });
  } catch {
    if (uploadedKey && uploadedMediaId) {
      try {
        const committed = await db.$transaction(async tx => {
          await tx.$executeRaw`SET LOCAL lock_timeout='5s'`;
          // Wait for the first transaction's row lock: an ordinary read could
          // observe its old version while COMMIT is still completing.
          const rows = await tx.$queryRaw<Array<{ status: string; storageKey: string | null }>>`
            SELECT status, "storageKey" FROM "MediaObject" WHERE id=${uploadedMediaId} FOR UPDATE`;
          return rows[0];
        }, { timeout: 10000, maxWait: 5000 });
        if (committed?.status === 'READY' && committed.storageKey === uploadedKey) {
          return { status: 'READY', mediaId: uploadedMediaId };
        }
      } catch { /* An unavailable database cannot prove the object is unreferenced. */ }
      // Preserve uncertain uploads. An owner may reconcile media and private
      // references later; the media-only runtime must not delete a committed
      // object or gain access to customer PrivateFile records to guess ownership.
    }
    // The transaction may have lost its lock; never mutate a row owned by a new worker here.
    return { status: 'FAILED', errorCode: 'MEDIA_DATABASE_FAILED' };
  }
}
