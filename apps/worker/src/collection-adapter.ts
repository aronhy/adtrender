import { pathToFileURL } from 'node:url';
import { isAbsolute } from 'node:path';
import type { CollectionAdapter } from './collection-tick';

export interface LoadedCollectionAdapter { adapter?: CollectionAdapter; requireSnapshots?: boolean; browserChannel?: 'chrome' | 'chromium' }

/**
 * Collectors live outside this repository. COLLECTION_ADAPTER_MODULE names an
 * absolute path to an ES module exporting `collect` (and optionally
 * `requireSnapshots`); without it the collection lane stays idle.
 */
export async function loadCollectionAdapter(env: Record<string, string | undefined> = process.env, load: (url: string) => Promise<any> = url => import(url)): Promise<LoadedCollectionAdapter> {
  const channel = env.META_BROWSER_CHANNEL?.trim();
  if (channel && channel !== 'chrome' && channel !== 'chromium') throw new Error('META_BROWSER_CHANNEL_INVALID');
  const browserChannel = (channel || undefined) as LoadedCollectionAdapter['browserChannel'];
  const path = env.COLLECTION_ADAPTER_MODULE?.trim();
  if (!path) return { browserChannel };
  if (!isAbsolute(path)) throw new Error('COLLECTION_ADAPTER_MODULE_INVALID');
  const module = await load(pathToFileURL(path).href);
  if (typeof module.collect !== 'function') throw new Error('COLLECTION_ADAPTER_MODULE_INVALID');
  return { adapter: module.collect, requireSnapshots: module.requireSnapshots === true, browserChannel };
}
