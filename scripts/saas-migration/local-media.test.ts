import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { createInventoryManifest } from './inventory';
import { buildPublicImportPlan, importPublicPlan, isImportedMediaStateValid, runImportPublicCli } from './import-public';
import { prepareLocalMediaManifest, runLocalMediaCli, uploadLocalMedia, validateMediaDestination, type LocalMediaProvider } from './local-media';

const when = '2026-10-05T00:00:00.000Z';
const targetUrl = process.env.SAAS_MEDIA_TEST_DATABASE_URL || 'postgresql://saas_local@127.0.0.1:55438/saas_media_test';
const destination = { endpoint: 'http://127.0.0.1:13991', bucket: 'saas-migration-test-media' };
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(extra: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'saas-local-media-test-'))); roots.push(root);
  const allowedRoot = join(root, 'media'); await mkdir(allowedRoot); await writeFile(join(allowedRoot, 'image.jpg'), bytes);
  const sourceAdId = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const input = JSON.stringify([{ libraryId: sourceAdId, sourceUrl: `https://www.facebook.com/ads/library/?id=${sourceAdId}`, mediaType: 'image', mediaUrl: '/local-media/image.jpg', sourceMediaUrl: 'https://scontent.fbcdn.net/image.jpg?token=DO_NOT_REPORT', ...extra }]);
  const inventory = createInventoryManifest(input, { generatedAt: when, ownership: 'public', localMediaFiles: ['image.jpg'] });
  const options = { allowedRoot, confirmInventoryHash: inventory.manifestHash, targetUrl, destination, generatedAt: when };
  return { root, allowedRoot, input, inventory, options, sourceAdId };
}
class FakeProvider implements LocalMediaProvider {
  objects = new Map<string, { bytes: Buffer; mimeType: string }>(); puts = 0; gets = 0; failRead = false; race = false;
  async get({ key }: Parameters<LocalMediaProvider['get']>[0]) {
    this.gets++; if (this.failRead) throw new Error('SECRET_PROVIDER_TOKEN');
    return this.objects.get(key) ?? null;
  }
  async putIfAbsent({ key, bytes: body, mimeType }: Parameters<LocalMediaProvider['putIfAbsent']>[0]) {
    this.puts++;
    if (this.objects.has(key)) return 'EXISTS' as const;
    this.objects.set(key, { bytes: Buffer.from(body), mimeType });
    return this.race ? 'EXISTS' as const : 'CREATED' as const;
  }
}

