// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdFinderTool } from './AdFinderTool';
import { CalculatorTool } from './CalculatorTool';
import { HookTool } from './HookTool';

let host: HTMLDivElement;
let root: Root | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host.remove();
  vi.unstubAllGlobals();
});

const calculators = ['roas-calculator', 'ecommerce-profit-calculator', 'profit-margin-calculator', 'roi-calculator', 'customer-lifetime-value-calculator', 'shopify-cost-calculator'];
const tools: [string, ReactElement][] = [
  ...calculators.map(slug => [slug, createElement(CalculatorTool, { slug })] as [string, ReactElement]),
  ['hook-generator', createElement(HookTool)],
  ['ad-finder', createElement(AdFinderTool)],
];

function prerender(element: ReactElement) {
  host.innerHTML = renderToString(element);
  return host.querySelector('form')!;
}

async function hydrate(element: ReactElement) {
  const recoverable = vi.fn();
  await act(async () => { root = hydrateRoot(host, element, { onRecoverableError: recoverable }); });
  expect(recoverable).not.toHaveBeenCalled();
  expect(host.querySelector('fieldset')?.disabled).toBe(false);
  expect([...host.querySelectorAll('input,textarea,select,button')].every(control => !control.matches(':disabled'))).toBe(true);
}

async function fill(name: string, value: string) {
  const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!;
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement) {
  let submission: Event | undefined;
  const locationBefore = window.location.href;
  form.addEventListener('submit', event => { submission = event; }, { once: true });
  await act(async () => form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(submission?.defaultPrevented).toBe(true);
  expect(window.location.href).toBe(locationBefore);
}

describe('client-only public tool forms', () => {
  it.each(tools)('%s disables every control before hydration and excludes native form data', (_name, element) => {
    const form = prerender(element);
    const controls = [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input,textarea,select,button')];
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every(control => control.matches(':disabled'))).toBe(true);
    expect(form.querySelector('fieldset')?.disabled).toBe(true);
    expect(form.querySelector('noscript')?.textContent).toContain('JavaScript');
    expect(form.querySelector('noscript')?.textContent).toContain('当前浏览器');
    // Even restored/autofilled values must not become successful native GET
    // controls while React's preventDefault handler is unavailable.
    for (const field of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')) field.value = 'private-input-123';
    expect([...new FormData(form).entries()]).toEqual([]);
    const submitted = vi.fn((event: Event) => event.preventDefault());
    form.addEventListener('submit', submitted);
    form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    expect(submitted).not.toHaveBeenCalled();
  });

  it('hydrates the calculator, enables its controls, and calculates locally', async () => {
    const element = createElement(CalculatorTool, { slug: 'roas-calculator' });
    const form = prerender(element);
    await hydrate(element);
    await fill('revenue', '1000');
    await fill('adSpend', '250');
    await fill('contributionMarginPct', '40');
    await submit(form);
    expect(host.querySelector('.tool-results')?.textContent).toContain('4.00');
  });

  it('hydrates the Hook form and generates ten local templates', async () => {
    const element = createElement(HookTool);
    const form = prerender(element);
    await hydrate(element);
    await fill('product', '便携咖啡杯');
    await fill('audience', '通勤者');
    await fill('benefit', '单手开合');
    await submit(form);
    expect(host.querySelectorAll('.tool-hook-list li')).toHaveLength(10);
  });

  it('hydrates Ad Finder and prepares the official library link locally', async () => {
    const element = createElement(AdFinderTool);
    const form = prerender(element);
    await hydrate(element);
    await fill('query', 'shoes');
    await submit(form);
    expect(host.querySelector<HTMLAnchorElement>('.tool-link-list a[href^="https://"]')?.href).toBe('https://www.facebook.com/ads/library/');
  });
});
