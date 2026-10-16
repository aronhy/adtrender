/**
 * Operator-controlled synthetic test probe. The controller prepends `const input`.
 * stdout is one PRIVATE JSON envelope; only its report may enter public evidence.
 * This verifies persisted Wasp sessions and research, not signup/login or providers.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

let db;
let state = typeof input === 'object' && input ? input.state ?? null : null;
const phase = typeof input === 'object' && input ? input.phase : null;
const phases = ['preflight', 'seed', 'verify', 'cleanup'];
const roles = ['ownerA', 'ownerB', 'viewer'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const demand = value => { if (!value) throw new Error('PROBE_ASSERTION_FAILED'); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const businessModels = ['user', 'auth', 'authIdentity', 'session', 'organization', 'organizationMember', 'workspace', 'workspaceMember', 'invitation', 'subscription', 'entitlement', 'usageLedger', 'advertiser', 'ad', 'adObservation', 'mediaObject', 'folder', 'savedAd', 'note', 'privateFile', 'analysisJob', 'analysisResult', 'emailDelivery', 'authLink', 'oAuthCodeUse', 'accountSupportRequest', 'feedback', 'productEvent', 'auditEvent', 'collectionTask', 'collectionRun', 'runItem', 'billingEvent'];
let apiOrigin;
let expectedDatabaseRole;
let expectedDatabaseName;
let report = null;
let ok = false;

function email(role) { return `research-probe-${state.runId}-${role.toLowerCase()}@example.test`; }
function orgName(key) { return `合成持久化验收 ${state.runId} ${key}`; }
function workspaceName(key) { return `合成研究工作区 ${state.runId} ${key}`; }
function folderName() { return `合成文件夹 ${state.runId}`; }
function noteBody(edited = true) { return `合成验收笔记 ${state.runId} ${edited ? '已编辑' : '初稿'}`; }
function sourceKey() { return `research-probe-${state.runId}`; }
function adBody() { return `合成公开广告 ${state.runId}，仅验证数据库持久化，非真实采集。`; }
function validateInput() {
  demand(phases.includes(phase));
  demand(state && uuid.test(state.runId) && uuid.test(state.sourceId) && uuid.test(state.adId));
  for (const role of roles) {
    const user = state.users?.[role];
    demand(user && uuid.test(user.id) && uuid.test(user.authId) && /^[a-f0-9]{64,128}$/.test(user.sessionId));
  }
  const ids = [state.runId, state.sourceId, state.adId, ...roles.flatMap(role => [state.users[role].id, state.users[role].authId])];
  demand(new Set(ids).size === ids.length && new Set(roles.map(role => state.users[role].sessionId)).size === roles.length);
  const target = new URL(process.env.DATABASE_URL ?? '');
  demand(['postgres:', 'postgresql:'].includes(target.protocol));
  const remoteTest = target.pathname === '/ad_research_test' && decodeURIComponent(target.username) === 'saas_app';
  const localTest = ['127.0.0.1', 'localhost'].includes(target.hostname) && /^\/saas_research_persistence_test_[a-f0-9]{32}$/.test(target.pathname) && decodeURIComponent(target.username) === 'saas_local';
  demand(remoteTest || localTest);
  expectedDatabaseRole = remoteTest ? 'saas_app' : 'saas_local';
  expectedDatabaseName = target.pathname.slice(1);
  const api = new URL(input.apiOrigin ?? 'http://127.0.0.1:3001');
  demand(api.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(api.hostname) && !api.username && !api.password && api.pathname === '/' && !api.search && !api.hash);
  apiOrigin = api.origin;
  if (phase !== 'preflight') demand(state.baseline?.version === 1 && state.baseline.runId === state.runId && Array.isArray(state.baseline.plans) && Array.isArray(state.baseline.sources));
}
function providersClosed() {
  for (const key of ['BILLING_ENABLED', 'LIVE_BILLING_ENABLED', 'PUBLIC_PRICING_ENABLED', 'GOOGLE_AUTH_ENABLED']) demand([undefined, '', 'false'].includes(process.env[key]));
  for (const key of ['OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) demand(!process.env[key]?.trim());
}
async function counts(client) { return Object.fromEntries(await Promise.all(businessModels.map(async key => [key, await client[key].count()]))); }
async function catalog(client) {
  const plans = await client.planVersion.findMany({ orderBy: { id: 'asc' } });
  const sources = await client.dataSource.findMany({ orderBy: { id: 'asc' } });
  return { plans: plans.map(row => ({ id: row.id, sha256: digest(row) })), sources: sources.map(row => ({ id: row.id, sha256: digest(row) })) };
}
async function operation(name, args, role, expected = 200) {
  const response = await fetch(`${apiOrigin}/operations/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(role ? { authorization: `Bearer ${state.users[role].sessionId}` } : {}) },
    body: JSON.stringify({ json: args }), signal: AbortSignal.timeout(15_000), redirect: 'error',
  });
  demand(response.status === expected);
  const value = await response.json();
  if (expected === 200) { demand(value && Object.hasOwn(value, 'json')); return value.json; }
  return null;
}
const command = (args, role, expected) => operation('app-command', args, role, expected);
const appState = (workspaceId, role, expected) => operation('get-app-state', { workspaceId }, role, expected);

async function preflight() {
  providersClosed();
  const baseline = await db.$transaction(async tx => {
    const current = await counts(tx); demand(Object.values(current).every(value => value === 0));
    const meta = await tx.dataSource.findUnique({ where: { key: 'meta_ad_library' } });
    demand(meta?.status === 'PAUSED');
    demand(await tx.dataSource.count({ where: { status: 'ACTIVE' } }) === 0);
    return { version: 1, runId: state.runId, checkedAt: new Date().toISOString(), counts: current, ...await catalog(tx) };
  }, { isolationLevel: 'RepeatableRead' });
  state.baseline = baseline;
  return { zeroCustomerAndWorkQueues: true, providersDisabled: true, metaSourcePaused: true, preservedPlanCount: baseline.plans.length, externalProvidersUsed: false };
}

async function inspectUsers(client) {
  const found = [];
  for (const role of roles) {
    const expected = state.users[role];
    const user = await client.user.findUnique({ where: { id: expected.id }, include: { auth: { include: { identities: true, sessions: true } } } });
    if (!user) continue;
    demand(user.email === email(role) && user.displayName === `合成持久化验收 ${role}` && !user.isAdmin && !user.disabledAt);
    demand(user.auth?.id === expected.authId && user.auth.userId === expected.id);
    demand(user.auth.identities.length === 1 && user.auth.identities[0].providerName === 'email' && user.auth.identities[0].providerUserId === email(role));
    demand(JSON.parse(user.auth.identities[0].providerData).isEmailVerified === true);
    demand(user.auth.sessions.length === 1 && user.auth.sessions[0].id === expected.sessionId);
    found.push(user);
  }
  return found;
}

// Re-discover committed scopes from the preflight's exact user IDs AND run names.
// This also works when an API response or the seed phase's stdout was lost.
async function discover(client) {
  const users = await inspectUsers(client);
  const organizations = {};
  for (const [key, role] of [['a', 'ownerA'], ['b', 'ownerB']]) {
    const rows = await client.organization.findMany({ where: { name: orgName(key), members: { some: { userId: state.users[role].id, role: 'OWNER' } } }, include: { members: true, workspaces: true, subscription: true, entitlements: true, auditEvents: true } });
    demand(rows.length <= 1);
    const org = rows[0]; if (!org) continue;
    demand(org.status === 'ACTIVE' && org.workspaces.length === 1 && org.workspaces[0].name === workspaceName(key) && !org.workspaces[0].archivedAt);
    const allowed = key === 'a' ? [state.users.ownerA.id, state.users.viewer.id] : [state.users.ownerB.id];
    demand(org.members.every(member => allowed.includes(member.userId) && member.role === (member.userId === state.users[role].id ? 'OWNER' : 'MEMBER')));
    demand(org.members.filter(member => member.role === 'OWNER').length === 1);
    demand(org.subscription?.provider === 'TRIAL' && !org.subscription.providerCustomerId && !org.subscription.providerSubscriptionId && !org.subscription.scheduledPlanVersionId);
    demand(org.entitlements.length === 4 && new Set(org.entitlements.map(row => row.key)).size === 4 && org.entitlements.every(row => ['WORKSPACES', 'MEMBERS', 'SAVED_ADS', 'ANALYSES'].includes(row.key) && row.source === 'PLAN' && row.reserved === 0));
    demand(org.auditEvents.length === 1 && org.auditEvents[0].action === 'ORGANIZATION_CREATED' && org.auditEvents[0].actorUserId === state.users[role].id && org.auditEvents[0].targetId === org.id);
    organizations[key] = { id: org.id, workspaceId: org.workspaces[0].id, ownerMemberId: org.members.find(member => member.role === 'OWNER').id, subscriptionId: org.subscription.id, entitlementIds: org.entitlements.map(row => row.id), planId: org.subscription.planVersionId, auditIds: org.auditEvents.map(row => row.id) };
  }
  const orgIds = Object.values(organizations).map(org => org.id);
  const memberships = await client.organizationMember.findMany({ where: { userId: { in: users.map(user => user.id) } } });
  demand(memberships.every(member => orgIds.includes(member.organizationId)));
  state.organizations = organizations;
  state.createdPlanIds = [...new Set(Object.values(organizations).map(org => org.planId).filter(id => !state.baseline.plans.some(plan => plan.id === id)))];
  return organizations;
}

async function seed() {
  providersClosed();
  demand((await db.user.findMany({ select: { id: true } })).every(user => roles.some(role => state.users[role].id === user.id)));
  const { hashPassword } = await import('wasp/auth/password');
  const passwordHash = await hashPassword(randomBytes(48).toString('base64url'));
  await db.$transaction(async tx => {
    await inspectUsers(tx);
    for (const role of roles) {
      const user = state.users[role];
      if (await tx.user.findUnique({ where: { id: user.id }, select: { id: true } })) continue;
      await tx.user.create({ data: { id: user.id, email: email(role), displayName: `合成持久化验收 ${role}`, auth: { create: { id: user.authId, identities: { create: { providerName: 'email', providerUserId: email(role), providerData: JSON.stringify({ hashedPassword: passwordHash, isEmailVerified: true, emailVerificationSentAt: null, passwordResetSentAt: null }) } }, sessions: { create: { id: user.sessionId, expiresAt: new Date(Date.now() + 3_600_000) } } } } } });
    }
    const source = await tx.dataSource.findUnique({ where: { id: state.sourceId } });
    if (source) demand(source.key === sourceKey() && source.status === 'DISABLED' && source.adapterVersion === 'synthetic-research-probe-1');
    else await tx.dataSource.create({ data: { id: state.sourceId, key: sourceKey(), name: `合成持久化验收 ${state.runId}`, status: 'DISABLED', adapterVersion: 'synthetic-research-probe-1' } });
    const ad = await tx.ad.findUnique({ where: { id: state.adId } });
    if (ad) demand(ad.dataSourceId === state.sourceId && ad.sourceAdId === sourceKey() && ad.body === adBody());
    else await tx.ad.create({ data: { id: state.adId, dataSourceId: state.sourceId, sourceAdId: sourceKey(), sourceUrl: 'https://example.test/synthetic-research-probe', body: adBody(), fieldProvenance: { synthetic: true, runId: state.runId }, publisherPlatforms: [] } });
  });
  await discover(db);
  for (const [key, role] of [['a', 'ownerA'], ['b', 'ownerB']]) {
    if (state.organizations[key]) continue;
    const created = await command({ type: 'CREATE_ORGANIZATION', name: orgName(key), workspaceName: workspaceName(key) }, role);
    demand(uuid.test(created.workspaceId));
    await discover(db); demand(state.organizations[key]?.workspaceId === created.workspaceId);
  }
  const a = state.organizations.a;
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${a.id} FOR UPDATE`;
    const existing = await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId: a.id, userId: state.users.viewer.id } } });
    if (!existing) {
      const now = new Date();
      const quota = await tx.entitlement.findFirst({ where: { organizationId: a.id, key: 'MEMBERS', validFrom: { lte: now }, OR: [{ validUntil: null }, { validUntil: { gt: now } }] }, orderBy: { periodStart: 'desc' } });
      demand(quota && quota.used + quota.reserved < quota.limit);
      await tx.entitlement.update({ where: { id: quota.id }, data: { used: { increment: 1 }, version: { increment: 1 } } });
      const member = await tx.organizationMember.create({ data: { organizationId: a.id, userId: state.users.viewer.id, role: 'MEMBER' } });
      const workspaceMember = await tx.workspaceMember.create({ data: { organizationId: a.id, workspaceId: a.workspaceId, userId: state.users.viewer.id, role: 'VIEWER' } });
      state.viewerMemberId = member.id; state.viewerWorkspaceMemberId = workspaceMember.id;
    } else demand(existing.role === 'MEMBER');
  });
  await command({ type: 'SAVE_AD', workspaceId: a.workspaceId, adId: state.adId }, 'ownerA');
  await command({ type: 'SAVE_AD', workspaceId: a.workspaceId, adId: state.adId }, 'ownerA');
  await command({ type: 'CREATE_FOLDER', workspaceId: a.workspaceId, name: folderName() }, 'ownerA');
  let current = await appState(a.workspaceId, 'ownerA');
  demand(current.research.savedAds.length === 1 && current.research.folders.length === 1);
  state.savedAdId = current.research.savedAds[0].id; state.folderId = current.research.folders[0].id;
  await command({ type: 'MOVE_SAVED_AD', workspaceId: a.workspaceId, savedAdId: state.savedAdId, folderId: state.folderId }, 'ownerA');
  if (current.research.notes.length === 0) await command({ type: 'SAVE_NOTE', workspaceId: a.workspaceId, savedAdId: state.savedAdId, body: noteBody(false) }, 'ownerA');
  current = await appState(a.workspaceId, 'ownerA'); demand(current.research.notes.length === 1);
  state.noteId = current.research.notes[0].id;
  await command({ type: 'SAVE_NOTE', workspaceId: a.workspaceId, savedAdId: state.savedAdId, noteId: state.noteId, body: noteBody() }, 'ownerA');
  return { syntheticUsers: 3, organizations: 2, savedAds: 1, folders: 1, editedNotes: 1, nativeApiWrites: true, realSignupOrLoginTested: false, emailQueued: false, externalProvidersUsed: false };
}

async function verify() {
  providersClosed();
  const discovered = await discover(db); demand(discovered.a && discovered.b);
  const a = discovered.a, b = discovered.b;
  const checkResearch = current => {
    demand(current.selectedWorkspace.id === a.workspaceId && current.selectedWorkspace.organizationId === a.id);
    demand(current.overview.savedCount === 1 && current.overview.analysisCount === 0);
    demand(current.research.savedAds.length === 1 && current.research.savedAds[0].id === state.savedAdId && current.research.savedAds[0].adId === state.adId && current.research.savedAds[0].folderId === state.folderId);
    demand(current.research.folders.length === 1 && current.research.folders[0].id === state.folderId && current.research.folders[0].name === folderName());
    demand(current.research.notes.length === 1 && current.research.notes[0].id === state.noteId && current.research.notes[0].savedAdId === state.savedAdId && current.research.notes[0].body === noteBody());
  };
  const owner = await appState(a.workspaceId, 'ownerA'); demand(owner.role === 'OWNER'); checkResearch(owner);
  await command({ type: 'SAVE_AD', workspaceId: a.workspaceId, adId: state.adId }, 'ownerA'); checkResearch(await appState(a.workspaceId, 'ownerA'));
  const quota = await db.entitlement.findMany({ where: { organizationId: a.id, key: 'SAVED_ADS' } }); demand(quota.length === 1 && quota[0].used === 1 && quota[0].reserved === 0);
  const viewer = await appState(a.workspaceId, 'viewer'); demand(viewer.role === 'VIEWER'); checkResearch(viewer);
  const other = await appState(b.workspaceId, 'ownerB'); demand(other.research.savedAds.length === 0 && other.research.notes.length === 0 && other.research.folders.length === 0);
  await appState(b.workspaceId, 'ownerA', 403); await appState(a.workspaceId, 'ownerB', 403); await appState(b.workspaceId, 'viewer', 403);
  await command({ type: 'SAVE_NOTE', workspaceId: b.workspaceId, savedAdId: state.savedAdId, body: noteBody() }, 'ownerB', 404);
  await command({ type: 'SAVE_AD', workspaceId: a.workspaceId, adId: state.adId }, 'viewer', 403);
  await command({ type: 'SAVE_NOTE', workspaceId: a.workspaceId, savedAdId: state.savedAdId, body: noteBody() }, 'viewer', 403);
  await appState(a.workspaceId, null, 401);
  const page = await operation('get-research-page', { workspaceId: a.workspaceId, kind: 'saved', folderId: state.folderId }, 'ownerA');
  demand(page.total === 1 && page.savedAds[0].id === state.savedAdId && page.savedAds[0].notes.length === 1 && page.savedAds[0].notes[0].body === noteBody());
  checkResearch(await appState(a.workspaceId, 'ownerA'));
  demand(await db.emailDelivery.count() === 0 && await db.analysisJob.count() === 0 && await db.collectionRun.count() === 0);
  demand((await db.dataSource.findUnique({ where: { key: 'meta_ad_library' } }))?.status === 'PAUSED');
  return { nativeSessionsValid: true, organizations: 2, savedAds: 1, folders: 1, editedNotes: 1, stableRecordIds: true, duplicateSaveIdempotent: true, savedQuotaUsed: 1, folderResearchQueryVerified: true, crossOrganizationReadDenied: true, crossOrganizationNoteDenied: true, viewerReadAllowed: true, viewerWriteDenied: true, unauthenticatedDenied: true, emailQueued: false, externalProvidersUsed: false };
}

async function cleanup() {
  const result = await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1748210449)`;
    const organizations = await discover(tx);
    const orgIds = Object.values(organizations).map(org => org.id);
    const userIds = roles.map(role => state.users[role].id);
    for (const orgId of [...orgIds].sort()) await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${orgId} FOR UPDATE`;
    const a = organizations.a;
    for (const model of ['invitation', 'usageLedger', 'privateFile', 'analysisJob', 'analysisResult', 'emailDelivery', 'feedback', 'productEvent', 'billingEvent']) demand(await tx[model].count({ where: { organizationId: { in: orgIds } } }) === 0);
    demand(await tx.accountSupportRequest.count({ where: { userId: { in: userIds } } }) === 0);
    demand(await tx.oAuthCodeUse.count({ where: { userId: { in: userIds } } }) === 0);
    demand(await tx.authLink.count({ where: { recipientEmail: { in: roles.map(email) } } }) === 0);
    const saved = await tx.savedAd.findMany({ where: { organizationId: { in: orgIds } } });
    demand(saved.length <= 1 && saved.every(row => a && row.organizationId === a.id && row.workspaceId === a.workspaceId && row.adId === state.adId && row.savedByUserId === state.users.ownerA.id));
    const folders = await tx.folder.findMany({ where: { organizationId: { in: orgIds } } });
    demand(folders.length <= 1 && folders.every(row => a && row.organizationId === a.id && row.workspaceId === a.workspaceId && row.name === folderName()));
    const notes = await tx.note.findMany({ where: { organizationId: { in: orgIds } } });
    demand(notes.length <= 1 && notes.every(row => a && row.organizationId === a.id && row.workspaceId === a.workspaceId && row.savedAdId === saved[0]?.id && row.authorUserId === state.users.ownerA.id && [noteBody(false), noteBody()].includes(row.body)));
    const workspaceMembers = await tx.workspaceMember.findMany({ where: { organizationId: { in: orgIds } } });
    demand(workspaceMembers.length <= 1 && workspaceMembers.every(row => a && row.organizationId === a.id && row.workspaceId === a.workspaceId && row.userId === state.users.viewer.id && row.role === 'VIEWER'));
    const source = await tx.dataSource.findUnique({ where: { id: state.sourceId } });
    if (source) demand(source.key === sourceKey() && source.status === 'DISABLED' && source.adapterVersion === 'synthetic-research-probe-1');
    const ad = await tx.ad.findUnique({ where: { id: state.adId } });
    if (ad) demand(source && ad.dataSourceId === state.sourceId && ad.sourceAdId === sourceKey() && ad.body === adBody() && ad.fieldProvenance?.runId === state.runId);
    if (source) demand(await tx.ad.count({ where: { dataSourceId: source.id } }) === (ad ? 1 : 0));
    if (ad) demand(await tx.savedAd.count({ where: { adId: ad.id } }) === saved.length);
    const plansToRemove = [];
    for (const id of state.createdPlanIds) {
      const plan = await tx.planVersion.findUniqueOrThrow({ where: { id } });
      demand(/^trial-[a-f0-9]{16}$/.test(plan.key) && !plan.providerPriceId && !plan.publicConfirmedAt && !plan.verifiedProviderMode);
      demand(await tx.subscription.count({ where: { OR: [{ planVersionId: id }, { scheduledPlanVersionId: id }], organizationId: { notIn: orgIds } } }) === 0);
      plansToRemove.push(id);
    }
    // RESTRICT relationships require this order. Last-owner triggers run at commit,
    // by which time these exact organizations no longer exist; no constraint bypass.
    await tx.note.deleteMany({ where: { id: { in: notes.map(row => row.id) }, organizationId: { in: orgIds } } });
    await tx.savedAd.deleteMany({ where: { id: { in: saved.map(row => row.id) }, organizationId: { in: orgIds } } });
    await tx.folder.deleteMany({ where: { id: { in: folders.map(row => row.id) }, organizationId: { in: orgIds } } });
    await tx.auditEvent.deleteMany({ where: { id: { in: Object.values(organizations).flatMap(org => org.auditIds) }, organizationId: { in: orgIds } } });
    await tx.workspaceMember.deleteMany({ where: { id: { in: workspaceMembers.map(row => row.id) }, userId: state.users.viewer.id } });
    await tx.workspace.deleteMany({ where: { id: { in: Object.values(organizations).map(org => org.workspaceId) }, organizationId: { in: orgIds } } });
    await tx.entitlement.deleteMany({ where: { id: { in: Object.values(organizations).flatMap(org => org.entitlementIds) }, organizationId: { in: orgIds } } });
    await tx.subscription.deleteMany({ where: { id: { in: Object.values(organizations).map(org => org.subscriptionId) }, organizationId: { in: orgIds } } });
    const members = await tx.organizationMember.findMany({ where: { organizationId: { in: orgIds }, userId: { in: userIds } }, select: { id: true } });
    await tx.organizationMember.deleteMany({ where: { id: { in: members.map(row => row.id) }, organizationId: { in: orgIds }, userId: { in: userIds } } });
    await tx.organization.deleteMany({ where: { id: { in: orgIds }, name: { in: ['a', 'b'].map(orgName) } } });
    if (ad) await tx.ad.delete({ where: { id: ad.id } });
    if (source) await tx.dataSource.delete({ where: { id: source.id } });
    await tx.planVersion.deleteMany({ where: { id: { in: plansToRemove } } });
    const secret = process.env.RATE_LIMIT_HMAC_SECRET ?? process.env.JWT_SECRET;
    demand(typeof secret === 'string' && secret.length > 0);
    const hashes = userIds.map(id => createHmac('sha256', secret).update(id).digest('hex'));
    const buckets = await tx.rateLimitBucket.findMany({ where: { principalHash: { in: hashes }, scope: { in: ['ACTION', 'CREATE_ORGANIZATION'] } }, select: { id: true } });
    await tx.rateLimitBucket.deleteMany({ where: { id: { in: buckets.map(row => row.id) }, principalHash: { in: hashes }, scope: { in: ['ACTION', 'CREATE_ORGANIZATION'] } } });
    // Wasp's User -> Auth -> AuthIdentity/Session cascade revokes every fixture token.
    for (const role of roles) await tx.user.deleteMany({ where: { id: state.users[role].id, email: email(role) } });
    const current = await counts(tx); demand(JSON.stringify(current) === JSON.stringify(state.baseline.counts));
    const preserved = await catalog(tx); demand(JSON.stringify(preserved.plans) === JSON.stringify(state.baseline.plans) && JSON.stringify(preserved.sources) === JSON.stringify(state.baseline.sources));
    return { fixtureRecordsRemaining: 0, fixtureSessionsRemaining: 0, businessCountsRestored: true, priorPlansAndSourcesUnchanged: true, removedNewTrialPlans: plansToRemove.length, exactFixtureRateBucketsRemoved: buckets.length, deferredOwnerConstraintPreserved: true, externalProvidersUsed: false };
  }, { maxWait: 10_000, timeout: 30_000 });
  for (const role of roles) await operation('get-app-state', {}, role, 401);
  return { ...result, revokedSessionApiRejected: true };
}

try {
  validateInput();
  const { PrismaClient } = await import('@prisma/client');
  db = new PrismaClient({ log: [] });
  const [identity] = await db.$queryRaw`SELECT current_user AS role, current_database() AS name`;
  demand(identity?.role === expectedDatabaseRole && identity?.name === expectedDatabaseName);
  report = await ({ preflight, seed, verify, cleanup })[phase]();
  ok = true;
} catch {
  report = null;
} finally {
  if (db) { try { await db.$disconnect(); } catch { ok = false; report = null; } }
  process.stdout.write(JSON.stringify({ ok, state, report, errorCode: ok ? null : phases.includes(phase) ? `RESEARCH_PROBE_${phase.toUpperCase()}_FAILED` : 'RESEARCH_PROBE_INVALID_INPUT' }) + '\n');
}
