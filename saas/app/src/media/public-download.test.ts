import { afterEach, describe, expect, it, vi } from 'vitest';
import { signPublicAdMediaDownload } from './public-download';

const mediaId = '12345678-1234-4234-8234-123456789012';
const input = { userId: 'viewer', workspaceId: 'workspace', adId: 'ad', mediaId };
function fixture() {
  let media: any = { id: mediaId, adId: 'ad', type: 'IMAGE', mimeType: 'image/jpeg', status: 'READY', storageKey: `public-media/${mediaId}`, expiresAt: null, sourceUrl: 'https://original.example/private-source', ad: { id: 'ad', dataSourceId: 'source' } };
  const tx = {
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'viewer', disabledAt: null }) },
    workspace: { findUnique: vi.fn().mockResolvedValue({ id: 'workspace', organizationId: 'organization', archivedAt: null }) },
    organizationMember: { findUnique: vi.fn().mockResolvedValue({ role: 'MEMBER', organization: { id: 'organization', status: 'ACTIVE' } }) },
    workspaceMember: { findUnique: vi.fn().mockResolvedValue({ role: 'VIEWER', organizationId: 'organization' }) },
    ad: { findUnique: vi.fn().mockResolvedValue({ id: 'ad', dataSourceId: 'source' }) },
    mediaObject: { findUnique: vi.fn(async () => media) },
  };
  const db = { $transaction: vi.fn(async (operation: any) => operation(tx)) } as any;
  const storage = { signGet: vi.fn().mockResolvedValue({ url: 'https://objects.example/download?signed=test', expiresAt: new Date(Date.now() + 300_000) }) };
  return { db, tx, storage, set: (data: any) => { media = data === null ? null : { ...media, ...data }; } };
}
afterEach(() => vi.useRealTimers());

describe('authenticated archived public creative download', () => {
  it('allows a viewer to download only persisted READY bytes with a safe attachment name', async () => {
    const { db, storage } = fixture();
    const result = await signPublicAdMediaDownload(db, input, storage);
    expect(storage.signGet).toHaveBeenCalledWith(`public-media/${mediaId}`, { expiresInSeconds: 300, objectExpiresAt: null, disposition: 'attachment', filename: `creative-${mediaId}.jpg` });
    expect(result).toEqual({ url: 'https://objects.example/download?signed=test', expiresAt: expect.any(Date) });
    expect(result).not.toHaveProperty('storageKey');
    expect(result).not.toHaveProperty('sourceUrl');
  });
  it('checks authentication and workspace access before querying the ad or media', async () => {
    const f = fixture();
    await expect(signPublicAdMediaDownload(f.db, { ...input, userId: '' }, f.storage)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    f.tx.workspaceMember.findUnique.mockResolvedValue(null);
    await expect(signPublicAdMediaDownload(f.db, input, f.storage)).rejects.toMatchObject({ code: 'WORKSPACE_FORBIDDEN' });
    expect(f.tx.ad.findUnique).not.toHaveBeenCalled();
    expect(f.tx.mediaObject.findUnique).not.toHaveBeenCalled();
    expect(f.storage.signGet).not.toHaveBeenCalled();
  });
  it('rejects an object from another ad or source', async () => {
    for (const changed of [{ adId: 'other-ad', ad: { id: 'other-ad', dataSourceId: 'source' } }, { ad: { id: 'ad', dataSourceId: 'other-source' } }]) {
      const f = fixture(); f.set(changed);
      await expect(signPublicAdMediaDownload(f.db, input, f.storage)).rejects.toMatchObject({ code: 'AD_MEDIA_NOT_FOUND' });
      expect(f.storage.signGet).not.toHaveBeenCalled();
    }
  });
  it.each(['PENDING', 'FAILED', 'UNAVAILABLE', 'EXPIRED'])('does not substitute source URLs for unavailable archived bytes: %s', async status => {
    const f = fixture(); f.set({ status });
    await expect(signPublicAdMediaDownload(f.db, input, f.storage)).rejects.toMatchObject({ code: 'AD_MEDIA_UNAVAILABLE' });
    expect(f.storage.signGet).not.toHaveBeenCalled();
  });
  it('rejects expired files, missing storage and private object keys', async () => {
    const expired = fixture(); expired.set({ expiresAt: new Date(0) });
    await expect(signPublicAdMediaDownload(expired.db, input, expired.storage)).rejects.toMatchObject({ code: 'AD_MEDIA_EXPIRED' });
    for (const storageKey of [null, `private/organization/workspace/${mediaId}`]) {
      const f = fixture(); f.set({ storageKey });
      await expect(signPublicAdMediaDownload(f.db, input, f.storage)).rejects.toMatchObject({ code: 'AD_MEDIA_UNAVAILABLE' });
      expect(f.storage.signGet).not.toHaveBeenCalled();
    }
  });
  it('reports absent object and storage configuration explicitly', async () => {
    const absent = fixture(); absent.set(null);
    await expect(signPublicAdMediaDownload(absent.db, input, absent.storage)).rejects.toMatchObject({ code: 'AD_MEDIA_NOT_FOUND' });
    const unconfigured = fixture();
    await expect(signPublicAdMediaDownload(unconfigured.db, input, null)).rejects.toMatchObject({ code: 'STORAGE_NOT_CONFIGURED' });
  });
  it('uses type-safe fallback extensions when no verified MIME is stored', async () => {
    const f = fixture(); f.set({ mimeType: null, type: 'VIDEO' });
    await signPublicAdMediaDownload(f.db, input, f.storage);
    expect(f.storage.signGet.mock.calls[0][1]).toMatchObject({ filename: `creative-${mediaId}.mp4` });
  });
});
