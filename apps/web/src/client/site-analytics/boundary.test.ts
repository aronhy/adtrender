// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://adtrender.com/"}
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, useLocation, useNavigate } from 'react-router';
import { AnalyticsBoundary, AnalyticsPreferences } from './SiteAnalytics';
import { createSiteAnalytics } from './analytics';

afterEach(() => { cleanup(); localStorage.clear(); document.head.querySelectorAll('script').forEach(script => script.remove()); history.replaceState({}, '', '/'); });
describe('website consent and render boundary', () => {
  it.each([
    ['/', '/tools/hook-generator'],
    ['/tools/roas-calculator', '/pricing'],
    ['/tools/roas-calculator', '/login'],
    ['/login', '/tools/ad-finder'],
  ])('blocks child mounting before changing analytics document type from %s to %s', (from, to) => {
    history.replaceState({}, '', from);
    const navigations: string[] = [];
    let destinationMounts = 0;
    const runtime = createSiteAnalytics(window, { ga4: 'G-TEST123456', clarity: 'abc123xyz' }, url => navigations.push(url));
    function Content() {
      const location = useLocation(), navigate = useNavigate();
      if (location.pathname === to) { destinationMounts++; return createElement('input', { 'aria-label': 'Sensitive tool input', value: 'PRIVATE', readOnly: true }); }
      return createElement('button', { onClick: () => void navigate(to) }, 'Next page');
    }
    render(createElement(MemoryRouter, { initialEntries: [from] }, createElement(AnalyticsBoundary, { runtime }, createElement(Content))));
    const accept = screen.queryByRole('button', { name: '接受统计' });
    if (accept) fireEvent.click(accept);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(destinationMounts).toBe(0);
    expect(screen.queryByRole('textbox', { name: 'Sensitive tool input' })).toBeNull();
    expect(navigations).toEqual([`https://adtrender.com${to}`]);
  });
  it('describes first-party tool statistics without promising third-party providers', () => {
    history.replaceState({}, '', '/tools/roas-calculator');
    const runtime = createSiteAnalytics(window, { ga4: 'G-TEST123456', clarity: 'abc123xyz', growth: true }, () => {});
    render(createElement(MemoryRouter, { initialEntries: ['/tools/roas-calculator'] }, createElement(AnalyticsBoundary, { runtime }, createElement('p', null, 'Calculator'))));
    const notice = screen.getByRole('complementary', { name: '网站统计选择' });
    expect(notice.textContent).not.toContain('Google Analytics');
    expect(notice.textContent).not.toContain('Microsoft Clarity');
    expect(notice.textContent).toContain('第一方');
    expect(notice.textContent).toContain('工具输入和结果');
  });
  it('shows an outstanding withdrawal after reload even if the server stays offline', async () => {
    localStorage.setItem('adtrender.website-analytics.v2', 'rejected');
    localStorage.setItem('adtrender.growth.revoke.v2', '1');
    const originalFetch = window.fetch;
    window.fetch = async () => { throw new Error('offline'); };
    try {
      const runtime = createSiteAnalytics(window, { growth: true }, () => {});
      render(createElement(MemoryRouter, null, createElement(AnalyticsBoundary, { runtime }, createElement(AnalyticsPreferences))));
      await runtime.growth!.flush();
      expect(screen.getByRole('button', { name: '重试撤回' })).toBeTruthy();
      expect(screen.getByText('当前选择：已拒绝统计')).toBeTruthy();
    } finally { window.fetch = originalFetch; }
  });
  it('never mounts private children after a programmatic router transition in a public document', () => {
    let privateMounts = 0;
    const navigations: string[] = [];
    const runtime = createSiteAnalytics(window, { ga4: 'G-TEST123456', clarity: 'abc123xyz' }, url => navigations.push(url));
    function Content() {
      const location = useLocation(), navigate = useNavigate();
      if (location.pathname.startsWith('/app')) { privateMounts++; return createElement('div', null, 'PRIVATE DATA'); }
      return createElement('button', { onClick: () => void navigate('/app/settings?workspace=private') }, 'Open workspace');
    }
    render(createElement(MemoryRouter, null, createElement(AnalyticsBoundary, { runtime }, createElement(Content))));
    fireEvent.click(screen.getByRole('button', { name: '接受统计' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace' }));
    expect(privateMounts).toBe(0);
    expect(screen.queryByText('PRIVATE DATA')).toBeNull();
    expect(navigations).toEqual(['https://adtrender.com/app/settings?workspace=private']);
  });
  it('lets visitors decline without provider scripts and later change the choice on the privacy page', () => {
    const runtime = createSiteAnalytics(window, { ga4: 'G-TEST123456' }, () => {});
    render(createElement(MemoryRouter, null, createElement(AnalyticsBoundary, { runtime }, createElement(AnalyticsPreferences))));
    const reject = screen.getAllByRole('button', { name: '拒绝统计' }); fireEvent.click(reject[0]!);
    expect(document.scripts.length).toBe(0);
    expect(screen.getByText('当前选择：已拒绝统计')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '允许统计' }));
    expect(document.scripts.length).toBe(1);
    expect(screen.getByRole('button', { name: '撤回统计同意' })).toBeTruthy();
  });
  it('runs a real Link click callback before the public-to-private document navigation', async () => {
    const order: string[] = [];
    const runtime = createSiteAnalytics(window, {}, url => order.push(`navigate:${url}`));
    const planLink = createElement(Link, { to: '/app/settings?plan=selected-plan', onClick: () => { localStorage.setItem('selected-plan', 'plan-1'); order.push('remember-plan'); } }, 'Choose plan');
    render(createElement(MemoryRouter, null, createElement(AnalyticsBoundary, { runtime }, planLink)));
    fireEvent.click(screen.getByRole('link', { name: 'Choose plan' }));
    await waitFor(() => expect(order).toEqual(['remember-plan', 'navigate:https://adtrender.com/app/settings?plan=selected-plan']));
    expect(localStorage.getItem('selected-plan')).toBe('plan-1');
    expect(location.pathname).toBe('/');
  });
});
