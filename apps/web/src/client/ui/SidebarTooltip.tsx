import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './interactions.css';
export function SidebarTooltip({
  children,
  label,
  enabled,
}: {
  children?: ReactNode;
  label: string;
  enabled: boolean;
}) {
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  useEffect(() => {
    const hide = () => setPosition(null);
    window.addEventListener('resize', hide);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('resize', hide);
      window.removeEventListener('scroll', hide, true);
    };
  }, []);
  useEffect(() => {
    if (!enabled) setPosition(null);
  }, [enabled]);
  const show = (node: HTMLElement) => {
    if (!enabled || window.innerWidth <= 960) return;
    const rect = node.querySelector('a')?.getBoundingClientRect();
    if (rect)
      setPosition({ left: rect.right + 12, top: rect.top + rect.height / 2 });
  };
  return (
    <span
      className="ui-sidebar-nav-item"
      onMouseEnter={(e) => show(e.currentTarget)}
      onMouseLeave={() => setPosition(null)}
      onFocusCapture={(e) => show(e.currentTarget)}
      onBlurCapture={() => setPosition(null)}
    >
      {children}
      {position &&
        enabled &&
        createPortal(
          <span role="tooltip" className="ui-sidebar-tooltip" style={position}>
            {label}
          </span>,
          document.body
        )}
    </span>
  );
}
