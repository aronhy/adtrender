import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Info,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useWorkspaceLocale } from '../workspace-i18n/locale';
import './interactions.css';
export type ToastInput = {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
  action?: { label: string; run: () => void | Promise<unknown> };
};
type ToastItem = ToastInput & { scope: string };
const empty = {
  notify: (_input: ToastInput) => {},
  dismiss: (_id: string) => {},
  items: [] as ToastItem[],
};
const ToastContext = createContext(empty);
export function ToastProvider({
  scope,
  children,
}: {
  scope: string;
  children: ReactNode;
}) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(
    () => setItems((items) => items.filter((item) => item.scope === scope)),
    [scope]
  );
  const notify = useCallback(
    (input: ToastInput) => {
      if (currentScope.current !== scope) return;
      setItems((items) =>
        items.some((item) => item.id === input.id && item.scope === scope)
          ? items
          : [...items, { ...input, scope }]
      );
    },
    [scope]
  );
  const dismiss = useCallback(
    (id: string) => setItems((items) => items.filter((item) => item.id !== id)),
    []
  );
  return (
    <ToastContext.Provider
      value={{
        notify,
        dismiss,
        items: items.filter((item) => item.scope === scope),
      }}
    >
      {children}
    </ToastContext.Provider>
  );
}
export function useToast() {
  return useContext(ToastContext);
}
function Notification({
  item,
  paused,
  hidden,
  index,
}: {
  item: ToastItem;
  paused: boolean;
  hidden: boolean;
  index: number;
}) {
  const { dismiss } = useToast();
  const { t } = useWorkspaceLocale();
  const [visible, setVisible] = useState(() => !document.hidden);
  const remaining = useRef(5000);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  useEffect(() => {
    if (item.type === 'error' || paused || !visible) return;
    const start = Date.now();
    const timer = window.setTimeout(() => dismiss(item.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - start));
    };
  }, [item.id, item.type, paused, visible, dismiss]);
  const Icon =
    item.type === 'success'
      ? Check
      : item.type === 'error'
        ? TriangleAlert
        : Info;
  return (
    <li
      className={`ui-toast ui-toast-${item.type}`}
      data-toast-id={item.id}
      data-toast-hidden={hidden}
      aria-hidden={hidden}
      inert={hidden}
      style={{ '--toast-index': index } as React.CSSProperties}
    >
      <span className="ui-toast-icon">
        <Icon size={17} aria-hidden="true" />
      </span>
      <div>
        <p role={item.type === 'error' ? 'alert' : 'status'}>{item.message}</p>
        {item.action && (
          <button
            type="button"
            className="ui-toast-action"
            onClick={() => void item.action!.run()}
          >
            {item.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        className="ui-toast-close"
        aria-label={t('ui.dismiss')}
        onClick={() => dismiss(item.id)}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </li>
  );
}
export function ToastViewport() {
  const { items } = useToast();
  const { t } = useWorkspaceLocale();
  const [expanded, setExpanded] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hover, setHover] = useState(false);
  const paused = focused || hover;
  const showAll = expanded || hover || focused;
  useEffect(() => {
    if (!items.length) {
      setExpanded(false);
      setHover(false);
      setFocused(false);
    }
  }, [items.length]);
  if (!items.length) return null;
  return (
    <section
      className="ui-toast-viewport"
      aria-label={t('ui.notifications')}
      data-toast-expanded={showAll}
      onMouseEnter={() => {
        setHover(true);
      }}
      onMouseLeave={() => {
        setHover(false);
      }}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
    >
      <button
        className="ui-toast-toggle"
        type="button"
        aria-expanded={showAll}
        onClick={() => setExpanded(!expanded)}
      >
        {showAll
          ? t('ui.notificationsCollapse')
          : t('ui.notificationsCount', { count: items.length })}
        {showAll ? (
          <ChevronDown size={14} aria-hidden="true" />
        ) : (
          <ChevronUp size={14} aria-hidden="true" />
        )}
      </button>
      <ol>
        {[...items].reverse().map((item, index) => (
          <Notification
            key={`${item.scope}:${item.id}`}
            item={item}
            index={Math.min(index, 2)}
            hidden={!showAll && index > 2}
            paused={paused || expanded}
          />
        ))}
      </ol>
    </section>
  );
}
