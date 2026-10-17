// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyButton } from './CopyButton';
import { FilterSelect } from './FilterSelect';
import { AnimatedTabs } from './AnimatedTabs';
import { FaqAccordion } from './FaqAccordion';
import { ResizableAdDetail } from './ResizableAdDetail';
import { ToastProvider, ToastViewport, useToast } from './Toast';

let host: HTMLDivElement;
let root: Root;
const render = async (node: ReactNode) => {
  await act(async () => root.render(node));
};
const click = async (node: Element) => {
  await act(async () => {
    (node as HTMLElement).click();
  });
};
const key = async (node: Element, value: string) => {
  await act(async () => {
    node.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true })
    );
  });
};
const buttons = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
const button = (text: string) =>
  buttons().find((node) => node.textContent?.includes(text))!;
const change = async (node: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('copy feedback', () => {
  it('waits for real clipboard success, copies full content and resets for another ad', async () => {
    let resolve!: () => void;
    const writeText = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        })
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    await render(
      h(CopyButton, {
        value: '完整文案\nSecond line ✨',
        label: 'Copy',
        successLabel: 'Copied',
        errorLabel: 'Copy failed',
      })
    );
    await click(button('Copy'));
    expect(button('Copy').textContent).not.toContain('Copied');
    expect(writeText).toHaveBeenCalledWith('完整文案\nSecond line ✨');
    await act(async () => resolve());
    expect(button('Copied')).toBeTruthy();
    await render(
      h(CopyButton, {
        value: 'Another ad',
        label: 'Copy',
        successLabel: 'Copied',
        errorLabel: 'Copy failed',
      })
    );
    expect(button('Copy').textContent).not.toContain('Copied');
  });
  it('reports refusal without claiming success, and disables empty text', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    await render(
      h(CopyButton, {
        value: 'text',
        label: 'Copy',
        successLabel: 'Copied',
        errorLabel: 'Copy failed',
      })
    );
    await click(button('Copy'));
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      'Copy failed'
    );
    expect(host.textContent).not.toContain('Copied');
    await render(
      h(CopyButton, {
        value: '',
        label: 'Copy',
        successLabel: 'Copied',
        errorLabel: 'Copy failed',
      })
    );
    expect(button('Copy').disabled).toBe(true);
  });
});

describe('form-compatible filter dropdown', () => {
  const select = (extra = {}) =>
    h(
      FilterSelect,
      {
        name: 'country',
        'aria-label': 'Country',
        defaultValue: 'US',
        searchLabel: 'Find option',
        emptyLabel: 'No options',
        ...extra,
      },
      h('option', { value: '' }, 'All countries'),
      h('option', { value: 'US' }, 'United States'),
      h('option', { value: 'JP' }, 'Japan'),
      h('option', { value: 'CN', disabled: true }, 'China')
    );
  it('selects by keyboard without submitting and resets both UI and native FormData', async () => {
    const submit = vi.fn((event: Event) => event.preventDefault());
    await render(h('form', { onSubmit: submit }, select()));
    const trigger = host.querySelector('[role="combobox"]')!;
    await key(trigger, 'ArrowDown');
    await key(trigger, 'ArrowDown');
    await key(trigger, 'Enter');
    expect(new FormData(host.querySelector('form')!).get('country')).toBe('JP');
    expect(submit).not.toHaveBeenCalled();
    await act(async () => host.querySelector('form')!.reset());
    expect(new FormData(host.querySelector('form')!).get('country')).toBe('US');
    expect(trigger.textContent).toContain('United States');
  });
  it('keeps controlled values, disabled fields and an empty search distinct', async () => {
    const onChange = vi.fn();
    await render(h('form', null, select({ value: 'JP', onChange })));
    expect(host.querySelector('[role="combobox"]')?.textContent).toContain(
      'Japan'
    );
    await render(h('form', null, select({ disabled: true })));
    expect(
      host.querySelector<HTMLButtonElement>('[role="combobox"]')?.disabled
    ).toBe(true);
    expect(new FormData(host.querySelector('form')!).has('country')).toBe(
      false
    );
    await render(
      h(
        FilterSelect,
        {
          name: 'many',
          'aria-label': 'Many',
          searchLabel: 'Find option',
          emptyLabel: 'No options',
        },
        ...Array.from({ length: 10 }, (_, i) =>
          h('option', { value: String(i), key: i }, 'Option ' + i)
        )
      )
    );
    await click(host.querySelector('[role="combobox"]')!);
    const input =
      document.querySelector<HTMLInputElement>('[role="searchbox"]')!;
    await change(input, 'missing');
    expect(document.body.textContent).toContain('No options');
    await key(input, 'Escape');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(
      host.querySelector('[role="combobox"]')
    );
  });
});

