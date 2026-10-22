// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdFinderTool } from './AdFinderTool';
import { consumeHomeSearchIntent } from '../home-search-intent';

let host: HTMLDivElement;
let root: Root;
let clipboard: PropertyDescriptor | undefined;
const copied: string[] = [];
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  copied.length = 0;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  await act(async () => root.render(createElement(AdFinderTool)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  sessionStorage.clear();
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
  else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function fill(value: string) {
  const field = host.querySelector('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() { await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }

describe('anonymous ad library navigation form', () => {
  it('requires a query and focuses its visible error without exposing navigation', async () => {
    await submit();
    expect(host.textContent).toContain('请输入品牌或关键词');
    expect(document.activeElement).toBe(host.querySelector('input'));
    expect(host.querySelectorAll('.tool-link-list a')).toHaveLength(0);
  });
  it('shows an overlong query error and focuses the input instead of silently truncating', async () => {
    const query = '字'.repeat(201);
    await fill(query);
    await submit();
    expect(host.textContent).toContain('最多 200');
    expect(document.activeElement).toBe(host.querySelector('input'));
    expect(host.querySelector('input')!.value).toBe(query);
    expect(host.querySelectorAll('.tool-link-list a')).toHaveLength(0);
  });
  it('offers official navigation and copy without login or a search API call', async () => {
    const fetch = vi.fn(() => { throw Error('search API not allowed'); });
    vi.stubGlobal('fetch', fetch);
    await fill('  & ? # 中文  ');
    await submit();
    const official = host.querySelector<HTMLAnchorElement>('.tool-link-list a[href^="https://"]')!;
    expect(official.href).toBe('https://www.facebook.com/ads/library/');
    expect(official.target).toBe('_blank');
    expect(official.rel).toContain('noopener');
    expect(official.getAttribute('referrerpolicy')).toBe('no-referrer');
    const workspace = host.querySelector<HTMLAnchorElement>('.tool-link-list a[href^="/app/ads"]')!;
    expect(workspace.getAttribute('href')).toBe('/app/ads?q=%26+%3F+%23+%E4%B8%AD%E6%96%87&platform=facebook');
    expect(workspace.textContent).toContain('需登录');
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent?.includes('复制关键词'))!.click());
    expect(copied).toEqual(['& ? # 中文']);
    expect(fetch).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
    expect(host.querySelector('.tool-link-list')!.closest('[data-clarity-mask="true"]')).not.toBeNull();
  });
  it('only remembers a constrained workspace search when the user chooses that link', async () => {
    await fill('shoes & bags');
    await submit();
    const link = host.querySelector<HTMLAnchorElement>('.tool-link-list a[href^="/app/ads"]')!;
    // Exercise the real click handler, while suppressing jsdom navigation.
    link.addEventListener('click', event => event.preventDefault());
    await act(async () => link.click());
    expect(consumeHomeSearchIntent()).toBe('/app/ads?q=shoes+%26+bags&platform=facebook');
    expect(consumeHomeSearchIntent()).toBeNull();
  });
  it('clears old links after query/platform changes and reset', async () => {
    await fill('shoes');
    await submit();
    await fill('new query');
    expect(host.querySelectorAll('.tool-link-list a')).toHaveLength(0);
    await submit();
    await act(async () => {
      const select = host.querySelector('select')!;
      select.value = 'google';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.querySelectorAll('.tool-link-list a')).toHaveLength(0);
    await submit();
    expect(host.querySelector<HTMLAnchorElement>('.tool-link-list a[href^="https://"]')!.href).toBe('https://adstransparency.google.com/');
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="reset"]')!.click());
    expect(host.querySelector('input')!.value).toBe('');
    expect(host.querySelectorAll('.tool-link-list a')).toHaveLength(0);
  });
});
