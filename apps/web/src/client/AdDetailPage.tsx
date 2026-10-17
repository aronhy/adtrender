import { AnimatedTabs } from './ui/AnimatedTabs';
import { ResizableAdDetail } from './ui/ResizableAdDetail';
import { CopyButton, CopyField } from './ui/CopyButton';
import { useToast } from './ui/Toast';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { getPublicAd, getPublicAdMediaDownload, getPublicRelatedAds, useQuery } from 'wasp/client/operations';
import { ArrowLeft, ArrowRight, Bookmark, Building2, Check, ChevronDown, Copy, Download, FileSearch, FileText, ImageIcon, Info, RefreshCw, UserRound, Video } from 'lucide-react';
import { canEdit, CommandButton, CommandForm, Empty, Field, formText, Loading, SourceLink, Status, track, useApp, workspaceHref } from './App';
import { WorkspaceRequired } from './WorkspacePages';
import { useWorkspaceLocale } from './workspace-i18n/locale';
import { advertiserName, createMediaRefreshGate, mediaUrl, previewMedia } from './ad-media';
import { searchReturnHref, sourceDateLabel } from './ad-search-params';
import { MediaPlayer } from './AdMedia';
import { AdvertiserLogo, AdPlatformLogos } from './AdIdentity';
import { AdHistoryPanel } from './AdHistoryPanel';
import type { AdDetailResult, AdView, MediaView, RelatedAdsResult } from './types';
import './ad-detail.css';

type DetailTab = 'overview' | 'history' | 'related';
const detailTabs: DetailTab[] = ['overview', 'history', 'related'];
function landingDomain(value?: string | null) {
  try { const url = new URL(value ?? ''); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.hostname.replace(/^www\./, '') : null; }
  catch { return null; }
}

function sourceStatus(value: string) {
  const code = value?.toUpperCase();
  return code === 'ACTIVE' ? 'active' : code === 'INACTIVE' ? 'inactive' : 'unknown';
}

export function AdDetailPage() {
  const { state } = useApp();
  const { adId } = useParams();
  return state.selectedWorkspace && adId ? <AdDetailContent key={`${state.selectedWorkspace.id}:${adId}`} workspaceId={state.selectedWorkspace.id} adId={adId} /> : <WorkspaceRequired />;
}

