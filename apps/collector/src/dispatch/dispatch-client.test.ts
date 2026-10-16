import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDispatchHttpClient } from './dispatch-client';
import { SEED_MANIFEST_CHUNK_BYTES, seedCanonical, seedManifestContentHash, type SeedConfigManifest, type SeedManifestChunk, type SeedManifestDescriptor } from '../../../../packages/contracts/src/seeds';
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const uuid = (n: number) => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
function manifest(count = 2): SeedConfigManifest {
  const queries: SeedConfigManifest['queries'] = Array.from({ length: count }, (_, n) => ({ queryId: uuid(n + 1), queryKey: hash('native-query-' + n), queryKeyVersion: 'legacy-1', sourceKey: 'meta_ad_library', channel: 'META', mode: 'KEYWORD', params: { country: 'US', language: 'en', keyword: 'fixture-' + n + '-品牌🚀', status: 'all', mediaType: 'all' }, legacyDims: {}, adapterVersion: 'meta-service-dom-1', capabilityVersion: 'fixture-1', desiredEnabled: true, nativeJobIds: ['native-fixture-' + n] }));
  const body = { schemaVersion: 1 as const, protocolMin: 1, protocolMax: 1, publicationId: uuid(50000), revision: 8, parentRevision: 7, compilerVersion: 'seed-compiler-1', capabilityVersion: 'fixture-1', createdAt: '2026-10-11T00:00:00.000Z', queries, bindings: queries.map(q => ({ queryId: q.queryId, ownerKind: 'SEED' as const, seedId: uuid(100000 + Number.parseInt(q.queryId.slice(-12), 16)), scanPlanId: null, legacyOwnerKey: null, ownerRevision: 1, participationStatus: 'ACTIVE' as const, purposeSnapshot: [{ family: 'ECOMMERCE' as const, category: '品牌发现' }], validFromRevision: 8, validToRevision: null })), scanPlans: [], tombstones: [], schedulePolicyVersion: 'compatibility-fair-1' };
  return { ...body, contentHash: seedManifestContentHash(body) };
}
function transfer(m: SeedConfigManifest, raw = Buffer.from(seedCanonical(m), 'utf8')) {
  const descriptor: SeedManifestDescriptor = { type: 'SEED_MANIFEST_DESCRIPTOR', schemaVersion: 1, publicationId: m.publicationId, publicationRevision: m.revision, manifestHash: m.contentHash, byteSha256: hash(raw), byteLength: raw.length, chunkBytes: SEED_MANIFEST_CHUNK_BYTES, totalChunks: Math.ceil(raw.length / SEED_MANIFEST_CHUNK_BYTES) };
  const chunks: SeedManifestChunk[] = Array.from({ length: descriptor.totalChunks }, (_, chunkIndex) => { const bytes = raw.subarray(chunkIndex * descriptor.chunkBytes, (chunkIndex + 1) * descriptor.chunkBytes); return { type: 'SEED_MANIFEST_CHUNK', schemaVersion: 1, publicationId: m.publicationId, publicationRevision: m.revision, manifestHash: m.contentHash, chunkIndex, byteSha256: hash(bytes), byteLength: bytes.length, dataBase64: bytes.toString('base64') }; });
  return { manifest: m, raw, descriptor, chunks };
}
type Transfer = ReturnType<typeof transfer>;
function client(f: Transfer, options: { descriptor?: any; chunk?: (chunk: SeedManifestChunk) => any; response?: (url: URL, init?: RequestInit) => Response } = {}) {
  const requests: Array<{ url: URL; headers: Headers }> = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)); requests.push({ url, headers: new Headers(init?.headers) });
    if (options.response) return options.response(url, init);
    const index = url.searchParams.get('chunkIndex'), body = index === null ? options.descriptor ?? f.descriptor : options.chunk?.(f.chunks[Number(index)]) ?? f.chunks[Number(index)];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { requests, api: createDispatchHttpClient({ origin: 'https://collector.example.test', token: 'synthetic-no-network-token', nodeId: 'fixture-node', incarnationId: uuid(80000), sourceKey: 'meta_ad_library', request }) };
}
let large: Transfer;
beforeAll(() => { large = transfer(manifest(16000)); });
describe('config transport through the production HTTP client without network or database', () => {
  it('downloads 16000 queries and bindings with bounded immutable pages', async () => {
    expect(large.raw.length).toBeGreaterThan(8_000_000);
    const f = client(large), result = await f.api.fetchConfig(); if (result.status !== 200) throw Error('EXPECTED_MANIFEST');
    expect(result.manifest.queries).toHaveLength(16000); expect(result.manifest.bindings).toHaveLength(16000); expect(result.manifest.contentHash).toBe(large.manifest.contentHash); expect(result.manifest.queries.at(-1)).toEqual(large.manifest.queries.at(-1));
    expect(f.requests).toHaveLength(large.descriptor.totalChunks + 1); expect(f.requests[0].url.searchParams.get('chunked')).toBe('1');
    for (const [n, request] of f.requests.slice(1).entries()) { expect(request.url.searchParams.get('publicationId')).toBe(large.descriptor.publicationId); expect(request.url.searchParams.get('manifestHash')).toBe(large.descriptor.manifestHash); expect(request.url.searchParams.get('chunkIndex')).toBe(String(n)); expect(request.headers.has('if-none-match')).toBe(false); expect(request.headers.get('x-collector-source')).toBe('meta_ad_library'); }
  }, 30000);
  it('retains 304 cache negotiation and does not request pages', async () => {
    const f = client(large, { response: () => new Response(null, { status: 304 }) }); expect(await f.api.fetchConfig(large.manifest.contentHash)).toEqual({ status: 304 }); expect(f.requests).toHaveLength(1); expect(f.requests[0].headers.get('if-none-match')).toBe('"' + large.manifest.contentHash + '"'); expect(f.requests[0].url.searchParams.get('chunked')).toBe('1');
  });
  it.each(['RAW', 'WRAPPED'])('keeps an old small 200 manifest compatible (%s)', async kind => {
    const m = manifest(), f = client(large, { response: () => new Response(JSON.stringify(kind === 'RAW' ? m : { manifest: m }), { status: 200 }) }); expect(await f.api.fetchConfig()).toEqual({ status: 200, manifest: m }); expect(f.requests).toHaveLength(1);
  });
  it.each([
    ['bad SHA', (c: SeedManifestChunk) => ({ ...c, byteSha256: '0'.repeat(64) })],
    ['bad base64', (c: SeedManifestChunk) => ({ ...c, dataBase64: '%' + c.dataBase64.slice(1) })],
    ['truncated bytes with a valid page digest', (c: SeedManifestChunk) => { const b = Buffer.from(c.dataBase64, 'base64').subarray(0, c.byteLength - 1); return { ...c, byteLength: b.length, byteSha256: hash(b), dataBase64: b.toString('base64') }; }],
    ['mixed publication ID', (c: SeedManifestChunk) => ({ ...c, publicationId: uuid(90000) })],
    ['mixed publication revision', (c: SeedManifestChunk) => ({ ...c, publicationRevision: c.publicationRevision + 1 })],
    ['mixed scoped manifest hash', (c: SeedManifestChunk) => ({ ...c, manifestHash: '0'.repeat(64) })],
    ['wrong index', (c: SeedManifestChunk) => ({ ...c, chunkIndex: c.chunkIndex + 1 })],
  ] as const)('rejects %s instead of exposing a partial config', async (_, mutate) => { await expect(client(large, { chunk: mutate }).api.fetchConfig()).rejects.toThrow(); });
  it.each([
    ['zero bytes', { byteLength: 0 }], ['invalid publication', { publicationId: 'not-a-publication' }], ['wrong schema', { schemaVersion: 2 }], ['oversized page', { chunkBytes: SEED_MANIFEST_CHUNK_BYTES * 2 }], ['zero pages', { totalChunks: 0 }], ['wrong total page count', { totalChunks: 1 }], ['unsafe byte length', { byteLength: Number.MAX_SAFE_INTEGER + 1 }],
  ])('rejects an invalid descriptor (%s)', async (_, mutation) => { const f = client(large, { descriptor: { ...large.descriptor, ...mutation } }); await expect(f.api.fetchConfig()).rejects.toThrow(); expect(f.requests).toHaveLength(1); });
  it('checks the complete byte SHA after all individually valid pages', async () => { await expect(client(large, { descriptor: { ...large.descriptor, byteSha256: '0'.repeat(64) } }).api.fetchConfig()).rejects.toThrow(); });
  it('checks the scoped manifest content hash after the byte digest passes', async () => { const m = manifest(); m.contentHash = '0'.repeat(64); await expect(client(transfer(m)).api.fetchConfig()).rejects.toThrow('COLLECTOR_CONTROL_RESPONSE_INVALID'); });
  it('checks the complete manifest publication against the fixed descriptor', async () => {
    const small = transfer(manifest()), publicationId = uuid(90001), f = client(small, { descriptor: { ...small.descriptor, publicationId }, chunk: c => ({ ...c, publicationId }) }); await expect(f.api.fetchConfig()).rejects.toThrow();
  });
  it('decodes UTF8 only after byte chunks are reassembled', async () => {
    const m = manifest(2); m.queries[0].params.keyword = 'a'.repeat(950000); m.queries[1].params.keyword = 'boundary_marker'; m.contentHash = seedManifestContentHash(m); const prefix = Buffer.byteLength(seedCanonical(m).split('boundary_marker')[0], 'utf8'); m.queries[1].params.keyword = 'a'.repeat(SEED_MANIFEST_CHUNK_BYTES - prefix - 1) + '🚀'; m.contentHash = seedManifestContentHash(m);
    const f = transfer(m); expect(f.raw[SEED_MANIFEST_CHUNK_BYTES - 1]).toBe(0xf0); const result = await client(f).api.fetchConfig(); if (result.status !== 200) throw Error('EXPECTED_MANIFEST'); expect(result.manifest.queries[1].params.keyword).toBe(m.queries[1].params.keyword);
  });
});
