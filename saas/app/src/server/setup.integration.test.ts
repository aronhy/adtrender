import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { decryptMessage } from './email';
import { consumeAuthLink } from '../auth/links';

vi.mock('wasp/server', () => ({ prisma: {} }));
vi.mock('wasp/server/email', () => ({ emailSender: { send: async () => {} } }));
import { createQueuedEmailSender } from './setup';

const testUrl = process.env.SAAS_TEST_DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url: testUrl ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
const key = 'c'.repeat(64);
const recipients=new Set<string>();
afterAll(async()=>{
  if(recipients.size)await db.emailDelivery.deleteMany({where:{recipientEmail:{in:[...recipients]}}});
  await db.$disconnect();
});

describe.skipIf(!testUrl)('transactional Wasp authentication email adapter', () => {
  it('replaces every native token occurrence, accepts text-only mail and queues an encrypted opaque link', async () => {
    const email = `${randomUUID()}@example.test`;
    recipients.add(email);
    await db.user.create({ data: { email, auth: { create: { identities: { create: { providerName: 'email', providerUserId: email, providerData: JSON.stringify({ hashedPassword: 'fixture-hash', isEmailVerified: false }) } } } } } });
    const native = `native-jwt-${randomUUID()}`;
    const link = `https://app.example.test/password-reset?token=${native}`;
    await createQueuedEmailSender(db, key)({ to: email, subject: '重置', text: `帮助 https://app.example.test/help 。重置 ${link} 。备用 ${link} 。` });
    const outbox = await db.emailDelivery.findFirstOrThrow({ where: { recipientEmail: email } });
    const payload = decryptMessage(outbox.encryptedPayload!, key);
    expect(payload.text).not.toContain(native);
    const opaque = new URL(payload.text.match(/https:\/\/[^\s]+\/password-reset\?[^\s]+/)![0]).searchParams.get('token')!;
    expect(opaque).toMatch(/^[a-f0-9]{64}$/);
    await expect(consumeAuthLink(db, opaque, 'RESET', key)).resolves.toMatchObject({ frameworkToken: native, email });
    expect(await db.authLink.count({ where: { recipientEmail: email } })).toBe(1);
    expect(outbox.templateKey).toBe('RESET');
  });

  it('rolls back the opaque link if the encrypted outbox insertion fails', async () => {
    const email = `${randomUUID()}@example.test`;
    recipients.add(email);
    await db.user.create({ data: { email, auth: { create: { identities: { create: { providerName: 'email', providerUserId: email, providerData: JSON.stringify({ hashedPassword: 'fixture-hash', isEmailVerified: false }) } } } } } });
    await expect(createQueuedEmailSender(db, key)({ to: email, subject: '验证', text: 'https://app.example.test/email-verification?token=native-jwt', html: 'x'.repeat(110_000) })).rejects.toThrow('EMAIL_QUEUE_FAILED');
    expect(await db.authLink.count({ where: { recipientEmail: email } })).toBe(0);
    expect(await db.emailDelivery.count({ where: { recipientEmail: email } })).toBe(0);
  });
});
