import {
  Children,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { GripVertical, RotateCcw } from 'lucide-react';
import { useWorkspaceLocale } from '../workspace-i18n/locale';
import './interactions.css';
const storageKey = 'adtrender.detail.split';
const defaultRatio = 0.346;
export function ResizableAdDetail({
  children,
  label,
  resetLabel,
}: {
  children?: ReactNode;
  label?: string;
  resetLabel?: string;
}) {
  const { t } = useWorkspaceLocale();
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState(defaultRatio);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    id: number;
    startX: number;
    startWidth: number;
    startRatio: number;
  } | null>(null);
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved > 0.05 && saved < 0.95)
        setRatio(saved);
    } catch {}
    const measure = () =>
      setWidth(container.current?.getBoundingClientRect().width ?? 0);
    measure();
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(measure)
        : null;
    if (container.current) observer?.observe(container.current);
    window.addEventListener('resize', measure);
    window.addEventListener('blur', cancel);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('blur', cancel);
    };
  }, []);
  function cancel() {
    drag.current = null;
    setDragging(false);
  }
  const enabled =
    width >= 756 && (typeof window === 'undefined' || window.innerWidth > 880);
  const available = Math.max(1, width - 40);
  const left = Math.max(280, Math.min(available - 420, available * ratio));
  useEffect(() => {
    if (!enabled) cancel();
  }, [enabled]);
  const update = (pixels: number) => {
    const next = Math.max(280, Math.min(available - 420, pixels)) / available;
    setRatio(next);
    try {
      localStorage.setItem(storageKey, String(next));
    } catch {}
  };
  const reset = () => {
    setRatio(defaultRatio);
    try {
      localStorage.setItem(storageKey, String(defaultRatio));
    } catch {}
  };
  const nodes = Children.toArray(children);
  return (
    <div
      ref={container}
      className="ws-detail-layout ui-resizable"
      data-enabled={enabled}
      data-dragging={dragging}
      style={{ '--detail-left': `${left}px` } as CSSProperties}
    >
      {nodes[0]}
      <div className="ui-divider-track">
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={label ?? t('ui.resize')}
          aria-disabled={!enabled}
          aria-valuemin={280}
          aria-valuemax={Math.max(280, available - 420)}
          aria-valuenow={Math.round(left)}
          tabIndex={enabled ? 0 : -1}
          className="ui-divider"
          onDoubleClick={reset}
          onKeyDown={(event) => {
            if (!enabled) return;
            const next =
              event.key === 'ArrowLeft'
                ? left - 16
                : event.key === 'ArrowRight'
                  ? left + 16
                  : event.key === 'Home'
                    ? 280
                    : event.key === 'End'
                      ? available - 420
                      : undefined;
            if (next !== undefined) {
              event.preventDefault();
              update(next);
            }
          }}
          onPointerDown={(event) => {
            if (!enabled || event.button !== 0) return;
            event.preventDefault();
            drag.current = {
              id: event.pointerId,
              startX: event.clientX,
              startWidth: left,
              startRatio: ratio,
            };
            event.currentTarget.setPointerCapture?.(event.pointerId);
            setDragging(true);
          }}
          onPointerMove={(event) => {
            if (drag.current?.id === event.pointerId)
              update(
                drag.current.startWidth + event.clientX - drag.current.startX
              );
          }}
          onPointerUp={(event) => {
            if (drag.current?.id !== event.pointerId) return;
            cancel();
            if (event.currentTarget.hasPointerCapture?.(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={cancel}
          onLostPointerCapture={cancel}
        >
          <GripVertical size={15} aria-hidden="true" />
        </div>
        <button
          type="button"
          className="ui-divider-reset"
          aria-label={resetLabel ?? t('ui.resetLayout')}
          title={resetLabel ?? t('ui.resetLayout')}
          onClick={reset}
        >
          <RotateCcw size={13} aria-hidden="true" />
          <span className="ui-sr-only">
            {resetLabel ?? t('ui.resetLayout')}
          </span>
        </button>
      </div>
      {nodes[1]}
    </div>
  );
}