function AdDetailContent({ workspaceId, adId }: { workspaceId: string; adId: string }) {
  const { state } = useApp();
  const { t, href, date, error, locale } = useWorkspaceLocale();
  const [params] = useSearchParams();
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [workspaceId, adId]);
  const [tab, setTab] = useState<DetailTab>('overview');
  const tabId = useId();
  const query = useQuery(getPublicAd, { workspaceId, adId }, { refetchOnWindowFocus: false, refetchOnReconnect: false });
  const refreshMedia = useMemo(() => createMediaRefreshGate(async () => (await query.refetch({ cancelRefetch: false })).isSuccess), [workspaceId, adId, query.refetch]);
  const data = query.data as AdDetailResult | undefined;
  const [mediaIndex, setMediaIndex] = useState<number | null>(null);
  const defaultMediaIndex = data ? Math.max(0, data.media.indexOf(previewMedia(data.media)!)) : 0;
  useEffect(() => { if (data && mediaIndex === null) setMediaIndex(defaultMediaIndex); }, [data, mediaIndex, defaultMediaIndex]);
  const [analysisKey] = useState(() => crypto.randomUUID());
  const tracked = useRef('');
  useEffect(() => {
    if (data && tracked.current !== `${workspaceId}:${adId}`) {
      track({ type: 'PRODUCT_EVENT', workspaceId, adId, name: 'ad_detail_open' }); tracked.current = `${workspaceId}:${adId}`;
    }
  }, [data, workspaceId, adId]);
  const back = href(searchReturnHref(params.get('returnTo'), workspaceId));
  if (query.isLoading) return <Loading label={t('ads.detailLoading')} />;
  if (query.error || !data) return <Empty title={t('ads.detailError')} action={<Link to={back}>{t('ads.backLibrary')}<ArrowRight size={15} aria-hidden="true" /></Link>}>{error(query.error)}</Empty>;
  const ad = data.ad;
  const selectedMediaIndex = data.media.length ? Math.min(mediaIndex ?? defaultMediaIndex, data.media.length - 1) : 0;
  const media = data.media[selectedMediaIndex];
  const textOnly = ad.mediaType?.toUpperCase() === 'TEXT' && !media && [ad.copy, ad.headline, ad.description].some(value => Boolean(value?.trim()));
  const name = advertiserName(ad.advertiserName);
  const title = name || ad.headline?.trim() || t('ads.detail');
  const countryNames = new Intl.DisplayNames([locale], { type: 'region' });
  const countries = ad.reportedCountries?.length ? ad.reportedCountries.map(code => { try { return countryNames.of(code) || code; } catch { return code; } }).join(' · ') : t('ads.notProvided');
  const days = (value?: number | null) => value == null ? t('ads.unknown') : t(value === 1 ? 'ads.dayCount' : 'ads.daysCount', { count: value.toLocaleString(locale) });
  const switchTab = (next: DetailTab, focus = false) => { setTab(next); if (focus) document.getElementById(`${tabId}-${next}`)?.focus(); };
  const summary = data.advertiserSummary;
  const format = Array.from(new Set(data.media.map(item => item.type.toUpperCase())));
  const mediaLabel = ad.mediaType?.toUpperCase() === 'TEXT' ? t('ads.library.textAds') : format.includes('IMAGE') && format.includes('VIDEO') ? t('ads.detail.mixedMedia') : format.includes('VIDEO') ? t('ads.videos') : format.includes('IMAGE') ? t('ads.images') : t('ads.notProvided');

  return <div className="ws-ad-detail ws-ad-detail-redesign">
    <div className="ws-detail-actions"><Link className="back-link" to={back}><ArrowLeft size={16} aria-hidden="true" />{t('ads.backResults')}</Link>
      <div className="ws-detail-primary-actions"><CommandButton command={{ type: 'SAVE_AD', workspaceId, adId }} disabled={!canEdit(state) || ad.saved} className={`button ${ad.saved ? 'secondary' : 'primary'}`}>
        {ad.saved ? <><Check size={17} aria-hidden="true" />{t('ads.saved')}</> : <><Bookmark size={17} aria-hidden="true" />{t('ads.save')}</>}
      </CommandButton><SourceLink url={ad.sourceUrl} onClick={() => track({ type: 'PRODUCT_EVENT', workspaceId, adId, name: 'source_link_click' })}>{t('ads.originalSource')}</SourceLink></div>
    </div>
    <ResizableAdDetail>
      <aside className="detail-media ws-detail-creative" aria-label={t('ads.originalCopy')}>
        <CreativeCard ad={ad} media={media} revision={query.dataUpdatedAt} workspaceId={workspaceId} adId={adId} />
        <div className="media-toolbar"><span>{textOnly ? t('ads.library.textAds') : t('ads.assetPosition', { current: (data.media.length ? selectedMediaIndex + 1 : 0).toLocaleString(locale), total: data.media.length.toLocaleString(locale) })}{media && <span className="ws-detail-archive-state"> · {t(media.status === 'CACHED' ? 'ads.detail.assetSaved' : media.status === 'READY' ? 'ads.detail.assetReady' : media.status === 'PENDING' ? 'ads.detail.assetPending' : 'ads.mediaUnavailable')}</span>}</span>
          <button type="button" className="text-button" disabled={query.isFetching} onClick={() => void refreshMedia()}><RefreshCw size={14} aria-hidden="true" />{t('ads.refreshMedia')}</button>
        </div>
        {data.media.length > 1 && <div className="media-picker ws-detail-thumbnails" aria-label={t('ads.chooseMedia')}>{data.media.map((item, index) => <button key={item.id} type="button" className={index === selectedMediaIndex ? 'selected' : ''} onClick={() => setMediaIndex(index)} aria-pressed={index === selectedMediaIndex} aria-label={t('ads.assetNumber', { number: (index + 1).toLocaleString(locale) })}>
          <MediaPlayer media={item} compact revision={query.dataUpdatedAt} />
          <span className="ws-detail-thumb-label">{item.type.toUpperCase() === 'VIDEO' ? <Video size={12} aria-hidden="true" /> : <ImageIcon size={12} aria-hidden="true" />}{(index + 1).toLocaleString(locale)}</span>
        </button>)}</div>}
        <CreativeTools sourceUrl={ad.sourceUrl} copy={[ad.headline, ad.copy, ad.description].filter(Boolean).join('\n\n')} textOnly={textOnly} media={media} workspaceId={workspaceId} adId={adId} />
        <details className="ws-detail-archive"><summary><FileText size={15} aria-hidden="true" /><span>{t('ads.detail.originalRecords')}</span><ChevronDown size={15} aria-hidden="true" /></summary>
          <details className="ws-observations"><summary>{t('ads.observations')}<small>{data.observations.length.toLocaleString(locale)}</small></summary><p className="small-note">{t('ads.observationsHint')}</p>
            {data.observations.length ? <div className="table-wrap"><table><thead><tr><th>{t('ads.observedAt')}</th><th>{t('ads.sourceStatus')}</th><th>{t('ads.country')}</th></tr></thead><tbody>{data.observations.map(observation => <tr key={observation.id}><td>{date(observation.observedAt, true)}</td><td><Status value={sourceStatus(observation.sourceStatus)} /></td><td>{observation.queryCountry || t('ads.unknown')}</td></tr>)}</tbody></table></div> : <p className="small-note">{t('ads.noObservationsBody')}</p>}
          </details>
        </details>
        <details className="ws-detail-organize"><summary><Bookmark size={15} aria-hidden="true" />{t('ads.detail.savedFolder')}<ChevronDown size={15} aria-hidden="true" /></summary>
          <CommandForm label={t(ad.saved ? 'ads.updateFolder' : 'ads.saveWorkspace')} disabled={!canEdit(state)} build={form => ad.savedAdId
            ? { type: 'MOVE_SAVED_AD', workspaceId, savedAdId: ad.savedAdId, folderId: formText(form, 'folderId') || null }
            : { type: 'SAVE_AD', workspaceId, adId, folderId: formText(form, 'folderId') || undefined }}>
            <Field label={t('ads.savedFolder')}><select name="folderId" defaultValue={state.research.savedAds.find(saved => saved.id === ad.savedAdId)?.folderId || ''}><option value="">{t('ads.unfiled')}</option>{state.research.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></Field>
          </CommandForm>
        </details>
      </aside>
      <section className="detail-information ws-detail-main">
        <header className="ws-detail-identity"><AdvertiserLogo name={name} url={ad.advertiserAvatarUrl} className="ws-detail-advertiser-icon" /><div><h1>{title}</h1><div className="ws-detail-identity-links">{landingDomain(ad.landingPageUrl) && <SourceLink allowHttp url={ad.landingPageUrl}>{landingDomain(ad.landingPageUrl)}</SourceLink>}<AdPlatformLogos className="ws-detail-platform" platforms={ad.publisherPlatforms} sourceKey={ad.dataSourceKey} unknownLabel={t('ads.platformUnknown')} /></div></div></header>
        <AnimatedTabs className="ws-detail-tabs" idBase={tabId} value={tab} onChange={next => switchTab(next)} label={t('ads.detail')} items={detailTabs.map(value=>({value,label:t(value === 'history' ? 'ads.history.tab' : value === 'related' ? 'ads.detail.related' : 'ads.detail.overview')}))} />
        <div role="tabpanel" id={`${tabId}-${tab}-panel`} aria-labelledby={`${tabId}-${tab}`} tabIndex={0} className="ws-detail-tab-panel">
          {tab === 'overview' ? <>
            <section className="ws-detail-panel ws-detail-facts" aria-labelledby={`${tabId}-facts`}>
              <div className="ws-detail-panel-heading"><h2 id={`${tabId}-facts`}><FileText size={20} aria-hidden="true" />{t('ads.detail.facts')}</h2><details className="ws-detail-more-facts"><summary>{t('ads.detail.moreFacts')}<ChevronDown size={15} aria-hidden="true" /></summary><dl className="metadata-list"><Fact label={t('ads.source')}>{ad.dataSourceKey || t('ads.notProvided')}</Fact><Fact label={t('ads.sourceAdId')}>{ad.sourceAdId}</Fact><Fact label={t('ads.advertiserId')}>{ad.advertiserId || t('ads.notProvided')}</Fact><Fact label={t('ads.statusObservedAt')}>{date(ad.statusObservedAt, true)}</Fact><Fact label={t('ads.sourceEnded')}>{sourceDateLabel(ad.sourceEndedAt, locale, t('ads.notProvided'))}</Fact><Fact label={t('ads.firstObserved')}>{date(ad.firstObservedAt, true)}</Fact><Fact label={t('ads.lastObserved')}>{date(ad.lastObservedAt, true)}</Fact></dl><p className="small-note">{t('ads.observationNote')}</p></details></div>
              <div className="ws-detail-status-strip"><Status value={sourceStatus(ad.status)} /><div><span>{t('ads.detail.sourceStart')}</span><strong>{sourceDateLabel(ad.sourceStartedAt, locale, t('ads.notProvided'))}</strong></div><div><span>{t('ads.detail.lastObserved')}</span><strong>{date(ad.lastObservedAt)}</strong></div></div>
              <dl className="metadata-list ws-detail-metrics"><Fact label={t('ads.detail.observedDays')} title={t('ads.observedDays')}>{days(ad.deliverySummary?.observedDays)}</Fact><Fact label={t('ads.detail.activeObservedDays')} title={t('ads.activeObservedDays')}>{days(ad.deliverySummary?.activeObservedDays)}</Fact><Fact label={t('ads.detail.assets')}>{t('ads.detail.assetCount', { count: data.media.length.toLocaleString(locale) })}</Fact></dl>
              <div className="ws-detail-fact-columns"><dl className="metadata-list"><Fact label={t('ads.platform')}>{ad.publisherPlatforms.length ? ad.publisherPlatforms.join(' · ') : t('ads.platformUnknown')}</Fact><Fact label={t('ads.reportedCountries')}>{countries}</Fact><Fact label={t('ads.callToAction')}>{ad.cta || t('ads.notProvided')}</Fact></dl>
                <dl className="metadata-list"><Fact label={t('ads.detail.mediaFormat')}>{mediaLabel}</Fact><Fact label={t('ads.landingPage')}>{landingDomain(ad.landingPageUrl) ? <SourceLink allowHttp url={ad.landingPageUrl}>{landingDomain(ad.landingPageUrl)}</SourceLink> : t('ads.notProvided')}</Fact><Fact label={t('ads.sourceDateSpan')}>{days(ad.deliverySummary?.sourceDateSpanDays)}</Fact></dl></div>
              <p className="ws-detail-fact-note"><Info size={14} aria-hidden="true" />{t('ads.spanCompactNote')}</p>
              <button type="button" className="text-button ws-detail-history-link" onClick={() => switchTab('history', true)}>{t('ads.detail.viewHistory')}<ArrowRight size={15} aria-hidden="true" /></button>

            </section>
            <section className="ws-detail-panel ws-detail-advertiser" aria-labelledby={`${tabId}-advertiser`}><div className="ws-detail-panel-heading"><h2 id={`${tabId}-advertiser`}><UserRound size={20} aria-hidden="true" />{t('ads.detail.advertiserOverview')}</h2>{summary && <span className="ws-detail-scope">{t('ads.detail.sourceScope', { source: summary.dataSourceKey || t('ads.notProvided') })}</span>}<button type="button" className="text-button" onClick={() => switchTab('related', true)}>{t('ads.detail.allRelated')}<ArrowRight size={15} aria-hidden="true" /></button></div>
              {summary ? <><div className="ws-detail-advertiser-profile"><span className="ws-detail-advertiser-icon" aria-hidden="true"><Building2 size={22} /></span><div><strong>{advertiserName(summary.name) || t('ads.notProvided')}</strong>{landingDomain(summary.websiteUrl) && <SourceLink url={summary.websiteUrl}>{landingDomain(summary.websiteUrl)}</SourceLink>}</div><span>{t('ads.detail.libraryScope', { date: date(summary.asOf) })}</span></div>
                <dl className="metadata-list ws-detail-metrics"><Fact label={t('ads.detail.collectedAds')}>{summary.collectedAds.toLocaleString(locale)}</Fact><Fact label={t('ads.detail.activeAds')}>{summary.activeAds.toLocaleString(locale)}</Fact><Fact label={t('ads.detail.newAds')}>{summary.newAds7Days.toLocaleString(locale)}</Fact></dl>
                <p className="small-note ws-detail-advertiser-note">{t('ads.detail.advertiserNote')}</p>
                {summary.recentAds.length > 0 && <><div className="ws-detail-recent-heading"><h3>{t('ads.detail.recentCreatives')}</h3><button type="button" className="text-button" onClick={() => switchTab('related', true)}>{t('ads.detail.allRelated')}<ArrowRight size={14} aria-hidden="true" /></button></div><div className="ws-detail-recent-grid">{summary.recentAds.map(recent => <Link key={recent.id} className="ws-detail-recent-card" to={href(`${workspaceHref(`/app/ads/${encodeURIComponent(recent.id)}`, workspaceId)}&returnTo=${encodeURIComponent(params.get('returnTo') || '')}`)} aria-label={recent.headline?.trim() || t('ads.viewDetails')}><MediaPlayer media={previewMedia(recent.media)} compact revision={query.dataUpdatedAt} /></Link>)}</div></>}
              </> : <div className="ws-detail-advertiser-missing"><Building2 size={25} aria-hidden="true" /><h3>{t('ads.detail.advertiserUnavailable')}</h3><p>{t('ads.detail.advertiserUnavailableNote')}</p></div>}
            </section>
            <section className="ws-detail-analysis"><div><FileSearch size={20} aria-hidden="true" /><div><h2>{t('ads.analysisLabel')}</h2><p>{t('ads.detail.analysisIntro')}</p></div></div><CommandButton command={{ type: 'ANALYZE_AD', workspaceId, adId, idempotencyKey: analysisKey }} disabled={!canEdit(state)} className="button secondary"><FileSearch size={16} aria-hidden="true" />{t('ads.analyze')}</CommandButton><Link to={href(workspaceHref('/app/research', workspaceId))}>{t('ads.savedAnalyses')}<ArrowRight size={14} aria-hidden="true" /></Link></section>
          </> : tab === 'history' ? <AdHistoryPanel workspaceId={workspaceId} adId={adId} /> : <RelatedAds key={`${workspaceId}:${adId}:${ad.dataSourceKey}:${ad.advertiserId}`} workspaceId={workspaceId} adId={adId} returnTo={params.get('returnTo') || ''} unavailable={!summary} advertiserId={ad.advertiserId ?? null} dataSourceKey={ad.dataSourceKey ?? null} onRefreshDetail={() => void query.refetch()} />}
        </div>
      </section>
    </ResizableAdDetail>
  </div>;
}

