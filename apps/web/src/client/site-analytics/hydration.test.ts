import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { SiteAnalytics } from './SiteAnalytics';
import * as analytics from './analytics';
import { CalculatorTool } from '../tools/CalculatorTool';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
let root: Root | undefined;
let dom: any;
const tool = '/tools/roas-calculator';

function browser(path: string, html = '') {
  dom = new JSDOM(`<!doctype html><html><head></head><body><div id="root">${html}</div></body></html>`, { url: `https://adtrender.com${path}` });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent']) vi.stubGlobal(key, dom.window[key]);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  dom.window.localStorage.clear();
  dom.window.fetch = async (_path: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    return { ok: true, json: async () => body.choice ? { consent: body.choice, recording: body.choice === 'accepted' } : { recorded: true } };
  };
  return document.getElementById('root')!;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  dom?.window.close(); dom = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('website analytics SSR hydration', () => {
  it('hydrates a true server-rendered calculator without changing its useId labels or replacing inputs', async () => {
    expect(typeof window).toBe('undefined');
    const tree = createElement(MemoryRouter, { initialEntries: [tool] }, createElement(SiteAnalytics, null, createElement(CalculatorTool, { slug: 'roas-calculator' })));
    const html = renderToString(tree);
    const host = browser(tool, html);
    const inputs = Array.from(host.querySelectorAll('input'));
    const ids = inputs.map(input => input.id);
    const errors: unknown[] = [];
    const consoleErrors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => { root = hydrateRoot(host, tree, { onRecoverableError: error => errors.push(error) }); });
    expect(errors).toEqual([]);
    expect(consoleErrors.mock.calls).toEqual([]);
    for (const [index, input] of Array.from(host.querySelectorAll('input')).entries()) expect(input).toBe(inputs[index]);
    expect(Array.from(host.querySelectorAll('input'), input => input.id)).toEqual(ids);
    expect(inputs).toHaveLength(3);
    for (const label of host.querySelectorAll('label')) {
      expect(label.control).toBe(host.querySelector(`[id="${label.htmlFor}"]`));
      expect(label.control).not.toBeNull();
    }
    expect(host.querySelector('[aria-label="网站统计选择"]')).not.toBeNull();
    expect(document.scripts.length).toBe(0);
  });

  it.each([
    { immediate: false, phase: 'after marketing analytics starts' },
    { immediate: true, phase: 'before analytics initialization in a child effect' },
  ])('keeps tool inputs unmounted when navigation occurs $phase', async ({ immediate }) => {
    const host = browser('/');
    vi.stubEnv('VITE_GA4_MEASUREMENT_ID', 'G-TEST123456');
    vi.stubEnv('VITE_CLARITY_PROJECT_ID', 'abc123xyz');
    dom.window.localStorage.setItem('adtrender.website-analytics.v2', 'accepted');
    const navigations: string[] = [];
    const createRuntime = analytics.createSiteAnalytics;
    vi.spyOn(analytics, 'createSiteAnalytics').mockImplementation((window, config) => createRuntime(window, config, url => navigations.push(url)));
    let toolMounts = 0;
    function Content() {
      const location = useLocation(), navigate = useNavigate();
      // Child effects run before SiteAnalytics initializes its deferred runtime.
      useEffect(() => { if (immediate) void navigate(tool); }, [navigate]);
      if (location.pathname === tool) { toolMounts++; return createElement(CalculatorTool, { slug: 'roas-calculator' }); }
      return createElement('button', { onClick: () => void navigate(tool) }, 'Open calculator');
    }
    await act(async () => { root = createRoot(host); root.render(createElement(MemoryRouter, null, createElement(SiteAnalytics, null, createElement(Content)))); });
    if (!immediate) {
      expect(document.scripts.length).toBe(2);
      await act(async () => { host.querySelector('button')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    }
    expect(toolMounts).toBe(0);
    expect(host.querySelector('input')).toBeNull();
    expect(navigations).toEqual([`https://adtrender.com${tool}`]);
    expect(document.scripts.length).toBe(0);
  });
});
