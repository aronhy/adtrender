import { describe, expect, it, vi } from 'vitest';
import { advertiserName, createMediaRefreshGate, mediaUrl, mediaUrlExpired, previewMedia, videoPreviewUrl } from './ad-media';
import type { MediaView } from './types';

const media = (id: string, type: string, status = 'READY', extra: Partial<MediaView> = {}): MediaView => ({ id, type, status, displayUrl: `https://media.example.test/${id}?signature=synthetic`, ...extra });

describe('actual public media DTO handling', () => {
  it('prefers a valid image after unavailable entries or videos, and uses a ready video without a poster', () => {
    const failed = media('failed', 'IMAGE', 'FAILED', { displayUrl: null });
    const video = media('video', 'VIDEO'); const image = media('image', 'IMAGE', 'CACHED');
    expect(previewMedia([failed, video, image])).toBe(image);
    expect(previewMedia([failed, video])).toBe(video);
    expect(previewMedia([failed])).toBe(failed);
    expect(previewMedia([])).toBeUndefined();
  });
  it('ignores unusable source URLs and prefers a fresh signature before an expired image', () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    const expired = media('expired', 'IMAGE', 'READY', { displayUrlExpiresAt: '2026-10-07T11:59:59Z' });
    const video = media('video', 'VIDEO', 'READY', { displayUrlExpiresAt: '2026-10-07T12:05:00Z' });
    expect(previewMedia([expired, media('insecure', 'IMAGE', 'READY', { displayUrl: 'http://media.example.test/image' }), video], now)).toBe(video);
    expect(previewMedia([expired], now)).toBe(expired); // Retains the record for an explicit manual refresh.
    expect(mediaUrlExpired(expired, now)).toBe(true);
    expect(mediaUrlExpired(video, now)).toBe(false);
    for (const url of ['javascript:alert(1)', 'data:image/png,fixture', '/relative', 'https://user:password@media.example.test/image']) expect(mediaUrl(url)).toBeUndefined();
  });
  it('adds a first-frame fragment while preserving every signed query parameter', () => {
    const original = 'https://media.example.test/video?X-Amz-Signature=synthetic&X-Amz-Expires=300';
    const preview = new URL(videoPreviewUrl(original));
    expect(preview.hash).toBe('#t=0.1'); expect(preview.search).toBe(new URL(original).search);
  });
  it('keeps missing advertiser names missing and preserves actual names', () => {
    expect(advertiserName(null)).toBeNull(); expect(advertiserName('  ')).toBeNull(); expect(advertiserName(' Original Studio ')).toBe('Original Studio');
  });
});

describe('manual media refresh', () => {
  it('coalesces simultaneous manual requests', async () => {
    let complete!: (result: boolean) => void;
    const refresh = vi.fn(() => new Promise<boolean>(resolve => { complete = resolve; }));
    const request = createMediaRefreshGate(refresh);
    const first = request(); const second = request(); expect(first).toBe(second);
    await Promise.resolve(); expect(refresh).toHaveBeenCalledTimes(1); complete(true);
    await expect(first).resolves.toBe(true); expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('permits the next user request after either failure or success', async () => {
    const refresh = vi.fn<() => Promise<boolean>>().mockRejectedValueOnce(new Error('Synthetic failure')).mockResolvedValue(true);
    const request = createMediaRefreshGate(refresh);
    await expect(request()).resolves.toBe(false);
    await expect(request()).resolves.toBe(true); await expect(request()).resolves.toBe(true); expect(refresh).toHaveBeenCalledTimes(3);
  });
});
