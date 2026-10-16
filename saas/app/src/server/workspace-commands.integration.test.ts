import { createHmac, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createTeamService } from '../team/service';
import { admitQuota, initializeTrial, releaseQuota } from '../billing/quotas';
import { requireWorkspaceRole } from '../team/access';
import { appCommand, getAppState } from './operations';
import type { AppCommand } from '../client/types';
import { enqueueAnalysis, retryAnalysis } from '../analysis/service';
import { analysisWorkerTick } from '../analysis/worker';

const injected = vi.hoisted(() => ({ db: null as any, providerAccess: 0 }));
vi.mock('wasp/server', async () => {
  const { PrismaClient } = await import('@prisma/client');
  injected.db = new PrismaClient({ datasources: { db: { url: process.env.SAAS_TEST_DATABASE_URL ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
  return { prisma: injected.db, HttpError: class extends Error { constructor(public statusCode: number, message: string) { super(message); } } };
});
vi.mock('../billing/configured', async () => {
  const { createStripeBilling } = await import('../billing/stripe');
  return { billingFromEnvironment: (db: PrismaClient) => createStripeBilling(db, new Proxy({} as import('stripe').default, {
    get() { injected.providerAccess++; throw new Error('UNEXPECTED_PROVIDER_ACCESS'); },
  }), { publicAppUrl: 'http://localhost:3000', webhookSecret: 'test-only', mode: 'test', refundPolicy: 'RETAIN_PAID_PERIOD' }) };
});
const db = injected.db as PrismaClient;
const userIds: string[] = [], organizationIds: string[] = [], sourceIds: string[] = [];
const analysisEnv = { OPENAI_API_KEY: 'fixture-no-network', ANALYSIS_MODEL: 'fixture-model' };
const providerResult = () => ({ output: { inferences: [] } });
const command = (userId: string, value: Record<string, unknown>) => appCommand(value as AppCommand, { user: { id: userId } });
const team = createTeamService(db, { initializeOrganization: (tx, organizationId) => initializeTrial(tx, organizationId, { days: 14, workspaces: 3, members: 10, savedAds: 20, analyses: 5 }), admitQuota, releaseQuota });
async function user(isAdmin = false) {
  const row = await db.user.create({ data: { email: `workspace-commands-${randomUUID()}@example.test`, isAdmin } }); userIds.push(row.id); return row;
}
async function fixture(two = true) {
  const owner = await user(); const a = await team.createOrganization({ userId: owner.id, name: '客户隔离命令测试' }); organizationIds.push(a.organization.id);
  const b = two ? await team.createWorkspace({ userId: owner.id, organizationId: a.organization.id, name: '客户 B' }) : null;
  const member = async (role: 'MEMBER' | 'ADMIN', workspaceRole: 'EDITOR' | 'VIEWER' = 'VIEWER') => {
    const target = await user();
    const membership = await db.$transaction(async tx => {
      await admitQuota(tx, a.organization.id, 'MEMBERS', 1);
      const row = await tx.organizationMember.create({ data: { organizationId: a.organization.id, userId: target.id, role } });
      for (const workspace of [a.workspace, ...(b ? [b] : [])]) await tx.workspaceMember.create({ data: { organizationId: a.organization.id, workspaceId: workspace.id, userId: target.id, role: workspaceRole } });
      return row;
    });
    return { ...target, membership };
  };
  const archive = { type: 'ARCHIVE_WORKSPACE', organizationId: a.organization.id, workspaceId: a.workspace.id };
  return { ...a, b, owner, member, archive };
}
async function analysisFixture(two = false) {
  const f = await fixture(two);
  const source = await db.dataSource.create({ data: { key: randomUUID(), name: 'workspace archive test', adapterVersion: 'fixture' } }); sourceIds.push(source.id);
  const ad = await db.ad.create({ data: { dataSourceId: source.id, sourceAdId: randomUUID(), sourceUrl: 'https://example.test/ad', body: 'Handmade oak chairs.' } });
  const input = { userId: f.owner.id, workspaceId: f.workspace.id, adId: ad.id, idempotencyKey: randomUUID() };
  return { ...f, input };
}
afterAll(async () => {
  if (!process.env.SAAS_TEST_DATABASE_URL) return;
  if (organizationIds.length) {
    await db.organization.updateMany({ where: { id: { in: organizationIds } }, data: { status: 'ARCHIVED' } });
    const scope = { organizationId: { in: organizationIds } };
    await db.auditEvent.deleteMany({ where: scope }); await db.folder.deleteMany({ where: scope });
    await db.analysisResult.deleteMany({ where: scope }); await db.analysisJob.deleteMany({ where: scope }); await db.usageLedger.deleteMany({ where: scope });
    await db.workspaceMember.deleteMany({ where: scope }); await db.workspace.deleteMany({ where: scope });
    await db.organizationMember.deleteMany({ where: scope }); await db.entitlement.deleteMany({ where: scope });
    await db.subscription.deleteMany({ where: scope }); await db.organization.deleteMany({ where: { id: { in: organizationIds } } });
  }
  await db.ad.deleteMany({ where: { dataSourceId: { in: sourceIds } } }); await db.dataSource.deleteMany({ where: { id: { in: sourceIds } } });
  const secret = process.env.RATE_LIMIT_HMAC_SECRET ?? process.env.JWT_SECRET ?? 'local-development-only';
  await db.rateLimitBucket.deleteMany({ where: { scope: 'ACTION', principalHash: { in: userIds.map(id => createHmac('sha256', secret).update(id).digest('hex')) } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } }); await db.$disconnect();
});

describe.skipIf(!process.env.SAAS_TEST_DATABASE_URL)('actual workspace appCommand entrypoints', () => {
  it('archives the explicit workspace, preserves research, releases quota and falls back to another workspace', async () => {
    const f = await fixture(); const folder = await db.folder.create({ data: { organizationId: f.organization.id, workspaceId: f.workspace.id, name: '保留的研究资料' } });
    expect(await command(f.owner.id, f.archive)).toMatchObject({ workspaceId: null });
    expect(await db.workspace.findUniqueOrThrow({ where: { id: f.workspace.id } })).toMatchObject({ archivedAt: expect.any(Date) });
    expect(await db.folder.findUnique({ where: { id: folder.id } })).not.toBeNull();
    expect(await db.entitlement.findFirstOrThrow({ where: { organizationId: f.organization.id, key: 'WORKSPACES' } })).toMatchObject({ used: 1 });
    expect(await getAppState({}, { user: { id: f.owner.id } })).toMatchObject({ selectedWorkspace: { id: f.b!.id } });
    await expect(command(f.owner.id, { type: 'CREATE_FOLDER', workspaceId: f.workspace.id, name: '禁止归档后写入' })).rejects.toMatchObject({ statusCode: 403 });
    expect(await db.auditEvent.count({ where: { organizationId: f.organization.id, action: 'WORKSPACE_ARCHIVED', targetId: f.workspace.id } })).toBe(1);
  });

  it('repeated concurrent archive commands release exactly one workspace', async () => {
    const f = await fixture(); await Promise.all([command(f.owner.id, f.archive), command(f.owner.id, f.archive)]);
    expect(await db.entitlement.findFirstOrThrow({ where: { organizationId: f.organization.id, key: 'WORKSPACES' } })).toMatchObject({ used: 1 });
    expect(await db.auditEvent.count({ where: { organizationId: f.organization.id, action: 'WORKSPACE_ARCHIVED' } })).toBe(1);
  });

  it('allows organization admins but rejects editors, viewers and unrelated platform admins', async () => {
    const f = await fixture(); const editor = await f.member('MEMBER', 'EDITOR'), viewer = await f.member('MEMBER'), outsider = await user(true), admin = await f.member('ADMIN');
    for (const denied of [editor, viewer, outsider]) await expect(command(denied.id, f.archive)).rejects.toMatchObject({ statusCode: 403 });
    expect(await db.workspace.findUniqueOrThrow({ where: { id: f.workspace.id } })).toMatchObject({ archivedAt: null });
    await expect(command(admin.id, f.archive)).resolves.toMatchObject({ workspaceId: null });
  });

  it('rejects cross-organization workspace IDs before changing quotas or rows', async () => {
    const a = await fixture(), b = await fixture(false);
    await expect(command(a.owner.id, { ...a.archive, workspaceId: b.workspace.id })).rejects.toMatchObject({ statusCode: 403 });
    await expect(command(a.owner.id, b.archive)).rejects.toMatchObject({ statusCode: 403 });
    expect(await db.workspace.findUniqueOrThrow({ where: { id: b.workspace.id } })).toMatchObject({ archivedAt: null });
    expect(await db.entitlement.findFirstOrThrow({ where: { organizationId: b.organization.id, key: 'WORKSPACES' } })).toMatchObject({ used: 1 });
  });

  it('removes only A workspace access while keeping B, organization membership and seat usage', async () => {
    const f = await fixture(); const member = await f.member('MEMBER', 'EDITOR');
    const remove = { type: 'REMOVE_WORKSPACE_MEMBER', organizationId: f.organization.id, workspaceId: f.workspace.id, memberId: member.membership.id };
    await command(f.owner.id, remove); await command(f.owner.id, remove);
    await expect(requireWorkspaceRole(db, member.id, f.workspace.id)).rejects.toMatchObject({ status: 403 });
    await expect(command(member.id, { type: 'CREATE_FOLDER', workspaceId: f.workspace.id, name: '不应创建' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(command(member.id, { type: 'CREATE_FOLDER', workspaceId: f.b!.id, name: 'B 仍可写入' })).resolves.toBeDefined();
    expect(await db.organizationMember.findUnique({ where: { id: member.membership.id } })).not.toBeNull();
    expect(await db.entitlement.findFirstOrThrow({ where: { organizationId: f.organization.id, key: 'MEMBERS' } })).toMatchObject({ used: 2 });
    expect(await db.auditEvent.count({ where: { organizationId: f.organization.id, workspaceId: f.workspace.id, action: 'WORKSPACE_MEMBER_REMOVED' } })).toBe(1);
  });

  it('rejects ordinary members removing peers and preserves inherited owner/admin access', async () => {
    const f = await fixture(); const editor = await f.member('MEMBER', 'EDITOR'), admin = await f.member('ADMIN');
    const owner = await db.organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: f.organization.id, userId: f.owner.id } } });
    const remove = { type: 'REMOVE_WORKSPACE_MEMBER', organizationId: f.organization.id, workspaceId: f.workspace.id, memberId: editor.membership.id };
    await expect(command(editor.id, remove)).rejects.toMatchObject({ statusCode: 403 });
    await expect(command(admin.id, { ...remove, memberId: owner.id })).rejects.toThrow('OWNER_PROTECTED');
    for (const target of [owner, admin.membership]) await expect(command(f.owner.id, { ...remove, memberId: target.id })).rejects.toThrow('WORKSPACE_ROLE_INHERITED');
    expect(await db.organizationMember.count({ where: { organizationId: f.organization.id, role: 'OWNER' } })).toBe(1);
    await expect(command(admin.id, remove)).resolves.toBeDefined();
  });

  it('does not accept a member ID from another organization', async () => {
    const a = await fixture(), b = await fixture(); const member = await b.member('MEMBER');
    await expect(command(a.owner.id, { type: 'REMOVE_WORKSPACE_MEMBER', organizationId: a.organization.id, workspaceId: a.workspace.id, memberId: member.membership.id })).rejects.toMatchObject({ statusCode: 404 });
    await expect(requireWorkspaceRole(db, member.id, b.workspace.id)).resolves.toBeDefined();
  });

  it('keeps an existing organization and billing reachable with no active workspace and can create a replacement', async () => {
    const f = await fixture(false); await command(f.owner.id, f.archive);
    const state = await getAppState({}, { user: { id: f.owner.id } });
    expect(state.selectedWorkspace).toBeNull(); expect(state.workspaces).toEqual([]);
    expect(state.organizations).toEqual([expect.objectContaining({ id: f.organization.id, role: 'OWNER' })]);
    expect(state.billing).toMatchObject({ organizationId: f.organization.id });
    const next = await command(f.owner.id, { type: 'CREATE_WORKSPACE', organizationId: f.organization.id, name: '新的研究空间' });
    expect(next.workspaceId).toBeTruthy(); expect((await getAppState({}, { user: { id: f.owner.id } })).selectedWorkspace?.id).toBe(next.workspaceId);
  });

  it('permits quota release after expiration while keeping billing reachable and rejecting unpaid new workspace creation', async () => {
    const f = await fixture(false); await db.entitlement.updateMany({ where: { organizationId: f.organization.id }, data: { validUntil: new Date(Date.now() - 1000) } });
    await command(f.owner.id, f.archive);
    expect((await getAppState({}, { user: { id: f.owner.id } })).billing).toMatchObject({ organizationId: f.organization.id });
    await expect(command(f.owner.id, { type: 'CREATE_WORKSPACE', organizationId: f.organization.id, name: '仍需有效权益' })).rejects.toThrow('ENTITLEMENT_EXPIRED');
  });

  it('only allows explicitly selecting a managed organization and never mixes workspace data with its billing', async () => {
    const a = await fixture(false), b = await fixture(false); const member = await a.member('MEMBER');
    await expect(getAppState({ organizationId: b.organization.id }, { user: { id: a.owner.id } })).rejects.toMatchObject({ statusCode: 403 });
    await expect(getAppState({ organizationId: a.organization.id }, { user: { id: member.id } })).rejects.toMatchObject({ statusCode: 403 });
    await db.$transaction(async tx => {
      await admitQuota(tx, b.organization.id, 'MEMBERS', 1);
      await tx.organizationMember.create({ data: { organizationId: b.organization.id, userId: a.owner.id, role: 'ADMIN' } });
    });
    await expect(getAppState({ organizationId: b.organization.id, workspaceId: a.workspace.id }, { user: { id: a.owner.id } })).rejects.toMatchObject({ statusCode: 403 });
    await db.folder.create({ data: { organizationId: b.organization.id, workspaceId: b.workspace.id, name: '归档前私有资料' } });
    await command(b.owner.id, b.archive);
    const state = await getAppState({ organizationId: b.organization.id }, { user: { id: a.owner.id } });
    expect(state.selectedWorkspace).toBeNull();
    expect(state.billing).toMatchObject({ organizationId: b.organization.id });
    expect(state.research).toMatchObject({ folders: [], savedAds: [], notes: [], analyses: [] });
    expect(state.workspaces.map(workspace => workspace.id)).toEqual([a.workspace.id]);
  });

  it('keeps zero-workspace billing read access separate from owner-only writes without calling Stripe', async () => {
    const f = await fixture(false), admin = await f.member('ADMIN'); await command(f.owner.id, f.archive);
    expect((await getAppState({ organizationId: f.organization.id }, { user: { id: admin.id } })).billing).toMatchObject({ organizationId: f.organization.id });
    for (const type of ['CHECKOUT', 'CANCEL_SUBSCRIPTION', 'CHANGE_PLAN']) {
      await expect(command(admin.id, { type, organizationId: f.organization.id, planVersionId: randomUUID() })).rejects.toMatchObject({ statusCode: 403 });
    }
    await expect(command(f.owner.id, { type: 'CANCEL_SUBSCRIPTION', organizationId: f.organization.id })).rejects.toThrow('PAID_SUBSCRIPTION_REQUIRED');
    expect(injected.providerAccess).toBe(0);
  });

  it('rechecks disabled and demoted managers on each command', async () => {
    const f = await fixture(); const admin = await f.member('ADMIN');
    await db.organizationMember.update({ where: { id: admin.membership.id }, data: { role: 'MEMBER' } });
    await expect(command(admin.id, f.archive)).rejects.toMatchObject({ statusCode: 403 });
    await db.user.update({ where: { id: f.owner.id }, data: { disabledAt: new Date() } });
    await expect(command(f.owner.id, f.archive)).rejects.toThrow('ACCOUNT_DISABLED');
  });

  it('cancels queued analysis in the archived workspace and leaves another workspace job usable', async () => {
    const f = await analysisFixture(true), job = await enqueueAnalysis(db, f.input, analysisEnv);
    const other = await enqueueAnalysis(db, { ...f.input, workspaceId: f.b!.id, idempotencyKey: randomUUID() }, analysisEnv);
    await command(f.owner.id, f.archive); await command(f.owner.id, f.archive);
    expect(await db.analysisJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'CANCELED', leaseVersion: job.leaseVersion + 1, leaseOwner: null, leaseExpiresAt: null, errorCode: 'WORKSPACE_ARCHIVED' });
    expect(await db.usageLedger.findUniqueOrThrow({ where: { id: job.usageLedgerId! } })).toMatchObject({ status: 'RELEASED' });
    let calls = 0; const provider = async () => { calls++; return providerResult(); };
    expect((await analysisWorkerTick(db, { workerId: 'archive-queued', jobId: job.id, provider })).status).toBe('IDLE'); expect(calls).toBe(0);
    expect((await analysisWorkerTick(db, { workerId: 'archive-other', jobId: other.id, provider })).status).toBe('SUCCEEDED'); expect(calls).toBe(1);
    expect(await db.entitlement.findFirstOrThrow({ where: { organizationId: f.organization.id, key: 'ANALYSES' } })).toMatchObject({ used: 1, reserved: 0 });
  });

  it('fences an already running worker and releases its reservation when the workspace is archived', async () => {
    const f = await analysisFixture(), job = await enqueueAnalysis(db, f.input, analysisEnv); let runningVersion = 0;
    const result = await analysisWorkerTick(db, { workerId: 'archive-running', jobId: job.id, provider: async () => {
      const running = await db.analysisJob.findUniqueOrThrow({ where: { id: job.id } }); expect(running.status).toBe('RUNNING'); runningVersion = running.leaseVersion;
      await command(f.owner.id, f.archive); return providerResult();
    } });
    expect(result.status).toBe('LEASE_LOST');
    expect(await db.analysisJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'CANCELED', leaseVersion: runningVersion + 1, leaseOwner: null, leaseExpiresAt: null, errorCode: 'WORKSPACE_ARCHIVED' });
    expect(await db.usageLedger.findUniqueOrThrow({ where: { id: job.usageLedgerId! } })).toMatchObject({ status: 'RELEASED' });
    expect(await db.analysisResult.count({ where: { analysisJobId: job.id } })).toBe(0);
    expect(await db.entitlement.findFirstOrThrow({ where: { organizationId: f.organization.id, key: 'ANALYSES' } })).toMatchObject({ used: 0, reserved: 0 });
  });

  it('rolls back analysis cancellation and reservation release when the archive transaction fails', async () => {
    const f = await analysisFixture(), job = await enqueueAnalysis(db, f.input, analysisEnv);
    await db.entitlement.updateMany({ where: { organizationId: f.organization.id, key: 'WORKSPACES' }, data: { used: 0 } });
    await expect(command(f.owner.id, f.archive)).rejects.toThrow('QUOTA_COUNT_MISMATCH');
    expect(await db.workspace.findUniqueOrThrow({ where: { id: f.workspace.id } })).toMatchObject({ archivedAt: null });
    expect(await db.analysisJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'QUEUED', leaseVersion: job.leaseVersion });
    expect(await db.usageLedger.findUniqueOrThrow({ where: { id: job.usageLedgerId! } })).toMatchObject({ status: 'RESERVED' });
    expect(await db.entitlement.findFirstOrThrow({ where: { organizationId: f.organization.id, key: 'ANALYSES' } })).toMatchObject({ used: 0, reserved: 1 });
  });

  it('does not claim a queued job belonging to an already archived workspace', async () => {
    const f = await analysisFixture(), job = await enqueueAnalysis(db, f.input, analysisEnv);
    await db.workspace.update({ where: { id: f.workspace.id }, data: { archivedAt: new Date() } });
    let calls = 0;
    expect((await analysisWorkerTick(db, { workerId: 'archive-claim-guard', jobId: job.id, provider: async () => { calls++; return providerResult(); } })).status).toBe('IDLE');
    expect(calls).toBe(0);
  });

  it('rechecks archive status before committing provider output even without a prior cancellation fence', async () => {
    const f = await analysisFixture(), job = await enqueueAnalysis(db, f.input, analysisEnv);
    const result = await analysisWorkerTick(db, { workerId: 'archive-finish-guard', jobId: job.id, provider: async () => {
      await db.workspace.update({ where: { id: f.workspace.id }, data: { archivedAt: new Date() } }); return providerResult();
    } });
    expect(result).toMatchObject({ status: 'FAILED', errorCode: 'WORKSPACE_ARCHIVED' });
    expect(await db.analysisResult.count({ where: { analysisJobId: job.id } })).toBe(0);
    expect(await db.usageLedger.findUniqueOrThrow({ where: { id: job.usageLedgerId! } })).toMatchObject({ status: 'RELEASED' });
    expect(await db.entitlement.findFirstOrThrow({ where: { organizationId: f.organization.id, key: 'ANALYSES' } })).toMatchObject({ used: 0, reserved: 0 });
  });

  it.each(['enqueue', 'retry'] as const)('rechecks workspace access after waiting for the organization lock during %s', async mode => {
    const f = await analysisFixture();
    const job = mode === 'retry' ? await enqueueAnalysis(db, f.input, analysisEnv) : null;
    if (job) await analysisWorkerTick(db, { workerId: 'archive-before-retry', jobId: job.id, provider: async () => { throw new Error('fixture'); } });
    let observed!: () => void, resume!: () => void, paused = false;
    const observedRead = new Promise<void>(resolve => { observed = resolve; }), mayResume = new Promise<void>(resolve => { resume = resolve; });
    // Pause a real PostgreSQL read response before the org lock, so archive can
    // commit between the initial permission check and the mutation's lock.
    const delayed = { $transaction: (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => db.$transaction(tx => fn(new Proxy(tx, {
      get(target, name) { return name === 'workspace' ? { ...target.workspace, findUnique: async (args: any) => {
        const row = await target.workspace.findUnique(args); if (!paused) { paused = true; observed(); await mayResume; } return row;
      } } : Reflect.get(target, name); },
    }))) } as PrismaClient;
    const pending = (mode === 'enqueue' ? enqueueAnalysis(delayed, f.input, analysisEnv) : retryAnalysis(delayed, { ...f.input, jobId: job!.id, attemptKey: 'after-archive' }, analysisEnv)).then(value => ({ value }), error => ({ error }));
    await observedRead;
    try { await command(f.owner.id, f.archive); } finally { resume(); }
    expect(await pending).toMatchObject({ error: { code: 'WORKSPACE_FORBIDDEN' } });
    expect(await db.analysisJob.count({ where: { workspaceId: f.workspace.id, status: { in: ['QUEUED', 'RUNNING'] } } })).toBe(0);
    expect(await db.entitlement.findFirstOrThrow({ where: { organizationId: f.organization.id, key: 'ANALYSES' } })).toMatchObject({ used: 0, reserved: 0 });
  });
});
