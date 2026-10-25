import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { operationalHealth } from './health';

const url = process.env.SAAS_TEST_DATABASE_URL;
const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://unused@127.0.0.1:1/not_run' } } });
afterAll(() => db.$disconnect());

// Every fixture change, including clearing unrelated health records, rolls back.
async function isolated(run: (tx: Prisma.TransactionClient) => Promise<void>) {
  const rollback = new Error('HEALTH_TEST_ROLLBACK');
  try {
    await db.$transaction(async tx => {
      await tx.workerHeartbeat.deleteMany();
      await tx.emailDelivery.deleteMany();
      await tx.workerHeartbeat.create({ data: { id: randomUUID(), version: 'fixture', capabilities: ['mail', 'collection'] } });
      const source = { status: 'ACTIVE', lastSuccessfulAt: new Date(), lastErrorCode: null };
      await tx.dataSource.upsert({ where: { key: 'meta_ad_library' }, create: { key: 'meta_ad_library', name: 'Health fixture', adapterVersion: 'fixture', ...source }, update: source });
      await run(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

describe.skipIf(!url)('operational mail health on isolated PostgreSQL', () => {
  it('ignores expired historical failures and expired queued payloads', async () => isolated(async tx => {
    const past = new Date(Date.now() - 3600000), future = new Date(Date.now() + 3600000);
    await tx.emailDelivery.createMany({ data: [
      { recipientEmail: 'health@example.test', templateKey: 'VERIFY', dedupeKey: randomUUID(), status: 'FAILED', expiresAt: past, payloadExpiresAt: future },
      { recipientEmail: 'health@example.test', templateKey: 'VERIFY', dedupeKey: randomUUID(), status: 'UNKNOWN', expiresAt: future, payloadExpiresAt: past },
      { recipientEmail: 'health@example.test', templateKey: 'VERIFY', dedupeKey: randomUUID(), status: 'QUEUED', createdAt: past, expiresAt: future, payloadExpiresAt: past },
    ] });
    expect(await operationalHealth(tx as PrismaClient)).toMatchObject({ status: 'ok', email: 'ok' });
  }));

  it.each(['FAILED', 'UNKNOWN', 'QUEUED'])('keeps active %s mail visible to probes', async status => isolated(async tx => {
    const future = new Date(Date.now() + 3600000);
    await tx.emailDelivery.create({ data: { recipientEmail: 'health@example.test', templateKey: 'VERIFY', dedupeKey: randomUUID(), status, createdAt: new Date(Date.now() - 3600000), expiresAt: future, payloadExpiresAt: future } });
    expect(await operationalHealth(tx as PrismaClient)).toMatchObject({ status: 'degraded', email: 'attention' });
  }));
});
