import { useId, useMemo, useState } from 'react';
import { ArrowRight, CircleCheck, CircleHelp, CircleX, Layers, Minus, TriangleAlert } from 'lucide-react';
import type { AdHistoryResult } from '../ad-history/api-types';
import type { AdHistoryDayView } from '../ad-history/types';
import { useWorkspaceLocale } from './workspace-i18n/locale';
import { historyDateLabel } from './ad-history-ui';
import { buildAdHistoryChartData, type HistoryChartStatus } from './ad-history-chart-data';

const stateKeys: Record<HistoryChartStatus, string> = {
  ACTIVE: 'ads.active', INACTIVE: 'ads.inactive', UNKNOWN: 'ads.history.chart.unknown', MISSING: 'ads.history.chart.missing', CONFLICT: 'ads.history.chart.conflict', MIXED: 'ads.history.chart.mixed',
};
const stateIcons = { ACTIVE: CircleCheck, INACTIVE: CircleX, UNKNOWN: CircleHelp, MISSING: Minus, CONFLICT: TriangleAlert, MIXED: Layers };
const states: HistoryChartStatus[] = ['ACTIVE', 'INACTIVE', 'UNKNOWN', 'MISSING', 'CONFLICT', 'MIXED'];

/** A descriptive categorical chart. Unknown dates are gaps, never inferred inactive periods. */
export function AdHistoryCharts({ data, onSelect }: { data: AdHistoryResult; onSelect?: (day: AdHistoryDayView) => void }) {
  const { t, locale } = useWorkspaceLocale();
  const id = useId();
  const points = useMemo(() => buildAdHistoryChartData(data), [data]);
  const [selectedDay, setSelectedDay] = useState<string>();
  const selected = points.find(point => point.day === selectedDay);
  const selectedRecord = selected?.rows.find(row => row.observationState === 'OBSERVED' && row.latestObservationId);
  const dayLabel = (day: string) => historyDateLabel(day, locale, t('ads.unknown'));
  const shortDayLabel = (day: string) => new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit', timeZone: 'UTC' }).format(new Date(day + 'T00:00:00Z'));
  const x = (index: number) => points.length > 1 ? 10 + index / (points.length - 1) * 580 : 300;
  const y = (value: 1 | 0) => value === 1 ? 18 : 82;
  const segments: Array<Array<{ index: number; value: 1 | 0 }>> = [];
  let segment: Array<{ index: number; value: 1 | 0 }> = [];
  points.forEach((point, index) => {
    if (point.plotValue === null) { if (segment.length) segments.push(segment); segment = []; }
    else segment.push({ index, value: point.plotValue });
  });
  if (segment.length) segments.push(segment);
  const tickIndices = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].filter(index => index >= 0);
  if (data.projectionPending) return <div className="ws-history-charts"><p className="small-note" role="status">{t('ads.history.projectionPending')}</p></div>;
  if (!points.length) return null;

  return <section className="ws-history-charts" aria-labelledby={`${id}-title`}>
    <div className="ws-history-chart-header"><h3 id={`${id}-title`}>{t('ads.history.chart.title')}</h3><span>{t('ads.history.chart.period', { from: shortDayLabel(data.from), to: shortDayLabel(data.to) })}</span></div>
    <p id={`${id}-note`} className="ws-history-chart-note">{t('ads.history.chart.note')}</p>
    <div className="ws-history-chart-plot"><div className="ws-history-chart-ylabels" aria-hidden="true"><span>{t('ads.history.chart.active')}</span><span>{t('ads.history.chart.inactive')}</span></div>
      <svg className="ws-history-status-chart" viewBox="0 0 600 110" width="100%" height="110" preserveAspectRatio="none" role="img" aria-labelledby={`${id}-svg-title`} aria-describedby={`${id}-note`}>
        <title id={`${id}-svg-title`}>{t('ads.history.chart.svgLabel')}</title>
        <line x1="0" y1="18" x2="600" y2="18" stroke="#e8ebef" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" aria-hidden="true" />
        <line x1="0" y1="82" x2="600" y2="82" stroke="#e8ebef" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" aria-hidden="true" />
        {segments.map((values, index) => <path key={index} className="ws-history-status-line" d={values.map((point, position) => `${position ? 'L' : 'M'}${x(point.index)} ${y(point.value)}`).join(' ')} fill="none" stroke="#f16a36" strokeWidth="2" vectorEffect="non-scaling-stroke" aria-hidden="true" />)}
        {selected && <line className="ws-history-selected-date" x1={x(points.indexOf(selected))} y1="5" x2={x(points.indexOf(selected))} y2="97" stroke="#a0a7b2" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" aria-hidden="true" />}
        {points.map((point, index) => point.plotValue !== null && <circle key={point.day} className="ws-history-status-point" cx={x(index)} cy={y(point.plotValue)} r={selectedDay === point.day ? 4 : 3} fill="#f16a36" onMouseEnter={() => setSelectedDay(point.day)} aria-hidden="true" />)}
      </svg>
    </div>
    <div className="ws-history-chart-xlabels" aria-hidden="true">{tickIndices.map(index => <span key={index}>{shortDayLabel(points[index].day)}</span>)}</div>
    <ol className="ws-history-source-strip" aria-label={t('ads.history.chart.title')} aria-describedby={`${id}-choose`}>
      {points.map((point, index) => { const Icon = stateIcons[point.status]; return <li key={point.day}><button className="ws-history-status-button" type="button" id={`${id}-day-${index}`} data-status={point.status} aria-label={t('ads.history.chart.dayLabel', { date: dayLabel(point.day), status: t(stateKeys[point.status]) })} aria-pressed={selectedDay === point.day} tabIndex={selected ? selectedDay === point.day ? 0 : -1 : index === points.length - 1 ? 0 : -1} onFocus={() => setSelectedDay(point.day)} onMouseEnter={() => setSelectedDay(point.day)} onClick={() => setSelectedDay(point.day)} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : Math.max(0, Math.min(points.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
        setSelectedDay(points[next].day); document.getElementById(`${id}-day-${next}`)?.focus();
      }}><Icon size={13} aria-hidden="true" /></button></li>; })}
    </ol>
    <div className="ws-history-chart-legend">{states.map(status => { const Icon = stateIcons[status]; return <span key={status} data-status={status}><Icon size={12} aria-hidden="true" />{t(stateKeys[status])}</span>; })}</div>
    <div className="ws-history-chart-tooltip" role="status" aria-live="polite">{selected ? <><div><strong>{dayLabel(selected.day)}</strong><span>{t(stateKeys[selected.status])}</span></div>{['UNKNOWN', 'MISSING', 'CONFLICT', 'MIXED'].includes(selected.status) && <p>{t(selected.status === 'MIXED' ? 'ads.history.chart.mixedNote' : selected.status === 'CONFLICT' ? 'ads.history.chart.conflictNote' : 'ads.history.chart.gapNote')}</p>}
      {selectedRecord && onSelect ? <button type="button" className="text-button ws-history-chart-view-day" onClick={() => onSelect(selectedRecord)}>{t('ads.history.viewDay')}<ArrowRight size={14} aria-hidden="true" /></button> : !selectedRecord && <p>{t('ads.history.chart.noRecord')}</p>}
    </> : <p>{t('ads.history.chart.chooseDay')}</p>}</div>
    <p id={`${id}-choose`} className="ws-history-chart-keyboard-note">{t('ads.history.chart.chooseDay')}</p>
  </section>;
}
