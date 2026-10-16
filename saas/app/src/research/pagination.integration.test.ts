import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listResearchPage } from './pagination';

const url = process.env.SAAS_TEST_DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
const ids = { users: [randomUUID(), randomUUID(), randomUUID()], orgs: [randomUUID(), randomUUID()], workspaces: [randomUUID(), randomUUID(), randomUUID()], source: randomUUID(), folder: randomUUID(), foreignFolder: randomUUID() };
const savedIds = Array.from({ length: 205 }, () => randomUUID());
const adIds = savedIds.map(() => randomUUID());
const jobIds = Array.from({ length: 105 }, () => randomUUID());
const scope = { userId: ids.users[0], workspaceId: ids.workspaces[0] };
const old = new Date('2020-01-01T00:00:00.000Z');
const recent = new Date('2020-01-02T00:00:00.000Z');

afterAll(async () => {
  if (url) {
    await db.$transaction(async tx => {
      const where = { organizationId: { in: ids.orgs } };
      await tx.analysisResult.deleteMany({ where }); await tx.analysisJob.deleteMany({ where });
      await tx.note.deleteMany({ where }); await tx.savedAd.deleteMany({ where }); await tx.folder.deleteMany({ where });
      await tx.workspaceMember.deleteMany({ where }); await tx.workspace.deleteMany({ where }); await tx.organizationMember.deleteMany({ where });
      await tx.organization.deleteMany({ where: { id: { in: ids.orgs } } }); await tx.ad.deleteMany({ where: { dataSourceId: ids.source } });
      await tx.dataSource.deleteMany({ where: { id: ids.source } }); await tx.user.deleteMany({ where: { id: { in: ids.users } } });
    });
  }
  await db.$disconnect();
});