function Fact({ label, title, children }: { label: string; title?: string; children: ReactNode }) { return <div><dt title={title}>{label}</dt><dd>{children}</dd></div>; }

function CreativeCard({ ad, media, revision, workspaceId, adId }: { ad: AdView; media?: MediaView; revision: number; workspaceId: string; adId: string }) {
  const { t } = useWorkspaceLocale();
  const [expanded, setExpanded] = useState(false);
  const name = advertiserName(ad.advertiserName);
  const longCopy = (ad.copy?.length ?? 0) > 180;
  const textOnly = ad.mediaType?.toUpperCase() === 'TEXT' && !media && [ad.copy, ad.headline, ad.description].some(value => Boolean(value?.trim()));
  return <article className="ws-detail-creative-card"><header><AdvertiserLogo name={name} url={ad.advertiserAvatarUrl} className="ws-detail-creative-icon" /><div>{name && <strong>{name}</strong>}</div><AdPlatformLogos className="ws-detail-platform" platforms={ad.publisherPlatforms} sourceKey={ad.dataSourceKey} unknownLabel={t('ads.platformUnknown')} /></header>
    <p className={`ad-copy full-copy ws-detail-creative-copy${longCopy && !expanded ? ' ws-detail-copy-collapsed' : ''}`}>{ad.copy || t('ads.copyUnavailable')}</p>
    {longCopy && <button type="button" className="text-button ws-detail-copy-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{t(expanded ? 'ads.detail.collapseCopy' : 'ads.detail.expandCopy')}<ChevronDown size={14} aria-hidden="true" /></button>}
    {!textOnly && <div className={`detail-media-stage${media?.type.toUpperCase() === 'VIDEO' ? ' ws-detail-video-stage' : ''}`}><MediaPlayer media={media} revision={revision} onPlay={() => track({ type: 'PRODUCT_EVENT', workspaceId, adId, name: 'media_play' })} /></div>}
    {(ad.headline?.trim() || ad.cta || landingDomain(ad.landingPageUrl)) && <footer><div>{ad.headline?.trim() && <strong>{ad.headline}</strong>}{landingDomain(ad.landingPageUrl) && <SourceLink allowHttp url={ad.landingPageUrl}>{landingDomain(ad.landingPageUrl)}</SourceLink>}</div>{ad.cta && <span className="ws-detail-cta">{landingDomain(ad.landingPageUrl) ? <SourceLink allowHttp url={ad.landingPageUrl}>{ad.cta}</SourceLink> : ad.cta}</span>}</footer>}
    {ad.description && <p className="ws-detail-creative-description">{ad.description}</p>}
  </article>;
}

function CreativeTools({ copy, sourceUrl, media, textOnly, workspaceId, adId }: { sourceUrl?: string | null; textOnly?: boolean; copy?: string | null; media?: MediaView; workspaceId: string; adId: string }) {
  const { t, error } = useWorkspaceLocale();
  const { notify } = useToast();
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadError, setDownloadError] = useState<unknown>(null);
  const downloadPending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => setDownloadError(null), [media?.id]);
  const canDownload = media?.status === 'READY' && Boolean(mediaUrl(media.displayUrl));
  return <><div className="ws-detail-creative-tools"><CopyButton value={copy} label={t('ads.detail.copyText')} successLabel={t('ads.detail.copied')} errorLabel={t('ads.detail.copyFailed')} />
    {!textOnly && <button type="button" className="text-button ws-detail-download" disabled={downloadBusy || !canDownload} title={!canDownload ? t('ads.detail.downloadUnavailable') : undefined} aria-label={t('ads.detail.download')} aria-busy={downloadBusy} onClick={async () => {
      if (downloadPending.current || !canDownload || !media) return;
      downloadPending.current = true; setDownloadBusy(true); setDownloadError(null);
      try {
        const result = await getPublicAdMediaDownload({ workspaceId, adId, mediaId: media.id });
        const url = mediaUrl(result.url);
        const expiresAt = new Date(result.expiresAt ?? '').valueOf();
        if (!url || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('MEDIA_DOWNLOAD_UNAVAILABLE');
        if (mounted.current) { notify({id:`download:${media.id}`,type:'info',message:t('ui.downloadStarted')}); window.location.assign(url); }
      } catch (reason) { if (mounted.current) { setDownloadError(reason); notify({id:`download:${media.id}`,type:'error',message:error(reason)}); } }
      finally { downloadPending.current = false; if (mounted.current) setDownloadBusy(false); }
    }}><Download size={16} aria-hidden="true" />{t(downloadBusy ? 'common.working' : 'ads.detail.download')}</button>}
  </div>{sourceUrl && mediaUrl(sourceUrl) && <div className="ws-detail-source-copy"><CopyField value={mediaUrl(sourceUrl)} label={t('ui.copySource')} successLabel={t('ads.detail.copied')} errorLabel={t('ads.detail.copyFailed')} /></div>}{downloadError !== null && <p className="inline-error ws-detail-copy-notice" role="alert">{error(downloadError)}</p>}</>;
}

