import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { createTeamService } from '../team/service';
import { initializeTrial, admitQuota } from '../billing/quotas';
import { loadAppState,billingView } from './views';

const testUrl = process.env.SAAS_TEST_DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url: testUrl ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
afterAll(() => db.$disconnect());

async function fixture() {
  const user = (isAdmin = false) => db.user.create({ data: { email: `${randomUUID()}@example.test`, isAdmin } });
  const [ownerA, ownerB, viewer, platformAdmin] = await Promise.all([user(), user(), user(), user(true)]);
  const team = createTeamService(db, { initializeOrganization: (tx, organizationId) => initializeTrial(tx, organizationId, { days: 14, workspaces: 3, members: 5, savedAds: 30, analyses: 10 }), admitQuota });
  const a = await team.createOrganization({ userId: ownerA.id, name: '租户A' });
  const b = await team.createOrganization({ userId: ownerB.id, name: '租户B' });
  const clientTwo = await team.createWorkspace({ userId: ownerA.id, organizationId: a.organization.id, name: 'A另一个客户' });
  await db.organizationMember.create({ data: { organizationId: a.organization.id, userId: viewer.id, role: 'MEMBER' } });
  await db.workspaceMember.create({ data: { organizationId: a.organization.id, workspaceId: a.workspace.id, userId: viewer.id, role: 'VIEWER' } });
  const source = await db.dataSource.create({ data: { key: `view-${randomUUID()}`, name: '视图测试来源', adapterVersion: 'test' } });
  const ad = await db.ad.create({ data: { dataSourceId: source.id, sourceAdId: randomUUID(), sourceUrl: 'https://www.facebook.com/ads/library/', body: '公共广告' } });
  async function privateRecords(organizationId: string, workspaceId: string, actor: string) {
    const marker = `private-${randomUUID()}`;
    const folder = await db.folder.create({ data: { organizationId, workspaceId, name: marker } });
    const savedAd = await db.savedAd.create({ data: { organizationId, workspaceId, folderId: folder.id, adId: ad.id, savedByUserId: actor } });
    await db.note.create({ data: { organizationId, workspaceId, savedAdId: savedAd.id, body: marker, authorUserId: actor } });
    const analysis = await db.analysisJob.create({ data: { organizationId, workspaceId, adId: ad.id, requestedByUserId: actor, idempotencyKey: randomUUID(), inputSnapshot: { marker }, inputSha256: 'a'.repeat(64), model: 'test-fixture', promptVersion: 'v1', status: 'SUCCEEDED' } });
    await db.analysisResult.create({ data: { organizationId, workspaceId, analysisJobId: analysis.id, facts: { marker }, inferences: [], evidence: [], model: 'test-fixture', promptVersion: 'v1' } });
    return marker;
  }
  const [markerA, markerB, markerTwo] = await Promise.all([
    privateRecords(a.organization.id, a.workspace.id, ownerA.id),
    privateRecords(b.organization.id, b.workspace.id, ownerB.id),
    privateRecords(a.organization.id, clientTwo.id, ownerA.id),
  ]);
  const secret = randomUUID();
  await db.invitation.create({ data: { organizationId: a.organization.id, email: `${randomUUID()}@example.test`, tokenHash: secret, expiresAt: new Date(Date.now() + 3_600_000), invitedByUserId: ownerA.id } });
  return { a, b, ownerA, ownerB, viewer, platformAdmin, clientTwo, markerA, markerB, markerTwo, secret };
}

