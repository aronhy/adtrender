import type { MediaView } from './types';

export function advertiserName(value: string | null | undefined) {
  return typeof value === 'string' ? value.trim() || null : null;
}

export function mediaUrl(value: string | null | undefined) {
  try { const url = new URL(value ?? ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}

export function mediaUrlExpired(media: MediaView | undefined, now = Date.now()) {
  if (!media?.displayUrlExpiresAt) return false;
  const expiresAt = new Date(media.displayUrlExpiresAt).valueOf();
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

/** Prefer an actual image over a video; keep the original unavailable state if nothing can be displayed. */
export function previewMedia(media: MediaView[] = [], now = Date.now()) {
  const ready = media.filter(item => ['READY', 'CACHED'].includes(item.status) && mediaUrl(item.displayUrl));
  for (const candidates of [ready.filter(item => !mediaUrlExpired(item, now)), ready]) {
    const candidate = candidates.find(item => item.type.toUpperCase() === 'IMAGE') ?? candidates.find(item => item.type.toUpperCase() === 'VIDEO');
    if (candidate) return candidate;
  }
  return media[0];
}

/** A media fragment requests the first frame without changing the signed query or starting playback. */
export function videoPreviewUrl(value: string) {
  const url = new URL(value); url.hash = 't=0.1'; return url.href;
}

/** Coalesce concurrent explicit refreshes. Only user actions call this gate. */
export function createMediaRefreshGate(refresh: () => Promise<boolean>) {
  let pending: Promise<boolean> | null = null;
  return (): Promise<boolean> => {
    if (pending) return pending;
    const request = Promise.resolve().then(refresh).catch(() => false).finally(() => { if (pending === request) pending = null; });
    pending = request;
    return request;
  };
}
