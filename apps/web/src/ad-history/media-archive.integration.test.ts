import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lookupArchivedMedia } from './media-archive';

const url = process.env.SAAS_TEST_DATABASE_URL;
let db: PrismaClient, source: { id: string };
type Capture = { id: string; adId: string; mediaObjectId: string; sourceUrl: string; objectKey: string;
  sha256: string; mimeType: string; sizeBytes: bigint; downloadedAt: Date | null; recordedAt: Date; captureKind: string };
async function media(status = 'PENDING') {
  const ad = await db.ad.create({ data: { dataSourceId: source.id, sourceAdId: randomUUID(), sourceUrl: 'https://example.test/ad' } });
  return db.mediaObject.create({ data: { adId: ad.id, sourceUrl: `https://cdn.example.test/${randomUUID()}`, status } });
}
const object = (sha256 = 'a'.repeat(64)) => ({ storageKey: `public-media/${randomUUID()}`, sha256,
  mimeType: 'image/png', sizeBytes: 12n, downloadedAt: new Date('2026-10-05T03:04:05Z'), status: 'READY', type: 'IMAGE' });
async function captures(adId: string): Promise<Capture[]> {
  return db.$queryRaw`SELECT * FROM public."ArchiveMediaCapture" WHERE "adId"=${adId} ORDER BY "recordedAt", id`;
}

