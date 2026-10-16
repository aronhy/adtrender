import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptConsent, revokeConsent, recordPublicEvent } from './service';
import { safelyRecordConversion } from './conversions';
import { growthContext } from './context';

const testUrl = process.env.SAAS_TEST_DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url: testUrl ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
const visits: string[] = [], users: string[] = [];
async function visitor(source = 'google') {
  const result = await acceptConsent(db, undefined, { landingPath: '/', source, medium: 'organic' });
  visits.push(result.visit.id); return result;
}
async function user() { const row = await db.user.create({ data: {} }); users.push(row.id); return row; }
async function conversion(userId: string, token: string | undefined, name: 'ACCOUNT_CREATED'|'REGISTRATION_VERIFIED'|'FIRST_AD_SAVED') {
  return growthContext.run({ token }, () => db.$transaction(tx => safelyRecordConversion(tx, userId, name)));
}
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  if (visits.length) { await db.conversionEvent.deleteMany({ where: { visitId: { in: visits } } }); await db.growthEvent.deleteMany({ where: { visitId: { in: visits } } }); await db.growthVisit.deleteMany({ where: { id: { in: visits } } }); }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } });
  await db.$disconnect();
});
describe.skipIf(!testUrl)('first-party ledger on PostgreSQL', () => {
  beforeEach(() => vi.stubEnv('GROWTH_ATTRIBUTION_ENABLED', 'true'));
  it('keeps a 30-day first touch stable on accepted retries and flags QA visitors', async () => {
    const first = await visitor('codex');
    const retry = await acceptConsent(db, first.token, { landingPath: '/pricing', source: 'bing' });
    expect(retry.token).toBe(first.token); expect(retry.visit.id).toBe(first.visit.id);
    expect(retry.visit.source).toBe('codex'); expect(retry.visit.landingPath).toBe('/'); expect(retry.visit.isTest).toBe(true);
    expect(first.visit.tokenHash).not.toBe(first.token);
    expect(first.visit.expiresAt.valueOf() - first.visit.createdAt.valueOf()).toBe(30 * 86400_000);
  });
  it('deduplicates retried clicks with a server-derived key and denies stale/revoked visitors', async () => {
    const f = await visitor(), requestNonce = randomUUID();
    const body = { name: 'CTA_CLICK' as const, pathname: '/' as const, target: 'signup' as const, requestNonce };
    await Promise.all([recordPublicEvent(db, f.token, body), recordPublicEvent(db, f.token, body)]);
    expect(await db.growthEvent.count({ where: { visitId: f.visit.id } })).toBe(1);
    await revokeConsent(db, f.token);
    expect(await recordPublicEvent(db, f.token, { ...body, requestNonce: randomUUID() })).toEqual({ recorded: false });
    const renewed = await acceptConsent(db, f.token, { landingPath: '/help' }); visits.push(renewed.visit.id);
    expect(renewed.visit.id).not.toBe(f.visit.id);
  });
  it('anchors all later conversions to the original signup visit and deduplicates concurrent writes', async () => {
    const f = await visitor(), other = await visitor(), u = await user();
    await Promise.all([conversion(u.id, f.token, 'ACCOUNT_CREATED'), conversion(u.id, f.token, 'ACCOUNT_CREATED')]);
    await conversion(u.id, other.token, 'REGISTRATION_VERIFIED');
    await conversion(u.id, undefined, 'REGISTRATION_VERIFIED');
    expect(await db.conversionEvent.count({ where: { userId: u.id } })).toBe(1);
    await conversion(u.id, f.token, 'REGISTRATION_VERIFIED');
    await Promise.all([conversion(u.id, f.token, 'FIRST_AD_SAVED'), conversion(u.id, f.token, 'FIRST_AD_SAVED')]);
    expect((await db.conversionEvent.findMany({ where: { userId: u.id } })).map(row => row.name).sort()).toEqual(['ACCOUNT_CREATED', 'FIRST_AD_SAVED', 'REGISTRATION_VERIFIED']);
  });
  it('never adds conversion after withdrawal, expiry or without the account-created binding', async () => {
    const f = await visitor(), u = await user();
    await conversion(u.id, f.token, 'REGISTRATION_VERIFIED');
    expect(await db.conversionEvent.count({ where: { userId: u.id } })).toBe(0);
    await conversion(u.id, f.token, 'ACCOUNT_CREATED'); await revokeConsent(db, f.token);
    await conversion(u.id, f.token, 'REGISTRATION_VERIFIED');
    expect(await db.conversionEvent.count({ where: { userId: u.id } })).toBe(1);
    const expired = await visitor(), u2 = await user();
    await db.growthVisit.update({ where: { id: expired.visit.id }, data: { expiresAt: new Date(0) } });
    await conversion(u2.id, expired.token, 'ACCOUNT_CREATED');
    expect(await db.conversionEvent.count({ where: { userId: u2.id } })).toBe(0);
  });
  it('does not bind an older account to a newer visit, but permits later admission from its original visit', async () => {
    const old = await user();
    await db.user.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 10_000) } });
    const f = await visitor(); await conversion(old.id, f.token, 'ACCOUNT_CREATED');
    expect(await db.conversionEvent.count({ where: { userId: old.id } })).toBe(0);
    const newlyCreated = await user(); await conversion(newlyCreated.id, f.token, 'ACCOUNT_CREATED');
    expect(await db.conversionEvent.count({ where: { userId: newlyCreated.id } })).toBe(1);
  });
  it('waits through a short public-event lock and restores the transaction lock timeout', async () => {
    const f = await visitor(), u = await user();
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const holder = db.$transaction(async tx => { await tx.$queryRaw`SELECT id FROM "GrowthVisit" WHERE id=${f.visit.id} FOR UPDATE`; locked(); await gate; });
    await ready;
    const timer = setTimeout(release, 75);
    try {
      const timeout = await growthContext.run({ token: f.token }, () => db.$transaction(async tx => {
        await tx.$queryRaw`SELECT set_config('lock_timeout', '1234ms', true)`;
        await safelyRecordConversion(tx, u.id, 'ACCOUNT_CREATED');
        return tx.$queryRaw<Array<{ setting: string }>>`SELECT current_setting('lock_timeout') AS setting`;
      }));
      expect(timeout[0].setting).toBe('1234ms');
      expect(await db.conversionEvent.count({ where: { userId: u.id } })).toBe(1);
    } finally { clearTimeout(timer); release(); await holder; }
  });
  it('drops only statistics after 250ms contention and still commits the core transaction with restored timeout', async () => {
    const f = await visitor(), u = await user();
    let locked!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const holder = db.$transaction(async tx => { await tx.$queryRaw`SELECT id FROM "GrowthVisit" WHERE id=${f.visit.id} FOR UPDATE`; locked(); await gate; });
    await ready;
    try {
      const timeout = await growthContext.run({ token: f.token }, () => db.$transaction(async tx => {
        await tx.$queryRaw`SELECT set_config('lock_timeout', '987ms', true)`;
        await safelyRecordConversion(tx, u.id, 'ACCOUNT_CREATED');
        await tx.user.update({ where: { id: u.id }, data: { displayName: 'committed despite contention' } });
        return tx.$queryRaw<Array<{ setting: string }>>`SELECT current_setting('lock_timeout') AS setting`;
      }));
      expect(timeout[0].setting).toBe('987ms');
      expect(await db.conversionEvent.count({ where: { userId: u.id } })).toBe(0);
      expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).displayName).toBe('committed despite contention');
    } finally { release(); await holder; }
  });
  it('rolls a statistics SQL failure back to a savepoint while core transaction still commits', async () => {
    const f = await visitor(), u = await user();
    await growthContext.run({ token: f.token }, () => db.$transaction(async tx => {
      const failing = new Proxy(tx, { get: (target, key) => key === 'conversionEvent' ? { createMany: () => tx.$executeRawUnsafe('SELECT * FROM "missing_growth_fixture_table"') } : (target as any)[key] });
      await safelyRecordConversion(failing, u.id, 'ACCOUNT_CREATED');
      await tx.user.update({ where: { id: u.id }, data: { displayName: 'core business committed' } });
    }));
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).displayName).toBe('core business committed');
  });
});