describe('approved local public media manifest', () => {
  it('never accepts a database media identity that could escape the generated object key namespace', () => {
    const expected = { sourceUrl: 'legacy-local-sha256:fixture', sha256: hash(bytes), sizeBytes: bytes.length };
    const stored = { ...expected, sizeBytes: BigInt(bytes.length), id: '../private/other', status: 'PENDING', storageKey: null, mimeType: null, downloadedAt: null, expiresAt: null, errorCode: 'LEGACY_MEDIA_NOT_UPLOADED' };
    expect(isImportedMediaStateValid(stored, expected)).toBe(false);
  });
  it('binds bytes, MIME, public mapping and isolated destinations with a stable canonical hash', async () => {
    const f = await fixture(); const manifest = await prepareLocalMediaManifest(f.input, f.inventory, f.options);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0]).toMatchObject({ relativePath: 'image.jpg', sha256: hash(bytes), sizeBytes: bytes.length, mimeType: 'image/jpeg' });
    expect(manifest.files[0].targets).toHaveLength(1);
    expect(JSON.stringify(manifest)).not.toContain('DO_NOT_REPORT');
    const later = await prepareLocalMediaManifest(f.input, f.inventory, { ...f.options, generatedAt: '2026-10-06T00:00:00Z' });
    expect(later.manifestHash).toBe(manifest.manifestHash);
    const plan = buildPublicImportPlan(f.input, f.inventory, { confirmManifestHash: f.inventory.manifestHash, localMediaFiles: ['image.jpg'], mediaEvidence: { 'image.jpg': { sha256: hash(bytes), sizeBytes: bytes.length } } });
    expect(manifest.publicPlanHash).toBe(plan.planHash);
  });
  it.each([{ workspaceId: 'PRIVATE' }, { ownership: 'unknown' }, { sourceUrl: 'https://example.test' }])('rejects a batch containing private or unknown records before reading files', async extra => {
    const f = await fixture(extra); await rm(join(f.allowedRoot, 'image.jpg'));
    await expect(prepareLocalMediaManifest(f.input, f.inventory, f.options)).rejects.toThrow('MEDIA_PUBLIC_BATCH_REQUIRED');
  });
  it('requires the exact public inventory confirmation and rejects modified input', async () => {
    const f = await fixture();
    await expect(prepareLocalMediaManifest(f.input, f.inventory, { ...f.options, confirmInventoryHash: '0'.repeat(64) })).rejects.toThrow('IMPORT_MANIFEST_NOT_CONFIRMED');
    await expect(prepareLocalMediaManifest(f.input + '\n', f.inventory, f.options)).rejects.toThrow('IMPORT_MANIFEST_MISMATCH');
  });
  it('refuses a remote-only variant that would erase a local file identity during media deduplication', async () => {
    const f = await fixture(); const rows = JSON.parse(f.input);
    rows.push({ ...rows[0], mediaUrl: rows[0].sourceMediaUrl, variantIndex: 1 });
    const input = JSON.stringify(rows); const inventory = createInventoryManifest(input, { generatedAt: when, ownership: 'public', localMediaFiles: ['image.jpg'] });
    await expect(prepareLocalMediaManifest(input, inventory, { ...f.options, confirmInventoryHash: inventory.manifestHash })).rejects.toThrow('MEDIA_AMBIGUOUS_MAPPING');
  });
  it('CLI prepare is offline, leaves input intact and refuses to overwrite its manifest', async () => {
    const f = await fixture(); const inputPath = join(f.root, 'input.json'), inventoryPath = join(f.root, 'inventory.json'), output = join(f.root, 'approved-media.json');
    await writeFile(inputPath, f.input); await writeFile(inventoryPath, JSON.stringify(f.inventory));
    const args = ['--mode', 'prepare', '--input', inputPath, '--inventory', inventoryPath, '--confirm-inventory', f.inventory.manifestHash, '--media-root', f.allowedRoot,
      '--target-url', targetUrl, '--endpoint', destination.endpoint, '--bucket', destination.bucket, '--output', output];
    await runLocalMediaCli(args); const manifest = await readFile(output, 'utf8'); expect(JSON.parse(manifest).files).toHaveLength(1);
    await expect(runLocalMediaCli(args)).rejects.toThrow();
    expect(await readFile(inputPath, 'utf8')).toBe(f.input); expect(await readFile(output, 'utf8')).toBe(manifest); expect(await readFile(join(f.allowedRoot, 'image.jpg'))).toEqual(bytes);
  });
  it('the public import CLI confirms approval before accessing the local root and rejects a symlink root', async () => {
    const f = await fixture(); const inputPath = join(f.root, 'input.json'), inventoryPath = join(f.root, 'inventory.json'), link = join(f.root, 'linked');
    await writeFile(inputPath, f.input); await writeFile(inventoryPath, JSON.stringify(f.inventory)); await symlink(f.allowedRoot, link);
    const args = ['--input', inputPath, '--manifest', inventoryPath, '--confirm-manifest', f.inventory.manifestHash, '--target-url', targetUrl, '--output', join(f.root, 'import.json'), '--media-root', link];
    await expect(runImportPublicCli(args)).rejects.toThrow('MEDIA_UNSAFE_ROOT');
    args[5] = '0'.repeat(64); args[11] = join(f.root, 'does-not-exist');
    await expect(runImportPublicCli(args)).rejects.toThrow('IMPORT_MANIFEST_NOT_CONFIRMED');
  });
  it('rejects symlink files, a symlink root and symlink ancestors', async () => {
    const f = await fixture(); const outside = join(f.root, 'outside.jpg'); await writeFile(outside, bytes);
    await rm(join(f.allowedRoot, 'image.jpg')); await symlink(outside, join(f.allowedRoot, 'image.jpg'));
    await expect(prepareLocalMediaManifest(f.input, f.inventory, f.options)).rejects.toThrow('MEDIA_UNSAFE_FILE');
    await rm(join(f.allowedRoot, 'image.jpg')); await writeFile(join(f.allowedRoot, 'image.jpg'), bytes);
    await symlink(f.allowedRoot, join(f.root, 'linked'));
    await expect(prepareLocalMediaManifest(f.input, f.inventory, { ...f.options, allowedRoot: join(f.root, 'linked') })).rejects.toThrow('MEDIA_UNSAFE_ROOT');
    await symlink(f.root, join(f.root, 'ancestor'));
    await expect(prepareLocalMediaManifest(f.input, f.inventory, { ...f.options, allowedRoot: join(f.root, 'ancestor', 'media') })).rejects.toThrow('MEDIA_UNSAFE_ROOT');
  });
  it('rejects missing files, oversized media, MIME spoofing and unsupported files', async () => {
    const f = await fixture();
    await expect(prepareLocalMediaManifest(f.input, f.inventory, { ...f.options, maxBytes: 4 })).rejects.toThrow('MEDIA_SIZE_LIMIT');
    await writeFile(join(f.allowedRoot, 'image.jpg'), '<script>bad</script>');
    await expect(prepareLocalMediaManifest(f.input, f.inventory, f.options)).rejects.toThrow('MEDIA_INVALID_SIGNATURE');
    await rm(join(f.allowedRoot, 'image.jpg'));
    await expect(prepareLocalMediaManifest(f.input, f.inventory, f.options)).rejects.toThrow('MEDIA_UNSAFE_FILE');
    const unsupported = await fixture({ mediaUrl: '/local-media/image.svg' }); await writeFile(join(unsupported.allowedRoot, 'image.svg'), '<svg/>');
    const inventory = createInventoryManifest(unsupported.input, { generatedAt: when, ownership: 'public', localMediaFiles: ['image.svg'] });
    await expect(prepareLocalMediaManifest(unsupported.input, inventory, { ...unsupported.options, confirmInventoryHash: inventory.manifestHash })).rejects.toThrow('MEDIA_UNSUPPORTED_TYPE');
  });
  it.each([
    { endpoint: 'https://s3.amazonaws.com', bucket: 'saas-migration-test-media' },
    { endpoint: 'http://localhost:13991', bucket: 'saas-migration-test-media' },
    { endpoint: 'http://127.0.0.1:13991/path', bucket: 'saas-migration-test-media' },
    { endpoint: 'http://u:p@127.0.0.1:13991', bucket: 'saas-migration-test-media' },
    { endpoint: 'http://127.0.0.1:13991', bucket: 'production' },
  ])('rejects nonisolated object destinations', value => expect(() => validateMediaDestination(value)).toThrow('MEDIA_UNSAFE_DESTINATION'));
});

