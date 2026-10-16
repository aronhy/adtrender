import type { PrismaClient } from '@prisma/client';

export function createBillingReconciler(db: Pick<PrismaClient, 'subscription'>, reconcile: (subscription: { organizationId: string }) => Promise<unknown>, options: { batchSize?: number; signal?: AbortSignal; onFailure?: (organizationId: string) => void } = {}) {
  const batchSize = options.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('INVALID_BILLING_BATCH_SIZE');
  let cursor: string | null = null;
  return async () => {
    if (options.signal?.aborted) return { status: 'STOPPED', processed: 0, failed: 0, cursor };
    const page = (after: string | null) => db.subscription.findMany({ where: { providerSubscriptionId: { not: null }, ...(after ? { id: { gt: after } } : {}) }, take: batchSize, orderBy: { id: 'asc' }, select: { id: true, organizationId: true } });
    let subscriptions = await page(cursor);
    if (!subscriptions.length && cursor !== null) { cursor = null; subscriptions = await page(null); }
    let processed = 0, failed = 0;
    for (const subscription of subscriptions) {
      if (options.signal?.aborted) break;
      try { await reconcile(subscription); }
      catch { failed++; options.onFailure?.(subscription.organizationId); }
      finally { cursor = subscription.id; processed++; }
    }
    return { status: options.signal?.aborted ? 'STOPPED' : 'COMPLETED', processed, failed, cursor };
  };
}
