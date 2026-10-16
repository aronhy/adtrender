import type { PrismaClient } from '@prisma/client';
import { DomainError, requireWorkspaceRole } from '../team/access';
import type { S3Storage } from './storage';

export type PublicAdMediaDownloadInput = { userId: string; workspaceId: string; adId: string; mediaId: string };
const publicKey = /^public-media\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const extensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm' };
function filename(media: { id: string; mimeType: string | null; type: string }): string {
  const extension = extensions[media.mimeType?.toLowerCase() ?? ''] ?? (media.type === 'VIDEO' ? 'mp4' : media.type === 'IMAGE' ? 'jpg' : 'bin');
  // Database-owned IDs define the name. Never include source URLs, copy or a
  // browser-provided filename in a signed response header.
  const safeId = media.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
  if (!safeId) throw new DomainError(409, 'AD_MEDIA_UNAVAILABLE');
  return `creative-${safeId}.${extension}`;
}

/** Downloads the persisted public creative belonging to the requested ad.
 * Viewer authorization precedes all ad/media reads; source URLs are not a fallback. */
export async function signPublicAdMediaDownload(db: PrismaClient, input: PublicAdMediaDownloadInput, storage: Pick<S3Storage, 'signGet'> | null) {
  return db.$transaction(async tx => {
    await requireWorkspaceRole(tx, input.userId, input.workspaceId);
    const ad = await tx.ad.findUnique({ where: { id: input.adId }, select: { id: true, dataSourceId: true } });
    if (!ad) throw new DomainError(404, 'AD_NOT_FOUND');
    const media = await tx.mediaObject.findUnique({ where: { id: input.mediaId }, select: { id: true, adId: true, type: true, mimeType: true, status: true, storageKey: true, expiresAt: true, ad: { select: { id: true, dataSourceId: true } } } });
    if (!media || media.adId !== ad.id || media.ad.id !== ad.id || media.ad.dataSourceId !== ad.dataSourceId) throw new DomainError(404, 'AD_MEDIA_NOT_FOUND');
    if (media.expiresAt && (!Number.isFinite(media.expiresAt.valueOf()) || media.expiresAt <= new Date())) throw new DomainError(410, 'AD_MEDIA_EXPIRED');
    if (media.status !== 'READY' || !media.storageKey || !publicKey.test(media.storageKey)) throw new DomainError(409, 'AD_MEDIA_UNAVAILABLE');
    if (!storage) throw new DomainError(503, 'STORAGE_NOT_CONFIGURED');
    const signed = await storage.signGet(media.storageKey, { expiresInSeconds: 300, objectExpiresAt: media.expiresAt, disposition: 'attachment', filename: filename(media) });
    return { url: signed.url, expiresAt: signed.expiresAt };
  }, { isolationLevel: 'RepeatableRead' });
}
