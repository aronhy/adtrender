import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '../../apps/web/node_modules/@prisma/client/index.js';
import { MEDIA_MAX_BYTES, matchesMediaSignature } from '../../apps/web/src/media/download';
import { createInventoryManifest } from './inventory';
import { checkedRoot, readApprovedFile } from './media-files';
import { assertPublicImportIsolation, buildPublicImportPlan, importPublicPlan, isImportedMediaStateValid, validateImportTarget } from './import-public';

type Inventory = ReturnType<typeof createInventoryManifest>;
type Destination = { endpoint: string; bucket: string };
type PrepareOptions = { allowedRoot: string; confirmInventoryHash: string; targetUrl: string; destination: Destination; generatedAt: string; maxBytes?: number };
export type LocalMediaProvider = {
  get(args: { key: string; maxBytes: number }): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  putIfAbsent(args: { key: string; bytes: Uint8Array; mimeType: string; sha256: string }): Promise<'CREATED' | 'EXISTS'>;
};
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const fixedCode = (error: unknown) => error instanceof Error && /^(MEDIA|IMPORT|LEGACY_MEDIA)_[A-Z_]+$/.test(error.message) ? error.message : 'MEDIA_FAILED';

/** No DNS, cloud endpoint, ambient credentials or production bucket fallback. */
export function validateMediaDestination(value: Destination): Destination {
  try {
    const url = new URL(value.endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || !/^saas-migration-test-[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/.test(value.bucket)) throw new Error();
    return { endpoint: url.origin, bucket: value.bucket };
  } catch { throw new Error('MEDIA_UNSAFE_DESTINATION'); }
}

async function prepare(input: string | Uint8Array, inventory: Inventory, options: PrepareOptions) {
  if (!inventory || inventory.classification !== 'public' || inventory.quarantined.count !== 0) throw new Error('MEDIA_PUBLIC_BATCH_REQUIRED');
  const target = validateImportTarget(options.targetUrl); const destination = validateMediaDestination(options.destination);
  const maxBytes = options.maxBytes ?? MEDIA_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MEDIA_MAX_BYTES) throw new Error('MEDIA_SIZE_LIMIT');
  if (!Number.isFinite(new Date(options.generatedAt).valueOf())) throw new Error('MEDIA_INVALID_TIME');
  // Validate the approved input before opening any local media. Missing files are
  // reported by readApprovedFile, so inventory existence checks use its approved count.
  const document = JSON.parse(typeof input === 'string' ? input : Buffer.from(input).toString('utf8'));
  const rows = Array.isArray(document) ? document : document.ads;
  const names: string[] = [...new Set<string>((Array.isArray(rows) ? rows : []).flatMap((row: unknown) => row && typeof row === 'object' && 'mediaUrl' in row && typeof row.mediaUrl === 'string' && row.mediaUrl.startsWith('/local-media/') ? [row.mediaUrl.slice(13)] : []))].sort();
  const preliminary = buildPublicImportPlan(input, inventory, { confirmManifestHash: options.confirmInventoryHash, localMediaFiles: inventory.localMedia.checked ? names : undefined });
  if (preliminary.quarantined.length) throw new Error('MEDIA_PUBLIC_BATCH_REQUIRED');
  await checkedRoot(options.allowedRoot);
  const evidence: Record<string, { sha256: string; sizeBytes: number }> = {};
  const files = [];
  for (const relativePath of names) {
    const data = await readApprovedFile(options.allowedRoot, relativePath, maxBytes);
    evidence[relativePath] = { sha256: data.sha256, sizeBytes: data.sizeBytes };
    files.push({ relativePath, sha256: data.sha256, sizeBytes: data.sizeBytes, mimeType: data.mimeType, targets: [] as Array<{ sourceAdId: string; sourceUrlHash: string }> });
  }
  const plan = buildPublicImportPlan(input, inventory, { confirmManifestHash: options.confirmInventoryHash, localMediaFiles: inventory.localMedia.checked ? names : undefined, mediaEvidence: evidence });
  const mappedTargets = new Map<string, string>();
  for (const file of files) for (const ad of plan.ads) for (const variant of ad.variants) {
    if (variant.media?.localReferenceHash !== digest(file.relativePath)) continue;
    const media = variant.media; const key = `${ad.sourceAdId}:${digest(media.sourceUrl)}`;
    const effective = ad.media.find(item => item.sourceUrl === media.sourceUrl);
    if (!effective || effective.localReferenceHash !== media.localReferenceHash || effective.sha256 !== file.sha256 || effective.sizeBytes !== file.sizeBytes) throw new Error('MEDIA_AMBIGUOUS_MAPPING');
    // A deduplicated database media identity cannot represent conflicting files.
    if (mappedTargets.has(key) && mappedTargets.get(key) !== file.relativePath) throw new Error('MEDIA_AMBIGUOUS_MAPPING');
    mappedTargets.set(key, file.relativePath);
    if (!file.targets.some(item => `${item.sourceAdId}:${item.sourceUrlHash}` === key)) file.targets.push({ sourceAdId: ad.sourceAdId, sourceUrlHash: digest(media.sourceUrl) });
    if ((media.type === 'IMAGE' && !file.mimeType.startsWith('image/')) || (media.type === 'VIDEO' && !file.mimeType.startsWith('video/'))) throw new Error('MEDIA_TYPE_MISMATCH');
  }
  if (files.some(file => !file.targets.length)) throw new Error('MEDIA_AMBIGUOUS_MAPPING');
  for (const file of files) file.targets.sort((a, b) => `${a.sourceAdId}:${a.sourceUrlHash}`.localeCompare(`${b.sourceAdId}:${b.sourceUrlHash}`));
  const core = { schemaVersion: 1, classification: 'public' as const, inputSha256: inventory.sha256, inventoryManifestHash: inventory.manifestHash, publicPlanHash: plan.planHash,
    target: { host: target.host, port: target.port, database: target.database }, destination, maxBytes, files };
  return { manifest: { ...core, manifestHash: digest(canonical(core)), generatedAt: options.generatedAt }, plan };
}
export async function prepareLocalMediaManifest(input: string | Uint8Array, inventory: Inventory, options: PrepareOptions) { return (await prepare(input, inventory, options)).manifest; }
export type LocalMediaManifest = Awaited<ReturnType<typeof prepareLocalMediaManifest>>;

