/** Independent public-media storage daemon. Shares row locks with the ordinary worker. */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { statfs, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { S3Storage } from '../../app/src/media/storage';
import { mediaWorkerTick, type MediaWorkerResult } from './media';
import { runMediaStorageLane, type MediaStoragePhase } from './media-storage-lane';

const allowed = new Set(['--once', '--help']), args = new Set(process.argv.slice(2));
if (args.has('--help')) {
  console.log('media-storage [--once] — persists public creatives using server-only database/S3 configuration');
  process.exit(0);
}
if ([...args].some(arg => !allowed.has(arg))) throw Error('UNSUPPORTED_ARGUMENT');
if (!process.env.S3_BUCKET || !process.env.S3_REGION) throw Error('STORAGE_CONFIGURATION_REQUIRED');
const db = new PrismaClient(), root = process.env.MEDIA_STATE_DIR ?? '/data', controller = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());
const storage = new S3Storage({ bucket: process.env.S3_BUCKET, region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT || undefined, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  maxAttempts: 1, requestHandler: { requestTimeout: 10000, connectionTimeout: 5000 } });
const counts: Record<string, number> = {};
let last: unknown, lastStatusAt = 0;
let statusWrite = Promise.resolve();
let phase: MediaStoragePhase = { state: 'RUNNING', errorCode: null, retryAt: null };
const log = (event: string, data: unknown) => console.log(JSON.stringify({ at: new Date().toISOString(), event, data }));
const sleep = (ms: number) => new Promise<void>(resolve => {
  const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); controller.signal.addEventListener('abort', done, { once: true });
  if (controller.signal.aborted) done();
});
async function writeStatus(next: MediaStoragePhase) {
  const changed = phase.state !== next.state || phase.errorCode !== next.errorCode || phase.retryAt !== next.retryAt;
  phase = next;
  const now = Date.now();
  if (!changed && now - lastStatusAt < 5000 && !controller.signal.aborted) return;
  const file = join(root, 'status.json'), temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify({ updatedAt: new Date().toISOString(), ...phase, counts, last }), { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  lastStatusAt = now;
}
function status(next: MediaStoragePhase) {
  // Both transfer lanes publish to one file in call order, even if disk writes vary in latency.
  const pending = statusWrite.then(() => writeStatus(next));
  statusWrite = pending.catch(() => undefined);
  return pending;
}
function record(outcome: MediaWorkerResult) {
  if (['IDLE', 'CANCELED'].includes(outcome.status)) return;
  counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  last = { ...outcome, at: new Date().toISOString() };
  log('media', last);
}
await mkdir(root, { recursive: true, mode: 0o700 });
log('started', { concurrency: 2 });
try {
  await Promise.all([0, 1].map(() => runMediaStorageLane({
    signal: controller.signal, once: args.has('--once'),
    diskFreeBytes: async () => { const disk = await statfs(root); return disk.bavail * disk.bsize; },
    download: () => mediaWorkerTick(db, storage, undefined, { signal: controller.signal }),
    publish: status, record, log, sleep,
  })));
} finally {
  await db.$disconnect();
  await status({ state: 'STOPPED', errorCode: phase.errorCode, retryAt: null });
  log('stopped', counts);
}
