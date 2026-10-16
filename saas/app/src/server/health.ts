import type { PrismaClient } from '@prisma/client';

/** Safe for probes: no tenant IDs, payloads, credentials or provider exception text. */
export async function operationalHealth(db: PrismaClient) {
  try {
    await db.$queryRaw`SELECT 1`;
    const [workers, source, staleMail] = await Promise.all([
      db.workerHeartbeat.findMany({ where: { lastSeenAt: { gt: new Date(Date.now() - 90000) }, status: { not: 'STOPPED' } }, select: { capabilities: true } }),
      db.dataSource.findUnique({ where: { key: 'meta_ad_library' }, select: { status: true, lastSuccessfulAt: true, lastErrorCode: true } }),
      db.emailDelivery.count({ where: { OR: [{ status: 'UNKNOWN' }, { status: 'FAILED' }, { status: 'QUEUED', createdAt: { lt: new Date(Date.now() - 300000) } }] } }),
    ]);
    const worker = workers.some(row => row.capabilities.includes('collection') && row.capabilities.includes('mail')) ? 'ok' : 'unavailable';
    const sourceStatus = !source ? 'unconfigured' : source.status !== 'ACTIVE' ? 'paused' : source.lastErrorCode ? 'error' : !source.lastSuccessfulAt || Date.now() - source.lastSuccessfulAt.valueOf() > 86400000 ? 'stale' : 'ok';
    return { status: worker === 'ok' && staleMail === 0 && sourceStatus === 'ok' ? 'ok' : 'degraded', api: 'ok', database: 'ok', worker, source: sourceStatus, email: staleMail ? 'attention' : 'ok' };
  } catch {
    return { status: 'unavailable', api: 'ok', database: 'unavailable', worker: 'unknown', source: 'unknown', email: 'unknown' };
  }
}