/** Approval is explicit: this never imports a missing public-data run or creates a bucket. */
export async function uploadLocalMedia(db: PrismaClient, input: string | Uint8Array, inventory: Inventory, manifest: LocalMediaManifest, options: PrepareOptions & { confirmManifestHash: string; provider: LocalMediaProvider }) {
  if (!manifest || !/^[a-f0-9]{64}$/.test(options.confirmManifestHash) || manifest.manifestHash !== options.confirmManifestHash) throw new Error('MEDIA_MANIFEST_NOT_CONFIRMED');
  const prepared = await prepare(input, inventory, { ...options, generatedAt: manifest.generatedAt, maxBytes: manifest.maxBytes });
  if (canonical(prepared.manifest) !== canonical(manifest)) throw new Error('MEDIA_MANIFEST_MISMATCH');
  await importPublicPlan(db, prepared.plan, options.targetUrl, { verifyOnly: true });
  const results: Array<{ referenceHash: string; status: 'READY' | 'FAILED'; errorCode?: string }> = [];
  let uploaded = 0, reverified = 0;
  for (const file of manifest.files) {
    const local = await readApprovedFile(options.allowedRoot, file.relativePath, manifest.maxBytes);
    if (local.sha256 !== file.sha256 || local.sizeBytes !== file.sizeBytes || local.mimeType !== file.mimeType) throw new Error('MEDIA_MANIFEST_MISMATCH');
    for (const reference of file.targets) {
      const expected = prepared.plan.ads.find(ad => ad.sourceAdId === reference.sourceAdId)?.media.find(media => digest(media.sourceUrl) === reference.sourceUrlHash);
      if (!expected) throw new Error('MEDIA_AMBIGUOUS_MAPPING');
      const result = await db.$transaction(async tx => {
        const source = await assertPublicImportIsolation(tx, options.targetUrl);
        const run = await tx.collectionRun.findUnique({ where: { idempotencyKey: `legacy-public:${manifest.inputSha256}` } });
        if (!source || run?.dataSourceId !== source.id || run.status !== 'SUCCEEDED' || (run.coverage as Record<string, unknown>).planHash !== manifest.publicPlanHash) throw new Error('IMPORT_APPROVED_RUN_REQUIRED');
        const stored = await tx.mediaObject.findFirst({ where: { sourceUrl: expected.sourceUrl, ad: { dataSourceId: source.id, sourceAdId: reference.sourceAdId } } });
        if (!stored || !isImportedMediaStateValid(stored, expected) || (stored.status === 'READY' && stored.mimeType !== file.mimeType)) throw new Error('IMPORT_RECONCILIATION_FAILED');
        const key = `public-media/${stored.id}`; let created = false;
        try {
          const verify = (object: { bytes: Uint8Array; mimeType: string } | null) => {
            if (!object || object.bytes.byteLength !== file.sizeBytes || object.mimeType !== file.mimeType || digest(object.bytes) !== file.sha256 || !matchesMediaSignature(file.mimeType, object.bytes)) throw new Error('LEGACY_MEDIA_OBJECT_MISMATCH');
          };
          const existing = await options.provider.get({ key, maxBytes: file.sizeBytes });
          if (existing) verify(existing);
          else {
            // READY objects disappearing are made non-ready; an explicit retry can
            // restore the now FAILED record after the failure has been reported.
            if (stored.status === 'READY') throw new Error('LEGACY_MEDIA_OBJECT_MISMATCH');
            created = await options.provider.putIfAbsent({ key, bytes: local.bytes, mimeType: file.mimeType, sha256: file.sha256 }) === 'CREATED';
            verify(await options.provider.get({ key, maxBytes: file.sizeBytes }));
          }
          if (stored.status !== 'READY') await tx.mediaObject.update({ where: { id: stored.id }, data: { status: 'READY', storageKey: key, mimeType: file.mimeType, downloadedAt: new Date(), errorCode: null } });
          return { status: 'READY' as const, created, reverified: stored.status === 'READY' };
        } catch (error) {
          const errorCode = error instanceof Error && ['LEGACY_MEDIA_OBJECT_MISMATCH', 'LEGACY_MEDIA_SIZE_LIMIT'].includes(error.message) ? error.message : 'LEGACY_MEDIA_PROVIDER_FAILED';
          if (stored.status !== 'FAILED' || stored.errorCode !== errorCode) await tx.mediaObject.update({ where: { id: stored.id }, data: { status: 'FAILED', errorCode } });
          return { status: 'FAILED' as const, created, errorCode, reverified: false };
        }
      }, { timeout: 60_000, maxWait: 15_000 });
      if (result.created) uploaded++; if (result.reverified) reverified++;
      results.push({ referenceHash: digest(`${reference.sourceAdId}:${reference.sourceUrlHash}`), status: result.status, ...('errorCode' in result ? { errorCode: result.errorCode } : {}) });
    }
  }
  return { status: results.some(item => item.status === 'FAILED') ? 'INCOMPLETE' : 'VERIFIED', manifestHash: manifest.manifestHash, inputSha256: manifest.inputSha256, publicPlanHash: manifest.publicPlanHash,
    ready: results.filter(item => item.status === 'READY').length, failed: results.filter(item => item.status === 'FAILED').length, uploaded, reverified, results };
}

