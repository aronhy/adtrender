// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://adtrender.com/tools/roas-calculator"}
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { SiteAnalytics } from './SiteAnalytics';
import * as analytics from './analytics';
import { freeToolPaths } from '../../shared/free-tools';

afterEach(() => { document.body.replaceChildren(); document.head.querySelectorAll('script').forEach(node => node.remove()); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function visit(path: string, children = h('input', { value: 'PRIVATE-TOOL-DATA', readOnly: true })) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubEnv('VITE_GA4_MEASUREMENT_ID', 'G-TEST123456');
  vi.stubEnv('VITE_CLARITY_PROJECT_ID', 'abc123xyz');
  history.replaceState({}, '', path);
  localStorage.setItem('adtrender.website-analytics.v2', 'accepted');
  const requests: string[] = [];
  window.fetch = vi.fn(async (url, init) => {
    requests.push(String(url));
    const body = JSON.parse(init?.body as string);
    return { ok: true, json: async () => body.choice ? { consent: body.choice, recording: true } : { recorded: true } } as Response;
  });
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(h(MemoryRouter, { initialEntries: [path] }, h(SiteAnalytics, null, children)));
  });
  return { root, requests, container };
}

it.each(freeToolPaths)('keeps accepted %s entirely offline from growth and third-party analytics', async path => {
  const page = await visit(path);
  try {
    expect(page.requests).toEqual([]);
    expect(document.scripts.length).toBe(0);
    expect(page.container.querySelector('input')?.value).toBe('PRIVATE-TOOL-DATA');
    expect(page.container.querySelector('.analytics-consent')).toBeNull();
  } finally { await act(async () => page.root.unmount()); }
});

it.each(['/pricing', '/login', '/app/ads'])('leaves tools through a new document before mounting %s', async destination => {
  const navigations: string[] = [];
  const createRuntime = analytics.createSiteAnalytics;
  vi.spyOn(analytics, 'createSiteAnalytics').mockImplementation((browser, config) => createRuntime(browser, config, url => navigations.push(url)));
  let destinationMounts = 0;
  function Content() {
    const location = useLocation(), navigate = useNavigate();
    if (location.pathname === destination) { destinationMounts++; return h('input', { value: 'PRIVATE-DESTINATION', readOnly: true }); }
    return h('button', { onClick: () => void navigate(destination) }, 'Leave tools');
  }
  const page = await visit('/tools/guide', h(Content));
  try {
    await act(async () => page.container.querySelector('button')!.click());
    expect(destinationMounts).toBe(0);
    expect(navigations).toEqual([`https://adtrender.com${destination}`]);
    expect(page.requests).toEqual([]);
    expect(document.scripts.length).toBe(0);
  } finally { await act(async () => page.root.unmount()); }
});

it('retains existing accepted marketing analytics and first-party attribution', async () => {
  const page = await visit('/pricing');
  try {
    expect(page.requests).toContain('/growth/consent');
    expect(page.requests).toContain('/growth/events');
    expect([...document.scripts].map(node => node.src)).toEqual(expect.arrayContaining([
      'https://www.googletagmanager.com/gtag/js?id=G-TEST123456',
      'https://www.clarity.ms/tag/abc123xyz',
    ]));
  } finally { await act(async () => page.root.unmount()); }
});
