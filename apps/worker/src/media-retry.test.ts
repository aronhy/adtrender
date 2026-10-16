import { describe, expect, it } from 'vitest';
import { nextMediaDownloadAttempt } from './media-retry';

describe('bounded media transfer retry schedule', () => {
  const now = new Date('2026-10-08T00:00:00Z');
  it.each(['MEDIA_NETWORK_FAILED', 'MEDIA_TIMEOUT', 'MEDIA_HTTP_FAILED', 'MEDIA_STORAGE_FAILED'])('retries transient %s with durable exponential delays', code => {
    expect([1, 2, 3, 4].map(attempt => nextMediaDownloadAttempt(code, attempt, now)?.valueOf() - now.valueOf()))
      .toEqual([30_000, 120_000, 480_000, 1_800_000]);
    expect(nextMediaDownloadAttempt(code, 5, now)).toBeNull();
  });
  it.each(['MEDIA_URL_REJECTED', 'MEDIA_ADDRESS_REJECTED', 'MEDIA_REDIRECT_LIMIT', 'MEDIA_TOO_LARGE', 'MEDIA_TYPE_REJECTED', 'MEDIA_LENGTH_MISMATCH', 'MEDIA_OPTIONS_INVALID', 'MEDIA_EXPIRED', 'MEDIA_SOURCE_UNSUPPORTED', 'UNKNOWN_ERROR'])('never automatically repeats terminal %s', code => {
    expect(nextMediaDownloadAttempt(code, 1, now)).toBeNull();
  });
  it.each([0, -1, 6, NaN, 1.5])('refuses an invalid attempt count %s', attempt => {
    expect(nextMediaDownloadAttempt('MEDIA_HTTP_FAILED', attempt, now)).toBeNull();
  });
});
