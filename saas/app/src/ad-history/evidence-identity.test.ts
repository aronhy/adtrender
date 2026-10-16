import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../team/access', async importOriginal => ({ ...await importOriginal<typeof import('../team/access')>(), requireWorkspaceRole: async () => {} }));
import { getAdHistoryEvidence } from './evidence';

const input = { userId: 'user', workspaceId: 'workspace', adId: 'ad', observationId: 'observation' };
function database(snapshot: Record<string, unknown>, fieldProvenance: Record<string, unknown> = {}) {
  const observation = { id: 'observation', adId: 'ad', collectionRunId: 'run', observedAt: new Date('2026-10-08T01:00:00Z'), snapshot, fieldProvenance, parserVersion: 'meta-dom-1', run: { id: 'run' }, ad: { dataSource: { key: 'meta_ad_library' } } };
  const tx = { adObservation: { findFirst: async () => observation } };
  return { $transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx) } as unknown as PrismaClient;
}

describe('historical source advertiser identity', () => {
  it.each([
    [{ sourceAdvertiserId: 'page-url-sha256:' + 'a'.repeat(64) }, {}],
    [{ advertiserId: 'ad-local:123456789' }, {}],
    [{}, { sourceAdvertiserId: { value: 'page-url-sha256:' + 'b'.repeat(64) } }],
    [{ sourceAdvertiserId: '123456789' }, { sourceAdvertiserId: { kind: 'source-ad-local' } }],
  ])('keeps derived identifiers out of saved source evidence %#', async (snapshot, provenance) => {
    expect((await getAdHistoryEvidence(database(snapshot, provenance), input)).advertiserId).toBeNull();
  });
  it.each([
    [{ sourceAdvertiserId: '987654321' }, {}, '987654321'],
    [{ advertiserId: 'AR123456789' }, {}, 'AR123456789'],
    [{}, { sourceAdvertiserId: { value: '123456789', kind: 'source-advertiser-id' } }, '123456789'],
  ])('preserves saved original advertiser IDs %#', async (snapshot, provenance, expected) => {
    expect((await getAdHistoryEvidence(database(snapshot, provenance), input)).advertiserId).toBe(expected);
  });
});
