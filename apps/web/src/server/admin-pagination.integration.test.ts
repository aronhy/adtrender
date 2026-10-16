import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAdminPage } from './admin-pagination';

const url = process.env.SAAS_TEST_DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
const kinds = ['users', 'customers', 'tasks', 'runs', 'organizationFeedback', 'accountSupport', 'mediaFailures'] as const;
const ids = Object.fromEntries(kinds.map(kind => [kind, Array.from({ length: 105 }, () => randomUUID())])) as Record<(typeof kinds)[number], string[]>;
const admin = randomUUID(), otherAdmin = randomUUID(), ordinary = randomUUID(), source = randomUUID(), ad = randomUUID(), supportWorkspace = randomUUID();
const secretMarker = `never-expose-${randomUUID()}`;
const rowKey = (kind: (typeof kinds)[number]) => kind === 'organizationFeedback' || kind === 'accountSupport' ? 'feedback' : kind;

afterAll(async () => {
  if (url) await db.$transaction(async tx => {
    await tx.feedback.deleteMany({ where: { organizationId: { in: ids.customers } } });
    await tx.workspace.deleteMany({ where: { id: supportWorkspace } });
    await tx.accountSupportRequest.deleteMany({ where: { userId: ordinary } });
    await tx.mediaObject.deleteMany({ where: { adId: ad } });
    await tx.collectionRun.deleteMany({ where: { dataSourceId: source } });
    await tx.collectionTask.deleteMany({ where: { dataSourceId: source } });
    await tx.ad.deleteMany({ where: { id: ad } });
    await tx.dataSource.deleteMany({ where: { id: source } });
    await tx.organizationMember.deleteMany({ where: { organizationId: { in: ids.customers } } });
    await tx.organization.deleteMany({ where: { id: { in: ids.customers } } });
    await tx.user.deleteMany({ where: { id: { in: [...ids.users, admin, otherAdmin, ordinary] } } });
  });
  await db.$disconnect();
});

