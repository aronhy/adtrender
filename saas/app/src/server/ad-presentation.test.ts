import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaObject } from '@prisma/client';

const { signGet } = vi.hoisted(() => ({ signGet: vi.fn() }));
vi.mock('../media/storage', () => ({ S3Storage: class { signGet = signGet; } }));
import { adView, advertiserName, mediaView } from './views';

afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

describe('public ad presentation', () => {
  it('keeps missing advertiser names absent and preserves real source names', async () => {
    expect(advertiserName({})).toBeNull();
    expect(advertiserName({ advertiser: { name: ' ' }, fieldProvenance: { advertiserName: { value: 'Source name' } } })).toBe('Source name');
    expect(advertiserName({ advertiser: { name: 'Brand' } })).toBe('Brand');
    expect(advertiserName({ fieldProvenance: { advertiserName: { value: { invalid: true } } } })).toBeNull();
    expect((await adView({ id: 'ad', media: [] })).advertiserName).toBeNull();
  });

  it.each([
    ['page-url-sha256:' + 'a'.repeat(64), {}, null],
    ['ad-local:123456789', {}, null],
    ['123456789', { identifier: { kind: 'observed-page-url-hash' } }, null],
    ['123456789', { identifier: { kind: 'source-ad-local' } }, null],
    ['AR123456789', {}, 'AR123456789'],
    ['123456789', { identifier: { kind: 'source-advertiser-id' } }, '123456789'],
    ['987654321', {}, '987654321'],
  ])('returns only source advertiser IDs: %s', async (sourceAdvertiserId, fieldProvenance, expected) => {
    const view = await adView({ id: 'ad', media: [], advertiser: { sourceAdvertiserId, fieldProvenance } });
    expect(view.advertiserId).toBe(expected);
  });

  it('returns a bounded public media expiry without exposing storage internals', async () => {
    for (const key of ['S3_BUCKET', 'S3_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) vi.stubEnv(key, 'fixture');
    const expiresAt = new Date(Date.now() + 300_000);
    signGet.mockResolvedValue({ url: 'https://media.example.test/signed', expiresAt });
    const view = await mediaView({ id: 'media', type: 'IMAGE', status: 'READY', storageKey: 'private-key', sourceUrl: 'https://source.example.test/image', errorCode: null, expiresAt: null } as MediaObject);
    expect(signGet).toHaveBeenCalledWith('private-key', { objectExpiresAt: null, expiresInSeconds: 300 });
    expect(view).toEqual({ id: 'media', type: 'IMAGE', status: 'READY', displayUrl: 'https://media.example.test/signed', displayUrlExpiresAt: expiresAt, errorCode: null });
    expect(view).not.toHaveProperty('storageKey');
    expect(view).not.toHaveProperty('sourceUrl');
  });

  it('does not sign unavailable or expired media', async () => {
    const media = { id: 'media', type: 'IMAGE', status: 'UNAVAILABLE', storageKey: null, errorCode: 'PLATFORM_MEDIA_ADAPTER_PENDING', expiresAt: null } as MediaObject;
    expect(await mediaView(media)).toMatchObject({ status: 'UNAVAILABLE', displayUrl: null, displayUrlExpiresAt: null });
    expect(await mediaView({ ...media, status: 'READY', storageKey: 'key', expiresAt: new Date(0) })).toMatchObject({ status: 'EXPIRED', displayUrl: null });
    expect(signGet).not.toHaveBeenCalled();
  });
});
