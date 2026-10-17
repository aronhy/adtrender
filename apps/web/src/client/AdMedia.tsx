import { MediaPlaceholder } from './ui/MediaPlaceholder';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ImageIcon, Play, Video } from 'lucide-react';
import { useWorkspaceLocale } from './workspace-i18n/locale';
import type { DateValue, MediaView } from './types';
import { mediaUrl, mediaUrlExpired, videoPreviewUrl } from './ad-media';

export function MediaPlayer({ media, compact = false, onPlay, revision = 0, onUnavailable }: { media?: MediaView; compact?: boolean; onPlay?: () => void; revision?: number; onUnavailable?: (media: MediaView) => void }) {
  const { t } = useWorkspaceLocale();
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const imageElement = useRef<HTMLImageElement | null>(null);
  const videoElement = useRef<HTMLVideoElement | null>(null);
  const attemptedSource = useRef('');
  const retained = useRef<{ assetKey: string; src: string; expiresAt?: DateValue } | null>(null);
  const providedSrc = mediaUrl(media?.displayUrl);
  const url = providedSrc ? new URL(providedSrc) : null;
  // Signed query parameters can change while the actual stored asset stays the same.
  const assetKey = `${media?.id ?? ''}:${media?.type ?? ''}:${url?.origin ?? ''}${url?.pathname ?? ''}`;
  const retainedSource = loaded && !failed && retained.current?.assetKey === assetKey ? retained.current : null;
  const src = retainedSource?.src ?? providedSrc;
  const expired = mediaUrlExpired(retainedSource ? { ...media!, displayUrlExpiresAt: retainedSource.expiresAt } : media);
  const ready = Boolean(media && ['READY', 'CACHED'].includes(media.status));
  const sourceKey = `${media?.id ?? ''}:${src ?? ''}`;
  const markLoaded = () => {
    if (src) retained.current = { assetKey, src, expiresAt: retainedSource?.expiresAt ?? media?.displayUrlExpiresAt };
    setLoaded(true);
  };
  const fail = useCallback(() => {
    retained.current = null;
    setLoaded(false);
    // A user action may already have supplied another usable URL. Try the
    // existing response without requesting a new signature.
    if (src !== providedSrc && providedSrc && !mediaUrlExpired(media)) { setFailed(false); return; }
    setFailed(true);
    const attemptKey = `${sourceKey}:${revision}`;
    if (attemptedSource.current === attemptKey) return;
    attemptedSource.current = attemptKey;
    // Expired credentials do not mean the stored asset is broken.
    if (media && !expired) onUnavailable?.(media);
  }, [sourceKey, revision, src, providedSrc, expired, media, onUnavailable]);
  useEffect(() => {
    setFailed(false);
    // Cached files can emit load before this effect runs. Do not reset an
    // already decoded image or ready video back to the loading placeholder.
    const decoded = ready && Boolean(retained.current?.assetKey === assetKey || (imageElement.current?.complete && imageElement.current.naturalWidth > 0) || (videoElement.current && videoElement.current.readyState >= (compact ? 2 : 1)));
    if (decoded) markLoaded();
    else { retained.current = null; setLoaded(false); }
    setPosterFailed(false);
    attemptedSource.current = '';
  }, [sourceKey, revision, media?.posterUrl, compact, ready]);
  useEffect(() => {
    if (compact || loaded || failed || !src || expired || !ready) return;
    const timer = window.setTimeout(fail, 20_000);
    return () => window.clearTimeout(timer);
  }, [compact, loaded, failed, src, expired, ready, fail]);
  const video = media?.type.toUpperCase() === 'VIDEO';
  if (!media || !src || !ready || failed || (expired && !loaded)) return <div className="media-unavailable">
    {video ? <Video size={27} aria-hidden="true" /> : <ImageIcon size={27} aria-hidden="true" />}<span>{t(failed ? 'ads.mediaFailed' : media?.status === 'PENDING' ? 'ads.mediaPending' : 'ads.mediaUnavailable')}</span>{!compact && <small>{t('ads.mediaHint')}</small>}
  </div>;
  const poster = !posterFailed ? mediaUrl(media.posterUrl) : undefined;
  if (compact && video) return <div className={`media-view video-preview ${loaded ? 'media-loaded' : ''}`} aria-busy={!loaded}>
    {!loaded && <MediaPlaceholder />}
    {poster ? <img ref={imageElement} key={`${sourceKey}:poster`} src={poster} alt={t('ads.videoPoster')} loading="lazy" onLoad={markLoaded} onError={() => { retained.current = null; setPosterFailed(true); setLoaded(false); }} />
      : <video ref={videoElement} key={`${sourceKey}:video`} src={videoPreviewUrl(src)} muted playsInline preload="metadata" tabIndex={-1} aria-hidden="true" onLoadedData={markLoaded} onSeeked={markLoaded} onError={fail} />}
    <span><Play size={25} aria-hidden="true" />{t('ads.videoCreative')}</span>
  </div>;
  return <div className={`media-view ${loaded ? 'media-loaded' : ''}`} aria-busy={!loaded}>
    {!loaded && <MediaPlaceholder />}
    {video ? <video ref={videoElement} key={sourceKey} src={src} poster={poster} aria-label={t('ads.videoCreative')} controls preload="metadata" playsInline onLoadedMetadata={markLoaded} onError={fail} onPlay={onPlay} /> : <img ref={imageElement} key={sourceKey} src={src} alt={t('ads.creativeAlt')} loading={compact ? 'lazy' : 'eager'} onLoad={markLoaded} onError={fail} />}
  </div>;
}
