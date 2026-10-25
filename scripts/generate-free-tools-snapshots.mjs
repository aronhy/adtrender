import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { freeToolsCatalog } from '../apps/web/src/client/free-tools/catalog.ts';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const folder = new URL('../apps/web/src/client/free-tools/', import.meta.url);
const output = new URL('ssr-snapshots.json', folder);
const slugs = new Set(freeToolsCatalog.map(tool => tool.slug));
const paths = ['/tools', '/tools/guide', ...freeToolsCatalog.map(tool => `/tools/${tool.slug}`)];

function toolPath(hash) {
  if (hash === '#/') return '/tools';
  if (hash === '#/guide') return '/tools/guide';
  const match = /^#\/tools\/([a-z0-9-]+)$/.exec(hash);
  return match && slugs.has(match[1]) ? `/tools/${match[1]}` : null;
}

/** Render only the approved, initial blank forms: no server data or network. */
export async function renderApprovedSnapshots() {
  const provenance = JSON.parse(await readFile(new URL('provenance.json', folder), 'utf8'));
  const sources = {};
  for (const entry of provenance.files) {
    const wrapped = await readFile(new URL(`source/${entry.file}`, folder), 'utf8');
    if (entry.wrapped && (!wrapped.startsWith(provenance.prefix) || !wrapped.endsWith(provenance.suffix))) throw new Error(`APPROVED_WRAPPER_CHANGED:${entry.file}`);
    const source = entry.wrapped ? wrapped.slice(provenance.prefix.length, -provenance.suffix.length) : wrapped;
    if (Buffer.byteLength(source) !== entry.bytes || createHash('sha256').update(source).digest('hex') !== entry.sha256) throw new Error(`APPROVED_SOURCE_CHANGED:${entry.file}`);
    sources[entry.file] = source;
  }
  const snapshots = {};
  for (const path of paths) {
    const hash = path === '/tools' ? '#/' : path === '/tools/guide' ? '#/guide' : `#/tools/${path.slice('/tools/'.length)}`;
    const dom = new JSDOM(sources['index.html'], { url: `https://adtrender.com${path}${hash}`, runScripts: 'outside-only', pretendToBeVisual: true });
    try {
      const window = dom.window, document = window.document;
      window.matchMedia = () => ({ matches: true });
      window.scrollTo = () => {};
      window.HTMLElement.prototype.scrollIntoView = () => {};
      window.fetch = () => { throw new Error('SNAPSHOT_NETWORK_FORBIDDEN'); };
      for (const name of ['icons-data.js', 'icons.js', 'calculations.js', 'policies.js', 'motion.js', 'app.js']) window.eval(sources[name]);
      const main = document.querySelector('main');
      for (const anchor of main.querySelectorAll('a[href]')) {
        const destination = toolPath(anchor.getAttribute('href'));
        if (destination) anchor.setAttribute('href', destination);
      }
      for (const form of main.querySelectorAll('form')) {
        const fieldset = document.createElement('fieldset');
        fieldset.disabled = true;
        fieldset.append(...form.childNodes);
        form.append(fieldset);
      }
      const description = document.querySelector('.detail-intro > p:last-of-type, .directory-hero > p:not(.hero-kicker), .guide-intro > p')?.textContent;
      if (!main?.querySelector('h1') || !description) throw new Error(`SNAPSHOT_CONTENT_MISSING:${path}`);
      snapshots[path] = {
        title: document.title.replace(/ · AdTrender$/, ''),
        description,
        html: main.outerHTML + document.querySelector('.cta-band').outerHTML,
      };
    } finally { dom.window.close(); }
  }
  return snapshots;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const serialized = JSON.stringify(await renderApprovedSnapshots(), null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (await readFile(output, 'utf8') !== serialized) throw new Error('FREE_TOOLS_SNAPSHOTS_STALE');
    process.stdout.write(`Approved SSR snapshots verified: ${paths.length}\n`);
  } else {
    await writeFile(output, serialized);
    process.stdout.write(`Approved SSR snapshots written: ${paths.length}\n`);
  }
}
