import { AnimatedTabs } from './ui/AnimatedTabs';
import { useToast } from './ui/Toast';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { getResearchPage, useQuery } from 'wasp/client/operations';
import { ArrowRight, Bookmark, ChevronDown, FileSearch, Folder, Plus, RefreshCw, X } from 'lucide-react';
import { canEdit, CommandButton, CommandForm, Empty, Field, formText, Loading, PageHeader, Status, useApp, workspaceHref } from './App';
import { WorkspaceRequired } from './WorkspacePages';
import { useWorkspaceLocale } from './workspace-i18n/locale';
import type { AnalysisView, NoteView, ResearchPageResult, SavedAdView } from './types';
import { advertiserName } from './ad-media';
import './workspace-content.css';

export function ResearchPage() {
  const { state } = useApp();
  return state.selectedWorkspace ? <ResearchContent key={state.selectedWorkspace.id} workspaceId={state.selectedWorkspace.id} /> : <WorkspaceRequired />;
}

function ResearchContent({ workspaceId }: { workspaceId: string }) {
  const { state, refresh } = useApp();
  const { t, error, locale } = useWorkspaceLocale();
  const workspace = state.selectedWorkspace!;
  const [tab, setTab] = useState<'saved' | 'analysis'>('saved');
  const [folderId, setFolderId] = useState('');
  const [newFolder, setNewFolder] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);
  const groupId = useId();
  const folderFormId = useId();
  const tabs = ['saved', 'analysis'] as const;
  return <div className="ws-research-page">
    <PageHeader eyebrow={workspace.name} title={t('research.title')} description={t('research.description')}
      action={<button className="button secondary" disabled={refreshing} onClick={async () => {
        setRefreshing(true); setRefreshError(null);
        try { await refresh(); setReload(value => value + 1); }
        catch (reason) { setRefreshError(reason); }
        finally { setRefreshing(false); }
      }}><RefreshCw size={16} aria-hidden="true" />{t(refreshing ? 'research.refreshing' : 'research.refresh')}</button>} />
    {refreshError != null && <p className="inline-error" role="alert">{error(refreshError)}</p>}
    <AnimatedTabs className="tabs" idBase={groupId} panelId={()=>`${groupId}-panel`} value={tab} onChange={setTab} label={t('research.tabs')} items={tabs.map(value=>({value,label:<>{value==='saved'?<Bookmark size={17} aria-hidden="true"/>:<FileSearch size={17} aria-hidden="true"/>}{t(value==='saved'?'research.savedTab':'research.analysisTab')}<span>{(value==='saved'?state.overview.savedCount:state.overview.analysisCount).toLocaleString(locale)}</span></>}))} />
    <div id={`${groupId}-panel`} role="tabpanel" aria-labelledby={`${groupId}-${tab}`}>
      {tab === 'saved' && <>
        <div className="research-tools"><Field label={t('research.folderFilter')}><select value={folderId} onChange={event => setFolderId(event.target.value)}><option value="">{t('research.allSaved')}</option>{state.research.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></Field>
          <button className="button secondary" type="button" disabled={!canEdit(state)} aria-expanded={newFolder} aria-controls={folderFormId} onClick={() => setNewFolder(value => !value)}>
            {newFolder ? <X size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}{t(newFolder ? 'research.cancelFolder' : 'research.createFolder')}
          </button>
        </div>
        {newFolder && <div id={folderFormId} className="ws-create-folder"><p>{t('research.folderHint')}</p>
          <CommandForm className="inline-form" label={t('research.createFolder')} disabled={!canEdit(state)} reset build={data => ({ type: 'CREATE_FOLDER', workspaceId: workspace.id, name: formText(data, 'name') })}>
            <Field label={t('research.folderName')}><input name="name" required maxLength={80} placeholder={t('research.folderPlaceholder')} /></Field>
          </CommandForm>
        </div>}
      </>}
      <ResearchResults key={`${workspaceId}:${tab}:${folderId}:${reload}`} workspaceId={workspaceId} kind={tab} folderId={tab === 'saved' ? folderId || undefined : undefined} />
    </div>
    <p className="ws-sharing-note">{t('research.sharingNote')}</p>
  </div>;
}

