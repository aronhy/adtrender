import { describe, expect, it } from 'vitest';
import { historyDateLabel, historyDateRange, historyEventKey, mergeHistoryEvents } from './ad-history-ui';

describe('ad history display evidence', () => {
  it('keeps inclusive windows in Shanghai time at UTC date boundaries', () => {
    expect(historyDateRange(7, new Date('2026-10-07T16:00:00Z'))).toEqual({ from: '2026-10-02', to: '2026-10-08' });
    expect(historyDateRange(30, new Date('2026-01-02T15:59:59Z'))).toEqual({ from: '2025-12-04', to: '2026-01-02' });
    expect(historyDateRange(90, new Date('2026-01-01T00:00:00Z'))).toEqual({ from: '2025-10-04', to: '2026-01-01' });
  });
  it('labels observation timestamps in the same timezone as day grouping', () => {
    expect(historyDateLabel('2026-10-07T16:00:00Z', 'en', 'Missing')).toBe('Oct 8, 2026');
    expect(historyDateLabel('2026-10-08', 'en', 'Missing')).toBe('Oct 8, 2026');
    expect(historyDateLabel(null, 'es', 'Sin fecha')).toBe('Sin fecha');
    expect(historyDateLabel('invalid', 'es', 'Sin fecha')).toBe('Sin fecha');
  });
  it('deduplicates overlapping pages while retaining evidence references and newest first order', () => {
    const base = { type: 'BODY_CHANGED' as const, scopeHash: 'scope', beforeObservationId: 'before', afterObservationId: 'after' };
    const old = { ...base, id: 'old', observedAt: '2026-10-01T00:00:00Z' };
    const recent = { ...base, id: 'recent', observedAt: '2026-10-08T00:00:00Z' };
    expect(mergeHistoryEvents([old], [recent, old])).toEqual([recent, old]);
    expect(mergeHistoryEvents([], [])).toEqual([]);
  });
  it('uses reviewed event labels and a safe label for unknown event types', () => {
    expect(historyEventKey('STATUS_CHANGED')).toBe('ads.history.statusChanged');
    expect(historyEventKey('MEDIA_CHANGED')).toBe('ads.history.mediaChanged');
    expect(historyEventKey('unreviewed-provider-value')).toBe('ads.history.changed');
  });
});
