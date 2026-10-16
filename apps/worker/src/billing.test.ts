import { describe, expect, it, vi } from 'vitest';
import { createBillingReconciler } from './billing';

describe('fair billing reconciliation cursor', () => {
  it('advances past failed subscriptions, wraps, and revisits all organizations', async () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, organizationId: `org-${id}` }));
    const findMany = vi.fn(async ({ where, take, orderBy }: any) => {
      expect(orderBy).toEqual({ id: 'asc' });
      return rows.filter(row => !where.id?.gt || row.id > where.id.gt).slice(0, take);
    });
    const seen: string[] = []; const failures: string[] = [];
    const tick = createBillingReconciler({ subscription: { findMany } } as any, async row => {
      seen.push(row.organizationId); if (['org-a', 'org-b'].includes(row.organizationId)) throw new Error('PRIVATE_PROVIDER_DETAIL');
    }, { batchSize: 2, onFailure: organizationId => { failures.push(organizationId); } });
    expect(await tick()).toMatchObject({ processed: 2, failed: 2, cursor: 'b' });
    expect(await tick()).toMatchObject({ processed: 2, failed: 0, cursor: 'd' });
    expect(await tick()).toMatchObject({ processed: 1, failed: 0, cursor: 'e' });
    expect(await tick()).toMatchObject({ processed: 2, failed: 2, cursor: 'b' });
    expect(seen).toEqual(['org-a', 'org-b', 'org-c', 'org-d', 'org-e', 'org-a', 'org-b']);
    expect(failures).toEqual(['org-a', 'org-b', 'org-a', 'org-b']);
  });
  it('stops between organizations and retains the last attempted cursor', async () => {
    const controller = new AbortController(); const reconcile = vi.fn(async () => { controller.abort(); });
    const findMany = vi.fn(async () => [{ id: 'a', organizationId: 'org-a' }, { id: 'b', organizationId: 'org-b' }]);
    const tick = createBillingReconciler({ subscription: { findMany } } as any, reconcile, { signal: controller.signal });
    expect(await tick()).toMatchObject({ status: 'STOPPED', processed: 1, cursor: 'a' }); expect(reconcile).toHaveBeenCalledTimes(1);
    await tick(); expect(findMany).toHaveBeenCalledTimes(1);
  });
});
