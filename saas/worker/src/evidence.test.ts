import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { evidenceWriter } from './evidence';
const directories: string[] = [];
const input = () => ({ runId: randomUUID(), query: { keyword: 'coffee', country: 'US', status: 'all' as const, mediaType: 'all' as const, limit: 3 }, snapshot: { url: 'https://www.facebook.com/ads/library/', httpStatus: 403, html: '<body>Private raw source evidence</body>', observedAt: new Date().toISOString(), parserVersion: 'test' } });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'saas-evidence-test-')); directories.push(path); return path; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('private source evidence boundary', () => {
  it('does not enable capture without a fully configured evidence destination', () => {
    expect(evidenceWriter({})).toBeUndefined();
    expect(() => evidenceWriter({ S3_BUCKET: 'test-bucket' })).toThrow('EVIDENCE_STORAGE_CONFIG_INVALID');
  });
  it('rejects insecure storage endpoints and development storage in production', () => {
    expect(() => evidenceWriter({ S3_BUCKET: 'test-bucket', S3_REGION: 'us-east-1', S3_ENDPOINT: 'http://example.test' })).toThrow('EVIDENCE_STORAGE_CONFIG_INVALID');
    expect(() => evidenceWriter({ S3_BUCKET: 'test-bucket', S3_REGION: 'us-east-1', S3_ENDPOINT: 'https://user:password@example.test' })).toThrow('EVIDENCE_STORAGE_CONFIG_INVALID');
    expect(() => evidenceWriter({ NODE_ENV: 'production', DEV_EVIDENCE_DIR: '/private/tmp/test' })).toThrow();
    expect(() => evidenceWriter({ DEV_EVIDENCE_DIR: './public' })).toThrow();
  });
  it('writes restricted local evidence with a hash and no HTML in the returned reference', async () => {
    const path = await directory(); const snapshot = input(); const result = await evidenceWriter({ DEV_EVIDENCE_DIR: path })!(snapshot);
    const target = join(path, result.evidenceReference.replace('local-private:', ''));
    const bytes = await readFile(target);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.evidenceSha256); expect(JSON.parse(bytes.toString()).snapshot.html).toBe(snapshot.snapshot.html);
    expect((await stat(target)).mode & 0o777).toBe(0o600); expect((await stat(join(path, 'private-source-evidence', snapshot.runId))).mode & 0o777).toBe(0o700);
    expect(result).not.toHaveProperty('snapshot'); expect(result).not.toHaveProperty('html');
  });
  it('rejects path traversal before writing outside the evidence namespace', async () => {
    const path = await directory(); const writer = evidenceWriter({ DEV_EVIDENCE_DIR: path })!;
    await expect(writer({ ...input(), runId: '../escape' })).rejects.toThrow('EVIDENCE_RUN_ID_INVALID');
    expect(await readdir(path)).toEqual([]);
  });
  it('uses private cache policy and exposes only a stable failure code from an object provider', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
    const writer = evidenceWriter({ S3_BUCKET: 'test-bucket', S3_REGION: 'us-east-1' })!;
    const result = await writer(input()); const command = send.mock.calls[0][0] as any;
    expect(command.input.Key).toMatch(/^private-source-evidence\//); expect(command.input.CacheControl).toBe('private, no-store'); expect(command.input).not.toHaveProperty('ACL'); expect(result.evidenceReference).toMatch(/^s3:private-source-evidence\//);
    send.mockRejectedValueOnce(new Error('PROVIDER_SECRET') as never);
    await expect(writer(input())).rejects.toThrow('EVIDENCE_STORAGE_FAILED');
  });
});
