// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalculatorTool } from './CalculatorTool';

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function render(slug = 'roas-calculator') { await act(async () => root.render(h(CalculatorTool, { slug }))); }
async function click(text: string) {
  const button = Array.from(host.querySelectorAll('button')).find(item => item.textContent === text);
  expect(button, `Missing button ${text}`).toBeTruthy();
  await act(async () => button!.click());
}
function input(name: string) {
  const field = host.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  expect(field, `Missing input ${name}`).toBeTruthy();
  return field!;
}
async function change(name: string, value: string) {
  const field = input(name);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('anonymous calculator forms', () => {
  it.each(['roas-calculator', 'ecommerce-profit-calculator', 'profit-margin-calculator', 'roi-calculator', 'customer-lifetime-value-calculator', 'shopify-cost-calculator'])('%s starts empty and fills examples only on request', async slug => {
    await render(slug);
    const fields = Array.from(host.querySelectorAll('input'));
    expect(fields.length).toBeGreaterThan(1);
    expect(fields.every(field => field.value === '')).toBe(true);
    await click('填入示例');
    expect(fields.every(field => field.value !== '')).toBe(true);
    expect(host.querySelector('.tool-results')).toBeNull();
    await click('计算');
    expect(host.querySelector('.tool-results')).not.toBeNull();
  });
  it('focuses the first invalid input and links each error accessibly', async () => {
    await render();
    await click('计算');
    expect(document.activeElement).toBe(input('revenue'));
    for (const field of host.querySelectorAll('input')) {
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(document.getElementById(field.getAttribute('aria-describedby')!.split(' ').at(-1)!)?.textContent).toBeTruthy();
    }
    expect(host.querySelector('[aria-live]')?.textContent).toContain('检查');
  });
  it('shows a signed loss and removes stale results as soon as input changes', async () => {
    await render('ecommerce-profit-calculator');
    await click('填入示例');
    await change('goods', '800');
    await click('计算');
    expect(host.querySelector('.tool-results')?.textContent).toContain('-200.00');
    await change('revenue', '2000');
    expect(host.querySelector('.tool-results')).toBeNull();
    expect(host.textContent).toContain('重新计算');
    await click('计算');
    expect(host.querySelector('.tool-results')?.textContent).toContain('800.00');
  });
  it('reset clears inputs, results and errors', async () => {
    await render();
    await click('计算');
    await click('填入示例');
    await click('计算');
    await click('重置');
    expect(Array.from(host.querySelectorAll('input')).every(field => field.value === '')).toBe(true);
    expect(host.querySelector('.tool-results')).toBeNull();
    expect(host.querySelector('.tool-error')).toBeNull();
  });
  it('makes billing units explicit and invalidates old results when billing changes', async () => {
    await render('shopify-cost-calculator');
    expect(host.textContent).toContain('月度预算');
    expect(host.textContent).toContain('年度预算');
    await click('填入示例');
    await click('计算');
    expect(host.querySelector('.tool-results')?.textContent).toContain('612.00');
    const select = host.querySelector<HTMLSelectElement>('select[name="billing"]')!;
    await act(async () => { select.value = 'monthly'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(host.querySelector('.tool-results')).toBeNull();
    await click('计算');
    expect(host.querySelector('.tool-results')?.textContent).toContain('4572.00');
  });
  it('masks all financial fields and results from session replay', async () => {
    await render();
    for (const field of host.querySelectorAll('input')) expect(field.closest('[data-clarity-mask="true"]')).not.toBeNull();
    await click('填入示例');
    await click('计算');
    expect(host.querySelector('.tool-results')?.closest('[data-clarity-mask="true"]')).not.toBeNull();
  });
  it('keeps amounts local and copies a useful labeled result', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await render();
    await click('填入示例');
    await click('计算');
    await click('复制结果');
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('4.00'));
    expect(writeText.mock.calls[0][0]).toContain('实际 ROAS');
    expect(host.textContent).toContain('已复制');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storageSpy).not.toHaveBeenCalled();
  });
  it('exposes clipboard failure and keeps results available for manual copying', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } });
    await render();
    await click('填入示例');
    await click('计算');
    await click('复制结果');
    expect(host.textContent).toContain('复制失败');
    expect(host.querySelector('.tool-results')?.textContent).toContain('4.00');
  });
  it('labels LTV assumptions with annual units and identifies estimate limits', async () => {
    await render('customer-lifetime-value-calculator');
    const labels = Array.from(host.querySelectorAll('label')).map(label => label.textContent);
    expect(labels.some(label => label?.includes('每年购买次数'))).toBe(true);
    expect(labels.some(label => label?.includes('客户年限'))).toBe(true);
    expect(host.textContent).toContain('预测');
  });
  it('clears a previous calculator when the route slug changes', async () => {
    await render();
    await click('填入示例');
    await click('计算');
    await render('roi-calculator');
    expect(Array.from(host.querySelectorAll('input')).every(field => field.value === '')).toBe(true);
    expect(host.querySelector('.tool-results')).toBeNull();
  });
  it.each(['unknown-calculator', 'constructor', '__proto__', 'toString'])('does not substitute a calculator for unknown slug %s', async slug => {
    await render(slug);
    expect(host.querySelector('form')).toBeNull();
    expect(host.textContent).toContain('未找到');
  });
});
