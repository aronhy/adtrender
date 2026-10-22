// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://adtrender.com/tools/roi-calculator"}
import { act, createElement as h } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ToolMeta } from './ToolLayout';

it('retains the tool metadata while hydrating the Wasp default head', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const tree = h('html', null,
    h('head', null, h('title', null, 'Default'), h('meta', { name: 'description', content: 'Default' })),
    h('body', null, h(ToolMeta, { title: 'ROI 计算器', description: '计算投资回报率。', path: '/tools/roi-calculator' }), h('p', null, 'ROI')));
  // The build keeps the route metadata and removes the framework defaults.
  const html = renderToString(tree).replace('<title>Default</title>', '').replace('<meta name="description" content="Default"/>', '');
  document.open(); document.write(html); document.close();
  const errors: unknown[] = [];
  let root: ReturnType<typeof hydrateRoot>;
  await act(async () => { root = hydrateRoot(document, tree, { onRecoverableError: error => errors.push(error) }); });
  expect(document.title).toBe('ROI 计算器 · AdTrender');
  expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe('计算投资回报率。');
  expect(errors).toEqual([]);
  await act(async () => root!.unmount());
  vi.unstubAllGlobals();
});
