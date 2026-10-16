import { describe, expect, it } from 'vitest';
import { formatAdminAdsDate, verifiedScopeLabel } from './ads-format';

describe('advertising admin timestamps', () => {
  it('shows a UTC expiry across Hong Kong midnight with its exact minute', () => {
    const translate = (text: string, values?: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? `{${key}}`));
    const label = verifiedScopeLabel('Query · US · IMAGE · 最多 3 条 · 有效至 2026-10-10T16:30:00.000Z', translate, 'zh-CN');
    expect(label).toContain('10月11日');
    expect(label).toContain('00:30');
    expect(label).toContain('Asia/Hong_Kong');
    expect(label).not.toContain('2026-10-10T16:30');
  });
  it('keeps dates with unknown times intact and handles missing timestamps', () => {
    expect(formatAdminAdsDate(null, 'en')).toBe('—');
    expect(formatAdminAdsDate('invalid-date', 'en')).toBe('—');
    const translate = (_text: string, values?: Record<string, string | number>) => String(values?.date);
    expect(verifiedScopeLabel('Query · US · IMAGE · 最多 3 条 · 有效至 2026-10-11', translate, 'en')).toBe('2026-10-11');
  });
});
