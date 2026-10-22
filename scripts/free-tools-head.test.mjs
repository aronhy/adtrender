import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freeToolsHead } from './free-tools-head.mjs';

const transform = freeToolsHead(['/tools', '/tools/roi-calculator']).transformIndexHtml.handler;
const source = '<html><head><title>Default</title><meta name="description" content="Default"/><title>ROI · AdTrender</title><meta name="description" content="ROI formula"/><link rel="canonical" href="https://adtrender.com/tools/roi-calculator"/></head><body><p>Formula</p></body></html>';
test('tool HTML has one title and description from its rendered route', () => {
  const html = transform(source, { path: '/tools/roi-calculator/index.html' });
  assert.equal(html.match(/<title>/g).length, 1);
  assert.equal(html.match(/name="description"/g).length, 1);
  assert.ok(!html.includes('Default'));
  assert.ok(html.includes('<title>ROI · AdTrender</title>'));
  assert.ok(html.includes('<p>Formula</p>'));
  assert.ok(html.includes('rel="canonical"'));
});
test('SPA fallback, admin and unavailable routes keep the framework defaults', () => {
  for (const path of ['/200.html', '/app/admin', '/tools/unknown/index.html']) {
    assert.equal(transform(source, { path }), source);
  }
});