describe.skipIf(!url)('research cursor pages preserve historical records and tenant scope', () => {
  beforeAll(async () => {
    // Deferred owner constraints must see each organization and its OWNER together.
    // Keep setup atomic so a failed fixture never leaves rows for another suite.
    await db.$transaction(async tx => {
      await tx.user.createMany({ data: ids.users.map(id => ({ id, email: `research-page-${id}@example.test` })) });
      await tx.organization.createMany({ data: ids.orgs.map(id => ({ id, slug: id, name: 'Pagination fixture' })) });
      await tx.organizationMember.createMany({ data: [{ organizationId: ids.orgs[0], userId: ids.users[0], role: 'OWNER' }, { organizationId: ids.orgs[1], userId: ids.users[1], role: 'OWNER' }, { organizationId: ids.orgs[0], userId: ids.users[2], role: 'MEMBER' }] });
      await tx.workspace.createMany({ data: ids.workspaces.map((id, index) => ({ id, organizationId: ids.orgs[index === 2 ? 1 : 0], slug: id, name: 'Workspace fixture' })) });
      await tx.workspaceMember.create({ data: { organizationId: ids.orgs[0], workspaceId: ids.workspaces[0], userId: ids.users[2], role: 'VIEWER' } });
      await tx.folder.createMany({ data: [{ id: ids.folder, organizationId: ids.orgs[0], workspaceId: ids.workspaces[0], name: 'Old records' }, { id: ids.foreignFolder, organizationId: ids.orgs[0], workspaceId: ids.workspaces[1], name: 'Other client' }] });
      await tx.dataSource.create({ data: { id: ids.source, key: ids.source, name: 'Pagination fixture', adapterVersion: 'fixture' } });
      await tx.ad.createMany({ data: adIds.map(id => ({ id, dataSourceId: ids.source, sourceAdId: id, sourceUrl: 'https://www.facebook.com/ads/library/', body: 'Public fixture' })) });
      await tx.savedAd.createMany({ data: savedIds.map((id, index) => ({ id, organizationId: ids.orgs[0], workspaceId: ids.workspaces[0], adId: adIds[index], savedByUserId: ids.users[0], createdAt: index < 5 ? old : recent, folderId: index < 5 ? ids.folder : null })) });
      await tx.note.createMany({ data: savedIds.map((id, index) => ({ organizationId: ids.orgs[0], workspaceId: ids.workspaces[0], savedAdId: id, body: `note-${index}`, createdAt: index < 5 ? old : recent, updatedAt: index < 5 ? old : recent })) });
      await tx.note.create({ data: { organizationId: ids.orgs[0], workspaceId: ids.workspaces[0], savedAdId: savedIds[0], body: 'second-old-note', createdAt: old, updatedAt: old } });
      await tx.analysisJob.createMany({ data: jobIds.map((id, index) => ({ id, organizationId: ids.orgs[0], workspaceId: ids.workspaces[0], adId: adIds[0], idempotencyKey: id, inputSnapshot: {}, inputSha256: 'a'.repeat(64), model: 'fixture', promptVersion: 'fixture', status: 'SUCCEEDED', createdAt: index < 5 ? old : recent })) });
      await tx.analysisResult.createMany({ data: jobIds.map(id => ({ organizationId: ids.orgs[0], workspaceId: ids.workspaces[0], analysisJobId: id, facts: [], inferences: [], evidence: [], model: 'fixture', promptVersion: 'fixture' })) });
    });
  });

  it('walks all 205 saves and 105 analyses without duplicates at equal timestamps', async () => {
    for (const kind of ['saved', 'analysis'] as const) {
      const seen: string[] = []; let cursor: string | undefined; let pages = 0;
      do {
        const page = await listResearchPage(db, { ...scope, kind, limit: 23, cursor });
        expect(page.total).toBe(kind === 'saved' ? 205 : 105);
        const rows = page.kind === 'saved' ? page.savedAds : page.analyses;
        expect(rows.length).toBeLessThanOrEqual(23); seen.push(...rows.map(row => row.id));
        cursor = page.nextCursor ?? undefined; expect(++pages).toBeLessThan(20);
      } while (cursor);
      expect(new Set(seen).size).toBe(seen.length);
      expect([...seen].sort()).toEqual([...(kind === 'saved' ? savedIds : jobIds)].sort());
    }
  });

  it('filters the folder in PostgreSQL and returns every associated old note', async () => {
    const page = await listResearchPage(db, { ...scope, kind: 'saved', folderId: ids.folder });
    expect(page.kind).toBe('saved'); expect(page.total).toBe(5); expect(page.nextCursor).toBeNull();
    if (page.kind !== 'saved') throw new Error('Unexpected kind');
    expect(page.savedAds.map(row => row.id).sort()).toEqual(savedIds.slice(0, 5).sort());
    expect(page.savedAds.find(row => row.id === savedIds[0])?.notes.map(note => note.body).sort()).toEqual(['note-0', 'second-old-note']);
    expect(page.savedAds.every(row => row.notes.length > 0)).toBe(true);
  });

  it('uses a boundary without requiring the last row and excludes later inserts', async () => {
    const first = await listResearchPage(db, { ...scope, kind: 'analysis', limit: 10 });
    if (first.kind !== 'analysis') throw new Error('Unexpected kind');
    const anchor = first.analyses.at(-1)!;
    await db.analysisResult.deleteMany({ where: { analysisJobId: anchor.id } }); await db.analysisJob.delete({ where: { id: anchor.id } });
    const inserted = await db.analysisJob.create({ data: { organizationId: ids.orgs[0], workspaceId: ids.workspaces[0], adId: adIds[0], idempotencyKey: randomUUID(), inputSnapshot: {}, inputSha256: 'a'.repeat(64), model: 'fixture', promptVersion: 'fixture', createdAt: new Date(Date.now() + 1000) } });
    const next = await listResearchPage(db, { ...scope, kind: 'analysis', limit: 100, cursor: first.nextCursor! });
    if (next.kind !== 'analysis') throw new Error('Unexpected kind');
    expect(next.analyses).toHaveLength(95);
    expect(next.analyses.some(row => row.id === inserted.id || first.analyses.some(prior => prior.id === row.id))).toBe(false);
  });

  it('rejects foreign tenants/workspaces and rechecks viewer membership', async () => {
    await expect(listResearchPage(db, { ...scope, workspaceId: ids.workspaces[2], kind: 'saved' })).rejects.toMatchObject({ status: 403 });
    await expect(listResearchPage(db, { userId: ids.users[2], workspaceId: ids.workspaces[1], kind: 'saved' })).rejects.toMatchObject({ status: 403 });
    await expect(listResearchPage(db, { userId: ids.users[2], workspaceId: scope.workspaceId, kind: 'saved' })).resolves.toMatchObject({ total: 205 });
    await db.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: scope.workspaceId, userId: ids.users[2] } } });
    await expect(listResearchPage(db, { userId: ids.users[2], workspaceId: scope.workspaceId, kind: 'saved' })).rejects.toMatchObject({ status: 403 });
    await db.user.update({ where: { id: ids.users[2] }, data: { disabledAt: new Date() } });
    await expect(listResearchPage(db, { userId: ids.users[2], workspaceId: scope.workspaceId, kind: 'analysis' })).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
  });

  it('rejects invalid folders, malformed cursors and reuse across scope or filters', async () => {
    const first = await listResearchPage(db, { ...scope, kind: 'saved', limit: 2 });
    await expect(listResearchPage(db, { ...scope, kind: 'saved', folderId: ids.foreignFolder })).rejects.toMatchObject({ code: 'FOLDER_NOT_FOUND' });
    await expect(listResearchPage(db, { ...scope, kind: 'saved', folderId: randomUUID() })).rejects.toMatchObject({ code: 'FOLDER_NOT_FOUND' });
    await expect(listResearchPage(db, { ...scope, kind: 'analysis', folderId: ids.folder })).rejects.toMatchObject({ status: 400 });
    for (const cursor of ['not-json', 'x'.repeat(4096), Buffer.from(JSON.stringify({ v: 1, asOf: 'bad' })).toString('base64url')]) await expect(listResearchPage(db, { ...scope, kind: 'saved', cursor })).rejects.toMatchObject({ code: 'INVALID_RESEARCH_CURSOR' });
    const decoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8'));
    for (const changed of [{ asOf: new Date(Date.now() + 86400000).toISOString() }, { at: new Date(Date.now() + 86400000).toISOString() }, { unexpected: 'field' }]) {
      const cursor = Buffer.from(JSON.stringify({ ...decoded, ...changed })).toString('base64url');
      await expect(listResearchPage(db, { ...scope, kind: 'saved', cursor })).rejects.toMatchObject({ code: 'INVALID_RESEARCH_CURSOR' });
    }
    for (const filters of [{ kind: 'analysis' as const }, { kind: 'saved' as const, folderId: ids.folder }, { kind: 'saved' as const, workspaceId: ids.workspaces[1] }]) await expect(listResearchPage(db, { ...scope, ...filters, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'INVALID_RESEARCH_CURSOR' });
    await expect(listResearchPage(db, { ...scope, kind: 'saved', limit: 101 })).rejects.toMatchObject({ status: 400 });
  });
});