function ResearchResults({ workspaceId, kind, folderId }: { workspaceId: string; kind: 'saved' | 'analysis'; folderId?: string }) {
  const { commandVersion } = useApp();
  const { t, error, href, locale } = useWorkspaceLocale();
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const query = useQuery(getResearchPage, { workspaceId, kind, folderId, cursor: cursors.at(-1), limit: 20 });
  const previousCommandVersion = useRef(commandVersion);
  useEffect(() => { if (previousCommandVersion.current !== commandVersion) { previousCommandVersion.current = commandVersion; void query.refetch(); } }, [commandVersion, query.refetch]);
  const data = query.data as ResearchPageResult | undefined;
  if (query.isLoading) return <Loading label={t('research.loading')} />;
  if (query.error || !data) return <Empty title={t('research.loadError')} action={<button className="button secondary" onClick={() => void query.refetch()}>{t('research.retry')}</button>}>{error(query.error)}</Empty>;
  const empty = kind === 'saved' ? !data.savedAds.length : !data.analyses.length;
  const previousPage = () => setCursors(history => history.slice(0, -1));
  return <>
    <div className="ws-research-summary"><strong>{t('research.count', { count: data.total.toLocaleString(locale) })}</strong><span>{t('research.sortNote')}</span></div>
    {empty ? <Empty title={t(cursors.length > 1 ? 'research.emptyPage' : kind === 'analysis' ? 'research.emptyAnalyses' : folderId ? 'research.emptyFolder' : 'research.emptySaved')}
      action={cursors.length > 1 ? <button className="button secondary" onClick={previousPage}>{t('research.previous')}</button> : <Link className="button secondary" to={href(workspaceHref('/app/ads', workspaceId))}>{t('research.discover')}<ArrowRight size={16} aria-hidden="true" /></Link>}>
      {t(cursors.length > 1 ? 'research.emptyPageBody' : kind === 'analysis' ? 'research.emptyAnalysisBody' : folderId ? 'research.emptyFolderBody' : 'research.emptySavedBody')}
    </Empty> : kind === 'saved' ? <div className="saved-list">{data.savedAds.map(ad => <SavedResearchAd key={ad.id} ad={ad} workspaceId={workspaceId} />)}</div>
      : <div className="analysis-list">{data.analyses.map(analysis => <AnalysisCard key={analysis.id} analysis={analysis} workspaceId={workspaceId} />)}</div>}
    <div className="pagination"><span>{t('research.page', { page: cursors.length.toLocaleString(locale) })}</span>
      <button className="button secondary" disabled={query.isFetching || cursors.length === 1} onClick={previousPage}>{t('research.previous')}</button>
      <button className="button secondary" disabled={query.isFetching || !data.nextCursor} onClick={() => { if (data.nextCursor) setCursors(history => [...history, data.nextCursor!]); }}>{t('research.next')}<ArrowRight size={15} aria-hidden="true" /></button>
    </div>
  </>;
}

