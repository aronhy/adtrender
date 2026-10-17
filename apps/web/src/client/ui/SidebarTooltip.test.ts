// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { SidebarTooltip } from './SidebarTooltip';
it('keeps the tooltip outside the sidebar clipping layer and hides it on mobile', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  host.className = 'sidebar';
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(
          SidebarTooltip,
          { label: 'Ad library', enabled: true },
          h('a', { href: '#' }, 'Icon')
        )
      )
    );
    await act(async () => host.querySelector('a')!.focus());
    const tip = document.querySelector('[role="tooltip"]');
    expect(tip).not.toBeNull();
    expect(host.contains(tip)).toBe(false);
    vi.stubGlobal('innerWidth', 396);
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
it('keeps collapsed navigation labels visible in the base mobile CSS', () => {
  const style = document.createElement('style');
  style.textContent = readFileSync(
    'apps/web/src/client/ui/interactions.css',
    'utf8'
  );
  document.head.append(style);
  const shell = document.createElement('div');
  shell.className = 'workspace-shell workspace-collapsed';
  shell.innerHTML =
    '<aside class="sidebar"><span class="sidebar-link-label">Ad library</span></aside>';
  document.body.append(shell);
  try {
    expect(getComputedStyle(shell.querySelector('span')!).opacity).not.toBe(
      '0'
    );
  } finally {
    style.remove();
    shell.remove();
  }
});