describe.skipIf(!testUrl)('loadAppState tenant and workspace isolation', () => {
  it('returns only the selected workspace research and redacts invite secrets', async () => {
    const f = await fixture();
    const state = await loadAppState(db, f.ownerA.id, f.a.workspace.id);
    const serialized = JSON.stringify(state);
    expect(serialized).toContain(f.markerA);
    expect(serialized).not.toContain(f.markerB);
    expect(serialized).not.toContain(f.markerTwo);
    expect(serialized).not.toContain(f.secret);
    expect(state.organizations.map((organization) => organization.id)).toEqual([f.a.organization.id]);
    expect(state.overview).toMatchObject({ savedCount: 1, analysisCount: 1, pendingAnalysisCount: 0 });
    expect(state.invitations?.[0]).not.toHaveProperty('tokenHash');
    const other = await loadAppState(db, f.ownerB.id, f.b.workspace.id);
    expect(JSON.stringify(other)).toContain(f.markerB);
    expect(JSON.stringify(other)).not.toContain(f.markerA);
  });

  it('rejects cross-tenant IDs and does not expose other clients to a workspace viewer', async () => {
    const f = await fixture();
    await expect(loadAppState(db, f.ownerA.id, f.b.workspace.id)).rejects.toMatchObject({ status: 403 });
    await expect(loadAppState(db, f.viewer.id, f.clientTwo.id)).rejects.toMatchObject({ status: 403 });
    const state = await loadAppState(db, f.viewer.id, f.a.workspace.id);
    expect(state.workspaces.map((workspace) => workspace.id)).toEqual([f.a.workspace.id]);
    expect(state.role).toBe('VIEWER');
    expect(state.members).toEqual([]);
    expect(state.invitations).toEqual([]);
    expect(state).not.toHaveProperty('admin');
    expect(JSON.stringify(state)).not.toContain(f.markerTwo);
  });

  it('does not grant platform admins implicit access to tenant research', async () => {
    const f = await fixture();
    await expect(loadAppState(db, f.platformAdmin.id, f.b.workspace.id)).rejects.toMatchObject({ status: 403 });
    const state = await loadAppState(db, f.platformAdmin.id);
    expect(state.admin).toBeDefined();
    expect(state.selectedWorkspace).toBeNull();
    expect(state.research).toEqual({ folders: [], savedAds: [], notes: [], analyses: [] });
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain(f.markerA);
    expect(serialized).not.toContain(f.markerB);
    expect(serialized).not.toContain(f.markerTwo);
  });

  it('rereads workspace membership and account disablement for every state request', async () => {
    const f = await fixture();
    await expect(loadAppState(db, f.viewer.id, f.a.workspace.id)).resolves.toMatchObject({ role: 'VIEWER' });
    await db.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: f.a.workspace.id, userId: f.viewer.id } } });
    await expect(loadAppState(db, f.viewer.id, f.a.workspace.id)).rejects.toMatchObject({ status: 403 });
    expect((await loadAppState(db, f.viewer.id)).selectedWorkspace).toBeNull();
    await db.user.update({ where: { id: f.ownerA.id }, data: { disabledAt: new Date() } });
    await expect(loadAppState(db, f.ownerA.id, f.a.workspace.id)).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
  });
});


describe.skipIf(!testUrl)('billing purchase availability view',()=>{
  it('allows a new checkout after cancellation while preserving pending cancellation as an existing subscription',async()=>{
    const f=await fixture();
    await db.subscription.update({where:{organizationId:f.a.organization.id},data:{provider:'STRIPE',providerSubscriptionId:`sub-view-${randomUUID()}`,status:'ACTIVE',cancelAtPeriodEnd:false}});
    expect(await billingView(db,f.a.organization.id)).toMatchObject({hasProviderSubscription:true,canChangePlan:true});
    await db.subscription.update({where:{organizationId:f.a.organization.id},data:{cancelAtPeriodEnd:true}});
    expect(await billingView(db,f.a.organization.id)).toMatchObject({hasProviderSubscription:true,canChangePlan:false});
    await db.subscription.update({where:{organizationId:f.a.organization.id},data:{status:'CANCELED'}});
    expect(await billingView(db,f.a.organization.id)).toMatchObject({hasProviderSubscription:false,canChangePlan:false});
  });
});
