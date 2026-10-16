import { useEffect, useId, useMemo, useState } from 'react';
import { getPublicAdHistory, getPublicAdHistoryEvidence, useQuery } from 'wasp/client/operations';
import { ArrowRight, CalendarDays, RefreshCw } from 'lucide-react';
import { Empty, Field, Loading } from './App';
import { useWorkspaceLocale } from './workspace-i18n/locale';
import { historyDateLabel, historyDateRange, historyEventKey, mergeHistoryEvents } from './ad-history-ui';
import type { AdHistoryDayView, AdHistoryEventView, HistoryScopeView } from '../ad-history/types';
import type { AdHistoryResult } from '../ad-history/api-types';
import type { AdEvidenceResult, ArchivePreview } from '../ad-history/evidence';
import { AdHistoryCharts } from './AdHistoryCharts';
import './ad-history-charts.css';

export function AdHistoryPanel({ workspaceId, adId }: { workspaceId: string; adId: string }) {
  const { t } = useWorkspaceLocale();
  const [period, setPeriod] = useState<7 | 30 | 90>(30);
  const [scopeHash, setScopeHash] = useState('');
  const [scopes, setScopes] = useState<HistoryScopeView[]>([]);
  const range = useMemo(() => historyDateRange(period), [period]);
  return <section className="ws-ad-history" aria-label={t('ads.history.title')}>
    <div className="ws-history-toolbar"><div><h2>{t('ads.history.title')}</h2><p>{t('ads.history.intro')}</p></div>
      <div className="ws-history-filters"><Field label={t('ads.history.range')}><select value={period} onChange={event => setPeriod(Number(event.target.value) as 7 | 30 | 90)}>{([7, 30, 90] as const).map(days => <option key={days} value={days}>{t(`ads.last${days}Days`)}</option>)}</select></Field>
        <Field label={t('ads.history.scope')}><select value={scopeHash} onChange={event => setScopeHash(event.target.value)}><option value="">{t('ads.history.allScopes')}</option>{scopes.map(scope => <option key={scope.hash} value={scope.hash}>{scopeLabel(scope, t)}</option>)}</select></Field>
      </div>
    </div>
    <HistoryWindow key={`${workspaceId}:${adId}:${range.from}:${range.to}:${scopeHash}`} workspaceId={workspaceId} adId={adId} {...range} scopeHash={scopeHash || undefined} onScopes={setScopes} />
  </section>;
}

function scopeLabel(scope: HistoryScopeView, t: ReturnType<typeof useWorkspaceLocale>['t']) {
  const kind = scope.kind === 'HISTORY_RECHECK' ? 'ads.history.recheckScope' : scope.kind === 'MEDIA_REFRESH' ? 'ads.history.mediaRefreshScope' : scope.kind === 'DISCOVERY' ? 'ads.history.discoveryScope' : 'ads.history.legacyScope';
  return [scope.sourceKey || t('ads.history.sourceUnknown'), scope.queryCountry || t('ads.history.countryUnspecified'), scope.queryLanguage || t('ads.history.languageUnspecified'), t(kind), `#${scope.hash.slice(0, 8)}`].join(' · ');
}

