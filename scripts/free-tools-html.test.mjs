import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { readyFreeTools } from '../apps/web/src/shared/free-tools.ts';

const build = new URL('../apps/web/.wasp/out/web-app/build/', import.meta.url);
const origin = process.env.VITE_CUSTOMER_APP_ORIGIN ?? 'https://adtrender.com';
const pages = [
  { slug: '', title: '免费电商与广告工具', heading: '电商与广告免费工具' },
  { slug: 'guide', title: '免费工具使用指南', heading: '按任务选择工具' },
  ...readyFreeTools,
];

for (const page of pages) {
  const path = `/tools${page.slug ? `/${page.slug}` : ''}`;
  test(`built HTML is independently readable at ${path}`, async () => {
    const html = await readFile(new URL(`.${path}/index.html`, build), 'utf8');
    const dom = new JSDOM(html);
    const document = dom.window.document;
    assert.equal(document.title, `${page.title} · AdTrender`);
    assert.equal(document.querySelectorAll('title').length, 1, 'one unambiguous page title');
    assert.equal(document.querySelectorAll('meta[name="description"]').length, 1);
    assert.equal(document.querySelector('link[rel="canonical"]')?.getAttribute('href'), origin + path);
    assert.equal(document.querySelector('h1')?.textContent, page.heading ?? page.title);
    assert.ok(document.querySelector('main')?.textContent.includes('无需登录'));
    if (page.slug && page.slug !== 'guide') {
      const form = document.querySelector('form');
      assert.ok(form, 'the tool form exists before JavaScript runs');
      assert.ok(form.querySelector('fieldset[disabled]'), 'native submission is disabled until React handles the form');
      assert.deepEqual([...new dom.window.FormData(form).entries()], []);
      for (const input of document.querySelectorAll('input, textarea')) {
        const knownDefault = input.getAttribute('name') === 'days' ? '30' : input.getAttribute('name') === 'fixed' ? '0' : '';
        assert.equal(input.getAttribute('value') ?? input.textContent, knownDefault, 'only approved blank fields and fixed defaults, never visitor input');
      }
    } else if (!page.slug) {
      for (const tool of readyFreeTools) {
        assert.ok(document.querySelector(`main a[href="/tools/${tool.slug}"]`));
      }
    }
  });
}

test('SPA fallback remains available for workspace and unknown routes', async () => {
  const html = await readFile(new URL('200.html', build), 'utf8');
  assert.ok(html.includes('type="module"'));
  assert.ok(!html.includes('class="tool-workbench"'));
});
