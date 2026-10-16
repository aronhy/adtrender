import { describe, expect, it } from 'vitest';
import type { AdHistoryDayView } from '../ad-history/types';
import { buildAdHistoryChartData } from './ad-history-chart-data';

const row = (day: string, sourceStatus: AdHistoryDayView['sourceStatus'], values: Partial<AdHistoryDayView> = {}): AdHistoryDayView => ({
  day, scopeHash: 'scope-us', observationState: 'OBSERVED', checkState: 'OBSERVED', sourceStatus, hasStateConflict: false,
  observationCount: 1, lastObservedAt: day + 'T08:00:00Z', latestObservationId: 'observation-' + day, body: null, headline: null, cta: null, ...values,
});

describe('daily ad history chart facts', () => {
  it('orders the selected calendar window and leaves missing and unknown dates as line gaps instead of zero', () => {
    const points = buildAdHistoryChartData({ from: '2026-10-01', to: '2026-10-04', days: [row('2026-10-04', 'ACTIVE'), row('2026-10-03', 'UNKNOWN'), row('2026-10-01', 'ACTIVE')] });
    expect(points.map(point => point.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
    expect(points.map(point => point.status)).toEqual(['ACTIVE', 'MISSING', 'UNKNOWN', 'ACTIVE']);
    expect(points.map(point => point.plotValue)).toEqual([1, null, null, 1]);
  });

  it('groups daily source status across scopes without implying a global source state from mixed evidence', () => {
    const points = buildAdHistoryChartData({ from: '2026-10-01', to: '2026-10-03', days: [
      row('2026-10-01', 'ACTIVE'), row('2026-10-01', 'ACTIVE', { scopeHash: 'scope-ca', observationCount: 8 }),
      row('2026-10-02', 'ACTIVE'), row('2026-10-02', 'INACTIVE', { scopeHash: 'scope-ca' }),
      row('2026-10-03', 'INACTIVE'), row('2026-10-03', 'UNKNOWN', { scopeHash: 'scope-ca' }),
    ] });
    expect(points.map(point => point.status)).toEqual(['ACTIVE', 'MIXED', 'MIXED']);
    expect(points.map(point => point.plotValue)).toEqual([1, null, null]);
    expect(points[1].rows.map(item => item.scopeHash).sort()).toEqual(['scope-ca', 'scope-us']);
  });

  it('leaves conflicting and unobserved ACTIVE rows as gaps and excludes facts outside the selected window', () => {
    const points = buildAdHistoryChartData({ from: '2026-10-01', to: '2026-10-04', days: [
      row('2026-09-30', 'ACTIVE'), row('2026-10-01', 'ACTIVE', { hasStateConflict: true }),
      row('2026-10-02', 'ACTIVE', { observationState: 'NO_OBSERVATION', latestObservationId: null, observationCount: 0 }),
      row('2026-10-03', 'INACTIVE'), row('2026-10-04', 'ACTIVE'), row('2026-10-05', 'ACTIVE'),
    ] });
    expect(points.map(point => point.status)).toEqual(['CONFLICT', 'MISSING', 'INACTIVE', 'ACTIVE']);
    expect(points.map(point => point.plotValue)).toEqual([null, null, 0, 1]);
  });

  it('plots inactive observations at their categorical position without turning unknown source states into inactive', () => {
    const points = buildAdHistoryChartData({ from: '2026-10-01', to: '2026-10-03', days: [row('2026-10-01', 'ACTIVE'), row('2026-10-02', 'INACTIVE'), row('2026-10-03', 'UNKNOWN')] });
    expect(points.map(point => point.status)).toEqual(['ACTIVE', 'INACTIVE', 'UNKNOWN']);
    expect(points.map(point => point.plotValue)).toEqual([1, 0, null]);
  });
});
