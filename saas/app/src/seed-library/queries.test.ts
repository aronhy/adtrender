import { describe, expect, it, vi } from 'vitest';
import { getSeedRulesView } from './queries';

function rulesFixture(publications: Array<{ id: string; revision: number; status: string; receipts?: unknown[] }>) {
  const sorted = [...publications].sort((a, b) => b.revision - a.revision);
  return {
    user: { findUnique: vi.fn(async () => ({ id: 'admin', isAdmin: true, disabledAt: null })) },
    dataSource: { findMany: vi.fn(async () => []) },
    collectorSourceControl: { findMany: vi.fn(async () => []) },
    seedScanPlan: { findMany: vi.fn(async () => []) },
    seedPublication: {
      findMany: vi.fn(async ({ take }: { take: number }) => sorted.slice(0, take)),
      findFirst: vi.fn(async ({ where }: { where: { status: string } }) => sorted.find(item => item.status === where.status) ?? null),
    },
  };
}

describe('seed rules publication projection', () => {
  it('retains the real published head after twenty newer draft previews', async () => {
    const head = { id: 'published-head', revision: 41, status: 'PUBLISHED', receipts: [{ applyStatus: 'APPLIED' }] };
    const drafts = Array.from({ length: 20 }, (_, index) => ({ id: `draft-${index}`, revision: 42 + index, status: 'DRAFT', receipts: [] }));
    const db = rulesFixture([{ id: 'old-publication', revision: 10, status: 'PUBLISHED' }, head, ...drafts]);
    const result = await getSeedRulesView(db, { userId: 'admin' });
    expect(result.publications).toHaveLength(21);
    expect(result.publications.filter((item: typeof head) => item.status === 'PUBLISHED')).toEqual([head]);
    expect(result.publications.slice(0, 20).every((item: typeof head) => item.status === 'DRAFT')).toBe(true);
    expect(db.seedPublication.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'PUBLISHED' }, orderBy: { revision: 'desc' } }));
  });

  it('does not duplicate a published head already in the recent page', async () => {
    const head = { id: 'head', revision: 3, status: 'PUBLISHED', receipts: [] };
    const db = rulesFixture([head, { id: 'draft', revision: 4, status: 'DRAFT' }]);
    const result = await getSeedRulesView(db, { userId: 'admin' });
    expect(result.publications).toHaveLength(2);
    expect(result.publications.filter((item: typeof head) => item.id === head.id)).toHaveLength(1);
  });

  it('keeps a never-published catalog as draft history', async () => {
    const db = rulesFixture([{ id: 'draft', revision: 1, status: 'DRAFT' }]);
    const result = await getSeedRulesView(db, { userId: 'admin' });
    expect(result.publications).toEqual([{ id: 'draft', revision: 1, status: 'DRAFT' }]);
  });
});
