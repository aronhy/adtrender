import { describe, expect, it } from 'vitest';
import { snapshotMediaSourceUrls, lookupArchivedMedia } from './media-archive';

describe('immutable media lookup input', () => {
  it('uses saved canonical and raw media URLs without guessing from current ad fields', () => {
    expect(snapshotMediaSourceUrls({ media: [{ url: 'https://cdn.example.test/a?sig=old' }], raw: {
      media: [{ url: 'https://cdn.example.test/b' }, { sourceUrl: 'https://cdn.example.test/a?sig=old' }],
      sourceUrl: 'https://ads.example.test/not-a-media-asset', headline: 'Historical text',
    } })).toEqual(['https://cdn.example.test/a?sig=old', 'https://cdn.example.test/b']);
  });
  it('rejects malformed media and never treats page links or current hashes as historical evidence', () => {
    expect(snapshotMediaSourceUrls({ sourceUrl: 'https://page.example.test', raw: { media: [null, {},
      { url: 'javascript:alert(1)' }, { url: 'https://user:password@example.test/file' }, { sha256: 'a'.repeat(64) },
    ] } })).toEqual([]);
  });
  it('keeps exact URL identity including source query signatures', () => {
    expect(snapshotMediaSourceUrls({ raw: { media: [{ url: 'https://cdn.example.test/a?sig=one' },
      { url: 'https://cdn.example.test/a?sig=two' }] } })).toHaveLength(2);
  });
  it('bounds historical media addresses before any database read', async () => {
    const snapshot = { media: Array.from({ length: 101 }, (_, i) => ({ url: `https://cdn.example.test/${i}` })) };
    await expect(lookupArchivedMedia({} as any, { adId: 'ad', snapshot })).rejects.toThrow('HISTORY_MEDIA_LIMIT');
  });
  it('returns no capture when the saved snapshot contains no media URL', async () => {
    expect(await lookupArchivedMedia({} as any, { adId: 'ad', snapshot: { raw: { body: 'Saved text' } } })).toEqual([]);
  });
  it.each(['', undefined, 'a'.repeat(201)])('rejects an invalid ad identity %s', async adId => {
    await expect(lookupArchivedMedia({} as any, { adId: adId as string, snapshot: {} })).rejects.toThrow('INVALID_HISTORY_AD_ID');
  });
});