describe.skipIf(!url)('platform pages keep every operational record reachable', () => {
  beforeAll(async () => {
    const createdAt = new Date();
    await db.user.createMany({ data: [admin, otherAdmin, ordinary, ...ids.users].map(id => ({ id, email: `admin-page-${id}@example.test`, isAdmin: id === admin || id === otherAdmin, displayName: secretMarker, notificationPreference: { hidden: secretMarker }, createdAt })) });
    await db.$transaction(async tx => {
      await tx.organization.createMany({ data: ids.customers.map(id => ({ id, slug: id, name: `Customer ${id}`, createdAt })) });
      await tx.organizationMember.createMany({ data: ids.customers.map(organizationId => ({ organizationId, userId: ordinary, role: 'OWNER' })) });
    });
    await db.dataSource.create({ data: { id: source, key: source, name: 'Admin pagination fixture', adapterVersion: 'fixture', credentialReference: secretMarker } });
    await db.ad.create({ data: { id: ad, dataSourceId: source, sourceAdId: ad, sourceUrl: 'https://example.test/ad', body: secretMarker } });
    await db.collectionTask.createMany({ data: ids.tasks.map(id => ({ id, dataSourceId: source, name: `Task ${id}`, query: { keyword: 'fixture', country: 'ALL', credential: secretMarker }, status: 'PAUSED', createdAt })) });
    await db.collectionRun.createMany({ data: ids.runs.map(id => ({ id, dataSourceId: source, taskId: ids.tasks[0], idempotencyKey: id, querySnapshot: { hidden: secretMarker }, adapterVersion: 'fixture', status: 'FAILED', queuedAt: createdAt, createdAt, errorMessage: secretMarker, evidenceReference: secretMarker })) });
    await db.workspace.create({ data: { id: supportWorkspace, organizationId: ids.customers[0], slug: 'support-fixture', name: 'Support workspace fixture' } });
    await db.feedback.createMany({ data: ids.organizationFeedback.map(id => ({ id, organizationId: ids.customers[0], workspaceId: supportWorkspace, userId: ordinary, category: 'DELETION_REQUEST', subject: '删除申请：ORGANIZATION', body: 'Organization feedback', createdAt })) });
    await db.accountSupportRequest.createMany({ data: ids.accountSupport.map(id => ({ id, userId: ordinary, kind: 'FEEDBACK', body: 'Account support', createdAt })) });
    await db.mediaObject.createMany({ data: ids.mediaFailures.map(id => ({ id, adId: ad, sourceUrl: `https://example.test/${id}`, storageKey: `private-test-${id}`, status: 'FAILED', errorCode: 'MEDIA_HTTP_FAILED', createdAt })) });
  });

  it.each(kinds)('can reach all 105 %s rows across equal timestamps with no duplicates', async kind => {
    const expected = new Set(ids[kind]);
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
      const page = await listAdminPage(db, { userId: admin, kind, limit: 19, cursor });
      expect(page.kind).toBe(kind);
      expect(page.total).toBeGreaterThanOrEqual(105);
      const rows = page[rowKey(kind)];
      expect(rows.length).toBeLessThanOrEqual(19);
      for (const row of rows) { expect(seen.has(row.id)).toBe(false); seen.add(row.id); expected.delete(row.id); }
      if (!expected.size) break;
      expect(page.nextCursor).not.toBeNull();
      cursor = page.nextCursor ?? undefined;
    }
    expect(expected.size).toBe(0);
    expect(seen.size).toBeGreaterThan(100);
  });

  it('checks current platform role and disabledAt on each request, including cursor reuse', async () => {
    const page = await listAdminPage(db, { userId: otherAdmin, kind: 'users', limit: 2 });
    await expect(listAdminPage(db, { userId: ordinary, kind: 'users' })).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
    await db.user.update({ where: { id: otherAdmin }, data: { isAdmin: false } });
    await expect(listAdminPage(db, { userId: otherAdmin, kind: 'users', cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
    await db.user.update({ where: { id: otherAdmin }, data: { isAdmin: true, disabledAt: new Date() } });
    await expect(listAdminPage(db, { userId: otherAdmin, kind: 'users', cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    await db.user.update({ where: { id: otherAdmin }, data: { disabledAt: null } });
  });

  it('rejects malformed input and cursor reuse by another kind or administrator', async () => {
    const page = await listAdminPage(db, { userId: admin, kind: 'tasks', limit: 2 });
    await expect(listAdminPage(db, { userId: admin, kind: 'users', cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'INVALID_ADMIN_CURSOR' });
    await expect(listAdminPage(db, { userId: otherAdmin, kind: 'tasks', cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'INVALID_ADMIN_CURSOR' });
    for (const cursor of ['', 'bad-json', 'x'.repeat(4096)]) await expect(listAdminPage(db, { userId: admin, kind: 'tasks', cursor })).rejects.toMatchObject({ code: 'INVALID_ADMIN_CURSOR' });
    for (const limit of [0, 101, 1.5, Infinity]) await expect(listAdminPage(db, { userId: admin, kind: 'tasks', limit })).rejects.toMatchObject({ code: 'INVALID_ADMIN_QUERY' });
    const decoded = JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString());
    decoded.asOf = new Date(Date.now() + 60000).toISOString();
    await expect(listAdminPage(db, { userId: admin, kind: 'tasks', cursor: Buffer.from(JSON.stringify(decoded)).toString('base64url') })).rejects.toMatchObject({ code: 'INVALID_ADMIN_CURSOR' });
    await expect(listAdminPage(db, { userId: admin, kind: 'tasks', organizationId: ids.customers[0] } as any)).rejects.toMatchObject({ code: 'INVALID_ADMIN_QUERY' });
  });

  it('uses explicit DTO fields and provides historical run task names without exposing secrets', async () => {
    for (const kind of kinds) {
      const page = await listAdminPage(db, { userId: admin, kind, limit: 100 });
      expect(JSON.stringify(page)).not.toContain(secretMarker);
      expect(JSON.stringify(page)).not.toContain('private-test-');
      if (kind === 'runs') expect(page.runs.filter(row => ids.runs.includes(row.id)).every(row => row.taskName === `Task ${ids.tasks[0]}`)).toBe(true);
      if (kind === 'organizationFeedback') expect(page.feedback.every(row => row.scope === 'ORGANIZATION')).toBe(true);
      if (kind === 'accountSupport') expect(page.feedback.every(row => row.scope === 'ACCOUNT')).toBe(true);
    }
  });

  it('lets an administrator identify the requester, organization and workspace of a submitted request', async () => {
    const organizationPage = await listAdminPage(db, { userId: admin, kind: 'organizationFeedback', limit: 100 });
    const records = organizationPage.feedback.filter(row => ids.organizationFeedback.includes(row.id));
    expect(records.length).toBeGreaterThan(0);
    for (const row of records) expect(row).toMatchObject({
      subject: '删除申请：ORGANIZATION', requester: { id: ordinary, email: `admin-page-${ordinary}@example.test` },
      organization: { id: ids.customers[0], name: `Customer ${ids.customers[0]}` },
      workspace: { id: supportWorkspace, name: 'Support workspace fixture' },
    });
    const accountPage = await listAdminPage(db, { userId: admin, kind: 'accountSupport', limit: 100 });
    const accountRecords = accountPage.feedback.filter(row => ids.accountSupport.includes(row.id));
    expect(accountRecords.length).toBeGreaterThan(0);
    for (const row of accountRecords) expect(row).toMatchObject({ subject: null, requester: { id: ordinary, email: `admin-page-${ordinary}@example.test` }, organization: null, workspace: null });
  });

  it('never substitutes another member for a missing requester and denies customer access to support identities', async () => {
    const id = ids.organizationFeedback[0];
    await db.feedback.update({ where: { id }, data: { userId: null, workspaceId: null, createdAt: new Date() } });
    const page = await listAdminPage(db, { userId: admin, kind: 'organizationFeedback', limit: 100 });
    expect(page.feedback.find(row => row.id === id)).toMatchObject({ requester: null, workspace: null, organization: { id: ids.customers[0] } });
    for (const kind of ['organizationFeedback', 'accountSupport'] as const) {
      await expect(listAdminPage(db, { userId: ordinary, kind })).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
      await db.user.update({ where: { id: otherAdmin }, data: { disabledAt: new Date() } });
      try { await expect(listAdminPage(db, { userId: otherAdmin, kind })).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' }); }
      finally { await db.user.update({ where: { id: otherAdmin }, data: { disabledAt: null } }); }
    }
  });

  it('continues after a deleted cursor anchor and excludes rows created after asOf', async () => {
    const page = await listAdminPage(db, { userId: admin, kind: 'accountSupport', limit: 100 });
    const anchor = page.feedback.at(-1)!;
    expect(ids.accountSupport).toContain(anchor.id);
    await db.accountSupportRequest.delete({ where: { id: anchor.id } });
    const newer = await db.accountSupportRequest.create({ data: { userId: ordinary, kind: 'FEEDBACK', body: 'Later record', createdAt: new Date(Date.parse(page.asOf) + 1000) } });
    const next = await listAdminPage(db, { userId: admin, kind: 'accountSupport', cursor: page.nextCursor!, limit: 100 });
    expect(next.feedback.some(row => row.id === newer.id || page.feedback.some(previous => previous.id === row.id))).toBe(false);
    expect(next.feedback.filter(row => ids.accountSupport.includes(row.id))).toHaveLength(5);
  });
});
