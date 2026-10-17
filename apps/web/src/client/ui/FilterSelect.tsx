import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type SelectHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useWorkspaceLocale } from '../workspace-i18n/locale';
import './interactions.css';
type Props = SelectHTMLAttributes<HTMLSelectElement> & {
  searchLabel?: string;
  emptyLabel?: string;
};
type Option = { value: string; label: string; disabled: boolean };
function optionsOf(children: Props['children']): Option[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as ReactElement<{
      value?: unknown;
      children?: Props['children'];
      disabled?: boolean;
    }>;
    if (node.type === Fragment || node.type === 'optgroup')
      return optionsOf(node.props.children).map((option) => ({
        ...option,
        disabled: option.disabled || Boolean(node.props.disabled),
      }));
    if (node.type !== 'option') return [];
    return [
      {
        value: String(node.props.value ?? node.props.children ?? ''),
        label: Children.toArray(node.props.children).join(''),
        disabled: Boolean(node.props.disabled),
      },
    ];
  });
}
export function FilterSelect({
  children,
  searchLabel,
  emptyLabel,
  className = '',
  ...props
}: Props) {
  const { t } = useWorkspaceLocale();
  const id = useId();
  const options = optionsOf(children);
  const initial = String(
    props.value ?? props.defaultValue ?? options[0]?.value ?? ''
  );
  const [selected, setSelected] = useState(initial);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 200,
    maxHeight: 320,
  });
  const accepted = props.value !== undefined ? String(props.value) : selected;
  const native = useRef<HTMLSelectElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    popup = useRef<HTMLDivElement>(null),
    searchRef = useRef<HTMLInputElement>(null);
  const filtered = options.filter((option) =>
    option.label.toLocaleLowerCase().includes(search.toLocaleLowerCase())
  );
  useEffect(() => {
    if (props.value !== undefined) setSelected(String(props.value));
  }, [props.value]);
  useEffect(() => {
    const form = native.current?.form;
    if (!form) return;
    const reset = () => {
      queueMicrotask(() => {
        if (native.current) setSelected(native.current.value);
        setOpen(false);
        setSearch('');
      });
    };
    form.addEventListener('reset', reset);
    return () => form.removeEventListener('reset', reset);
  }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !popup.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const layout = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(
        Math.max(rect.width, 220),
        Math.max(160, window.innerWidth - 32)
      );
      const below = window.innerHeight - rect.bottom - 16;
      const above = rect.top - 16;
      const up = below < 240 && above > below;
      const height = Math.max(120, Math.min(320, up ? above - 8 : below - 8));
      setPosition({
        left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)),
        top: up ? Math.max(8, rect.top - height - 8) : rect.bottom + 8,
        width,
        maxHeight: height,
      });
    };
    layout();
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', layout);
    window.addEventListener('scroll', layout, true);
    if (options.length > 8) searchRef.current?.focus();
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', layout);
      window.removeEventListener('scroll', layout, true);
    };
  }, [open, options.length]);
  useEffect(() => {
    if (open)
      document
        .getElementById(`${id}-option-${active}`)
        ?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open, id]);
  const close = () => {
    setOpen(false);
    setSearch('');
    trigger.current?.focus();
  };
  const expand = () => {
    if (props.disabled || trigger.current?.matches(':disabled')) return;
    setSearch('');
    setActive(
      Math.max(
        0,
        options.findIndex((option) => option.value === accepted)
      )
    );
    setOpen(true);
  };
  const choose = (option?: Option) => {
    if (!option || option.disabled || !native.current) return;
    const select = native.current;
    select.value = option.value;
    setSelected(option.value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    close();
  };
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (open) event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      setSearch('');
      return;
    }
    if (
      event.key === 'Enter' ||
      (event.key === ' ' && event.target === trigger.current)
    ) {
      event.preventDefault();
      if (open) choose(filtered[active]);
      else expand();
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!open) {
        expand();
        return;
      }
      const step = event.key === 'ArrowUp' ? -1 : 1;
      let next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? filtered.length - 1
            : active + step;
      for (let i = 0; i < filtered.length; i++) {
        next = (next + filtered.length) % filtered.length;
        if (!filtered[next]?.disabled) break;
        next += step;
      }
      setActive(next);
    }
  };
  return (
    <span className={`ui-filter-select ${className}`}>
      <select
        {...props}
        className="ui-native-select"
        ref={native}
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          setSelected(event.currentTarget.value);
          props.onChange?.(event);
        }}
        onInvalid={(event) => {
          props.onInvalid?.(event);
          event.preventDefault();
          trigger.current?.focus();
          expand();
        }}
      >
        {children}
      </select>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        disabled={props.disabled}
        aria-label={props['aria-label']}
        aria-labelledby={props['aria-labelledby']}
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-haspopup="listbox"
        aria-activedescendant={
          open && filtered[active] ? `${id}-option-${active}` : undefined
        }
        className="ui-select-trigger"
        onClick={() => (open ? close() : expand())}
        onKeyDown={onKey}
      >
        <span>
          {options.find((option) => option.value === accepted)?.label ??
            options[0]?.label}
        </span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popup}
            className="ui-select-popup"
            style={position}
            onKeyDown={onKey}
          >
            {options.length > 8 && (
              <div className="ui-option-search">
                <Search size={15} aria-hidden="true" />
                <input
                  ref={searchRef}
                  type="search"
                  role="searchbox"
                  aria-controls={`${id}-list`}
                  aria-activedescendant={
                    filtered[active] ? `${id}-option-${active}` : undefined
                  }
                  aria-label={searchLabel ?? t('ui.optionsSearch')}
                  placeholder={searchLabel ?? t('ui.optionsSearch')}
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setActive(0);
                  }}
                />
              </div>
            )}
            <div
              id={`${id}-list`}
              role="listbox"
              aria-label={props['aria-label']}
            >
              {filtered.length ? (
                filtered.map((option, index) => (
                  <button
                    type="button"
                    role="option"
                    id={`${id}-option-${index}`}
                    key={option.value}
                    tabIndex={-1}
                    aria-selected={option.value === accepted}
                    disabled={option.disabled}
                    data-active={index === active}
                    onPointerMove={() => setActive(index)}
                    onClick={() => choose(option)}
                  >
                    <span>{option.label}</span>
                    {option.value === accepted && (
                      <Check size={15} aria-hidden="true" />
                    )}
                  </button>
                ))
              ) : (
                <p className="ui-select-empty">
                  {emptyLabel ?? t('ui.optionsEmpty')}
                </p>
              )}
            </div>
          </div>,
          document.body
        )}
    </span>
  );
}