function SavedResearchAd({ ad, workspaceId }: { ad: SavedAdView & { notes: NoteView[] }; workspaceId: string }) {
  const { state } = useApp();
  const { t, href, date, locale } = useWorkspaceLocale();
  const editable = canEdit(state);
  const advertiser = advertiserName(ad.advertiserName);
  const detail = href(workspaceHref(`/app/ads/${encodeURIComponent(ad.adId)}`, workspaceId));
  return <article><div className="saved-heading"><span className="ws-record-icon"><Bookmark size={20} aria-hidden="true" /></span><div className="ws-record-heading">
    {advertiser && <h3><Link to={detail}>{advertiser}</Link></h3>}
    <p>{t('research.savedAt', { date: date(ad.savedAt) })}<span aria-hidden="true"> · </span>{state.research.folders.find(folder => folder.id === ad.folderId)?.name || t('research.unfiled')}</p>
  </div><CommandButton command={{ type: 'REMOVE_SAVED_AD', workspaceId, savedAdId: ad.id }} disabled={!editable} className="text-button" confirmText={t('research.removeConfirm')}>{t('research.remove')}</CommandButton></div>
    <p className="ad-copy excerpt">{advertiser ? ad.copy || t('research.copyUnavailable') : <Link to={detail}>{ad.copy?.trim() || t('research.viewDetails')}</Link>}</p>
    <details className="ws-saved-organize"><summary><Folder size={16} aria-hidden="true" />{t('research.organize')}<ChevronDown size={15} aria-hidden="true" /></summary>
      <CommandForm key={ad.folderId ?? 'unfiled'} className="inline-form saved-folder-form" label={t('research.move')} disabled={!editable} build={data => ({ type: 'MOVE_SAVED_AD', workspaceId, savedAdId: ad.id, folderId: formText(data, 'folderId') || null })}>
        <Field label={t('research.folder')}><select name="folderId" defaultValue={ad.folderId || ''}><option value="">{t('research.unfiled')}</option>{state.research.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></Field>
      </CommandForm>
    </details>
    {ad.notes.length ? ad.notes.map((note, index) => <ResearchNote key={`${note.id}:${String(note.updatedAt)}`} savedAdId={ad.id} workspaceId={workspaceId} note={note} label={t('research.noteNumber', { number: (index + 1).toLocaleString(locale) })} />)
      : <ResearchNote savedAdId={ad.id} workspaceId={workspaceId} label={t('research.addNote')} />}
  </article>;
}

function ResearchNote({ savedAdId, workspaceId, note, label }: { savedAdId: string; workspaceId: string; note?: NoteView; label: string }) {
  const { state } = useApp();
  const { t } = useWorkspaceLocale();
  const editable = canEdit(state);
  return <details className="note-editor"><summary><span>{label}{note && <small className="ws-note-preview">{note.body}</small>}</span><Plus size={16} aria-hidden="true" /></summary>
    <CommandForm label={t('research.saveNote')} disabled={!editable} build={data => ({ type: 'SAVE_NOTE', workspaceId, savedAdId, noteId: note?.id, body: formText(data, 'body') })}>
      <Field label={t('research.note')} hint={t('research.noteHint')}><textarea name="body" defaultValue={note?.body} required maxLength={10000} rows={4} /></Field>
    </CommandForm>
    {note && <CommandButton command={{ type: 'DELETE_NOTE', workspaceId, noteId: note.id }} disabled={!editable} className="text-button" confirmText={t('research.deleteNoteConfirm')}>{t('research.deleteNote')}</CommandButton>}
  </details>;
}

function AnalysisCard({ analysis, workspaceId }: { analysis: AnalysisView; workspaceId: string }) {
  const {notify}=useToast(); const {t:noticeText}=useWorkspaceLocale(); const previousStatus=useRef(analysis.status);
  useEffect(()=>{const wasPending=['QUEUED','RUNNING','PENDING'].includes(previousStatus.current);previousStatus.current=analysis.status;if(wasPending&&['SUCCEEDED','FAILED'].includes(analysis.status))notify({id:`analysis:${analysis.id}:${analysis.status}`,type:analysis.status==='SUCCEEDED'?'success':'error',message:noticeText(analysis.status==='SUCCEEDED'?'ui.analysisDone':'ui.analysisFailed')});},[analysis.id,analysis.status,notify,noticeText]);
  const { state } = useApp();
  const { t, href, date, error } = useWorkspaceLocale();
  const editable = canEdit(state);
  const pending = ['QUEUED', 'RUNNING'].includes(analysis.status);
  return <article><header><span className="ws-record-icon"><FileSearch size={20} aria-hidden="true" /></span><div className="ws-record-heading">
    <h3><Link to={href(workspaceHref(`/app/ads/${encodeURIComponent(analysis.adId)}`, workspaceId))}>{advertiserName(analysis.advertiserName) || t('research.viewDetails')}</Link></h3><p>{date(analysis.createdAt, true)}</p>
  </div><Status value={analysis.status} /></header>
    {analysis.result ? <div className="analysis-result">
      {analysis.result.facts && <section><h4>{t('research.facts')}</h4><p>{analysis.result.facts}</p></section>}
      {analysis.result.interpretation && <section className="ws-ai-interpretation"><h4>{t('research.interpretation')}<span>{t('research.aiInference')}</span></h4><p>{analysis.result.interpretation}</p></section>}
      {analysis.result.limitations && <section><h4>{t('research.limitations')}</h4><p>{analysis.result.limitations}</p></section>}
      {analysis.result.evidence?.length ? <section><h4>{t('research.evidence')}</h4><ul>{analysis.result.evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul></section> : <p className="small-note">{t('research.noEvidence')}</p>}
    </div> : <p className="muted">{analysis.status === 'FAILED' ? t('research.analysisFailed', { reason: error(analysis.errorCode) }) : t(analysis.status === 'CANCELED' ? 'research.analysisCanceled' : pending ? 'research.analysisPending' : 'research.analysisUnavailable')}</p>}
    <div className="analysis-actions">
      {analysis.status === 'FAILED' && <RetryAnalysisButton key={`${analysis.id}:${analysis.attempt ?? 0}`} workspaceId={workspaceId} jobId={analysis.id} disabled={!editable} />}
      {pending && <CommandButton command={{ type: 'CANCEL_ANALYSIS', workspaceId, jobId: analysis.id }} disabled={!editable} confirmText={t('research.cancelAnalysisConfirm')}>{t('research.cancelAnalysis')}</CommandButton>}
    </div>
  </article>;
}

function RetryAnalysisButton({ workspaceId, jobId, disabled }: { workspaceId: string; jobId: string; disabled: boolean }) {
  const { t } = useWorkspaceLocale();
  const [attemptKey] = useState(() => crypto.randomUUID());
  return <CommandButton command={{ type: 'RETRY_ANALYSIS', workspaceId, jobId, attemptKey }} disabled={disabled}>{t('research.retryAnalysis')}</CommandButton>;
}
