import type { MediaWorkerResult } from './media';

export interface MediaStoragePhase {
  state: 'RUNNING' | 'PAUSED' | 'STOPPED';
  errorCode: string | null;
  retryAt: string | null;
}
interface MediaStorageLaneOptions {
  signal: AbortSignal;
  once?: boolean;
  diskFreeBytes(): Promise<number>;
  download(): Promise<MediaWorkerResult>;
  publish(phase: MediaStoragePhase): Promise<void>;
  record(outcome: MediaWorkerResult): void;
  log(event: string, data: { code: string }): void;
  sleep(milliseconds: number): Promise<void>;
  now?(): Date;
}

/** Disk pressure pauses transfers, never deletes durable source media to make room. */
export async function runMediaStorageLane(options: MediaStorageLaneOptions): Promise<void> {
  const now = options.now ?? (() => new Date());
  do {
    if (options.signal.aborted) return;
    try {
      if (await options.diskFreeBytes() < 2 * 1024 ** 3) {
        await options.publish({ state: 'PAUSED', errorCode: 'DISK_SPACE_LOW', retryAt: new Date(now().valueOf() + 60_000).toISOString() });
        options.log('paused', { code: 'DISK_SPACE_LOW' });
        if (!options.once) await options.sleep(60_000);
        continue;
      }
      await options.publish({ state: 'RUNNING', errorCode: null, retryAt: null });
      if (options.signal.aborted) return;
      const outcome = await options.download();
      options.record(outcome);
      await options.publish({ state: 'RUNNING', errorCode: null, retryAt: null });
      if (!options.once) await options.sleep(outcome.status === 'IDLE' ? 3000 : 1000);
    } catch {
      options.log('error', { code: 'MEDIA_SERVICE_ERROR' });
      await options.publish({ state: 'PAUSED', errorCode: 'MEDIA_SERVICE_ERROR', retryAt: new Date(now().valueOf() + 15_000).toISOString() }).catch(() => undefined);
      if (!options.once) await options.sleep(15_000);
    }
  } while (!options.once && !options.signal.aborted);
}
