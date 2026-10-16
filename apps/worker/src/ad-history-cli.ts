import { PrismaClient } from '@prisma/client';
import { backfillAdHistory } from '../../web/src/ad-history/projector';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('ad-history [--apply] [--limit 1..1000] [--ad-id ID ...]\nDefault: dry-run. Each apply invocation advances a durable cursor for its exact ad scope. Empty scope means all observed ads. New observations are independently queued.');
  process.exit(0);
}
let db: PrismaClient | undefined;
try {
  let apply = false, limit = 100;
  const adIds: string[] = [];
  while (args.length) {
    const arg = args.shift();
    if (arg === '--apply' && !apply) apply = true;
    else if (arg === '--limit') limit = Number(args.shift());
    else if (arg === '--ad-id' && args[0] && !args[0].startsWith('--')) adIds.push(args.shift()!);
    else throw new Error('INVALID_HISTORY_ARGUMENT');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('INVALID_HISTORY_LIMIT');
  if (!/^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? '')) throw new Error('DATABASE_NOT_CONFIGURED');
  db = new PrismaClient();
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
  const outcome = await backfillAdHistory(db, { apply, adIds, limit, signal: controller.signal });
  console.log(JSON.stringify({ event: 'ad_history_backfill', apply, ...outcome }));
} catch (error) {
  const allowed = ['INVALID_HISTORY_ARGUMENT', 'INVALID_HISTORY_LIMIT', 'INVALID_HISTORY_SCOPE', 'DATABASE_NOT_CONFIGURED', 'HISTORY_AD_OBSERVATION_LIMIT', 'HISTORY_CANCELED'];
  console.error(JSON.stringify({ event: 'ad_history_backfill_failed', errorCode: error instanceof Error && allowed.includes(error.message) ? error.message : 'HISTORY_BACKFILL_FAILED' }));
  process.exitCode = 1;
} finally { await db?.$disconnect(); }
