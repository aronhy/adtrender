import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { WorkerTickOptions } from '../../collector/src/worker';

export function evidenceWriter(env: NodeJS.ProcessEnv = process.env): WorkerTickOptions['persistEvidence'] {
  const bucket = env.S3_BUCKET;
  const local = env.DEV_EVIDENCE_DIR;
  if (local && (env.NODE_ENV === 'production' || !isAbsolute(local))) throw new Error('DEV_EVIDENCE_DIR is restricted to an absolute development path');
  if (!bucket && !local) return undefined;
  if (bucket && (!env.S3_REGION?.trim() || /[\s/]/.test(bucket))) throw new Error('EVIDENCE_STORAGE_CONFIG_INVALID');
  if (env.S3_ENDPOINT) {
    try {
      const endpoint = new URL(env.S3_ENDPOINT);
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
    } catch { throw new Error('EVIDENCE_STORAGE_CONFIG_INVALID'); }
  }
  const client = bucket ? new S3Client({ region: env.S3_REGION, endpoint: env.S3_ENDPOINT || undefined, forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true', maxAttempts: 2, requestHandler: { requestTimeout: 10000, connectionTimeout: 5000 } }) : undefined;
  return async input => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.runId)) throw new Error('EVIDENCE_RUN_ID_INVALID');
    const bytes = Buffer.from(JSON.stringify(input));
    if (bytes.length > 20 * 1024 * 1024) throw new Error('EVIDENCE_TOO_LARGE');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = `private-source-evidence/${input.runId}/${randomUUID()}.json`;
    try {
      if (client) await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: 'application/json', CacheControl: 'private, no-store', ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64') }));
      else {
        const directory = resolve(local!, 'private-source-evidence', input.runId);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(resolve(directory, key.split('/').at(-1)!), bytes, { mode: 0o600, flag: 'wx' });
      }
    } catch { throw new Error('EVIDENCE_STORAGE_FAILED'); }
    // This reference is internal metadata; no public API signs this namespace.
    return { evidenceReference: `${client ? 's3' : 'local-private'}:${key}`, evidenceSha256: sha256 };
  };
}