describe('search dropdown tab order', () => {
  it.each([false, true])(
    'restores its form position before Tab navigation (reverse=%s)',
    async (reverse) => {
      await render(
        h(
          'form',
          null,
          h('input', { 'aria-label': 'Before' }),
          h(
            FilterSelect,
            { 'aria-label': 'Country' },
            ...Array.from({ length: 10 }, (_, i) =>
              h('option', { value: String(i), key: i }, 'Option ' + i)
            )
          ),
          h('input', { 'aria-label': 'After' })
        )
      );
      const trigger =
        host.querySelector<HTMLButtonElement>('[role="combobox"]')!;
      await click(trigger);
      const search =
        document.querySelector<HTMLInputElement>('[role="searchbox"]')!;
      expect(document.activeElement).toBe(search);
      await act(async () => {
        search.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Tab',
            shiftKey: reverse,
            bubbles: true,
          })
        );
      });
      expect(document.activeElement).toBe(trigger);
      expect(document.querySelector('[role="searchbox"]')).toBeNull();
    }
  );
});
describe('controlled dropdown consistency', () => {
  it('restores the accepted value if the parent rejects a selection', async () => {
    const onChange = vi.fn();
    await render(
      h(
        'form',
        null,
        h(
          FilterSelect,
          { name: 'country', 'aria-label': 'Country', value: 'US', onChange },
          h('option', { value: 'US' }, 'United States'),
          h('option', { value: 'JP' }, 'Japan')
        )
      )
    );
    const trigger = host.querySelector('[role="combobox"]')!;
    await click(trigger);
    await click(document.querySelectorAll('[role="option"]')[1]);
    expect(onChange).toHaveBeenCalled();
    expect(new FormData(host.querySelector('form')!).get('country')).toBe('US');
    await click(trigger);
    expect(
      document.querySelector('[aria-selected="true"]')?.textContent
    ).toContain('United States');
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      document.querySelector('[aria-selected="true"]')?.id
    );
  });
});

describe('tabs and FAQ', () => {
  it('keeps all tab labels and panel relationships while keyboard selection follows focus', async () => {
    const onChange = vi.fn();
    await render(
      h(AnimatedTabs, {
        idBase: 'detail',
        value: 'overview',
        onChange,
        label: 'Details',
        items: [
          { value: 'overview', label: 'Overview' },
          { value: 'history', label: 'History' },
          { value: 'related', label: 'Related ads' },
        ],
      })
    );
    expect(host.textContent).toContain('Related ads');
    await key(button('Overview'), 'End');
    expect(onChange).toHaveBeenLastCalledWith('related');
    expect(document.activeElement).toBe(button('Related ads'));
    expect(button('History').getAttribute('aria-controls')).toBe(
      'detail-history-panel'
    );
  });
  it('opens one FAQ, closes it again and makes collapsed answer links inert', async () => {
    await render(
      h(FaqAccordion, {
        defaultOpen: 0,
        items: [
          {
            question: 'First question',
            answer: h('a', { href: '#answer' }, 'First answer'),
          },
          { question: 'Second question', answer: 'Second answer' },
        ],
      })
    );
    expect(button('First question').getAttribute('aria-expanded')).toBe('true');
    await click(button('Second question'));
    expect(button('First question').getAttribute('aria-expanded')).toBe(
      'false'
    );
    const first = document.getElementById(
      button('First question').getAttribute('aria-controls')!
    )!;
    expect(first.hasAttribute('inert')).toBe(true);
    await click(button('Second question'));
    expect(button('Second question').getAttribute('aria-expanded')).toBe(
      'false'
    );
  });
});

