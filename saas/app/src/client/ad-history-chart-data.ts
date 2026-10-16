import type { AdHistoryResult } from '../ad-history/api-types';
import type { AdHistoryDayView } from '../ad-history/types';

export type HistoryChartStatus = 'ACTIVE' | 'INACTIVE' | 'UNKNOWN' | 'MISSING' | 'CONFLICT' | 'MIXED';
export type AdHistoryChartDay = { day: string; status: HistoryChartStatus; plotValue: 1 | 0 | null; rows: AdHistoryDayView[] };

/** States are daily source snapshots, not performance or a reconstructed delivery-day metric. */
export function buildAdHistoryChartData(data: Pick<AdHistoryResult, 'from' | 'to' | 'days'>): AdHistoryChartDay[] {
  const start = Date.parse(data.from + 'T00:00:00Z');
  const end = Date.parse(data.to + 'T00:00:00Z');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const byDay = new Map<string, AdHistoryDayView[]>();
  for (const row of data.days) { const rows = byDay.get(row.day) ?? []; rows.push(row); byDay.set(row.day, rows); }
  const points: AdHistoryChartDay[] = [];
  for (let time = start; time <= end; time += 86_400_000) {
    const day = new Date(time).toISOString().slice(0, 10);
    const rows = byDay.get(day) ?? [];
    const observed = rows.filter(row => row.observationState === 'OBSERVED');
    const states = new Set(observed.map(row => row.sourceStatus));
    const status: HistoryChartStatus = !observed.length ? 'MISSING' : observed.some(row => row.hasStateConflict) ? 'CONFLICT'
      : states.size > 1 ? 'MIXED' : states.has('ACTIVE') ? 'ACTIVE' : states.has('INACTIVE') ? 'INACTIVE' : 'UNKNOWN';
    points.push({ day, rows, status, plotValue: status === 'ACTIVE' ? 1 : status === 'INACTIVE' ? 0 : null });
  }
  return points;
}