/** The production adapter uses the installed, locked SDK, but only against an
 * explicit loopback service and dedicated rehearsal credentials. */
export function createLocalS3Provider(destinationInput: Destination, credentials: { accessKeyId: string; secretAccessKey: string }): LocalMediaProvider & { close(): void } {
  const destination = validateMediaDestination(destinationInput);
  if (!credentials.accessKeyId || !credentials.secretAccessKey) throw new Error('MEDIA_CREDENTIALS_REQUIRED');
  const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
  const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3') as typeof import('../../apps/web/node_modules/@aws-sdk/client-s3');
  const client = new S3Client({ endpoint: destination.endpoint, region: 'us-east-1', forcePathStyle: true, credentials, maxAttempts: 1, followRegionRedirects: false });
  const errorStatus = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return {
    async get({ key, maxBytes }) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: destination.bucket, Key: key }), { abortSignal: AbortSignal.timeout(10_000) });
        const body = response.Body as AsyncIterable<Uint8Array> & { destroy?: () => void };
        try {
          if (!body || (response.ContentLength !== undefined && response.ContentLength > maxBytes)) throw new Error('LEGACY_MEDIA_SIZE_LIMIT');
          const parts: Buffer[] = []; let count = 0;
          for await (const part of body) { count += part.byteLength; if (count > maxBytes) throw new Error('LEGACY_MEDIA_SIZE_LIMIT'); parts.push(Buffer.from(part)); }
          if (response.ContentLength !== undefined && count !== response.ContentLength) throw new Error('LEGACY_MEDIA_OBJECT_MISMATCH');
          return { bytes: Buffer.concat(parts), mimeType: response.ContentType ?? '' };
        } finally { body?.destroy?.(); }
      } catch (error) { if (errorStatus(error) === 404) return null; throw error; }
    },
    async putIfAbsent({ key, bytes, mimeType, sha256 }) {
      try {
        await client.send(new PutObjectCommand({ Bucket: destination.bucket, Key: key, Body: bytes, ContentType: mimeType, ContentLength: bytes.byteLength, ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'), IfNoneMatch: '*' }), { abortSignal: AbortSignal.timeout(10_000) });
        return 'CREATED';
      } catch (error) { if ([409, 412].includes(errorStatus(error) ?? 0)) return 'EXISTS'; throw error; }
    },
    close() { client.destroy(); },
  };
}

export async function runLocalMediaCli(args: string[]) {
  const allowed = new Set(['--mode', '--input', '--inventory', '--confirm-inventory', '--media-root', '--target-url', '--endpoint', '--bucket', '--output', '--manifest', '--confirm-manifest']);
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) { if (!allowed.has(args[i]) || flags.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('MEDIA_USAGE'); flags.set(args[i], args[i + 1]); }
  for (const name of ['--mode', '--input', '--inventory', '--confirm-inventory', '--media-root', '--target-url', '--endpoint', '--bucket', '--output']) if (!flags.has(name)) throw new Error('MEDIA_USAGE');
  const mode = flags.get('--mode');
  if (!['prepare', 'upload'].includes(mode!) || (mode === 'upload' && (!flags.has('--manifest') || !flags.has('--confirm-manifest'))) || (mode === 'prepare' && (flags.has('--manifest') || flags.has('--confirm-manifest')))) throw new Error('MEDIA_USAGE');
  const input = await readFile(flags.get('--input')!); const inventory = JSON.parse(await readFile(flags.get('--inventory')!, 'utf8')) as Inventory;
  const options: PrepareOptions = { allowedRoot: flags.get('--media-root')!, confirmInventoryHash: flags.get('--confirm-inventory')!, targetUrl: flags.get('--target-url')!, destination: { endpoint: flags.get('--endpoint')!, bucket: flags.get('--bucket')! }, generatedAt: new Date().toISOString() };
  const output = await open(flags.get('--output')!, 'wx', 0o600);
  let db: PrismaClient | undefined; let provider: ReturnType<typeof createLocalS3Provider> | undefined;
  try {
    let result;
    if (mode === 'prepare') result = await prepareLocalMediaManifest(input, inventory, options);
    else {
      const manifest = JSON.parse(await readFile(flags.get('--manifest')!, 'utf8')) as LocalMediaManifest;
      const target = validateImportTarget(options.targetUrl); const url = new URL(target.url);
      if (process.env.SAAS_MIGRATION_DATABASE_PASSWORD) url.password = process.env.SAAS_MIGRATION_DATABASE_PASSWORD;
      const require = createRequire(new URL('../../apps/web/package.json', import.meta.url)); const { PrismaClient } = require('@prisma/client') as { PrismaClient: typeof import('../../apps/web/node_modules/@prisma/client/index.js').PrismaClient };
      provider = createLocalS3Provider(options.destination, { accessKeyId: process.env.SAAS_MIGRATION_S3_ACCESS_KEY_ID ?? '', secretAccessKey: process.env.SAAS_MIGRATION_S3_SECRET_ACCESS_KEY ?? '' });
      db = new PrismaClient({ datasources: { db: { url: url.href } } });
      result = await uploadLocalMedia(db, input, inventory, manifest, { ...options, confirmManifestHash: flags.get('--confirm-manifest')!, provider });
      if (result.failed) process.exitCode = 1;
    }
    await output.writeFile(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { const errorCode = fixedCode(error); await output.writeFile(`${JSON.stringify({ status: 'FAILED', errorCode })}\n`); throw new Error(errorCode); }
  finally { await db?.$disconnect(); provider?.close(); await output.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runLocalMediaCli(process.argv.slice(2)).catch(error => { process.stderr.write(`${fixedCode(error)}\n`); process.exitCode = 1; });
