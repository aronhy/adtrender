import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { queueEmail, deliverEmailBatch } from './email';
import { emailRetryEligibility, runPlatformAdminActivityCommand } from './platform-admin-activity';

const url = process.env.SAAS_TEST_DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
const key = 'a'.repeat(64);
const rejected = async () => { throw Object.assign(new Error('Synthetic authentication rejection'), { code: 'EAUTH', responseCode: 535 }); };
afterAll(async () => { vi.unstubAllEnvs(); await db.$disconnect(); });

async function isolated(run: (tx: Prisma.TransactionClient, adminId: string, id: string) => Promise<void>) {
  const rollback = new Error('MAIL_RETRY_ROLLBACK');
  try {
    await db.$transaction(async tx => {
      await tx.emailDelivery.deleteMany();
      const admin = await tx.user.create({ data: { isAdmin: true } });
      const dedupeKey = randomUUID();
      await queueEmail(tx, { to: 'retry@example.test', subject: 'Fixture', text: 'Private test payload' }, { key, dedupeKey, templateKey: 'VERIFY' });
      const row = await tx.emailDelivery.findUniqueOrThrow({ where: { dedupeKey } });
      await run(tx, admin.id, row.id);
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
}

function retry(tx: Prisma.TransactionClient, userId: string, id: string) {
  const wrapped = { $transaction: (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => run(tx) } as PrismaClient;
  return runPlatformAdminActivityCommand(wrapped, { userId, id, command: 'retry-email', expectedStatus: 'FAILED', reason: 'SMTP configuration corrected' });
}

describe.skipIf(!url)('real sender to administrator email retry lifecycle', () => {
  beforeAll(() => {
    for (const name of ['SMTP_HOST', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'EMAIL_FROM', 'OUTBOX_ENCRYPTION_KEY']) vi.stubEnv(name, 'isolated-fixture');
  });

  it('retains a rejected message for an audited retry and erases it after successful delivery', async () => isolated(async (tx, adminId, id) => {
    await deliverEmailBatch(tx as PrismaClient, rejected, key, 1);
    const failed = await tx.emailDelivery.findUniqueOrThrow({ where: { id } });
    expect(failed).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(failed.encryptedPayload).toBeTruthy();
    expect(failed.encryptedPayload).not.toContain('Private test payload');
    await retry(tx, adminId, id);
    expect(await tx.auditEvent.count({ where: { action: 'EMAIL_RETRY_REQUESTED', targetId: id } })).toBe(1);
    const send = vi.fn().mockResolvedValue({ messageId: 'fixture' });
    await deliverEmailBatch(tx as PrismaClient, send, key, 1);
    await deliverEmailBatch(tx as PrismaClient, send, key, 1);
    expect(send).toHaveBeenCalledOnce();
    expect(await tx.emailDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'SENT', attempts: 2, encryptedPayload: null });
  }));

  it('does not exceed three attempts through repeated administrator retries', async () => isolated(async (tx, adminId, id) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await deliverEmailBatch(tx as PrismaClient, rejected, key, 1);
      expect(await tx.emailDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'FAILED', attempts: attempt });
      if (attempt < 3) await retry(tx, adminId, id);
    }
    expect((await tx.emailDelivery.findUniqueOrThrow({ where: { id } })).encryptedPayload).toBeNull();
    await expect(retry(tx, adminId, id)).rejects.toMatchObject({ code: 'EMAIL_RETRY_UNAVAILABLE' });
  }));

  it('refuses expired mail and erases failed payloads even in the mail-only worker', async () => isolated(async (tx, adminId, id) => {
    await deliverEmailBatch(tx as PrismaClient, rejected, key, 1);
    await tx.emailDelivery.update({ where: { id }, data: { payloadExpiresAt: new Date(0) } });
    await expect(retry(tx, adminId, id)).rejects.toMatchObject({ code: 'EMAIL_RETRY_UNAVAILABLE' });
    const send = vi.fn();
    await deliverEmailBatch(tx as PrismaClient, send, key, 1);
    expect(send).not.toHaveBeenCalled();
    expect(await tx.emailDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'EXPIRED', encryptedPayload: null });
  }));

  it('keeps unknown outcomes non-retryable and preserves their status after payload expiry', async () => isolated(async (tx, adminId, id) => {
    await deliverEmailBatch(tx as PrismaClient, async () => { throw new Error('Synthetic ambiguous disconnect'); }, key, 1);
    let row = await tx.emailDelivery.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('UNKNOWN');
    expect(emailRetryEligibility({ ...row, payloadAvailable: true, payloadExpiresAt: row.payloadExpiresAt!.toISOString(), expiresAt: row.expiresAt!.toISOString(), leaseExpiresAt: null }).eligible).toBe(false);
    await expect(retry(tx, adminId, id)).rejects.toMatchObject({ code: 'ADMIN_ACTIVITY_CONFLICT' });
    await tx.emailDelivery.update({ where: { id }, data: { payloadExpiresAt: new Date(0) } });
    await deliverEmailBatch(tx as PrismaClient, vi.fn(), key, 1);
    row = await tx.emailDelivery.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'UNKNOWN', encryptedPayload: null });
  }));

  it('refuses an ordinary user before requeueing a failed delivery', async () => isolated(async (tx, _adminId, id) => {
    await deliverEmailBatch(tx as PrismaClient, rejected, key, 1);
    const user = await tx.user.create({ data: {} });
    await expect(retry(tx, user.id, id)).rejects.toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });
    expect(await tx.emailDelivery.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'FAILED', attempts: 1 });
  }));
});
