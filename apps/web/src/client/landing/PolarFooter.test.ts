// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PolarFooter, footerSlogan } from './PolarFooter';
import { localeNames, locales } from './messages';

describe('polar footer navigation and language switching', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  const render = async (locale: typeof locales[number] = 'zh-CN', onLocaleChange = vi.fn()) => {
    await act(async () => root.render(createElement(PolarFooter, { locale, onLocaleChange })));
    return onLocaleChange;
  };
  const click = async (node: Element) => { await act(async () => node.dispatchEvent(new MouseEvent('click', { bubbles: true }))); };
  const key = async (node: Element, value: string) => { await act(async () => node.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }))); };

  it('uses the official English slogan and localized working destinations in every language', async () => {
    for (const locale of locales) {
      await render(locale);
      expect(host.querySelector('.polar-footer__slogan')?.textContent).toBe(footerSlogan);
      expect(host.querySelector('footer')?.lang).toBe(locale);
      expect(host.querySelectorAll('nav h2')).toHaveLength(4);
      for (const link of host.querySelectorAll<HTMLAnchorElement>('a')) {
        const url = new URL(link.href);
        expect(url.searchParams.get('lang')).toBe(locale);
        expect(['/', '/app/ads', '/pricing', '/app/research', '/app', '/help', '/privacy', '/terms']).toContain(url.pathname);
      }
      expect(host.querySelector('.polar-footer__language-trigger')?.textContent).toContain(localeNames[locale]);
    }
  });

  it('offers the existing four locales and delegates a keyboard selection to the page provider', async () => {
    const change = await render();
    const trigger = host.querySelector<HTMLButtonElement>('.polar-footer__language-trigger')!;
    await key(trigger, 'ArrowUp');
    const options = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    expect(options.map(option => option.textContent)).toEqual(locales.map(locale => localeNames[locale]));
    expect(document.activeElement).toBe(options[0]);
    await key(options[0], 'End');
    expect(document.activeElement).toBe(options[3]);
    await click(options[3]);
    expect(change).toHaveBeenCalledExactlyOnceWith('es');
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('supports arrow navigation, Escape dismissal and outside dismissal without changing locale', async () => {
    const change = await render('en');
    const trigger = host.querySelector<HTMLButtonElement>('.polar-footer__language-trigger')!;
    await click(trigger);
    const options = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    expect(document.activeElement).toBe(options[2]);
    await key(options[2], 'ArrowDown'); expect(document.activeElement).toBe(options[3]);
    await key(options[3], 'ArrowDown'); expect(document.activeElement).toBe(options[0]);
    await key(options[0], 'Escape'); expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await click(trigger);
    await act(async () => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(change).not.toHaveBeenCalled();
  });
});
