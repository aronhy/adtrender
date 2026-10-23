import { PrismaClient } from '@prisma/client';
import {historyWorkerTick} from './ad-history';
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { workerTick } from './collection-tick';
import { loadCollectionAdapter } from './collection-adapter';
import { createCollectionQueue } from '../../web/src/collection-admin/queue';
import { analysisWorkerTick, recoverExpiredAnalysis } from '../../web/src/analysis/worker';
import { deliverEmailBatch } from '../../web/src/server/email';
import { validateRuntimeConfig } from '../../web/src/server/config';
import { S3Storage } from '../../web/src/media/storage';
import { billingFromEnvironment } from '../../web/src/billing/configured';
import { evidenceWriter } from './evidence';
import { mediaWorkerTick } from './media';
import { createBillingReconciler } from './billing';
import { expireStoredFiles, purgeExpiredSecurityRecords } from './retention';
import {seedDiscoveryTick,seedDispatchTick,evidenceStoresFromEnvironment,seedDiscoverySourcesFromEnvironment} from './seed-control';

const args = new Set(process.argv.slice(2));
if (args.has('--help')) {
  console.log('worker [--once] [--mail-only] — independent PostgreSQL jobs; configuration comes from server environment');
  process.exit(0);
}
if ([...args].some(arg => !['--once', '--mail-only'].includes(arg))) throw new Error('Unsupported worker argument');
validateRuntimeConfig(process.env);
const db = new PrismaClient();
const controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());
const workerId = `saas-${randomUUID()}`;
const once = args.has('--once');
const capabilities = args.has('--mail-only') ? ['mail'] : ['mail', 'collection', 'media', 'analysis', 'billing-reconciliation', 'retention'];
const log = (event: string, metadata: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, workerId, ...metadata }));
const timezone = await db.$queryRaw<Array<{ TimeZone: string }>>`SHOW timezone`;
if (timezone[0]?.TimeZone !== 'UTC') throw new Error('SaaS database sessions must use UTC');
const transport = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), secure: process.env.SMTP_SECURE === 'true',
  ...(process.env.SMTP_USERNAME ? { auth: { user: process.env.SMTP_USERNAME, pass: process.env.SMTP_PASSWORD } } : {}),
  connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 15000,
  disableFileAccess: true, disableUrlAccess: true,
}) : undefined;
const storage = process.env.S3_BUCKET && process.env.S3_REGION ? new S3Storage({ bucket: process.env.S3_BUCKET, region: process.env.S3_REGION, endpoint: process.env.S3_ENDPOINT || undefined, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true', maxAttempts: 1, requestHandler: { requestTimeout: 10000, connectionTimeout: 5000 } }) : undefined;
const persistEvidence = evidenceWriter();
const collection = await loadCollectionAdapter();
const seedEvidence=evidenceStoresFromEnvironment();
const reconcileBilling = createBillingReconciler(db, subscription => billingFromEnvironment(db).reconcileSubscription(subscription), { signal: controller.signal, onFailure: organizationId => log('billing_reconciliation_failed', { organizationId }) });
const sleep = (ms: number) => new Promise<void>(resolve => { const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); }; const timer = setTimeout(finish, ms); controller.signal.addEventListener('abort', finish, { once: true }); if (controller.signal.aborted) finish(); });
const heartbeat = () => db.workerHeartbeat.upsert({ where: { id: workerId }, create: { id: workerId, version: 'saas-phase-one-1', capabilities, status: 'IDLE' }, update: { lastSeenAt: new Date(), status: 'IDLE' } });
await heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat().catch(() => log('heartbeat_failed')), 15000);
async function lane(name: string, interval: number, execute: () => Promise<unknown>) {
  do {
    if (controller.signal.aborted) return;
    try { await execute(); } catch { log('lane_failed', { lane: name }); }
    if (!once) await sleep(interval);
  } while (!once && !controller.signal.aborted);
}
log('worker_started', { capabilities, once });
try {
  const lanes = [lane('mail', 2000, async () => {
    if (transport && process.env.OUTBOX_ENCRYPTION_KEY) await deliverEmailBatch(db, async message => transport.sendMail({ ...message, from: process.env.EMAIL_FROM, disableFileAccess: true, disableUrlAccess: true }), process.env.OUTBOX_ENCRYPTION_KEY, 5);
  })];
  if (!args.has('--mail-only')) lanes.push(
    lane('collection', 5000, async () => { const queue = createCollectionQueue(db); await queue.recoverExpired(); await queue.scheduleDue(); const outcome = await workerTick(db, { workerId: `${workerId}:collector`, persistEvidence, signal: controller.signal, ...collection }); if (!['IDLE', 'CONFIGURATION_REQUIRED'].includes(outcome.status)) log('collection_finished', outcome); }),
    lane('analysis', 3000, async () => { await recoverExpiredAnalysis(db); const outcome = await analysisWorkerTick(db, { workerId: `${workerId}:analysis`, signal: controller.signal }); if (!['IDLE', 'CONFIGURATION_REQUIRED'].includes(outcome.status)) log('analysis_finished', outcome); }),
    lane('media', 3000, async () => { const outcome = await mediaWorkerTick(db, storage, undefined, { signal: controller.signal }); if (!['IDLE', 'CONFIGURATION_REQUIRED'].includes(outcome.status)) log('media_finished', outcome); }),
    lane('history', 5000, async()=>{const outcome=await historyWorkerTick(db,{workerId: `${workerId}:history`,signal:controller.signal});if(outcome.processed||outcome.failed)log('history_finished',outcome);}),
    lane('billing', 300000, async () => {
      if (process.env.BILLING_ENABLED !== 'true') return;
      await reconcileBilling();
    }),
    lane('security-retention', 60000, async () => {
      const outcome = await purgeExpiredSecurityRecords(db, { signal: controller.signal, limit: 1000 });
      log('security_retention_finished', outcome);
    }),
    lane('retention', 3600000, async () => {
      await db.productEvent.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      await db.emailDelivery.updateMany({ where: { payloadExpiresAt: { lt: new Date() }, encryptedPayload: { not: null } }, data: { encryptedPayload: null } });
      await db.authLink.updateMany({ where: { expiresAt: { lt: new Date() }, encryptedPayload: { not: '' } }, data: { encryptedPayload: '' } });
      await db.emailDelivery.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      const outcome = await expireStoredFiles(db, storage, { signal: controller.signal });
      log('retention_finished', outcome);
    }),
  );
  if(!args.has('--mail-only')&&process.env.SEED_DISCOVERY_ENABLED==='true')lanes.push(lane('seed-discovery',60000,async()=>{
    const result=await seedDiscoveryTick(db,{extractionVersion:'public-clues-1',signal:controller.signal,sourceKeys:seedDiscoverySourcesFromEnvironment(),...seedEvidence});if(result.processed||result.failed)log('seed_discovery_finished',result);
  }));
  if(!args.has('--mail-only')&&process.env.COLLECTOR_DISPATCH_ENABLED==='true')lanes.push(lane('seed-dispatch',5000,async()=>{
    const actorUserId=process.env.COLLECTOR_DISPATCH_ACTOR_USER_ID;if(!actorUserId)throw Error('COLLECTOR_DISPATCH_ACTOR_REQUIRED');
    const result=await seedDispatchTick(db,{actorUserId,signal:controller.signal});if(result.rolling?.changed)log('seed_scan_window_published',result.rolling);if(result.created||result.recovering||result.failed)log('seed_dispatch_scheduled',{created:result.created,recovering:result.recovering,failed:result.failed});
  }));
  await Promise.all(lanes);
} finally {
  clearInterval(heartbeatTimer); transport?.close();
  await db.workerHeartbeat.update({ where: { id: workerId }, data: { status: 'STOPPED', lastSeenAt: new Date() } }).catch(() => undefined);
  await db.$disconnect(); log('worker_stopped');
}