function RelatedAds({ workspaceId, adId, returnTo, unavailable, advertiserId, dataSourceKey, onRefreshDetail }: { workspaceId: string; adId: string; returnTo: string; unavailable: boolean; advertiserId: string | null; dataSourceKey: string | null; onRefreshDetail: () => void }) {
  const { t, date, error, locale, href } = useWorkspaceLocale();
  const [cursor, setCursor] = useState<string | undefined>();
  const query = useQuery(getPublicRelatedAds, { workspaceId, adId, cursor, limit: 6 }, { refetchOnWindowFocus: false, refetchOnReconnect: false });
  const data = query.data as RelatedAdsResult | undefined;
  if (query.isLoading) return <Loading label={t('ads.detail.relatedLoading')} />;
  if (query.error || !data) return <Empty title={t('ads.detail.relatedError')} action={<button type="button" className="button secondary" onClick={() => void query.refetch()}>{t('ads.retrySearch')}</button>}>{error(query.error)}</Empty>;
  const identityMatches = data.anchorIdentity ? data.anchorIdentity.sourceAdvertiserId === advertiserId && data.anchorIdentity.dataSourceKey === dataSourceKey : advertiserId === null;
  if (!identityMatches) return <Empty title={t('ads.detail.relatedChanged')} action={<button type="button" className="button secondary" onClick={onRefreshDetail}>{t('ads.detail.refreshDetail')}</button>}>{t('ads.detail.relatedChangedNote')}</Empty>;
  return <section className="ws-detail-panel ws-detail-related"><div className="ws-detail-panel-heading"><h2>{t('ads.detail.relatedTotal', { count: data.total.toLocaleString(locale) })}</h2></div><p className="small-note">{t('ads.detail.relatedIntro')}</p>
    {data.ads.length ? <><div className="ws-detail-related-grid">{data.ads.map(ad => <Link key={ad.id} className="ws-detail-related-card" to={href(`${workspaceHref(`/app/ads/${encodeURIComponent(ad.id)}`, workspaceId)}&returnTo=${encodeURIComponent(returnTo)}`)}><div className="ws-detail-related-media"><MediaPlayer media={previewMedia(ad.media)} compact revision={query.dataUpdatedAt} /></div><div><strong>{ad.headline?.trim() || advertiserName(ad.advertiserName) || t('ads.viewDetails')}</strong><p>{ad.copy || t('ads.copyUnavailable')}</p><Status value={sourceStatus(ad.status)} /><span className="ws-detail-related-date">{t('ads.lastObservedDate', { date: date(ad.lastObservedAt) })}</span></div></Link>)}</div><div className="ws-detail-related-pagination"><span>{t('ads.detail.libraryScope', { date: date(data.asOf) })}</span>{cursor && <button type="button" className="text-button" disabled={query.isFetching} onClick={() => setCursor(undefined)}>{t('ads.firstPage')}</button>}<button type="button" className="button secondary" disabled={!data.nextCursor || query.isFetching} onClick={() => { if (data.nextCursor) setCursor(data.nextCursor); }}>{t('ads.nextPage')}<ArrowRight size={15} aria-hidden="true" /></button></div></>
      : <Empty title={t(unavailable ? 'ads.detail.advertiserUnavailable' : 'ads.detail.relatedEmpty')}>{t(unavailable ? 'ads.detail.advertiserUnavailableNote' : 'ads.detail.relatedEmptyNote')}</Empty>}
  </section>;
}
