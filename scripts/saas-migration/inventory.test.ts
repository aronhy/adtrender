import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInventoryManifest, runInventoryCli } from './inventory';

const generatedAt = '2026-10-04T00:00:00.000Z';
const ad = (overrides: Record<string, unknown> = {}) => ({
  id: '123456-0', libraryId: '123456', variantIndex: 0,
  sourceUrl: 'https://www.facebook.com/ads/library/?id=123456',
  copy: 'PRIVATE_TEXT_DO_NOT_OUTPUT', advertiser: 'PERSON_DO_NOT_OUTPUT',
  collectedAt: '2026-09-04T15:23:44.177Z', platforms: ['Facebook'],
  mediaUrl: '/local-media/image.jpg', ...overrides,
});
const input = (ads: unknown[]) => JSON.stringify({ version: 2, ads });
const options = { generatedAt, ownership: 'public' as const, localMediaFiles: ['image.jpg'] };
const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('legacy inventory manifest', () => {
  it('counts public source evidence without leaking record contents', () => {
    const result = createInventoryManifest(input([ad()]), options);
    expect(result).toMatchObject({ inputCount: 1, eligibleCount: 1, uniqueStableIds: 1,
      missingObservationTimeCount: 0, unknownPlatformCount: 0,
      localMedia: { references: 1, uniqueReferences: 1, checked: true, missingCount: 0 },
      quarantined: { count: 0 },
    });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(result);
    for (const secret of ['PRIVATE_TEXT_DO_NOT_OUTPUT', 'PERSON_DO_NOT_OUTPUT', '123456', 'image.jpg', 'facebook.com']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('keeps repeated library IDs separate from duplicate variant records', () => {
    const result = createInventoryManifest(input([
      ad(), ad({ id: '123456-1', variantIndex: 1 }), ad({ id: '123456-copy', variantIndex: 1 }),
    ]), options);
    expect(result).toMatchObject({ inputCount: 3, uniqueStableIds: 1,
      variants: { repeatedStableIdRows: 2, multiVariantGroups: 1, duplicateVariantRows: 1 },
    });
  });

  it('does not invent observations, publisher platforms or media availability', () => {
    const result = createInventoryManifest(input([
      ad({ collectedAt: undefined, lastCollectedAt: 'not-a-date', platforms: [], mediaUrl: '/local-media/missing.jpg' }),
      ad({ libraryId: '789012', sourceUrl: 'https://facebook.com/ads/library/?id=789012', collectedAt: '2026-02-30T00:00:00Z', platforms: ['unknown'] }),
    ]), options);
    expect(result).toMatchObject({ missingObservationTimeCount: 2, unknownPlatformCount: 2,
      localMedia: { references: 2, uniqueReferences: 2, checked: true, missingCount: 1 },
    });
    expect(createInventoryManifest(input([ad()]), { generatedAt, ownership: 'public' }).localMedia)
      .toMatchObject({ checked: false, missingCount: null });
  });

  it('quarantines unknown ownership and explicit private scope even when source is public', () => {
    expect(createInventoryManifest(input([ad()]), { generatedAt }).quarantined)
      .toMatchObject({ count: 1, reasons: { unknownOwnership: 1 } });
    const result = createInventoryManifest(input([ad({ tenant_id: 'DO_NOT_OUTPUT', workspace_id: 'DO_NOT_OUTPUT' })]), options);
    expect(result).toMatchObject({ eligibleCount: 0, quarantined: { count: 1, reasons: { unknownOwnership: 1 } } });
    expect(JSON.stringify(result)).not.toContain('DO_NOT_OUTPUT');
  });

  it('quarantines missing IDs, conflicting IDs and untrusted source URLs', () => {
    const result = createInventoryManifest(input([
      ad({ libraryId: undefined, sourceUrl: 'https://facebook.com/ads/library/' }),
      ad({ sourceUrl: 'https://facebook.com.evil.example/ads/library/?id=123456' }),
      ad({ sourceUrl: 'https://facebook.com/profile.php?id=123456' }),
      ad({ sourceUrl: 'http://facebook.com/ads/library/?id=123456' }),
      ad({ sourceUrl: 'https://facebook.com/ads/library/?id=999999' }),
      null,
    ]), options);
    expect(result).toMatchObject({ inputCount: 6, eligibleCount: 0, quarantined: { count: 6,
      reasons: { missingStableId: 1, nonMetaSource: 3, conflictingStableId: 1, invalidRecord: 1 },
    } });
  });

  it('uses a stable source URL ID when libraryId is absent', () => {
    expect(createInventoryManifest(input([ad({ libraryId: undefined })]), options))
      .toMatchObject({ eligibleCount: 1, uniqueStableIds: 1 });
  });

  it('quarantines ambiguous source URL IDs instead of accepting a declared library ID', () => {
    const result = createInventoryManifest(input([
      ad({ sourceUrl: 'https://facebook.com/ads/library/?id=123456&id=999999' }),
    ]), options);
    expect(result).toMatchObject({ eligibleCount: 0, quarantined: { count: 1, reasons: { conflictingStableId: 1 } } });
  });

  it.each(['{"ads":', '{"ads":{}}', 'null', '"SENSITIVE_BAD_INPUT"'])('rejects malformed document without exposing its contents: %s', raw => {
    expect(() => createInventoryManifest(raw, options)).toThrow(/^INVENTORY_INVALID_INPUT$/);
  });

  it('rejects unsafe media references without reading outside the supplied media root', () => {
    const result = createInventoryManifest(input([ad({ mediaUrl: '/local-media/../private/key.env' })]), options);
    expect(result).toMatchObject({ eligibleCount: 0, quarantined: { count: 1, reasons: { unsafeLocalMediaReference: 1 } } });
  });

  it('produces the same manifest hash across reruns but binds it to file bytes and media checks', () => {
    const raw = input([ad()]);
    const first = createInventoryManifest(raw, options);
    const rerun = createInventoryManifest(raw, { ...options, generatedAt: '2026-10-05T00:00:00.000Z' });
    expect(rerun.manifestHash).toBe(first.manifestHash);
    expect(createInventoryManifest(raw + '\n', options).manifestHash).not.toBe(first.manifestHash);
    expect(createInventoryManifest(raw, { ...options, localMediaFiles: [] }).manifestHash).not.toBe(first.manifestHash);
  });
});

describe('inventory CLI', () => {
  it('requires explicit input/output and refuses ambiguous flags', async () => {
    await expect(runInventoryCli([])).rejects.toThrow('INVENTORY_USAGE');
    await expect(runInventoryCli(['--input', 'ads.json', '--output', 'out.json', '--ownership', 'private'])).rejects.toThrow('INVENTORY_USAGE');
    await expect(runInventoryCli(['--input', 'a', '--input', 'b', '--output', 'c'])).rejects.toThrow('INVENTORY_USAGE');
  });

  it('writes a new manifest only, never overwrites input or a prior output, and ignores symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saas-inventory-')); temporaryDirectories.push(root);
    const source = join(root, 'ads.json'), output = join(root, 'manifest.json');
    const raw = input([ad()]); await writeFile(source, raw);
    await symlink(source, join(root, 'image.jpg'));
    await runInventoryCli(['--input', source, '--output', output, '--ownership', 'public', '--media-root', root]);
    const manifest = JSON.parse(await readFile(output, 'utf8'));
    expect(manifest.localMedia.missingCount).toBe(1);
    expect(await readFile(source, 'utf8')).toBe(raw);
    await expect(runInventoryCli(['--input', source, '--output', source])).rejects.toThrow('INVENTORY_OUTPUT_EXISTS');
    await expect(runInventoryCli(['--input', source, '--output', output])).rejects.toThrow('INVENTORY_OUTPUT_EXISTS');
    expect(await readFile(source, 'utf8')).toBe(raw);
  });
});
