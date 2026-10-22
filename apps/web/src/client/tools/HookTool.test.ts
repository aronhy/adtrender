// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookTool } from './HookTool';

let host: HTMLDivElement;
let root: Root;
let clipboard: PropertyDescriptor | undefined;
const copied: string[] = [];

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  copied.length = 0;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  await act(async () => root.render(createElement(HookTool)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
  else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function fill(name: string, value: string) {
  const field = host.querySelector<HTMLTextAreaElement>(`[name="${name}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() { await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); }
async function validInput(product = '便携咖啡杯') {
  await fill('product', product);
  await fill('audience', '通勤者');
  await fill('benefit', '单手开合');
}

describe('hook template form', () => {
  it('shows required errors and focuses the first invalid field', async () => {
    await submit();
    expect(host.querySelectorAll('[aria-invalid="true"]')).toHaveLength(3);
    expect(host.textContent).toContain('请输入产品');
    expect(document.activeElement).toBe(host.querySelector('[name="product"]'));
    expect(host.querySelectorAll('.tool-hook-list li')).toHaveLength(0);
    await fill('product', '杯子');
    await submit();
    expect(document.activeElement).toBe(host.querySelector('[name="audience"]'));
  });
  it('shows a visible length error instead of generating overlong input', async () => {
    await validInput('字'.repeat(201));
    await submit();
    expect(host.textContent).toContain('最多 200');
    expect(host.querySelectorAll('.tool-hook-list li')).toHaveLength(0);
    expect(document.activeElement).toBe(host.querySelector('[name="product"]'));
  });
  it('renders literal user text and copies an individual result and all ten', async () => {
    const product = '<img src=x onerror=alert(1)> "杯子"\n新款';
    await validInput(product);
    await submit();
    const items = [...host.querySelectorAll('.tool-hook-list li')];
    expect(items).toHaveLength(10);
    expect(items[0].textContent).toContain(product);
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('模板生成');
    await act(async () => items[0].querySelector('button')!.click());
    expect(copied[0]).toBe(items[0].querySelector('p')!.textContent);
    const copyAll = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('复制全部'))!;
    await act(async () => copyAll.click());
    expect(copied[1]).toContain(items[0].querySelector('p')!.textContent!);
    expect(copied[1]).toContain(items[9].querySelector('p')!.textContent!);
    expect(host.querySelector('.tool-hook-list')!.closest('[data-clarity-mask="true"]')).not.toBeNull();
    expect(host.querySelector('[name="product"]')!.closest('[data-clarity-mask="true"]')).not.toBeNull();
  });
  it('clears stale results on edits, language changes and reset', async () => {
    await validInput();
    await submit();
    await fill('benefit', '轻便');
    expect(host.querySelectorAll('.tool-hook-list li')).toHaveLength(0);
    await submit();
    await act(async () => {
      const select = host.querySelector('select')!;
      select.value = 'en';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.querySelectorAll('.tool-hook-list li')).toHaveLength(0);
    await submit();
    expect(host.querySelector('.tool-hook-list li')!.textContent).toContain('Question');
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="reset"]')!.click());
    expect(host.querySelectorAll('.tool-hook-list li')).toHaveLength(0);
    expect([...host.querySelectorAll('textarea')].map(field => field.value)).toEqual(['', '', '']);
  });
  it('does not persist text or make a model request while generating', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const fetch = vi.fn(() => { throw Error('network not allowed'); });
    vi.stubGlobal('fetch', fetch);
    await validInput();
    await submit();
    expect(host.querySelectorAll('.tool-hook-list li')).toHaveLength(10);
    expect(setItem).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