describe.skipIf(!process.env.SAAS_MEDIA_TEST_DATABASE_URL)('local media PostgreSQL and injected object storage', () => {
  async function imported() {
    const f = await fixture(); const manifest = await prepareLocalMediaManifest(f.input, f.inventory, f.options);
    const require = createRequire(new URL('../../saas/app/package.json', import.meta.url)); const { PrismaClient } = require('@prisma/client');
    const db = new PrismaClient({ datasources: { db: { url: targetUrl } } });
    const plan = buildPublicImportPlan(f.input, f.inventory, { confirmManifestHash: f.inventory.manifestHash, localMediaFiles: ['image.jpg'], mediaEvidence: { 'image.jpg': { sha256: hash(bytes), sizeBytes: bytes.length } } });
    await importPublicPlan(db, plan, targetUrl);
    const media = await db.mediaObject.findFirstOrThrow({ where: { ad: { sourceAdId: f.sourceAdId } } });
    const provider = new FakeProvider();
    const upload = (overrides: Record<string, unknown> = {}) => uploadLocalMedia(db, f.input, f.inventory, manifest, { ...f.options, confirmManifestHash: manifest.manifestHash, provider, ...overrides });
    return { ...f, db, plan, media, manifest, provider, upload };
  }
  it('uploads conditionally, reads bytes back before READY, then re-verifies without writes and permits public replay', async () => {
    const f = await imported();
    try {
      const report = await f.upload(); expect(report).toMatchObject({ ready: 1, failed: 0, uploaded: 1, reverified: 0 });
      const first = await f.db.mediaObject.findUniqueOrThrow({ where: { id: f.media.id } });
      expect(first).toMatchObject({ status: 'READY', storageKey: `public-media/${f.media.id}`, mimeType: 'image/jpeg', sha256: hash(bytes), sizeBytes: BigInt(bytes.length), errorCode: null });
      expect(f.provider.gets).toBe(2); expect(f.provider.puts).toBe(1);
      expect(await f.upload()).toMatchObject({ ready: 1, reverified: 1, uploaded: 0 });
      expect(f.provider.puts).toBe(1);
      expect((await f.db.mediaObject.findUniqueOrThrow({ where: { id: f.media.id } })).updatedAt).toEqual(first.updatedAt);
      expect((await importPublicPlan(f.db, f.plan, targetUrl)).status).toBe('REPLAY_VERIFIED_NO_WRITE');
      expect(JSON.stringify(report)).not.toMatch(/image\.jpg|DO_NOT_REPORT|public-media\/|127\.0\.0\.1/);
    } finally { await f.db.$disconnect(); }
  });
  it('keeps failed readback retryable, redacts provider failures and never marks unverified bytes READY', async () => {
    const f = await imported();
    try {
      const put = f.provider.putIfAbsent.bind(f.provider);
      f.provider.putIfAbsent = async args => { const result = await put(args); f.provider.failRead = true; return result; };
      const failed = await f.upload(); expect(failed).toMatchObject({ ready: 0, failed: 1 });
      expect(JSON.stringify(failed)).not.toContain('SECRET_PROVIDER_TOKEN');
      expect(await f.db.mediaObject.findUniqueOrThrow({ where: { id: f.media.id } })).toMatchObject({ status: 'FAILED', storageKey: null, errorCode: 'LEGACY_MEDIA_PROVIDER_FAILED' });
      expect((await importPublicPlan(f.db, f.plan, targetUrl)).status).toBe('REPLAY_VERIFIED_NO_WRITE');
      f.provider.failRead = false;
      expect(await f.upload()).toMatchObject({ ready: 1, failed: 0, uploaded: 0 }); expect(f.provider.puts).toBe(1);
    } finally { await f.db.$disconnect(); }
  });
  it('does not overwrite an existing different object and revokes READY when readback is corrupted', async () => {
    const f = await imported(); const key = `public-media/${f.media.id}`;
    try {
      f.provider.objects.set(key, { bytes: Buffer.from('wrong'), mimeType: 'image/jpeg' });
      expect(await f.upload()).toMatchObject({ failed: 1, ready: 0 }); expect(f.provider.puts).toBe(0);
      f.provider.objects.set(key, { bytes, mimeType: 'image/jpeg' }); expect(await f.upload()).toMatchObject({ ready: 1 });
      f.provider.objects.set(key, { bytes: Buffer.from('wrong'), mimeType: 'image/jpeg' });
      expect(await f.upload()).toMatchObject({ failed: 1, ready: 0 });
      expect(await f.db.mediaObject.findUniqueOrThrow({ where: { id: f.media.id } })).toMatchObject({ status: 'FAILED', errorCode: 'LEGACY_MEDIA_OBJECT_MISMATCH' });
      expect(f.provider.puts).toBe(0);
    } finally { await f.db.$disconnect(); }
  });
  it('handles a conditional PUT race by GET verification and rejects DB evidence drift on reimport', async () => {
    const f = await imported(); f.provider.race = true;
    try {
      expect(await f.upload()).toMatchObject({ ready: 1, failed: 0 });
      await f.db.mediaObject.update({ where: { id: f.media.id }, data: { sizeBytes: BigInt(999) } });
      await expect(importPublicPlan(f.db, f.plan, targetUrl)).rejects.toThrow('IMPORT_RECONCILIATION_FAILED');
    } finally { await f.db.$disconnect(); }
  });
  it('rejects drifted READY MIME rather than falsely declaring its metadata verified', async () => {
    const f = await imported();
    try {
      await f.upload(); await f.db.mediaObject.update({ where: { id: f.media.id }, data: { mimeType: 'image/png' } });
      const calls = f.provider.gets + f.provider.puts;
      await expect(f.upload()).rejects.toThrow('IMPORT_RECONCILIATION_FAILED');
      expect(f.provider.gets + f.provider.puts).toBe(calls);
    } finally { await f.db.$disconnect(); }
  });
  it('rejects approval, changed files, destination drift and private DB before object requests', async () => {
    const f = await imported();
    try {
      await expect(f.upload({ confirmManifestHash: '0'.repeat(64) })).rejects.toThrow('MEDIA_MANIFEST_NOT_CONFIRMED');
      await expect(f.upload({ destination: { ...destination, bucket: 'saas-migration-test-other' } })).rejects.toThrow('MEDIA_MANIFEST_MISMATCH');
      const changed = { ...f.manifest, files: [{ ...f.manifest.files[0], relativePath: '../outside.jpg' }] };
      await expect(uploadLocalMedia(f.db, f.input, f.inventory, changed, { ...f.options, confirmManifestHash: changed.manifestHash, provider: f.provider })).rejects.toThrow('MEDIA_MANIFEST_MISMATCH');
      await writeFile(join(f.allowedRoot, 'image.jpg'), Buffer.concat([bytes, Buffer.from('changed')]));
      await expect(f.upload()).rejects.toThrow('MEDIA_MANIFEST_MISMATCH'); await writeFile(join(f.allowedRoot, 'image.jpg'), bytes);
      const user = await f.db.user.create({ data: { email: `${randomUUID()}@example.test` } });
      try { await expect(f.upload()).rejects.toThrow('IMPORT_DATABASE_NOT_ISOLATED'); }
      finally { await f.db.user.delete({ where: { id: user.id } }); }
      expect(f.provider.gets + f.provider.puts).toBe(0);
    } finally { await f.db.$disconnect(); }
  });
  it('requires a completed public import and never creates one as a side effect of media upload', async () => {
    const f = await imported(); const other = await fixture();
    try {
      const manifest = await prepareLocalMediaManifest(other.input, other.inventory, other.options);
      await expect(uploadLocalMedia(f.db, other.input, other.inventory, manifest, { ...other.options, confirmManifestHash: manifest.manifestHash, provider: f.provider })).rejects.toThrow('IMPORT_APPROVED_RUN_REQUIRED');
      expect(await f.db.ad.count({ where: { sourceAdId: other.sourceAdId } })).toBe(0); expect(f.provider.gets + f.provider.puts).toBe(0);
    } finally { await f.db.$disconnect(); }
  });
});