function HistoryWindow({ workspaceId, adId, from, to, scopeHash, onScopes }: { workspaceId: string; adId: string; from: string; to: string; scopeHash?: string; onScopes: (scopes: HistoryScopeView[]) => void }) {
  const { t, error, locale } = useWorkspaceLocale();
  const [eventCursor, setEventCursor] = useState<string | undefined>();
  const query = useQuery(getPublicAdHistory, { workspaceId, adId, from, to, scopeHash, eventCursor });
  const response = query.data as AdHistoryResult | undefined;
  const [lastResponse, setLastResponse] = useState<AdHistoryResult>();
  const [events, setEvents] = useState<AdHistoryEventView[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>();
  useEffect(() => {
    if (!response) return;
    setLastResponse(response);
    setEvents(current => eventCursor ? mergeHistoryEvents(current, response.events) : response.events);
    onScopes(response.scopes);
  }, [response, eventCursor, onScopes]);
  const data = response ?? lastResponse;
  const retry = () => {if(eventCursor)setEventCursor(undefined);else void query.refetch();};
  const days = (value?: number | null) => value == null ? t('ads.unknown') : t(value === 1 ? 'ads.dayCount' : 'ads.daysCount', { count: value.toLocaleString(locale) });
  if (!data && query.isLoading) return <Loading label={t('ads.history.loading')} />;
  if (!data) return <Empty title={t('ads.history.error')} action={<button className="button secondary" onClick={retry}>{t('ads.retrySearch')}</button>}>{error(query.error)}</Empty>;
  return <>
    <div className="ws-history-context"><CalendarDays size={16} aria-hidden="true" /><span>{t('ads.history.window', { from: data.from, to: data.to, timezone: data.timezone })}</span><span>{t('ads.history.asOf', { date: historyDateLabel(data.asOf, locale, t('ads.unknown'), true) })}</span></div>
    <p className="small-note">{t('ads.history.coverageNote')}</p>
    {data.projectionPending && <p className="ws-history-pending" role="status">{t('ads.history.projectionPending')}</p>}
    {data.summary && <><dl className="ws-history-summary"><div><dt>{t('ads.history.observedDays')}</dt><dd>{days(data.summary.observedDays)}</dd></div><div><dt>{t('ads.history.activeObservedDays')}</dt><dd>{days(data.summary.activeObservedDays)}</dd></div><div><dt>{t('ads.sourceDateSpan')}</dt><dd>{days(data.summary.sourceDateSpanDays)}</dd></div></dl><p className="small-note">{t('ads.history.summaryNote')}</p></>}
    <AdHistoryCharts data={data} onSelect={day => setSelectedKey(`${day.day}:${day.scopeHash}`)} />
    <HistoryEvidence data={data} events={mergeHistoryEvents(events, response?.events ?? [])} selectedKey={selectedKey} onSelect={setSelectedKey} workspaceId={workspaceId} adId={adId} />
    {query.error && <p className="ws-history-error" role="alert">{error(query.error)} <button className="text-button" onClick={retry}>{t('ads.retrySearch')}</button></p>}
    {data.nextEventCursor && <button className="button secondary ws-history-more" disabled={query.isFetching} onClick={() => setEventCursor(data.nextEventCursor!)}>{query.isFetching ? <RefreshCw size={15} aria-hidden="true" /> : <ArrowRight size={15} aria-hidden="true" />}{t('ads.history.moreEvents')}</button>}
  </>;
}

/** Read-only presentation uses only facts from the selected historic day. */
export function HistoryEvidence({ data, events = data.events, selectedKey, onSelect, workspaceId, adId }: { data: AdHistoryResult; events?: AdHistoryEventView[]; selectedKey?: string; onSelect: (key: string) => void; workspaceId?: string; adId?: string }) {
  const { t, locale } = useWorkspaceLocale();
  const evidenceId = useId();
  const scopes = new Map(data.scopes.map(scope => [scope.hash, scope]));
  const dayKey = (day: AdHistoryDayView) => `${day.day}:${day.scopeHash}`;
  const selected = data.days.find(day => dayKey(day) === selectedKey);
  useEffect(() => {
    if (!selectedKey) return;
    const evidence = document.getElementById(evidenceId);
    evidence?.scrollIntoView?.({ block: 'nearest' });
    evidence?.focus({ preventScroll: true });
  }, [selectedKey, evidenceId]);
  const number = (value: number) => value.toLocaleString(locale);
  const date = (value?: string | null, time = false) => historyDateLabel(value, locale, t('ads.notProvided'), time);
  return <>
    <div className="ws-history-daily"><h3>{t('ads.history.daily')}</h3>{data.days.length ? <div className="table-wrap"><table><thead><tr><th>{t('ads.history.day')}</th><th>{t('ads.history.observation')}</th><th>{t('ads.sourceStatus')}</th><th>{t('ads.history.check')}</th><th>{t('ads.history.scope')}</th><th>{t('ads.history.evidence')}</th></tr></thead><tbody>
      {[...data.days].sort((a, b) => b.day.localeCompare(a.day) || a.scopeHash.localeCompare(b.scopeHash)).map(day => <tr key={dayKey(day)} className={day.hasStateConflict ? 'ws-history-conflict-row' : ''}>
        <td>{date(day.day)}</td><td><span className={`ws-history-state ${day.observationState === 'OBSERVED' ? 'observed' : 'missing'}`}>{t(day.observationState === 'OBSERVED' ? 'ads.history.observed' : data.projectionPending ? 'ads.history.awaitingProjection' : 'ads.history.missing')}</span>{day.observationState === 'OBSERVED' && <small>{t('ads.history.observationCount', { count: number(day.observationCount) })}</small>}</td>
        <td>{day.observationState === 'OBSERVED' ? t(day.sourceStatus === 'ACTIVE' ? 'ads.active' : day.sourceStatus === 'INACTIVE' ? 'ads.inactive' : 'ads.history.statusUnknown') : '—'}{day.hasStateConflict && <small className="ws-history-conflict">{t('ads.history.conflict')}</small>}</td>
        <td>{t('ads.history.check'+day.checkState)}{day.checkedAt&&<small>{date(day.checkedAt,true)}</small>}</td><td>{scopes.has(day.scopeHash) ? scopeLabel(scopes.get(day.scopeHash)!, t) : t('ads.history.scopeUnknown')}</td>
        <td>{day.latestObservationId ? <button className="text-button" aria-controls={evidenceId} aria-pressed={selectedKey === dayKey(day)} onClick={() => onSelect(dayKey(day))}>{t('ads.history.viewDay')}</button> : <span className="muted">{t(data.projectionPending ? 'ads.history.evidencePending' : 'ads.history.noEvidence')}</span>}</td>
      </tr>)}
    </tbody></table></div> : <Empty title={t('ads.history.noDays')}>{t('ads.noObservationsBody')}</Empty>}</div>
    {selected && <article className="ws-history-evidence" id={evidenceId} tabIndex={-1}><h3>{t('ads.history.selectedDay', { day: date(selected.day) })}</h3>
      <dl className="metadata-list"><div><dt>{t('ads.observedAt')}</dt><dd>{date(selected.lastObservedAt, true)}</dd></div><div><dt>{t('ads.history.observationId')}</dt><dd>{selected.latestObservationId || t('ads.history.noEvidence')}</dd></div><div><dt>{t('ads.history.headline')}</dt><dd>{selected.headline ?? t('ads.notProvided')}</dd></div><div><dt>{t('ads.callToAction')}</dt><dd>{selected.cta ?? t('ads.notProvided')}</dd></div></dl>
      <p className="ad-copy full-copy">{selected.body ?? t('ads.copyUnavailable')}</p><p className="small-note">{t('ads.history.historicMediaNote')}</p>
      {workspaceId && adId && selected.latestObservationId && <HistoricObservationDetail key={`${workspaceId}:${adId}:${selected.latestObservationId}`} workspaceId={workspaceId} adId={adId} observationId={selected.latestObservationId} />}
    </article>}
    <div className="ws-history-events"><h3>{t('ads.history.events')}</h3>{events.length ? <ol>{events.map(event => <li key={event.id}><div><strong>{t(historyEventKey(event.type))}</strong><time dateTime={event.observedAt}>{date(event.observedAt, true)}</time></div><p>{scopes.has(event.scopeHash) ? scopeLabel(scopes.get(event.scopeHash)!, t) : t('ads.history.scopeUnknown')}</p><details><summary>{t('ads.history.evidence')}</summary><dl><div><dt>{t('ads.history.beforeObservation')}</dt><dd>{event.beforeObservationId}</dd></div><div><dt>{t('ads.history.afterObservation')}</dt><dd>{event.afterObservationId}</dd></div></dl></details></li>)}</ol> : <p className="small-note">{t('ads.history.noEvents')}</p>}</div>
  </>;
}

/** Evidence is requested for one observation; a stale response cannot fill another day's details. */
function HistoricObservationDetail({ workspaceId, adId, observationId }: { workspaceId: string; adId: string; observationId: string }) {
  const { t, error } = useWorkspaceLocale();
  const query = useQuery(getPublicAdHistoryEvidence, { workspaceId, adId, observationId }, { refetchOnWindowFocus: false, refetchOnReconnect: false });
  const response = query.data as AdEvidenceResult | undefined;
  const evidence = response?.observationId === observationId ? response : undefined;
  if (!evidence && query.isLoading) return <Loading label={t('ads.history.evidenceLoading')} />;
  if (!evidence) return <div className="ws-history-error" role="alert"><p>{t('ads.history.evidenceUnavailable')}{query.error && ` · ${error(query.error)}`}</p><button className="text-button" onClick={() => void query.refetch()}>{t('ads.retrySearch')}</button></div>;
  const field = (value?: string | null) => value || t('ads.notProvided');
  const list = (values: string[]) => values.length ? values.join(', ') : t('ads.notProvided');
  return <div className="ws-history-observation-detail">
    <dl className="metadata-list ws-history-source-fields">
      <div><dt>{t('ads.history.advertiserName')}</dt><dd>{field(evidence.advertiserName)}</dd></div>
      <div><dt>{t('ads.advertiserId')}</dt><dd>{field(evidence.advertiserId)}</dd></div>
      <div><dt>{t('ads.reportedCountries')}</dt><dd>{list(evidence.reportedCountries)}</dd></div>
      <div><dt>{t('ads.platform')}</dt><dd>{list(evidence.publisherPlatforms)}</dd></div>
      <div><dt>{t('ads.history.adLanguages')}</dt><dd>{list(evidence.adLanguages)}</dd></div>
      <div><dt>{t('ads.landingPage')}</dt><dd>{field(evidence.landingPageUrl)}</dd></div>
      <div><dt>{t('ads.history.sourceStartedAt')}</dt><dd>{field(evidence.sourceStartedAt)}</dd></div>
      <div><dt>{t('ads.history.sourceEndedAt')}</dt><dd>{field(evidence.sourceEndedAt)}</dd></div>
    </dl>
    <section className="ws-history-archive" aria-label={t('ads.history.archiveMedia')}><h4>{t('ads.history.archiveMedia')}</h4>
      {evidence.media.length ? <ol>{evidence.media.map((capture, index) => <HistoricMediaCapture key={`${capture.id}:${capture.displayUrl}`} capture={capture} version={index + 1} />)}</ol> : <p className="small-note">{t('ads.history.noArchivedMedia')}</p>}
    </section>
  </div>;
}

function HistoricMediaCapture({ capture, version }: { capture: ArchivePreview; version: number }) {
  const { t, locale } = useWorkspaceLocale();
  const [previewFailed, setPreviewFailed] = useState(false);
  const caption = t('ads.history.archiveVersion', { count: version.toLocaleString(locale) });
  const time = (value: string | null) => value ? <time dateTime={value}>{historyDateLabel(value, locale, t('ads.unknown'), true)}</time> : t('ads.unknown');
  let size = capture.sizeBytes;
  try { size = BigInt(size).toLocaleString(locale); } catch { /* Keep the API value when the stored size cannot be formatted. */ }
  const preview = capture.displayUrl && !previewFailed;
  return <li className="ws-history-media-capture"><h5>{caption}</h5>
    {preview && capture.type === 'IMAGE' ? <img className="ws-history-media-preview" src={capture.displayUrl!} alt={caption} loading="lazy" referrerPolicy="no-referrer" onError={() => setPreviewFailed(true)} /> : preview && capture.type === 'VIDEO' ? <video className="ws-history-media-preview" src={capture.displayUrl!} aria-label={caption} controls preload="metadata" onError={() => setPreviewFailed(true)} /> : <p className="small-note">{t('ads.history.previewUnavailable')}</p>}
    <dl className="metadata-list">
      <div className="ws-history-download-time"><dt>{t('ads.history.downloadedAt')}</dt><dd>{time(capture.downloadedAt)}</dd></div>
      <div className="ws-history-recorded-time"><dt>{t('ads.history.recordedAt')}</dt><dd>{time(capture.recordedAt)}</dd></div>
      <div><dt>{t('ads.history.mediaAssociation')}</dt><dd>{t('ads.history.sourceUrlMatch')}</dd></div>
      <div><dt>SHA-256</dt><dd><code>{capture.sha256}</code></dd></div>
      <div><dt>{t('ads.mediaType')}</dt><dd>{capture.mimeType}</dd></div>
      <div><dt>{t('ads.history.sizeBytes')}</dt><dd>{size} B</dd></div>
    </dl>
  </li>;
}
