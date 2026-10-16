import { describe, expect, it } from 'vitest';
import { queryPlatformAdminUsers, runPlatformAdminUsersCommand } from './platform-admin-users';

const adminId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const targetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const organizationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const now = new Date('2026-10-11T04:00:00Z');

function database(options: { isAdmin?: boolean; disabled?: boolean; userRows?: any[]; organizationRows?: any[]; quotas?: any[]; identities?: any[] } = {}) {
  const sql: Array<{ text: string; values: unknown[] }> = [];
  const audit: any[] = [];
  const quota = { id: 'quota-id', organizationId, key: 'ANALYSES', used: 7, reserved: 2, limit: 10, source: 'PLAN', version: 0, validFrom: new Date('2026-10-01'), validUntil: new Date('2026-11-01'), periodStart: new Date('2026-10-01'), periodEnd: new Date('2026-11-01') };
  const target = { id: targetId, email: 'target@example.test', isAdmin: false, disabledAt: null };
  const tx: any = {
    user: { findUnique: async ({ where }: any) => where.id === adminId ? { id: adminId, email: 'admin@example.test', isAdmin: options.isAdmin ?? true, disabledAt: options.disabled ? now : null } : target,
      update: async ({ data }: any) => { Object.assign(target, data); return { id: targetId, disabledAt: target.disabledAt }; }, count: async () => 1 },
    organization: { count: async () => (options.organizationRows ?? []).length, findMany: async () => options.organizationRows ?? [], findUnique: async () => null },
    organizationMember: { findMany: async () => [], count: async () => 1 },
    authIdentity: { findMany: async () => options.identities ?? (options.userRows ?? []).map(row => ({ providerName: 'email', providerData: '{"isEmailVerified":true}', auth: { userId: row.id } })) },
    session: { deleteMany: async () => ({ count: 2 }) }, authLink: { updateMany: async () => ({ count: 1 }) },
    entitlement: { findFirst: async () => ({ ...quota }), update: async ({ data }: any) => { Object.assign(quota, data, { version: quota.version + 1 }); return quota; } },
    auditEvent: { create: async ({ data }: any) => { audit.push(data); return data; } },
    $executeRaw: async () => 1,
    $queryRaw: async (query: any, ...values: unknown[]) => {
      const text = query.text ?? query.join?.('?') ?? String(query); sql.push({ text, values: Array.isArray(query.values) ? query.values : values });
      if (text.includes('clock_timestamp')) return [{ now }];
      if (text.includes('FOR UPDATE')) return [{ id: organizationId }];
      if (text.includes('FROM "Entitlement"')) return options.quotas ?? [];
      if (text.includes('GROUP BY')) return [];
      if (/^SELECT COUNT\(\*\)/.test(text.trim())) return [{ count: (options.userRows ?? []).length }];
      return options.userRows ?? [];
    },
  };
  return { db: { ...tx, $transaction: async (fn: any) => fn(tx) } as any, sql, audit, quota, target };
}