describe('resizable detail layout', () => {
  it('clamps keyboard resizing, restores default and never remounts the media child', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1100,
      left: 0,
      right: 1100,
      top: 0,
      bottom: 600,
      height: 600,
      x: 0,
      y: 0,
      toJSON() {},
    });
    function Media() {
      return h('video', { 'data-media': true });
    }
    await render(
      h(
        ResizableAdDetail,
        { label: 'Resize panels', resetLabel: 'Reset layout' },
        h(Media),
        h('section', null, 'Facts')
      )
    );
    const media = host.querySelector('video');
    const divider = host.querySelector('[role="separator"]')!;
    expect(divider.getAttribute('aria-disabled')).toBe('false');
    await key(divider, 'Home');
    expect(
      Number(divider.getAttribute('aria-valuenow'))
    ).toBeGreaterThanOrEqual(280);
    await key(divider, 'End');
    expect(Number(divider.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(
      1100 - 420 - 40
    );
    await click(button('Reset layout'));
    expect(host.querySelector('video')).toBe(media);
    expect(localStorage.getItem('adtrender.detail.split')).not.toBeNull();
  });
});

function ToastProbe() {
  const { notify } = useToast();
  return h(
    'button',
    {
      onClick: () => {
        notify({ id: 'saved', type: 'success', message: 'Saved' });
        notify({ id: 'saved', type: 'success', message: 'Saved' });
      },
    },
    'Notify'
  );
}
describe('scoped notification queue', () => {
  it('deduplicates an operation, expires success and clears notifications on scope changes', async () => {
    vi.useFakeTimers();
    await render(
      h(ToastProvider, { scope: 'a' }, h(ToastProbe), h(ToastViewport))
    );
    await click(button('Notify'));
    expect(document.querySelectorAll('[data-toast-id="saved"]')).toHaveLength(
      1
    );
    await act(async () => {
      vi.advanceTimersByTime(5100);
    });
    expect(document.querySelector('[data-toast-id="saved"]')).toBeNull();
    await click(button('Notify'));
    await render(
      h(ToastProvider, { scope: 'b' }, h(ToastProbe), h(ToastViewport))
    );
    expect(document.querySelector('[data-toast-id="saved"]')).toBeNull();
  });
  it('keeps expiry paused while focused after the pointer leaves', async () => {
    vi.useFakeTimers();
    await render(
      h(ToastProvider, { scope: 'a' }, h(ToastProbe), h(ToastViewport))
    );
    await click(button('Notify'));
    const viewport = document.querySelector('.ui-toast-viewport')!;
    const dismiss =
      viewport.querySelector<HTMLButtonElement>('.ui-toast-close')!;
    await act(async () => {
      viewport.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      dismiss.focus();
      viewport.dispatchEvent(
        new MouseEvent('mouseout', {
          bubbles: true,
          relatedTarget: document.body,
        })
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    expect(
      document.querySelector('[data-toast-expanded="true"]')
    ).not.toBeNull();
    expect(document.querySelector('[data-toast-id="saved"]')).not.toBeNull();
    await act(async () => {
      dismiss.blur();
    });
    await act(async () => {
      vi.advanceTimersByTime(5100);
    });
    expect(document.querySelector('[data-toast-id="saved"]')).toBeNull();
  });
  it('retains errors and exposes notifications beyond the three visible stack items', async () => {
    vi.useFakeTimers();
    function Many() {
      const { notify } = useToast();
      return h(
        'button',
        {
          onClick: () => {
            for (let i = 0; i < 5; i++)
              notify({ id: String(i), type: 'error', message: 'Failure ' + i });
          },
        },
        'Many'
      );
    }
    await render(h(ToastProvider, { scope: 'a' }, h(Many), h(ToastViewport)));
    await click(button('Many'));
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(document.querySelectorAll('[data-toast-id]')).toHaveLength(5);
    expect(button('5')).toBeTruthy();
    await click(button('5'));
    expect(document.querySelector('[data-toast-expanded="true"]')).toBeTruthy();
  });
});
