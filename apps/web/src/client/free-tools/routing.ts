import { freeToolsCatalog } from './catalog';

const slugs = new Set<string>(freeToolsCatalog.map(tool => tool.slug));

/** Only the approved public tool routes can cross the prototype/router boundary. */
export function prototypeHashToPath(hash: string): string | null {
  if (hash === '#/') return '/tools';
  if (hash === '#/guide') return '/tools/guide';
  const match = /^#\/tools\/([a-z0-9-]+)$/.exec(hash);
  return match && slugs.has(match[1]) ? `/tools/${match[1]}` : null;
}

export function pathToPrototypeHash(pathname: string): string {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/tools') return '#/';
  if (path === '/tools/guide') return '#/guide';
  const match = /^\/tools\/([a-z0-9-]+)$/.exec(path);
  return match && slugs.has(match[1]) ? `#/tools/${match[1]}` : '#/';
}
