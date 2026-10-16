// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdHistoryResult } from '../ad-history/api-types';
import { WorkspaceLocaleProvider } from './workspace-i18n/locale';
import { translate } from './workspace-i18n/messages';
import { AdHistoryCharts } from './AdHistoryCharts';

const result = (): AdHistoryResult => ({
  timezone: 'Asia/Shanghai', from: '2026-10-01', to: '2026-10-03', asOf: '2026-10-08T08:00:00Z', scopes: [], events: [], nextEventCursor: null, projectionPending: false,
  days: ['2026-10-01', '2026-10-03'].map(day => ({ day, scopeHash: 'scope-us', observationState: 'OBSERVED', checkState: 'OBSERVED', sourceStatus: 'ACTIVE', hasStateConflict: false, observationCount: 4, lastObservedAt: day + 'T08:00:00Z', latestObservationId: 'observation-' + day, body: null, headline: null, cta: null })),
  summary: { observedDays: 2, activeObservedDays: 2, conflictDays: 0, firstObservedAt: null, lastObservedAt: null, sourceStartedAt: null, sourceEndedAt: null, sourceDateSpanDays: null, spanBasis: null, spanEndAt: null, scope: 'selected-window' },
});
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
async function render(data: AdHistoryResult, locale = 'en', onSelect = vi.fn()) {
  await act(async () => root.render(createElement(MemoryRouter, { key: locale, initialEntries: ['/app?lang=' + locale] }, createElement(WorkspaceLocaleProvider, null, createElement(AdHistoryCharts, { data, onSelect })))));
}
describe('source status chart presentation', () => {
  it('does not draw a connecting line across a missing observation and explains the source-state chart in four languages', async () => {
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'es'] as const) {
      await render(result(), locale);
      const chart = container.querySelector('svg[role="img"]');
      expect(chart).not.toBeNull();
      expect(chart!.textContent).toContain(translate(locale, 'ads.history.chart.svgLabel'));
      const paths = container.querySelectorAll('path.ws-history-status-line');
      expect(paths).toHaveLength(2);
      expect(Array.from(paths).every(path => !path.getAttribute('d')?.includes('L'))).toBe(true);
      expect(container.querySelectorAll('.ws-history-status-button')).toHaveLength(3);
      expect(container.querySelector('[data-status="MISSING"]')?.getAttribute('aria-label')).toContain(translate(locale, 'ads.history.chart.missing'));
    }
  });

  it('keeps keyboard date selection in chronological order and opens evidence only for a real observed row', async () => {
    const onSelect = vi.fn(); await render(result(), 'en', onSelect);
    const buttons = container.querySelectorAll<HTMLButtonElement>('.ws-history-status-button');
    await act(async () => { buttons[2].focus(); buttons[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(document.activeElement).toBe(buttons[1]);
    expect(container.querySelector('.ws-history-chart-tooltip')?.textContent).toContain(translate('en', 'ads.history.chart.missing'));
    expect(container.querySelector('.ws-history-chart-view-day')).toBeNull();
    await act(async () => buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    expect(document.activeElement).toBe(buttons[0]);
    await act(async () => container.querySelector<HTMLButtonElement>('.ws-history-chart-view-day')!.click());
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ day: '2026-10-01', latestObservationId: 'observation-2026-10-01' }));
  });

  it('withholds the chart while daily projection is incomplete', async () => {
    await render({ ...result(), projectionPending: true });
    expect(container.querySelector('svg[role="img"]')).toBeNull();
    expect(container.textContent).toContain(translate('en', 'ads.history.projectionPending'));
  });

  it('retains one keyboard entry point after a new date window removes the selected day', async () => {
    await render(result());
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.ws-history-status-button')[2].focus());
    const next = { ...result(), from: '2026-10-04', to: '2026-10-05', days: [] };
    await render(next);
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.ws-history-status-button'));
    expect(buttons.filter(button => button.tabIndex === 0)).toHaveLength(1);
  });
});
