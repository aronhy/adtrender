import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mediaWorkerTick } from './media';
import { expireStoredFiles } from './retention';

const require = createRequire(new URL('../../app/package.json', import.meta.url));
const testUrl = process.env.SAAS_TEST_DATABASE_URL;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const sha256 = createHash('sha256').update(png).digest('hex');
const download = async () => ({ ok: true as const, bytes: png, mimeType: 'image/png' as const, sizeBytes: png.length, sha256 });
const object = () => ({ storageKey: `public-media/${randomUUID()}`, mimeType: 'image/png' as const, sizeBytes: BigInt(png.length), sha256 });
let db: any, source: any;
async function fixture() {
  const ad = await db.ad.create({ data: { dataSourceId: source.id, sourceAdId: randomUUID(), sourceUrl: 'https://www.facebook.com/ads/library/' } });
  return db.mediaObject.create({ data: { adId: ad.id, sourceUrl: `https://scontent.fbcdn.net/${randomUUID()}.png`, type: 'IMAGE' } });
}

describe.skipIf(!testUrl)('PostgreSQL media worker transfer boundary', () => {
  beforeAll(async () => {
    const { PrismaClient } = require('@prisma/client'); db = new PrismaClient({ datasources: { db: { url: testUrl } } });
    source = await db.dataSource.upsert({ where: { key: 'meta_ad_library' }, create: { key: 'meta_ad_library', name: 'Isolated media test', status: 'ACTIVE', adapterVersion: 'test' }, update: {} });
  });
  afterAll(async () => { await db?.$disconnect(); });
  it('refuses work without storage configuration and leaves the row pending', async () => {
    const media = await fixture(); const fetch = vi.fn(download);
    expect(await mediaWorkerTick(db, undefined, fetch, { mediaId: media.id })).toMatchObject({ status: 'CONFIGURATION_REQUIRED' });
    expect(fetch).not.toHaveBeenCalled(); expect((await db.mediaObject.findUnique({ where: { id: media.id } })).status).toBe('PENDING');
  });
  it('honors shutdown before claim without querying or downloading', async () => {
    const controller = new AbortController(); controller.abort();
    const storage = { put: vi.fn(async () => object()), delete: vi.fn(async () => {}) };
    const forbiddenDb = { $transaction: () => { throw new Error('must not claim after shutdown'); } } as any;
    expect(await mediaWorkerTick(forbiddenDb, storage, download, { signal: controller.signal })).toMatchObject({ status: 'CANCELED' });
    expect(storage.put).not.toHaveBeenCalled();
  });
  it('claims one media row once across overlapping worker transactions', async () => {
    const media = await fixture(); let unblock!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
    const fetch = vi.fn(async () => { entered(); await gate; return download(); });
    const storage = { put: vi.fn(async () => object()), delete: vi.fn(async () => {}) };
    const first = mediaWorkerTick(db, storage, fetch, { mediaId: media.id });
    await started;
    try { expect(await mediaWorkerTick(db, storage, fetch, { mediaId: media.id })).toEqual({ status: 'IDLE' }); }
    finally { unblock(); }
    expect(await first).toMatchObject({ status: 'READY', mediaId: media.id });
    expect(storage.put).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
    expect(await db.mediaObject.findUnique({ where: { id: media.id } })).toMatchObject({ status: 'READY', sha256, mimeType: 'image/png' });
  });
  it('persists upload failure without leaking provider details or retrying forever', async () => {
    const media = await fixture(); const storage = { put: vi.fn(async () => { throw new Error('PROVIDER_SECRET'); }), delete: vi.fn(async () => {}) };
    expect(await mediaWorkerTick(db, storage, download, { mediaId: media.id })).toMatchObject({ status: 'FAILED', errorCode: 'MEDIA_STORAGE_FAILED' });
    expect(await db.mediaObject.findUnique({ where: { id: media.id } })).toMatchObject({ status: 'FAILED', errorCode: 'MEDIA_STORAGE_FAILED', storageKey: null });
    expect(await mediaWorkerTick(db, storage, download, { mediaId: media.id })).toEqual({ status: 'IDLE' }); expect(storage.put).toHaveBeenCalledTimes(1);
  });
  it('records source download failure and never uploads unverified bytes', async () => {
    const media = await fixture(); const storage = { put: vi.fn(async () => object()), delete: vi.fn(async () => {}) };
    expect(await mediaWorkerTick(db, storage, async () => ({ ok: false, errorCode: 'MEDIA_TYPE_REJECTED' }), { mediaId: media.id })).toMatchObject({ status: 'FAILED', errorCode: 'MEDIA_TYPE_REJECTED' });
    expect(storage.put).not.toHaveBeenCalled();
  });
  it('automatically resumes a legacy transient failure without operator requeueing', async () => {
    const media = await platformFixture('pinterest_ads_repository', 'https://i.pinimg.com/474x/recover.jpg', 'IMAGE', 'FAILED', 'MEDIA_HTTP_FAILED');
    const storage = { put: vi.fn(async () => object()), delete: vi.fn(async () => {}) };
    expect(await mediaWorkerTick(db, storage, download, { mediaId: media.id })).toMatchObject({ status: 'READY', mediaId: media.id });
    expect(await db.mediaObject.findUnique({ where: { id: media.id } })).toMatchObject({ status: 'READY', errorCode: null });
  });
  it('allows one policy upgrade attempt for a previously rejected supported URL', async () => {
    const media = await platformFixture('pinterest_ads_repository', 'https://i.pinimg.com/474x/recover-policy.jpg', 'IMAGE', 'FAILED', 'MEDIA_URL_REJECTED');
    const fetch = vi.fn(download), storage = { put: vi.fn(async () => object()), delete: vi.fn(async () => {}) };
    expect(await mediaWorkerTick(db, storage, fetch, { mediaId: media.id })).toMatchObject({ status: 'READY', mediaId: media.id });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  async function retryState(id: string) {
    return (await db.$queryRaw`SELECT "downloadAttempts", "lastDownloadAttemptAt", "nextDownloadAttemptAt" FROM "MediaObject" WHERE id=${id}`)[0];
  }
  it('persists backoff, never retries before it is due, and stops after five failed transfers', async () => {
    const media = await fixture(), fetch = vi.fn(async () => ({ ok: false as const, errorCode: 'MEDIA_TIMEOUT' as const }));
    const storage = { put: vi.fn(async () => object()), delete: vi.fn(async () => {}) };
    for (let attempt = 1; attempt <= 5; attempt++) {
      const started = new Date();
      expect(await mediaWorkerTick(db, storage, fetch, { mediaId: media.id })).toMatchObject({ status: 'FAILED', errorCode: 'MEDIA_TIMEOUT' });
      const state = await retryState(media.id);
      expect(state.downloadAttempts).toBe(attempt);
      expect(state.lastDownloadAttemptAt.valueOf()).toBeGreaterThanOrEqual(started.valueOf());
      expect(await mediaWorkerTick(db, storage, fetch, { mediaId: media.id })).toEqual({ status: 'IDLE' });
      if (attempt < 5) {
        expect(state.nextDownloadAttemptAt.valueOf()).toBeGreaterThan(started.valueOf());
        await db.$executeRaw`UPDATE "MediaObject" SET "nextDownloadAttemptAt"=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=${media.id}`;
      } else expect(state.nextDownloadAttemptAt).toBeNull();
    }
    expect(fetch).toHaveBeenCalledTimes(5); expect(storage.put).not.toHaveBeenCalled();
  });
  it('makes a policy upgrade rejection terminal so supported initial URLs cannot loop on rejected redirects', async () => {
    const media = await platformFixture('pinterest_ads_repository', 'https://i.pinimg.com/474x/redirect.jpg', 'IMAGE', 'FAILED', 'MEDIA_URL_REJECTED');
    const fetch = vi.fn(async () => ({ ok: false as const, errorCode: 'MEDIA_URL_REJECTED' as const }));
    const storage = { put: vi.fn(async () => object()), delete: vi.fn(async () => {}) };
    expect(await mediaWorkerTick(db, storage, fetch, { mediaId: media.id })).toMatchObject({ status: 'FAILED', errorCode: 'MEDIA_URL_REJECTED' });
    expect(await retryState(media.id)).toMatchObject({ downloadAttempts: 1, nextDownloadAttemptAt: null });
    expect(await mediaWorkerTick(db, storage, fetch, { mediaId: media.id })).toEqual({ status: 'IDLE' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('recovers an old size rejection under the new limit once, then keeps any new size rejection terminal', async () => {
    const storage = { put: vi.fn(async () => object()), delete: vi.fn(async () => {}) };
    const recovered = await platformFixture('meta_ad_library', 'https://scontent.fbcdn.net/previously-large.mp4', 'VIDEO', 'FAILED', 'MEDIA_TOO_LARGE');
    expect(await mediaWorkerTick(db, storage, download, { mediaId: recovered.id })).toMatchObject({ status: 'READY' });
    const stillLarge = await platformFixture('meta_ad_library', 'https://scontent.fbcdn.net/still-large.mp4', 'VIDEO', 'FAILED', 'MEDIA_TOO_LARGE');
    const fetch = vi.fn(async () => ({ ok: false as const, errorCode: 'MEDIA_TOO_LARGE' as const }));
    expect(await mediaWorkerTick(db, storage, fetch, { mediaId: stillLarge.id })).toMatchObject({ status: 'FAILED', errorCode: 'MEDIA_TOO_LARGE' });
    expect(await retryState(stillLarge.id)).toMatchObject({ downloadAttempts: 1, nextDownloadAttemptAt: null });
    expect(await mediaWorkerTick(db, storage, fetch, { mediaId: stillLarge.id })).toEqual({ status: 'IDLE' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps retry timing across a fresh database client and clears an earlier error after recovery', async () => {
    const media = await fixture(), storage = { put: vi.fn(async () => object()), delete: vi.fn(async () => {}) };
    expect(await mediaWorkerTick(db, storage, async () => ({ ok: false, errorCode: 'MEDIA_HTTP_FAILED' }), { mediaId: media.id })).toMatchObject({ status: 'FAILED' });
    const { PrismaClient } = require('@prisma/client');
    const restarted = new PrismaClient({ datasources: { db: { url: testUrl } } });
    try {
      expect(await mediaWorkerTick(restarted, storage, download, { mediaId: media.id })).toEqual({ status: 'IDLE' });
      await db.$executeRaw`UPDATE "MediaObject" SET "nextDownloadAttemptAt"=CURRENT_TIMESTAMP-INTERVAL '1 second' WHERE id=${media.id}`;
      expect(await mediaWorkerTick(restarted, storage, download, { mediaId: media.id })).toMatchObject({ status: 'READY' });
      expect(await retryState(media.id)).toMatchObject({ downloadAttempts: 2, nextDownloadAttemptAt: null });
      expect(await db.mediaObject.findUnique({ where: { id: media.id } })).toMatchObject({ errorCode: null });
      expect(storage.put).toHaveBeenCalledTimes(1);
    } finally { await restarted.$disconnect(); }
  });
  it('claims a due retry once across simultaneous media workers', async () => {
    const media = await platformFixture('pinterest_ads_repository', 'https://i.pinimg.com/474x/parallel-retry.jpg', 'IMAGE', 'FAILED', 'MEDIA_NETWORK_FAILED');
    let unblock!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const fetch = vi.fn(async () => { entered(); await gate; return download(); });
    const storage = { put: vi.fn(async () => object()), delete: vi.fn(async () => {}) };
    const first = mediaWorkerTick(db, storage, fetch, { mediaId: media.id });
    await started;
    try { expect(await mediaWorkerTick(db, storage, fetch, { mediaId: media.id })).toEqual({ status: 'IDLE' }); }
    finally { unblock(); }
    expect(await first).toMatchObject({ status: 'READY' });
    expect(await retryState(media.id)).toMatchObject({ downloadAttempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1); expect(storage.put).toHaveBeenCalledTimes(1);
  });
  it('rechecks a supported Meta host after an old redirect rejection without changing its source URL', async () => {
    const url = 'https://scontent.fbcdn.net/previous-redirect.png';
    const media = await platformFixture('meta_ad_library', url, 'IMAGE', 'FAILED', 'MEDIA_URL_REJECTED');
    const storage = { put: vi.fn(async () => object()), delete: vi.fn(async () => {}) };
    expect(await mediaWorkerTick(db, storage, download, { mediaId: media.id })).toMatchObject({ status: 'READY' });
    expect(await db.mediaObject.findUnique({ where: { id: media.id } })).toMatchObject({ sourceUrl: url });
  });
  it('never retries unsafe legacy URLs or terminal content and private-address failures', async () => {
    const storage = { put: vi.fn(async () => object()), delete: vi.fn(async () => {}) }, fetch = vi.fn(download);
    for (const [url, code] of [
      ['https://i.pinimg.com.evil.test/474x/a.jpg', 'MEDIA_URL_REJECTED'],
      ['https://i.pinimg.com:443/474x/a.jpg', 'MEDIA_URL_REJECTED'],
      ['https://i.pinimg.com/474x/a.jpg', 'MEDIA_ADDRESS_REJECTED'],
      ['https://i.pinimg.com/474x/a.jpg', 'MEDIA_TYPE_REJECTED'],
      ['https://i.pinimg.com/474x/a.jpg', 'MEDIA_TOO_LARGE'],
    ]) {
      const media = await platformFixture('pinterest_ads_repository', url, 'IMAGE', 'FAILED', code);
      if (code === 'MEDIA_TOO_LARGE') await db.$executeRaw`UPDATE "MediaObject" SET "downloadAttempts"=1 WHERE id=${media.id}`;
      expect(await mediaWorkerTick(db, storage, fetch, { mediaId: media.id })).toEqual({ status: 'IDLE' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('clears retry scheduling on success and keeps downloaded media independent of signed source URL expiry', async () => {
    const url = 'https://scontent.fbcdn.net/creative.png?expires=1700000000', media = await fixture();
    await db.mediaObject.update({ where: { id: media.id }, data: { sourceUrl: url } });
    const storage = { put: vi.fn(async () => object()), delete: vi.fn(async () => {}) };
    expect(await mediaWorkerTick(db, storage, download, { mediaId: media.id })).toMatchObject({ status: 'READY' });
    expect(await retryState(media.id)).toMatchObject({ downloadAttempts: 1, nextDownloadAttemptAt: null });
    expect(await db.mediaObject.findUnique({ where: { id: media.id } })).toMatchObject({ sourceUrl: url, expiresAt: null, errorCode: null });
    expect(await expireStoredFiles(db, storage, { scope: { privateFileIds: [], mediaObjectIds: [media.id] } })).toMatchObject({ deleted: 0, failed: 0 });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(await mediaWorkerTick(db, storage, download, { mediaId: media.id })).toEqual({ status: 'IDLE' });
    expect(storage.put).toHaveBeenCalledTimes(1);
  });
  it('releases a canceled download without uploading or changing source facts', async () => {
    const media = await fixture(); const controller = new AbortController(); const storage = { put: vi.fn(async () => object()), delete: vi.fn(async () => {}) };
    expect(await mediaWorkerTick(db, storage, async () => { controller.abort(); return download(); }, { mediaId: media.id, signal: controller.signal })).toMatchObject({ status: 'CANCELED' });
    expect(storage.put).not.toHaveBeenCalled(); expect((await db.mediaObject.findUnique({ where: { id: media.id } })).status).toBe('PENDING');
    expect(await retryState(media.id)).toMatchObject({ downloadAttempts: 0, lastDownloadAttemptAt: null, nextDownloadAttemptAt: null });
  });
  it('cleans up a completed upload if shutdown arrives before metadata commit', async () => {
    const media = await fixture(); const controller = new AbortController(); const uploaded = object();
    const storage = { put: vi.fn(async () => { controller.abort(); return uploaded; }), delete: vi.fn(async () => {}) };
    expect(await mediaWorkerTick(db, storage, download, { mediaId: media.id, signal: controller.signal })).toMatchObject({ status: 'CANCELED' });
    expect(storage.delete).toHaveBeenCalledWith(uploaded.storageKey); expect((await db.mediaObject.findUnique({ where: { id: media.id } })).status).toBe('PENDING');
    expect(await retryState(media.id)).toMatchObject({ downloadAttempts: 0, lastDownloadAttemptAt: null, nextDownloadAttemptAt: null });
  });
  it('retains a failed cancellation cleanup key so retention retries without exposing a ready object',async()=>{
    const media=await fixture(),controller=new AbortController(),uploaded=object();let failDelete=true;const objects=new Set<string>();
    const storage={put:vi.fn(async()=>{objects.add(uploaded.storageKey);controller.abort();return uploaded;}),delete:vi.fn(async(key:string)=>{if(failDelete)throw new Error('STORAGE_UNAVAILABLE');objects.delete(key);})};
    expect(await mediaWorkerTick(db,storage,download,{mediaId:media.id,signal:controller.signal})).toMatchObject({status:'FAILED',errorCode:'MEDIA_CANCELED_CLEANUP_FAILED'});
    expect(await db.mediaObject.findUnique({where:{id:media.id}})).toMatchObject({status:'EXPIRED',storageKey:uploaded.storageKey,errorCode:'MEDIA_CANCELED_CLEANUP_FAILED'});
    failDelete=false;
    expect(await expireStoredFiles(db,storage,{scope:{privateFileIds:[],mediaObjectIds:[media.id]}})).toMatchObject({deleted:1,failed:0});
    expect(objects.size).toBe(0);expect(await db.mediaObject.findUnique({where:{id:media.id}})).toMatchObject({status:'DELETED'});
  });
  it('preserves an uploaded object after an unconfirmed metadata failure for later owner reconciliation', async () => {
    const media = await fixture(); const uploaded = object(); const storage = { put: vi.fn(async () => uploaded), delete: vi.fn(async () => {}) };
    const failedDatabase = { $transaction: (callback: any, options: any) => db.$transaction((tx: any) => callback(new Proxy(tx, {
      get: (target, key) => key === 'mediaObject' ? { update: () => { throw new Error('PRIVATE_DATABASE_DETAILS'); } } : target[key],
    })), options) } as any;
    expect(await mediaWorkerTick(failedDatabase, storage, download, { mediaId: media.id })).toEqual({ status: 'FAILED', errorCode: 'MEDIA_DATABASE_FAILED' });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(await db.mediaObject.findUnique({ where: { id: media.id } })).toMatchObject({ status: 'PENDING', storageKey: null });
  });
  it('keeps a committed ready object when the database commit acknowledgement is lost', async () => {
    const media = await fixture(), uploaded = object(), storage = { put: vi.fn(async () => uploaded), delete: vi.fn(async () => {}) };
    let acknowledgementLost = false;
    const uncertainDb = { $transaction: async (callback: any, options: any) => {
      const result = await db.$transaction(callback, options);
      if (!acknowledgementLost) { acknowledgementLost = true; throw new Error('SYNTHETIC_COMMIT_ACKNOWLEDGEMENT_LOST'); }
      return result;
    } } as any;
    expect(await mediaWorkerTick(uncertainDb, storage, download, { mediaId: media.id })).toMatchObject({ status: 'READY', mediaId: media.id });
    expect(await db.mediaObject.findUnique({ where: { id: media.id } })).toMatchObject({ status: 'READY', storageKey: uploaded.storageKey });
    expect(storage.delete).not.toHaveBeenCalled();
  });
  it('never deletes an uploaded object if the database is unreadable after a commit failure', async () => {
    const media = await fixture(), uploaded = object(), storage = { put: vi.fn(async () => uploaded), delete: vi.fn(async () => {}) };
    let first = true;
    const unavailableDb = { $transaction: (callback: any, options: any) => {
      if (!first) throw new Error('SYNTHETIC_DATABASE_UNAVAILABLE');
      first = false;
      return db.$transaction((tx: any) => callback(new Proxy(tx, { get: (target, key) => key === 'mediaObject'
        ? { update: () => { throw new Error('SYNTHETIC_METADATA_FAILURE'); } } : target[key] })), options);
    } } as any;
    expect(await mediaWorkerTick(unavailableDb, storage, download, { mediaId: media.id })).toMatchObject({ status: 'FAILED', errorCode: 'MEDIA_DATABASE_FAILED' });
    expect(storage.delete).not.toHaveBeenCalled();
  });
  it('waits for the prior transaction row lock before reconciling an uncertain commit', async () => {
    const media = await fixture(), uploaded = object(), storage = { put: vi.fn(async () => uploaded), delete: vi.fn(async () => {}) };
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    let first = true, priorCommit: Promise<unknown> | undefined;
    const uncertainDb = { $transaction: async (callback: any, options: any) => {
      if (!first) return db.$transaction(callback, options);
      first = false;
      priorCommit = db.$transaction(async (tx: any) => { const result = await callback(tx); entered(); await gate; return result; }, options);
      await started;
      throw new Error('SYNTHETIC_COMMIT_STILL_IN_PROGRESS');
    } } as any;
    let finished = false;
    const transfer = mediaWorkerTick(uncertainDb, storage, download, { mediaId: media.id }).then(result => { finished = true; return result; });
    await started;
    try {
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(finished).toBe(false);
      expect(storage.delete).not.toHaveBeenCalled();
    } finally { release(); await priorCommit; }
    expect(await transfer).toMatchObject({ status: 'READY', mediaId: media.id });
  });
  async function platformFixture(key: string, url: string, type = 'IMAGE', status = 'UNAVAILABLE', errorCode: string | null = 'PLATFORM_MEDIA_ADAPTER_PENDING', client = db) {
    const platform = await client.dataSource.upsert({ where: { key }, create: { key, name: 'Synthetic platform media', adapterVersion: 'test' }, update: {} });
    const ad = await client.ad.create({ data: { dataSourceId: platform.id, sourceAdId: randomUUID(), sourceUrl: 'https://example.test/synthetic-ad' } });
    return client.mediaObject.create({ data: { adId: ad.id, sourceUrl: url, type, status, errorCode } });
  }
  it('prioritizes new pending media over the historical backlog then resumes backfill', async () => {
    const rollback = new Error('rollback synthetic queue isolation');
    await expect(db.$transaction(async (tx: any) => {
      // Hide other synthetic fixtures only inside this rolled-back transaction.
      await tx.$executeRaw`UPDATE public."MediaObject" m SET status='READY' WHERE m.status IN ('PENDING','UNAVAILABLE','FAILED') AND EXISTS(SELECT 1 FROM public."ArchiveMediaCapture" a WHERE a."objectKey"=m."storageKey")`;
      await tx.$executeRaw`UPDATE public."MediaObject" m SET status='DELETED' WHERE m.status IN ('PENDING','UNAVAILABLE','FAILED') AND NOT EXISTS(SELECT 1 FROM public."ArchiveMediaCapture" a WHERE a."objectKey"=m."storageKey")`;
      await tx.$executeRaw`UPDATE public."MediaObject" m SET "lastDownloadAttemptAt"=NULL WHERE m.status NOT IN ('EXPIRED','DELETED') OR NOT EXISTS(SELECT 1 FROM public."ArchiveMediaCapture" a WHERE a."objectKey"=m."storageKey")`;
      const old = await platformFixture('pinterest_ads_repository', 'https://i.pinimg.com/474x/old.jpg', 'IMAGE', 'UNAVAILABLE', 'PLATFORM_MEDIA_ADAPTER_PENDING', tx);
      await tx.mediaObject.update({ where: { id: old.id }, data: { createdAt: new Date('2020-01-01T00:00:00Z') } });
      const fresh = await platformFixture('meta_ad_library', 'https://scontent.fbcdn.net/fresh.png', 'IMAGE', 'PENDING', null, tx);
      const scoped = { $transaction: (callback: any) => callback(tx) } as any;
      const storage = { put: async () => object(), delete: async () => {} };
      expect(await mediaWorkerTick(scoped, storage, download)).toMatchObject({ status: 'READY', mediaId: fresh.id });
      expect(await mediaWorkerTick(scoped, storage, download)).toMatchObject({ status: 'READY', mediaId: old.id });
      expect(await mediaWorkerTick(scoped, storage, download)).toEqual({ status: 'IDLE' });
      throw rollback;
    })).rejects.toBe(rollback);
  });
  it('durably gives three fresh transfers to one historical transfer and falls back when one lane is empty', async () => {
    const rollback = new Error('rollback weighted queue isolation');
    await expect(db.$transaction(async (tx: any) => {
      await tx.$executeRaw`UPDATE public."MediaObject" m SET status='READY' WHERE m.status IN ('PENDING','UNAVAILABLE','FAILED') AND EXISTS(SELECT 1 FROM public."ArchiveMediaCapture" a WHERE a."objectKey"=m."storageKey")`;
      await tx.$executeRaw`UPDATE public."MediaObject" m SET status='DELETED' WHERE NOT EXISTS(SELECT 1 FROM public."ArchiveMediaCapture" a WHERE a."objectKey"=m."storageKey")`;
      await tx.$executeRaw`UPDATE public."MediaObject" m SET "lastDownloadAttemptAt"=NULL WHERE m.status NOT IN ('EXPIRED','DELETED') OR NOT EXISTS(SELECT 1 FROM public."ArchiveMediaCapture" a WHERE a."objectKey"=m."storageKey")`;
      const old = await platformFixture('pinterest_ads_repository', 'https://i.pinimg.com/474x/weighted-old.jpg', 'IMAGE', 'UNAVAILABLE', 'PLATFORM_MEDIA_ADAPTER_PENDING', tx);
      await tx.mediaObject.update({ where: { id: old.id }, data: { createdAt: new Date('2020-01-01T00:00:00Z') } });
      const fresh = [];
      for (let i = 0; i < 4; i++) fresh.push(await platformFixture('meta_ad_library', `https://scontent.fbcdn.net/weighted-${i}.png`, 'IMAGE', 'PENDING', null, tx));
      const storage = { put: async () => object(), delete: async () => {} };
      // Recreate the facade each time: no in-process cursor may determine fairness.
      for (let i = 0; i < 3; i++) {
        const result = await mediaWorkerTick({ $transaction: (cb: any) => cb(tx) } as any, storage, download);
        expect(result.status).toBe('READY'); expect(fresh.map(m => m.id)).toContain(result.mediaId);
      }
      expect(await mediaWorkerTick({ $transaction: (cb: any) => cb(tx) } as any, storage, download)).toMatchObject({ status: 'READY', mediaId: old.id });
      expect(await mediaWorkerTick({ $transaction: (cb: any) => cb(tx) } as any, storage, download)).toMatchObject({ status: 'READY' });
      expect(await mediaWorkerTick({ $transaction: (cb: any) => cb(tx) } as any, storage, download)).toEqual({ status: 'IDLE' });
      throw rollback;
    })).rejects.toBe(rollback);
  });
  it.each([
    ['pinterest_ads_repository', 'https://i.pinimg.com/474x/35/b9/b2/35b9b254ac1604d6420df4069d3d7892.jpg', 'IMAGE'],
    ['google_ads_transparency', 'https://tpc.googlesyndication.com/archive/simgad/12345', 'IMAGE'],
    ['google_ads_transparency', 'https://i.ytimg.com/vi/abc_DEF-123/hqdefault.jpg', 'IMAGE'],
    ['google_ads_transparency', 'https://i3.ytimg.com/vi/abc_DEF-123/hqdefault.jpg', 'IMAGE'],
    ['google_ads_transparency', 'https://rr1---sn-5oxmp55u-8pxl.googlevideo.com/videoplayback?id=synthetic', 'VIDEO'],
    ['google_ads_transparency', 'https://rr2---sn-5oxmp55u-8pxl.googlevideo.com/videoplayback?id=synthetic', 'VIDEO'],
    ['google_ads_transparency', 'https://rr3---sn-5oxmp55u-8pxl.googlevideo.com/videoplayback?id=synthetic', 'VIDEO'],
    ['tiktok_commercial_library', 'https://library.tiktok.com/api/v1/cdn/123/video/Ynl0ZXM=/123abc', 'VIDEO'],
    ['snapchat_ads_gallery', 'https://cf-st.sc-cdn.net/d/123.1023', 'IMAGE'],
  ])('automatically stores eligible adapter-pending %s %s without mutating source facts', async (key, url, type) => {
    const media = await platformFixture(key, url, type);
    const mimeType = type === 'VIDEO' ? 'video/mp4' : 'image/png';
    const uploaded = { ...object(), mimeType };
    const fetch = vi.fn(async (_url, options) => { expect(options.allowedMimeTypes).toContain(mimeType); return { ...await download(), mimeType }; });
    const storage = { put: vi.fn(async () => uploaded), delete: vi.fn(async () => {}) };
    expect(await mediaWorkerTick(db, storage, fetch as any, { mediaId: media.id })).toMatchObject({ status: 'READY', mediaId: media.id });
    expect(await db.mediaObject.findUnique({ where: { id: media.id } })).toMatchObject({ status: 'READY', type, sourceUrl: url, errorCode: null, storageKey: uploaded.storageKey });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['snapchat_ads_gallery', 'https://cf-st.sc-cdn.net/avatar/user.jpg', 'IMAGE'],
    ['google_ads_transparency', 'https://yt3.ggpht.com/ytc/avatar', 'IMAGE'],
    ['google_ads_transparency', 'https://i.ytimg.com/avatars/person.jpg', 'IMAGE'],
    ['google_ads_transparency', 'https://www.youtube.com/watch?v=abc', 'VIDEO'],
    ['google_ads_transparency', 'https://rr3---sn-5oxmp55u-8pxl.googlevideo.com/avatars/person.jpg', 'VIDEO'],
    ['tiktok_commercial_library', 'https://p16-common-sign.tiktokcdn.com/tos-alisg-avt-0068/avatar.jpeg', 'IMAGE'],
    ['tiktok_commercial_library', 'https://library.tiktok.com/api/v1/cdn/123/image/Ynl0ZXM=/123abc', 'VIDEO'],
    ['pinterest_ads_repository', 'https://i.pinimg.com.evil.test/474x/a.jpg', 'IMAGE'],
    ['pinterest_ads_repository', 'https://i.pinimg.com:443/474x/a.jpg', 'IMAGE'],
    ['pinterest_ads_repository', 'https://i.pinimg.com/474x/a.jpg', 'VIDEO'],
  ])('leaves unsupported adapter-pending media untouched: %s %s', async (key, url, type) => {
    const media = await platformFixture(key, url, type); const fetch = vi.fn(download);
    const storage = { put: vi.fn(async () => object()), delete: vi.fn(async () => {}) };
    expect(await mediaWorkerTick(db, storage, fetch, { mediaId: media.id })).toEqual({ status: 'IDLE' });
    expect(await db.mediaObject.findUnique({ where: { id: media.id } })).toMatchObject({ status: 'UNAVAILABLE', errorCode: 'PLATFORM_MEDIA_ADAPTER_PENDING', storageKey: null });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not requeue different errors or stored media, and refuses unknown pending sources', async () => {
    const storage = { put: vi.fn(async () => object()), delete: vi.fn(async () => {}) }, fetch = vi.fn(download);
    for (const [status, errorCode] of [['UNAVAILABLE', 'SOURCE_REDACTED'], ['FAILED', 'MEDIA_TYPE_REJECTED'], ['READY', null]] as const) {
      const media = await platformFixture('pinterest_ads_repository', 'https://i.pinimg.com/474x/a.jpg', 'IMAGE', status, errorCode);
      expect(await mediaWorkerTick(db, storage, fetch, { mediaId: media.id })).toEqual({ status: 'IDLE' });
      expect(await db.mediaObject.findUnique({ where: { id: media.id } })).toMatchObject({ status, errorCode });
    }
    const unknown = await platformFixture(`unsupported-${randomUUID()}`, 'https://scontent.fbcdn.net/a.png', 'IMAGE', 'PENDING', null);
    expect(await mediaWorkerTick(db, storage, fetch, { mediaId: unknown.id })).toMatchObject({ status: 'FAILED', errorCode: 'MEDIA_SOURCE_UNSUPPORTED' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
