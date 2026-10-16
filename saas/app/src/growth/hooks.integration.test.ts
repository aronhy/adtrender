import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerEmailAccount, completeAuthLink } from '../auth/lifecycle';
import { onAfterSignup, onBeforeLogin, onAfterLogin } from '../auth/hooks';
import { issueAuthLink } from '../auth/links';
import { initializeTrial } from '../billing/quotas';
import { saveAd, unsaveAd } from '../research/service';
import { acceptConsent } from './service';
import { growthContext } from './context';

const injected = vi.hoisted(() => ({ db: null as any }));
vi.mock('wasp/server', () => ({
  prisma: new Proxy({}, { get: (_, name) => injected.db[name] }),
  config: { auth: { jwtSecret: 'local-growth-fixture-signing-key' }, frontendUrl: 'https://adtrender.com' },
  HttpError: class extends Error { constructor(public statusCode: number, message: string) { super(message); } },
}));
const testUrl = process.env.SAAS_TEST_DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url: testUrl ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
const key = 'e'.repeat(64), password = 'Local-Growth-Password-42';
const recipientEmails = new Set<string>();
const withToken = <T>(token: string | undefined, fn: () => T) => growthContext.run({ token }, fn);
async function visitor() { return acceptConsent(db, undefined, { landingPath: '/', source: 'codex', medium: 'qa' }); }
async function verifyLink(email: string, token: string | undefined) {
  const { createJWT, TimeSpan } = await import('wasp/auth/jwt');
  const link = await issueAuthLink(db, { email, purpose: 'VERIFY', key, frameworkToken: await createJWT({ email }, { expiresIn: new TimeSpan(30, 'm') }) });
  await withToken(token, () => completeAuthLink(db, { token: link, purpose: 'VERIFY', key }));
}
async function stages(userId: string) { return (await db.conversionEvent.findMany({ where: { userId }, orderBy: { name: 'asc' } })).map(row => row.name); }
async function emailUser(token: string | undefined) {
  const email = `growth-${randomUUID()}@example.test`;
  recipientEmails.add(email);
  await withToken(token, () => registerEmailAccount(db, { email, password, key, origin: 'https://adtrender.com' }));
  return db.user.findUniqueOrThrow({ where: { email } });
}
async function research(userId: string) {
  const slug = randomUUID();
  const org = await db.organization.create({ data: { name: 'Growth fixture', slug, members: { create: { userId, role: 'OWNER' } } } });
  await db.$transaction(tx => initializeTrial(tx, org.id, { days: 7, workspaces: 2, members: 2, savedAds: 10, analyses: 1 }));
  const ws = await db.workspace.create({ data: { organizationId: org.id, name: 'Research', slug: 'research' } });
  const source = await db.dataSource.create({ data: { key: slug, name: 'Growth fixture', adapterVersion: 'fixture' } });
  const ad = await db.ad.create({ data: { dataSourceId: source.id, sourceAdId: slug, sourceUrl: 'https://example.test/ad' } });
  return { userId, workspaceId: ws.id, adId: ad.id };
}
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
afterAll(async () => {
  if (recipientEmails.size) await db.emailDelivery.deleteMany({ where: { recipientEmail: { in: [...recipientEmails] } } });
  await db.$disconnect();
});
describe.skipIf(!testUrl)('growth conversion hooks with native auth and save transactions', () => {
  beforeAll(() => { injected.db = db; });
  beforeEach(() => { vi.stubEnv('GROWTH_ATTRIBUTION_ENABLED', 'true'); });
  it('records only actual new email creation and first verification, never duplicate signup or reset/reverify', async () => {
    const f = await visitor(), user = await emailUser(f.token);
    expect(await stages(user.id)).toEqual(['ACCOUNT_CREATED']);
    await withToken(f.token, () => registerEmailAccount(db, { email: user.email!, password, key, origin: 'https://adtrender.com' }));
    await verifyLink(user.email!, f.token); await verifyLink(user.email!, f.token);
    expect(await stages(user.id)).toEqual(['ACCOUNT_CREATED', 'REGISTRATION_VERIFIED']);
    const old = await emailUser(undefined);
    await withToken(f.token, () => registerEmailAccount(db, { email: old.email!, password, key, origin: 'https://adtrender.com' }));
    await verifyLink(old.email!, f.token);
    expect(await stages(old.id)).toEqual([]);
  });
  it('does not reconstruct missed verification after a request without current consent', async () => {
    const f = await visitor(), user = await emailUser(f.token);
    await verifyLink(user.email!, undefined); await verifyLink(user.email!, f.token);
    expect(await stages(user.id)).toEqual(['ACCOUNT_CREATED']);
  });
  it('records Google first trusted admission and does not count a returning admitted login', async () => {
    vi.stubEnv('GOOGLE_AUTH_ENABLED', 'true'); vi.stubEnv('GOOGLE_CLIENT_ID', 'fixture.apps.googleusercontent.com'); vi.stubEnv('GOOGLE_CLIENT_SECRET', 'fixture'); vi.stubEnv('REGISTRATION_MODE', 'public');
    const f = await visitor(), email = `growth-${randomUUID()}@gmail.com`, sub = randomUUID();
    const providerId = { providerName: 'google' as const, providerUserId: sub };
    const user = await db.user.create({ data: { email, auth: { create: { identities: { create: { ...providerId, providerData: '{}' } } } } } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ sub, email, email_verified: true }), { headers: { 'content-type': 'application/json' } })));
    const args = () => ({ req: { body: {} }, providerId, user, prisma: db, oauth: { providerName: 'google', tokens: { accessToken: 'fixture' } } }) as any;
    await withToken(f.token, () => onAfterSignup(args()));
    expect(await stages(user.id)).toEqual(['ACCOUNT_CREATED', 'REGISTRATION_VERIFIED']);
    const other = await visitor(), login = args();
    await withToken(other.token, async () => { await onBeforeLogin(login); await onAfterLogin(login); });
    expect((await db.conversionEvent.findMany({ where: { userId: user.id } })).every(row => row.visitId === f.visit.id)).toBe(true);
  });
  it('records only the first successful save and does not count failed/repeated/deleted/recreated saves', async () => {
    const f = await visitor(), user = await emailUser(f.token); await verifyLink(user.email!, f.token);
    const input = await research(user.id);
    await expect(withToken(f.token, () => saveAd(db, { ...input, adId: randomUUID() }))).rejects.toMatchObject({ code: 'AD_NOT_FOUND' });
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).firstAdSavedAt).toBeNull();
    const saved = await withToken(f.token, () => Promise.all([saveAd(db, input), saveAd(db, input)]));
    expect(saved[0].id).toBe(saved[1].id); expect(await stages(user.id)).toEqual(['ACCOUNT_CREATED', 'FIRST_AD_SAVED', 'REGISTRATION_VERIFIED']);
    await unsaveAd(db, { ...input, savedAdId: saved[0].id }); await withToken(f.token, () => saveAd(db, input));
    expect(await stages(user.id)).toHaveLength(3);
  });
  it('keeps the business milestone when first save was without consent, excluding a later resave', async () => {
    const f = await visitor(), user = await emailUser(f.token); await verifyLink(user.email!, f.token);
    const input = await research(user.id), saved = await saveAd(db, input);
    await unsaveAd(db, { ...input, savedAdId: saved.id }); await withToken(f.token, () => saveAd(db, input));
    expect(await stages(user.id)).toEqual(['ACCOUNT_CREATED', 'REGISTRATION_VERIFIED']);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).firstAdSavedAt).not.toBeNull();
  });
  it('never labels a historical account as a new first-use conversion', async () => {
    const f = await visitor(), user = await emailUser(undefined), input = await research(user.id);
    await withToken(f.token, () => saveAd(db, input));
    expect(await stages(user.id)).toEqual([]);
  });
});
