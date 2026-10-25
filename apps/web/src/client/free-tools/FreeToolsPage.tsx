import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { mount, type FreeToolsController } from './mount';
import { pathToPrototypeHash, prototypeHashToPath } from './routing';
import { ToolMeta } from '../tools/ToolLayout';
import snapshotJson from './ssr-snapshots.json?raw';
import './integration.css';

const snapshots = JSON.parse(snapshotJson) as Record<string, { title: string; description: string; html: string }>;

/** A single instance survives navigation between the directory, guide and tools. */
export function FreeToolsPage() {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<FreeToolsController | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const canonical = prototypeHashToPath(pathToPrototypeHash(location.pathname))!;
  const snapshot = snapshots[canonical];
  const latestNavigate = useRef(navigate);
  const latestPath = useRef(location.pathname);
  latestNavigate.current = navigate;
  latestPath.current = location.pathname;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const shadow = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
    const instance = mount(shadow, {
      pathname: latestPath.current,
      navigate: (path, options) => { void latestNavigate.current(path, options); },
    });
    controller.current = instance;

    const ownerDocument = element.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const header = element.closest('.studio-public')?.querySelector('.studio-site-header')
      ?? ownerDocument.querySelector('.studio-site-header');
    const updateHeaderHeight = () => {
      if (header) element.style.setProperty('--free-tools-header-height', `${header.getBoundingClientRect().height}px`);
    };
    updateHeaderHeight();
    const observer = ownerWindow && 'ResizeObserver' in ownerWindow
      ? new ownerWindow.ResizeObserver(updateHeaderHeight) : null;
    if (header) observer?.observe(header);
    ownerWindow?.addEventListener('resize', updateHeaderHeight);

    return () => {
      observer?.disconnect();
      ownerWindow?.removeEventListener('resize', updateHeaderHeight);
      instance.dispose();
      if (controller.current === instance) controller.current = null;
    };
  }, []);

  useEffect(() => {
    const canonical = prototypeHashToPath(pathToPrototypeHash(location.pathname))!;
    if (location.pathname.replace(/\/+$/, '') !== canonical) {
      void latestNavigate.current('/tools', { replace: true });
      return;
    }
    controller.current?.setPath(location.pathname);
  }, [location.pathname]);

  // The frozen light DOM is readable before JavaScript and contains disabled
  // forms only. The shadow has no slot, so it hides this fallback immediately
  // while preserving React's identical server/hydration tree.
  return <><ToolMeta title={snapshot.title} description={snapshot.description} path={canonical}/><div ref={host} className="free-tools-native-root" data-clarity-mask="true" dangerouslySetInnerHTML={{ __html: snapshot.html }}/></>;
}

export default FreeToolsPage;
