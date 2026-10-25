// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://adtrender.com/tools/shipping-policy-generator"}
import { act, createElement as h } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { FreeToolsPage } from './FreeToolsPage';
import { freeToolsCatalog } from './catalog';
const testUrl = import.meta.url;
const publicCss = readFileSync(new URL('../studio/studio-public.css', testUrl), 'utf8');
const integrationCss = readFileSync(new URL('./integration.css', testUrl), 'utf8');

const tree = (path: string) => h(MemoryRouter, { initialEntries: [path] }, h(FreeToolsPage));

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe('publishable approved tools HTML', () => {
  it.each([
    ['/tools', '电商与广告免费工具'],
    ['/tools/guide', '按任务选择工具'],
    ...freeToolsCatalog.map(tool => [`/tools/${tool.slug}`, tool.name]),
  ])('renders readable source content and canonical metadata before JavaScript at %s', (path, heading) => {
    const parsed = new DOMParser().parseFromString(renderToString(tree(path)), 'text/html');
    expect(parsed.querySelector('h1')?.textContent).toBe(heading);
    expect(parsed.querySelector('meta[name="description"]')?.getAttribute('content')).toBeTruthy();
    expect(parsed.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(`https://adtrender.com${path}`);
    expect(parsed.querySelector('main')?.textContent).toContain('无需登录');
    expect(parsed.querySelector('script')).toBeNull();
    expect(parsed.querySelector('meta[name="robots"]')).toBeNull();
    if (path !== '/tools' && path !== '/tools/guide') {
      const form = parsed.querySelector('form')!;
      expect(form).not.toBeNull();
      expect(form.querySelector('fieldset[disabled]')).not.toBeNull();
      expect([...new FormData(form).entries()]).toEqual([]);
    }
  });

  it('keeps the unhydrated body readable on its white background inside the dark public layout', () => {
    const style = document.createElement('style');
    style.textContent = publicCss + integrationCss;
    document.head.append(style);
    document.body.innerHTML = `<div class="studio-public">${renderToString(tree('/tools/guide'))}</div>`;
    const host = document.querySelector('.free-tools-native-root')!;
    expect(getComputedStyle(host).backgroundColor).toBe('rgb(255, 255, 255)');
    expect(getComputedStyle(host.querySelector('h1')!).color).toBe('rgb(28, 30, 33)');
    style.remove();
  });

  it('hydrates the static body without losing its content or exposing an active fallback form', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    // A real DOM Window is required: Vitest's window proxy is not a native
    // EventTarget, while the production adapter deliberately uses native APIs.
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://adtrender.com/tools/shipping-policy-generator', pretendToBeVisual: true });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    dom.window.matchMedia = (() => ({ matches: true })) as typeof window.matchMedia;
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    const container = document.createElement('div');
    document.body.append(container);
    container.innerHTML = renderToString(tree('/tools/shipping-policy-generator'));
    const recoverable: unknown[] = [];
    let root: ReturnType<typeof createRoot>;
    await act(async () => { root = hydrateRoot(container, tree('/tools/shipping-policy-generator'), { onRecoverableError: error => recoverable.push(error) }); });
    const host = container.querySelector('.free-tools-native-root')!;
    expect(host.shadowRoot?.querySelector('h1')?.textContent).toBe('配送政策模板');
    expect(host.querySelector('fieldset[disabled]')).not.toBeNull();
    expect(host.shadowRoot?.querySelector('fieldset[disabled]')).toBeNull();
    expect(recoverable).toEqual([]);
    await act(async () => { root!.unmount(); });
    expect(host.shadowRoot?.childNodes.length).toBe(0);
    dom.window.close();
  });
});
