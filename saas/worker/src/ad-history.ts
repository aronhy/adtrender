import type { PrismaClient } from '@prisma/client';
import { historyProjectionTick } from '../../app/src/ad-history/projector';

/** Separate, opt-in lane; ingestion never waits for a projection. */
export async function historyWorkerTick(db: PrismaClient, input: { workerId: string; limit?: number; signal?: AbortSignal }) {
  if (process.env.HISTORY_PROJECTOR_ENABLED !== 'true' || input.signal?.aborted) return { processed: 0, failed: 0 };
  return historyProjectionTick(db, { ...input, limit: input.limit ?? 10 });
}
