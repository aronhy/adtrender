import { describe, expect, it, vi } from 'vitest';
import { runMediaStorageLane } from './media-storage-lane';

describe('media storage disk pressure and recovery', () => {
  it('pauses downloads below the disk reserve, publishes a retry time, then reports recovery before downloading', async () => {
    const signal = new AbortController(), states: unknown[] = [], freeSpace = [1024, 4 * 1024 ** 3];
    const download = vi.fn(async () => { expect(states.at(-1)).toMatchObject({ state: 'RUNNING', errorCode: null, retryAt: null }); signal.abort(); return { status: 'READY' as const, mediaId: 'synthetic' }; });
    const sleep = vi.fn(async () => {});
    await runMediaStorageLane({ signal: signal.signal, diskFreeBytes: async () => freeSpace.shift()!, download,
      publish: async state => { states.push(state); }, record: () => {}, log: () => {}, sleep, now: () => new Date('2026-10-08T00:00:00Z') });
    expect(states[0]).toEqual({ state: 'PAUSED', errorCode: 'DISK_SPACE_LOW', retryAt: '2026-10-08T00:01:00.000Z' });
    expect(sleep).toHaveBeenNthCalledWith(1, 60_000); expect(download).toHaveBeenCalledTimes(1);
  });
  it('ends a one-shot low-disk verification without waiting or trying a transfer', async () => {
    const download = vi.fn(async () => ({ status: 'READY' as const })), sleep = vi.fn(async () => {}), publish = vi.fn(async () => {});
    await runMediaStorageLane({ signal: new AbortController().signal, once: true, diskFreeBytes: async () => 0,
      download, publish, record: () => {}, log: () => {}, sleep });
    expect(download).not.toHaveBeenCalled(); expect(sleep).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ state: 'PAUSED', errorCode: 'DISK_SPACE_LOW' }));
  });
  it('honors shutdown during a disk pause without claiming a queued row', async () => {
    const controller = new AbortController(), download = vi.fn(async () => ({ status: 'READY' as const }));
    await runMediaStorageLane({ signal: controller.signal, diskFreeBytes: async () => 0, download, publish: async () => {}, record: () => {}, log: () => {}, sleep: async () => { controller.abort(); } });
    expect(download).not.toHaveBeenCalled();
  });
});
