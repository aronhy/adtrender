import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import './interactions.css';
type Item<T extends string> = { value: T; label: ReactNode };
export function AnimatedTabs<T extends string>({
  items,
  value,
  onChange,
  label,
  idBase,
  panelId,
  className = '',
}: {
  items: Item<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  idBase?: string;
  panelId?: (value: T) => string;
  className?: string;
}) {
  const generated = useId();
  const id = idBase ?? generated;
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const container = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    const update = () => {
      const node = refs.current.get(value),
        parent = container.current;
      if (!node || !parent) return;
      setPosition((old) => {
        const next = { left: node.offsetLeft, width: node.offsetWidth };
        return old.left === next.left && old.width === next.width ? old : next;
      });
    };
    update();
    const observer =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (container.current) observer?.observe(container.current);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [value, items.map((item) => String(item.label)).join('|')]);
  const select = (next: T, focus = false) => {
    onChange(next);
    if (focus) {
      refs.current.get(next)?.focus();
      refs.current
        .get(next)
        ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  };
  return (
    <div
      ref={container}
      className={`${className} ui-tabs`}
      role="tablist"
      aria-label={label}
      style={
        {
          '--tab-left': `${position.left}px`,
          '--tab-width': `${position.width}px`,
        } as CSSProperties
      }
    >
      <span className="ui-tab-indicator" aria-hidden="true" />
      {items.map((item, index) => (
        <button
          key={item.value}
          ref={(node) => {
            if (node) refs.current.set(item.value, node);
            else refs.current.delete(item.value);
          }}
          type="button"
          id={`${id}-${item.value}`}
          role="tab"
          aria-selected={value === item.value}
          aria-controls={panelId?.(item.value) ?? `${id}-${item.value}-panel`}
          tabIndex={value === item.value ? 0 : -1}
          onClick={() => select(item.value)}
          onKeyDown={(event) => {
            const next =
              event.key === 'ArrowRight'
                ? items[(index + 1) % items.length]
                : event.key === 'ArrowLeft'
                  ? items[(index + items.length - 1) % items.length]
                  : event.key === 'Home'
                    ? items[0]
                    : event.key === 'End'
                      ? items.at(-1)
                      : undefined;
            if (next) {
              event.preventDefault();
              select(next.value, true);
            }
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