describe.skipIf(!url)('PostgreSQL immutable public media archive', () => {
  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url } } });
    source = await db.dataSource.create({ data: { key: `media-archive-${randomUUID()}`, name: 'Archive test', adapterVersion: 'test' } });
  });
  // Captures intentionally survive test teardown. Only the disposable DB owner
  // may discard the entire isolated database; ordinary row cleanup is forbidden.
  afterAll(async () => { await db?.$disconnect(); });

  it('captures READY atomically and deduplicates repeated updates without changing capture time', async () => {
    const row = await media(), value = object(), started = new Date();
    await db.mediaObject.update({ where: { id: row.id }, data: value });
    const first = await captures(row.adId);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ mediaObjectId: row.id, sourceUrl: row.sourceUrl, objectKey: value.storageKey,
      sha256: value.sha256, mimeType: value.mimeType, sizeBytes: 12n, downloadedAt: value.downloadedAt, captureKind: 'READY_CAPTURE' });
    expect(first[0].recordedAt.valueOf()).toBeGreaterThanOrEqual(started.valueOf() - 5);
    await db.mediaObject.update({ where: { id: row.id }, data: { status: 'READY', displayOrder: 7, observationId: null } });
    expect(await captures(row.adId)).toEqual(first);
  });
  it('captures a newly inserted READY row and keeps Ad identity attached to its evidence', async () => {
    const row = await media(), value = object();
    await db.mediaObject.create({ data: { ...value, adId: row.adId, sourceUrl: 'https://cdn.example.test/insert-ready' } });
    expect(await captures(row.adId)).toMatchObject([{ objectKey: value.storageKey, captureKind: 'READY_CAPTURE' }]);
    await expect(db.ad.delete({ where: { id: row.adId } })).rejects.toThrow();
    await db.mediaObject.deleteMany({ where: { adId: row.adId } });
    // Even after mutable media is gone, archive identity cannot be reassigned.
    await expect(db.ad.delete({ where: { id: row.adId } })).rejects.toThrow();
    await expect(db.ad.update({ where: { id: row.adId }, data: { id: randomUUID() } })).rejects.toThrow();
  });
  it('preserves two bytes versions when the same source URL is reused and the current row is deleted', async () => {
    const row = await media(), first = object(), second = object('b'.repeat(64));
    await db.mediaObject.update({ where: { id: row.id }, data: first });
    await db.mediaObject.update({ where: { id: row.id }, data: second });
    await db.mediaObject.delete({ where: { id: row.id } });
    const saved = await captures(row.adId);
    expect(saved).toHaveLength(2);
    expect(new Set(saved.map(c => `${c.sha256}:${c.objectKey}`))).toEqual(new Set([
      `${first.sha256}:${first.storageKey}`, `${second.sha256}:${second.storageKey}`,
    ]));
    expect(saved.every(c => c.sourceUrl === row.sourceUrl)).toBe(true);
  });
  it('saves the OLD READY value before a destructive metadata change', async () => {
    const row = await media(), value = object();
    // Reproduce an older READY row created outside the trigger so only OLD
    // capture can protect the previous bytes before metadata is cleared.
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe('ALTER TABLE public."MediaObject" DISABLE TRIGGER media_archive_capture');
      await tx.mediaObject.update({ where: { id: row.id }, data: value });
      await tx.$executeRawUnsafe('ALTER TABLE public."MediaObject" ENABLE TRIGGER media_archive_capture');
    });
    await db.mediaObject.update({ where: { id: row.id }, data: { status: 'PENDING', storageKey: null, sha256: null, sizeBytes: null, downloadedAt: null } });
    expect(await captures(row.adId)).toMatchObject([{ objectKey: value.storageKey, sha256: value.sha256,
      downloadedAt: value.downloadedAt, captureKind: 'READY_BEFORE_CHANGE_CAPTURE' }]);
  });
  it('rolls capture back with a failed source transaction', async () => {
    const row = await media();
    await expect(db.$transaction(async tx => {
      await tx.mediaObject.update({ where: { id: row.id }, data: object() });
      throw new Error('EXPECTED_ROLLBACK');
    })).rejects.toThrow('EXPECTED_ROLLBACK');
    expect(await captures(row.adId)).toEqual([]);
  });
  it('rejects archive UPDATE, DELETE and TRUNCATE even for the table owner', async () => {
    const row = await media(); await db.mediaObject.update({ where: { id: row.id }, data: object() });
    await expect(db.$executeRaw`UPDATE public."ArchiveMediaCapture" SET "sha256"=${'c'.repeat(64)} WHERE "adId"=${row.adId}`).rejects.toThrow('IMMUTABLE_MEDIA_CAPTURE');
    await expect(db.$executeRaw`DELETE FROM public."ArchiveMediaCapture" WHERE "adId"=${row.adId}`).rejects.toThrow('IMMUTABLE_MEDIA_CAPTURE');
    await expect(db.$executeRawUnsafe('TRUNCATE public."ArchiveMediaCapture"')).rejects.toThrow('IMMUTABLE_MEDIA_CAPTURE');
    expect(await captures(row.adId)).toHaveLength(1);
  });
  it('returns archived bytes for saved URLs with real capture times without claiming an old observation association', async () => {
    const row = await media(), other = await media(), first = object(), second = object('b'.repeat(64));
    await db.mediaObject.update({ where: { id: row.id }, data: first });
    await db.mediaObject.update({ where: { id: row.id }, data: second });
    await db.mediaObject.update({ where: { id: other.id }, data: { ...object('c'.repeat(64)), sourceUrl: row.sourceUrl } });
    const result = await lookupArchivedMedia(db, { adId: row.adId, snapshot: { raw: { media: [{ url: row.sourceUrl }], secret: 'SAVED_SECRET' } } });
    expect(result).toHaveLength(2);
    expect(new Set(result.map(c => c.objectKey))).toEqual(new Set([first.storageKey, second.storageKey]));
    expect(result.every(c => c.association === 'SOURCE_URL_MATCH' && c.recordedAt instanceof Date)).toBe(true);
    expect(JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v)).not.toMatch(/SAVED_SECRET|sourceUrl|cdn\.example\.test|bucket|https:/);
    expect(await lookupArchivedMedia(db, { adId: row.adId, snapshot: { raw: { media: [{ url: 'https://cdn.example.test/not-saved' }] } } })).toEqual([]);
  });
  it('keeps unknown download time null and never creates past daily observations', async () => {
    const row = await media();
    await db.mediaObject.update({ where: { id: row.id }, data: { ...object(), downloadedAt: null } });
    const [capture] = await captures(row.adId);
    expect(capture.downloadedAt).toBeNull();
    expect(capture.recordedAt.valueOf()).toBeGreaterThan(Date.parse('2026-10-05T00:00:00Z'));
    expect(await db.adObservation.count({ where: { adId: row.adId } })).toBe(0);
    expect(await db.adDailySnapshot.count({ where: { adId: row.adId } })).toBe(0);
  });
  it('permanently clears storage expiry for valid READY captures and rejects archived OLD or NEW key deletion states', async () => {
    const row = await media(), value = object();
    await db.mediaObject.update({ where: { id: row.id }, data: { ...value, expiresAt: new Date(Date.now() - 60000) } });
    expect(await db.mediaObject.findUnique({ where: { id: row.id } })).toMatchObject({ expiresAt: null, status: 'READY' });
    await db.mediaObject.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() + 60000) } });
    expect(await db.mediaObject.findUnique({ where: { id: row.id } })).toMatchObject({ expiresAt: null });
    for (const status of ['EXPIRED', 'DELETED']) {
      await expect(db.mediaObject.update({ where: { id: row.id }, data: { status } })).rejects.toThrow('ARCHIVED_MEDIA_PROTECTED');
      // Replacing/removing the key in the same mutation cannot hide OLD evidence.
      await expect(db.mediaObject.update({ where: { id: row.id }, data: { status, storageKey: null } })).rejects.toThrow('ARCHIVED_MEDIA_PROTECTED');
    }
    await db.mediaObject.delete({ where: { id: row.id } });
    const unrelated = await media();
    for (const status of ['EXPIRED', 'DELETED']) {
      await expect(db.mediaObject.update({ where: { id: unrelated.id }, data: { status, storageKey: value.storageKey } })).rejects.toThrow('ARCHIVED_MEDIA_PROTECTED');
    }
    const inserted = await db.mediaObject.create({ data: { ...object(), adId: unrelated.adId,
      sourceUrl: 'https://cdn.example.test/new-ready-expiry', expiresAt: new Date(Date.now() - 60000) } });
    expect(inserted).toMatchObject({ expiresAt: null, status: 'READY' });
  });
  it('protects archived bytes under the original retention worker without affecting unarchived expiry', async () => {
    const archived = await media(), ordinary = await media(), value = object(), ordinaryKey = `public-media/${randomUUID()}`;
    await db.mediaObject.update({ where: { id: archived.id }, data: { ...value, expiresAt: new Date(Date.now() - 60000) } });
    await db.mediaObject.update({ where: { id: ordinary.id }, data: { storageKey: ordinaryKey, expiresAt: new Date(Date.now() - 60000) } });
    const deleted: string[] = [];
    // The released pre-archive retention boundary: select expirable media,
    // lock it, mark EXPIRED, then call storage.delete, finally mark DELETED.
    async function oldSweep(ids: string[]) {
      const rows = await db.mediaObject.findMany({ where: { id: { in: ids }, expiresAt: { lte: new Date() },
        status: { in: ['READY', 'PENDING', 'FAILED', 'EXPIRED'] } }, select: { id: true }, take: 100 });
      for (const candidate of rows) await db.$transaction(async tx => {
        const [row] = await tx.$queryRaw<Array<{ id: string; storageKey: string | null }>>`
          SELECT id,"storageKey" FROM public."MediaObject" WHERE id=${candidate.id}
          AND "expiresAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          AND status IN ('READY','PENDING','FAILED','EXPIRED') FOR UPDATE SKIP LOCKED`;
        if (!row) return;
        await tx.mediaObject.update({ where: { id: row.id }, data: { status: 'EXPIRED' } });
        if (!row.storageKey) return;
        deleted.push(row.storageKey);
        await tx.mediaObject.update({ where: { id: row.id }, data: { status: 'DELETED', errorCode: null } });
      });
    }
    await oldSweep([archived.id, ordinary.id]);
    expect(deleted).toEqual([ordinaryKey]);
    expect(await db.mediaObject.findUnique({ where: { id: archived.id } })).toMatchObject({ status: 'READY', expiresAt: null });
    expect(await db.mediaObject.findUnique({ where: { id: ordinary.id } })).toMatchObject({ status: 'DELETED' });
    // Simulate an old worker that already claimed the row before the upgrade.
    await expect(db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM public."MediaObject" WHERE id=${archived.id} FOR UPDATE`;
      await tx.mediaObject.update({ where: { id: archived.id }, data: { status: 'EXPIRED' } });
      deleted.push(value.storageKey);
    })).rejects.toThrow('ARCHIVED_MEDIA_PROTECTED');
    expect(deleted).toEqual([ordinaryKey]);
  });
  it('backfills legacy READY rows in a fresh isolated database using only the archive migration', async () => {
    const scratchUrl = new URL(url!);
    const ownedSeedFixture = process.env.SAAS_OWNED_TEST_DATABASE_URL === url && scratchUrl.pathname.includes('_test_');
    if (scratchUrl.hostname !== '127.0.0.1' || (scratchUrl.port !== '55458' && !ownedSeedFixture)) throw new Error('LOCAL_ISOLATED_DATABASE_REQUIRED');
    const database = `archive_migration_${randomUUID().replaceAll('-', '')}`, adId = randomUUID();
    let scratch: PrismaClient | undefined;
    await db.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
    try {
      scratchUrl.pathname = `/${database}`;
      scratch = new PrismaClient({ datasources: { db: { url: scratchUrl.toString() } } });
      // Minimal existing source tables, then exactly the shipped new migration.
      await scratch.$executeRawUnsafe('CREATE TABLE public."Ad" (id TEXT PRIMARY KEY)');
      await scratch.$executeRawUnsafe(`CREATE TABLE public."MediaObject" (id TEXT PRIMARY KEY,"adId" TEXT NOT NULL,"sourceUrl" TEXT NOT NULL,"storageKey" TEXT,sha256 TEXT,type TEXT NOT NULL,status TEXT NOT NULL,"mimeType" TEXT,"sizeBytes" BIGINT,"downloadedAt" TIMESTAMP(3),"expiresAt" TIMESTAMP(3),"sourceExpiresAt" TIMESTAMP(3))`);
      await scratch.$executeRaw`INSERT INTO public."Ad" (id) VALUES (${adId})`;
      await scratch.$executeRaw`INSERT INTO public."MediaObject" (id,"adId","sourceUrl","storageKey",sha256,type,status,"mimeType","sizeBytes","downloadedAt","expiresAt","sourceExpiresAt")
        VALUES (${randomUUID()},${adId},'https://cdn.example.test/legacy',${`public-media/${randomUUID()}`},${'d'.repeat(64)},'IMAGE','READY','image/png',12,TIMESTAMP '2026-10-01 01:02:03',TIMESTAMP '2026-10-07 01:02:03',TIMESTAMP '2026-10-07 04:05:06')`;
      const started = new Date();
      const result = spawnSync('npm', ['--prefix', fileURLToPath(new URL('../..', import.meta.url)), 'exec', '--',
        'prisma', 'db', 'execute', '--file', fileURLToPath(new URL('../../migrations/20261008170000_ad_media_archive/migration.sql', import.meta.url)),
        '--schema', fileURLToPath(new URL('../../schema.prisma', import.meta.url))],
      { env: { ...process.env, DATABASE_URL: scratchUrl.toString() }, encoding: 'utf8' });
      // Provider output is intentionally not included in assertions/logs.
      expect(result.status, 'Archive migration must run successfully in the isolated fixture').toBe(0);
      const [capture] = await scratch.$queryRaw<Capture[]>`SELECT * FROM public."ArchiveMediaCapture" WHERE "adId"=${adId}`;
      expect(capture).toMatchObject({ captureKind: 'LEGACY_READY_CAPTURE', downloadedAt: new Date('2026-10-01T01:02:03Z') });
      expect(capture.recordedAt.valueOf()).toBeGreaterThanOrEqual(started.valueOf() - 5);
      expect(capture.recordedAt.valueOf()).toBeLessThanOrEqual(Date.now() + 5);
      const [stored] = await scratch.$queryRaw<Array<{ expiresAt: Date | null; sourceExpiresAt: Date }>>`
        SELECT "expiresAt","sourceExpiresAt" FROM public."MediaObject" WHERE "adId"=${adId}`;
      expect(stored).toEqual({ expiresAt: null, sourceExpiresAt: new Date('2026-10-07T04:05:06Z') });
      const [history] = await scratch.$queryRaw<Array<{ observations: string | null; days: string | null }>>`
        SELECT to_regclass('public."AdObservation"')::text AS observations,to_regclass('public."AdDailySnapshot"')::text AS days`;
      expect(history).toEqual({ observations: null, days: null });
    } finally {
      await scratch?.$disconnect();
      await db.$executeRawUnsafe(`DROP DATABASE "${database}" WITH (FORCE)`);
    }
  });
  it('uses a fixed-search-path non-login INSERT-only trigger identity and gives ingestion no archive access', async () => {
    const [role] = await db.$queryRaw<Array<{ rolcanlogin: boolean; rolsuper: boolean; rolcreaterole: boolean; insert: boolean; select: boolean; update: boolean; delete: boolean }>>`
      SELECT rolcanlogin, rolsuper, rolcreaterole,
        has_table_privilege(rolname, 'public."ArchiveMediaCapture"', 'INSERT') AS insert,
        has_table_privilege(rolname, 'public."ArchiveMediaCapture"', 'SELECT') AS select,
        has_table_privilege(rolname, 'public."ArchiveMediaCapture"', 'UPDATE') AS update,
        has_table_privilege(rolname, 'public."ArchiveMediaCapture"', 'DELETE') AS delete
      FROM pg_roles WHERE rolname='saas_media_archive_capture'`;
    expect(role).toEqual({ rolcanlogin: false, rolsuper: false, rolcreaterole: false, insert: true, select: false, update: false, delete: false });
    const [fn] = await db.$queryRaw<Array<{ prosecdef: boolean; proconfig: string[]; owner: string }>>`
      SELECT p.prosecdef,p.proconfig,r.rolname AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
      WHERE n.nspname='public' AND p.proname='saas_capture_ad_media'`;
    expect(fn).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'], owner: 'saas_media_archive_capture' });
    const [guardRole] = await db.$queryRaw<Array<{ rolcanlogin: boolean; rolsuper: boolean; select: boolean; insert: boolean; update: boolean; delete: boolean }>>`
      SELECT rolcanlogin,rolsuper,
        has_table_privilege(rolname,'public."ArchiveMediaCapture"','SELECT') AS select,
        has_table_privilege(rolname,'public."ArchiveMediaCapture"','INSERT') AS insert,
        has_table_privilege(rolname,'public."ArchiveMediaCapture"','UPDATE') AS update,
        has_table_privilege(rolname,'public."ArchiveMediaCapture"','DELETE') AS delete
      FROM pg_roles WHERE rolname='saas_media_archive_guard'`;
    expect(guardRole).toEqual({ rolcanlogin: false, rolsuper: false, select: true, insert: false, update: false, delete: false });
    const [guardFn] = await db.$queryRaw<Array<{ prosecdef: boolean; proconfig: string[]; owner: string }>>`
      SELECT p.prosecdef,p.proconfig,r.rolname AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
      WHERE n.nspname='public' AND p.proname='saas_guard_archived_media'`;
    expect(guardFn).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'], owner: 'saas_media_archive_guard' });
    const runtimeRole = `archive_ingest_${randomUUID().replaceAll('-', '')}`;
    try {
      await db.$executeRawUnsafe(`CREATE ROLE "${runtimeRole}" NOLOGIN`);
      await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
      await db.$executeRawUnsafe(`GRANT SELECT,INSERT,UPDATE ON public."MediaObject" TO "${runtimeRole}"`);
      const row = await media();
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE "${runtimeRole}"`);
        await tx.mediaObject.update({ where: { id: row.id }, data: { ...object(), expiresAt: new Date(Date.now() - 60000) } });
      });
      expect(await captures(row.adId)).toHaveLength(1);
      expect(await db.mediaObject.findUnique({ where: { id: row.id } })).toMatchObject({ expiresAt: null, status: 'READY' });
      for (const sql of ['SELECT * FROM public."ArchiveMediaCapture"', 'DELETE FROM public."ArchiveMediaCapture"',
        `INSERT INTO public."ArchiveMediaCapture" ("adId") VALUES ('denied')`, 'UPDATE public."ArchiveMediaCapture" SET "captureKind"=\'forged\'',
        'SELECT * FROM public."PrivateFile"', 'SELECT public.saas_capture_ad_media()', 'SELECT public.saas_guard_archived_media()']) {
        await expect(db.$transaction(async tx => { await tx.$executeRawUnsafe(`SET LOCAL ROLE "${runtimeRole}"`); await tx.$queryRawUnsafe(sql); })).rejects.toThrow('permission denied');
      }
    } finally {
      await db.$executeRawUnsafe(`DROP OWNED BY "${runtimeRole}"`);
      await db.$executeRawUnsafe(`DROP ROLE "${runtimeRole}"`);
    }
  });
});
