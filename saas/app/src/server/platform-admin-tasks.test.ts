import { describe, expect, it, vi } from 'vitest';
import { assertApplicationTask, parsePlatformAdminTaskAction, applyPlatformAdminTask } from './platform-admin-tasks';
const userId = '11111111-1111-4111-8111-111111111111'; const taskId = '22222222-2222-4222-8222-222222222222';
describe('application collection task administration guards', () => {
  it('rejects native archives even when an administrator asks to activate or cancel them', () => {
    expect(() => assertApplicationTask({ createdByUserId: null, dataSource: { adapterVersion: 'meta-dom-1' } })).toThrow('ARCHIVE_CONTROL_FORBIDDEN');
    expect(() => assertApplicationTask({ createdByUserId: userId, dataSource: { adapterVersion: 'google-native-1' } })).toThrow('ARCHIVE_CONTROL_FORBIDDEN');
    expect(() => assertApplicationTask({ createdByUserId: userId, dataSource: { adapterVersion: 'meta-dom-1' } })).not.toThrow();
  });
  it('requires reasons and validates queue idempotency and bounded schedule input', () => {
    expect(() => parsePlatformAdminTaskAction({ type: 'SET_TASK_STATUS', taskId, status: 'ACTIVE', reason: '' })).toThrow('INVALID_ADMIN_TASK_ACTION');
    expect(() => parsePlatformAdminTaskAction({ type: 'ENQUEUE_TASK', taskId, idempotencyKey: 'bad key', reason: '查询' })).toThrow('INVALID_ADMIN_TASK_ACTION');
    expect(() => parsePlatformAdminTaskAction({ type: 'CANCEL_RUN', runId: taskId, confirmationRunId: userId, reason: '取消' })).toThrow('INVALID_ADMIN_TASK_ACTION');
    expect(() => parsePlatformAdminTaskAction({ type: 'CREATE_TASK', sourceId: taskId, name: '测试', query: {}, intervalMinutes: 2000, reason: '查询' })).toThrow('INVALID_ADMIN_TASK_ACTION');
  });
  it('rejects nonadmin before reading or mutating an application task', async () => {
    const tx: any = { user: { findUnique: vi.fn(async () => ({ id: userId, isAdmin: false, disabledAt: null })) }, $queryRaw: vi.fn(), collectionTask: { update: vi.fn() } };
    const db: any = { $transaction: (fn: any) => fn(tx) };
    await expect(applyPlatformAdminTask(db, userId, { type: 'SET_TASK_STATUS', taskId, status: 'PAUSED', reason: '维护' })).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
    expect(tx.$queryRaw).not.toHaveBeenCalled(); expect(tx.collectionTask.update).not.toHaveBeenCalled();
  });
});
