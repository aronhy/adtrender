import { describe, expect, it, vi } from 'vitest';
import { loadGrowthSummary, parseGrowthRange } from './summary';

const now = new Date('2026-10-07T18:30:00Z');
describe('growth report UTC+8 cohort range', () => {
  it('includes both selected local dates using an exclusive UTC end', () => {
    const range = parseGrowthRange({ from: '2026-10-01', to: '2026-10-07' }, now);
    expect(range.start.toISOString()).toBe('2026-09-30T16:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-10-07T16:00:00.000Z');
    expect(range.days).toBe(7);
  });
  it('uses the UTC+8 current date when checking future dates', () => {
    expect(parseGrowthRange({ from: '2026-10-08', to: '2026-10-08' }, now).days).toBe(1);
  });
  it.each([
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-10-07T00:00:00Z', to: '2026-10-07' },
    { from: '2026-10-08', to: '2026-10-07' },
    { from: '2026-10-07', to: '2026-10-09' },
    { from: '2026-01-01', to: '2026-10-07' },
    { from: '2026-10-01', to: '2026-10-07', includeTest: true },
  ])('rejects invalid, future, excessive or unsupported query input: %j', input => {
    expect(() => parseGrowthRange(input, now)).toThrow();
  });
});

describe('growth report access boundary', () => {
  it.each([
    [null, 'AUTH_REQUIRED'],
    [{ id: 'ordinary', email: 'not-returned@example.test', isAdmin: false, disabledAt: null }, 'PLATFORM_ADMIN_REQUIRED'],
    [{ id: 'disabled', email: 'not-returned@example.test', isAdmin: true, disabledAt: new Date() }, 'ACCOUNT_DISABLED'],
  ])('rejects unauthorized callers before any growth aggregation', async (user, code) => {
    const aggregate = vi.fn();
    const tx = { user: { findUnique: async () => user }, $queryRaw: aggregate };
    const db = { $transaction: async (run: (client: unknown) => unknown) => run(tx) };
    await expect(loadGrowthSummary(db as any, { userId: 'actor', from: '2026-10-01', to: '2026-10-07' }, now)).rejects.toMatchObject({ code });
    expect(aggregate).not.toHaveBeenCalled();
  });
});
