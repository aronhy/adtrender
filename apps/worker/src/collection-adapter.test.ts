import { describe, expect, it } from 'vitest';
import { loadCollectionAdapter } from './collection-adapter';

describe('collection adapter loading', () => {
  it('stays idle without a configured collector module', async () => {
    expect(await loadCollectionAdapter({})).toEqual({ browserChannel: undefined });
  });
  it('loads collect and requireSnapshots from an absolute module path', async () => {
    const collect = async () => { throw new Error('unused'); };
    const loaded = await loadCollectionAdapter({ COLLECTION_ADAPTER_MODULE: '/opt/collectors/meta.mjs', META_BROWSER_CHANNEL: 'chromium' }, async url => {
      expect(url).toBe('file:///opt/collectors/meta.mjs');
      return { collect, requireSnapshots: true };
    });
    expect(loaded).toEqual({ adapter: collect, requireSnapshots: true, browserChannel: 'chromium' });
  });
  it('rejects relative paths, modules without collect and unknown browser channels', async () => {
    await expect(loadCollectionAdapter({ COLLECTION_ADAPTER_MODULE: 'meta.mjs' })).rejects.toThrow('COLLECTION_ADAPTER_MODULE_INVALID');
    await expect(loadCollectionAdapter({ COLLECTION_ADAPTER_MODULE: '/x.mjs' }, async () => ({}))).rejects.toThrow('COLLECTION_ADAPTER_MODULE_INVALID');
    await expect(loadCollectionAdapter({ META_BROWSER_CHANNEL: 'firefox' })).rejects.toThrow('META_BROWSER_CHANNEL_INVALID');
  });
});