describe('platform administrator user and organization management', () => {
  it('rechecks live role and account validity for every query and command', async () => {
    for (const options of [{ isAdmin: false }, { disabled: true }]) {
      const { db } = database(options);
      const code = options.disabled ? 'ACCOUNT_DISABLED' : 'PLATFORM_ADMIN_REQUIRED';
      await expect(queryPlatformAdminUsers(db, adminId, { section: 'users' })).rejects.toMatchObject({ code });
      await expect(runPlatformAdminUsersCommand(db, adminId, { type: 'ADJUST_ENTITLEMENT', organizationId, key: 'ANALYSES', limit: 20, reason: '支持调整' })).rejects.toMatchObject({ code });
    }
  });

  it('returns bounded user DTOs and binds cursor to filters and administrator', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, createdAt: new Date('2026-10-10T04:00:00Z'), email: `person-${i}@example.test`, displayName: 'Person', disabledAt: null, isAdmin: false, emailVerified: true, organizationCount: 2n, lastActivityAt: now, hidden: 'must-not-leak' }));
    const { db, sql } = database({ userRows: rows });
    const page = await queryPlatformAdminUsers(db, adminId, { section: 'users', search: 'Person', status: 'VERIFIED', from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' });
    expect(page.rows).toHaveLength(20);
    expect(page.rows[0]).toMatchObject({ organizationCount: 2, emailVerified: true, lastActivityAt: now });
    expect(JSON.stringify(page)).not.toContain('must-not-leak');
    expect(page.nextCursor).toBeTruthy();
    expect(sql.some(item => item.text.includes('ANY('))).toBe(true);
    expect(sql.some(item => item.values.includes('%Person%'))).toBe(true);
    await expect(queryPlatformAdminUsers(db, adminId, { section: 'users', cursor: page.nextCursor, search: 'Different' })).rejects.toMatchObject({ code: 'INVALID_ADMIN_CURSOR' });
  });

  it('shows only currently effective quotas and does not expose provider secrets', async () => {
    const org = { id: organizationId, name: 'Example', status: 'ACTIVE', createdAt: now, _count: { members: 3 }, subscription: { status: 'CANCELED', currentPeriodStart: now, currentPeriodEnd: null, trialEndsAt: null, cancelAtPeriodEnd: false, planVersion: { name: 'Plan', version: 2 }, providerSubscriptionId: 'do-not-expose', providerCustomerId: 'private-provider' } };
    const quota = { organizationId, key: 'ANALYSES', limit: 0, used: 4, reserved: 2, source: 'MANUAL', periodStart: now, periodEnd: null, validFrom: now, validUntil: null };
    const { db, sql } = database({ organizationRows: [org], quotas: [quota] });
    const page = await queryPlatformAdminUsers(db, adminId, { section: 'organizations' });
    expect(page.rows[0]).toMatchObject({ subscription: { status: 'CANCELED' }, entitlements: expect.arrayContaining([{ key: 'ANALYSES', current: expect.objectContaining({ limit: 0, used: 4, reserved: 2 }) }, { key: 'MEMBERS', current: null }]) });
    expect(JSON.stringify(page)).not.toContain('do-not-expose');
    expect(JSON.stringify(page)).not.toContain('private-provider');
    const statement = sql.find(item => item.text.includes('FROM "Entitlement"'))!.text;
    expect(statement).toContain('"validFrom" <='); expect(statement).toContain('"validUntil" >'); expect(statement).toContain('"periodStart" DESC');
  });

  it('requires reason and exact email confirmation before disabling an account', async () => {
    const { db, audit, target } = database();
    for (const confirmationEmail of [undefined, 'TARGET@example.test', 'target@example.test ']) {
      await expect(runPlatformAdminUsersCommand(db, adminId, { type: 'SET_ACCOUNT_STATUS', targetUserId: targetId, disabled: true, reason: '违规账号', confirmationEmail })).rejects.toMatchObject({ code: 'ACCOUNT_CONFIRMATION_MISMATCH' });
    }
    expect(target.disabledAt).toBeNull(); expect(audit).toHaveLength(0);
    await runPlatformAdminUsersCommand(db, adminId, { type: 'SET_ACCOUNT_STATUS', targetUserId: targetId, disabled: true, reason: '违规账号', confirmationEmail: 'target@example.test' });
    expect(target.disabledAt).toBeInstanceOf(Date);
    expect(audit[0]).toMatchObject({ action: 'USER_DISABLED', actorUserId: adminId, metadata: { reason: '违规账号', sessionsRevoked: 2 } });
  });

  it('keeps used and reserved quantities when lowering a quota and writes before/after audit', async () => {
    const { db, quota, audit } = database();
    await expect(runPlatformAdminUsersCommand(db, adminId, { type: 'ADJUST_ENTITLEMENT', organizationId, key: 'ANALYSES', limit: 4, reason: ' ' })).rejects.toMatchObject({ code: 'INVALID_ADMIN_COMMAND' });
    await runPlatformAdminUsersCommand(db, adminId, { type: 'ADJUST_ENTITLEMENT', organizationId, key: 'ANALYSES', limit: 4, reason: ' 客户降级 ' });
    expect(quota).toMatchObject({ limit: 4, used: 7, reserved: 2, source: 'MANUAL', version: 1 });
    expect(audit[0]).toMatchObject({ action: 'ENTITLEMENT_ADJUSTED', metadata: { before: 10, after: 4, reason: '客户降级' } });
  });

  it('rejects invalid date ranges and unknown scope fields', async () => {
    const { db } = database();
    for (const query of [{ section: 'users', from: '2026-11-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }, { section: 'users', from: '2026-10-01T00:00:00.000Z', to: '2026-10-01T00:00:00Z' }, { section: 'users', workspaceId: organizationId }, { section: 'users', status: 'oops' }]) {
      await expect(queryPlatformAdminUsers(db, adminId, query)).rejects.toMatchObject({ code: 'INVALID_ADMIN_QUERY' });
    }
  });

  it('treats malformed identity JSON and unadmitted Google identities as unverified without leaking credential fields', async () => {
    const user = { id: targetId, createdAt: now, email: 'target@example.test', displayName: null, disabledAt: null, isAdmin: false, organizationCount: 0, lastActivityAt: null };
    for (const providerData of ['bad-json', '{"admitted":false,"version":1,"verifiedEmail":"target@example.test","secret":"password-hash"}']) {
      const { db } = database({ userRows: [user], identities: [{ providerName: 'google', providerData, auth: { userId: targetId } }] });
      const page = await queryPlatformAdminUsers(db, adminId, { section: 'users' });
      expect(page.rows[0]).toMatchObject({ emailVerified: false });
      expect(JSON.stringify(page)).not.toContain('password-hash');
    }
  });
});
