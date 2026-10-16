import { describe, expect, it } from 'vitest';
import { quotaSummary } from './users-view';
import { usersCopy } from './users-copy';
import { translateAdminCopy } from './admin-copy-core';

describe('organization quota summary uses actual reservations', () => {
  it('never invents zero consumption for an absent effective entitlement', () => {
    expect(quotaSummary({ key: 'ANALYSES', current: null })).toEqual({ text: '未配置', occupied: null, tone: 'neutral' });
  });
  it('includes outstanding reservations and marks a downgrade below existing use', () => {
    const current = { limit: 8, used: 7, reserved: 2, source: 'MANUAL', periodStart: new Date(), periodEnd: null, validFrom: new Date(), validUntil: null };
    expect(quotaSummary({ key: 'ANALYSES', current })).toEqual({ text: '9 / 8', occupied: 9, tone: 'conflict' });
    expect(quotaSummary({ key: 'ANALYSES', current: { ...current, limit: 10 } })).toEqual({ text: '9 / 10', occupied: 9, tone: 'unknown' });
  });
  it('keeps an explicitly configured zero allowance distinct from a missing one', () => {
    expect(quotaSummary({ key: 'SAVED_ADS', current: { limit: 0, used: 0, reserved: 0, source: 'PLAN', periodStart: new Date(), periodEnd: null, validFrom: new Date(), validUntil: null } })).toEqual({ text: '0 / 0', occupied: 0, tone: 'neutral' });
  });
  it('translates quota caveats without changing injected organization names or numeric values', () => {
    for (const locale of ['zh-TW', 'en', 'es'] as const) {
      const notice = translateAdminCopy(locale, '{name} 的权益已调整，已记录审计。', { name: '研究组织 Original' }, usersCopy);
      expect(notice).toContain('研究组织 Original');
      expect(notice).not.toContain('的权益已调整');
      const usage = translateAdminCopy(locale, '已用 {used} / 预留 {reserved} / 上限 {limit}', { used: 7, reserved: 2, limit: 4 }, usersCopy);
      expect(usage).toContain('7'); expect(usage).toContain('2'); expect(usage).toContain('4');
      expect(usage).not.toContain('{used}');
      expect(usersCopy['预留尚未结算，不代表已完成分析；已用数可在降级后超过上限。未配置、已过期或尚未生效的记录不作为当前额度。'][locale]).toBeTruthy();
    }
  });
});
