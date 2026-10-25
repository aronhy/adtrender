import html from './source/index.html?raw';
import styles from './source/styles.css?raw';
import iconsCss from './source/icons.css?raw';
import policiesCss from './source/policies.css?raw';
import polishCss from './source/polish.css?raw';
import integrationCss from './integration.css?raw';
import iconsData from './source/icons-data.js';
import icons from './source/icons.js';
import calculations from './source/calculations.js';
import policies from './source/policies.js';
import motion from './source/motion.js';
import app from './source/app.js';
import { pathToPrototypeHash, prototypeHashToPath } from './routing';

export type FreeToolsNavigate = (path: string, options?: { replace?: boolean }) => void;
export type FreeToolsController = { setPath(pathname: string): void; dispose(): void };
type Options = { pathname: string; navigate: FreeToolsNavigate };
type ListenerOptions = boolean | AddEventListenerOptions | undefined;
type Listener = EventListenerOrEventListenerObject;
type SourceFactory = (
  window: unknown, document: unknown, location: unknown,
  requestAnimationFrame: unknown, cancelAnimationFrame: unknown,
  setTimeout: unknown, clearTimeout: unknown,
) => void;

function shadowCss(css: string): string {
  return css.replace(/:root\b/g, ':host')
    .replace(/(^|[{},])(\s*)(?:html|body)(?=\s*[{,])/g, '$1$2:host')
    .replace(/(["'])assets\/fonts\//g, '$1/free-tools/assets/fonts/');
}

/** Runs the byte-preserved classic scripts with per-instance browser facades. */
export function mount(root: ShadowRoot, options: Options): FreeToolsController {
  const document = root.ownerDocument;
  const ownerWindow = document.defaultView;
  if (!ownerWindow) throw new Error('FREE_TOOLS_WINDOW_REQUIRED');
  const browser = ownerWindow;
  let disposed = false;
  let currentHash = pathToPrototypeHash(options.pathname);
  const previousTitle = document.title;
  let ownedTitle: string | undefined;
  const removeListeners: Array<() => void> = [];
  const timers = new Set<number>();
  const frames = new Set<number>();
  const animations = new Set<Animation>();
  const objectUrls = new Set<string>();
  const decorated = new WeakSet<Element>();
  const hashEvents = document.createDocumentFragment();
  const nativeQueryAll = browser.Element.prototype.querySelectorAll;
  const nativeQuery = browser.Element.prototype.querySelector;
  const innerHtml = Object.getOwnPropertyDescriptor(browser.Element.prototype, 'innerHTML')!;
  const anchorHref = Object.getOwnPropertyDescriptor(browser.HTMLAnchorElement.prototype, 'href')!;
  const nativeAdd = browser.EventTarget.prototype.addEventListener;
  const nativeRemove = browser.EventTarget.prototype.removeEventListener;

  const addListener = (target: EventTarget, type: string, listener: Listener | null, settings?: ListenerOptions) => {
    if (disposed || !listener) return;
    const guarded: EventListener = event => {
      if (disposed) return;
      if (typeof listener === 'function') listener.call(target, event);
      else listener.handleEvent(event);
    };
    nativeAdd.call(target, type, guarded, settings);
    const capture = typeof settings === 'boolean' ? settings : settings?.capture ?? false;
    const remove = () => nativeRemove.call(target, type, guarded, capture);
    removeListeners.push(remove);
    return { listener, type, capture, target, remove };
  };
  const registrations: Array<NonNullable<ReturnType<typeof addListener>>> = [];
  const listen = (target: EventTarget, type: string, listener: Listener | null, settings?: ListenerOptions) => {
    const entry = addListener(target, type, listener, settings);
    if (entry) registrations.push(entry);
  };
  const unlisten = (target: EventTarget, type: string, listener: Listener | null, settings?: boolean | EventListenerOptions) => {
    const capture = typeof settings === 'boolean' ? settings : settings?.capture ?? false;
    for (const entry of registrations) {
      if (entry.target === target && entry.type === type && entry.listener === listener && entry.capture === capture) entry.remove();
    }
  };
  const setTimer = (callback: TimerHandler, delay?: number, ...args: unknown[]): number => {
    if (disposed) return 0;
    if (typeof callback !== 'function') throw new TypeError('FREE_TOOLS_FUNCTION_TIMER_REQUIRED');
    const id = browser.setTimeout(() => {
      timers.delete(id);
      if (!disposed) callback(...args);
    }, delay);
    timers.add(id);
    return id;
  };
  const clearTimer = (id?: number) => {
    if (id !== undefined) { browser.clearTimeout(id); timers.delete(id); }
  };
  const requestFrame = (callback: FrameRequestCallback): number => {
    if (disposed) return 0;
    const id = browser.requestAnimationFrame(time => {
      frames.delete(id);
      if (!disposed) callback(time);
    });
    frames.add(id);
    return id;
  };
  const cancelFrame = (id: number) => { browser.cancelAnimationFrame(id); frames.delete(id); };

  function rewriteAnchor(element: Element) {
    if (!(element instanceof browser.HTMLAnchorElement)) return;
    const rawHref = element.getAttribute('href');
    const path = rawHref && prototypeHashToPath(rawHref);
    if (path) element.setAttribute('href', path);
  }

  // Instrument only nodes belonging to this instance; no native prototype or
  // global is patched. Synchronous innerHTML instrumentation covers motion that
  // begins before MutationObserver callbacks run.
  function decorate(element: Element) {
    if (decorated.has(element)) return;
    decorated.add(element);
    const animate = element.animate;
    Object.defineProperty(element, 'animate', { configurable: true, value: (...args: Parameters<Element['animate']>) => {
      // Motion is optional. A missing/blocked Web Animations API must never
      // turn a successful calculation into the source's validation error path.
      let animation: Animation;
      try {
        if (!animate) throw new Error('ANIMATION_UNAVAILABLE');
        animation = animate.apply(element, args);
      } catch {
        return { finished: Promise.resolve(), cancel() {} } as unknown as Animation;
      }
      if (disposed) animation.cancel();
      else {
        animations.add(animation);
        void Promise.resolve(animation.finished).then(() => animations.delete(animation), () => animations.delete(animation));
      }
      return animation;
    } });
    Object.defineProperty(element, 'innerHTML', {
      configurable: true,
      get: () => innerHtml.get!.call(element) as string,
      set: value => { innerHtml.set!.call(element, value); prepareTree(element); },
    });
    Object.defineProperty(element, 'querySelector', { configurable: true, value: (selector: string) => {
      const result = nativeQuery.call(element, selector);
      if (result) decorate(result);
      return result;
    } });
    Object.defineProperty(element, 'querySelectorAll', { configurable: true, value: (selector: string) => {
      const result = nativeQueryAll.call(element, selector);
      result.forEach(decorate);
      return result;
    } });
    Object.defineProperty(element, 'addEventListener', { configurable: true, value: (type: string, listener: Listener | null, settings?: ListenerOptions) => listen(element, type, listener, settings) });
    Object.defineProperty(element, 'removeEventListener', { configurable: true, value: (type: string, listener: Listener | null, settings?: boolean | EventListenerOptions) => unlisten(element, type, listener, settings) });
    if (element instanceof browser.HTMLAnchorElement) Object.defineProperty(element, 'href', {
      configurable: true,
      get: () => anchorHref.get!.call(element) as string,
      set: (value: string) => {
        if (value.startsWith('blob:')) objectUrls.add(value);
        anchorHref.set!.call(element, value);
      },
    });
    rewriteAnchor(element);
  }

  function prepareTree(parent: ParentNode) {
    if (parent instanceof browser.Element) decorate(parent);
    const children = parent instanceof browser.Element ? nativeQueryAll.call(parent, '*') : parent.querySelectorAll('*');
    children.forEach(decorate);
  }

  root.replaceChildren();
  for (const css of [styles, iconsCss, policiesCss, polishCss, integrationCss]) {
    const style = document.createElement('style');
    style.textContent = shadowCss(css);
    root.append(style);
  }
  const parsed = new browser.DOMParser().parseFromString(html, 'text/html');
  for (const node of parsed.body.children) {
    if (node.matches('main,.cta-band,.toast,dialog')) root.append(document.importNode(node, true));
  }
  prepareTree(root);

  // The original route closes its own old mobile header unconditionally. These
  // detached compatibility nodes preserve that code without rendering a second header.
  const mobileNav = document.createElement('nav');
  mobileNav.className = 'mobile-nav';
  mobileNav.hidden = true;
  const mobileMenu = document.createElement('button');
  mobileMenu.className = 'mobile-menu';
  mobileMenu.setAttribute('aria-expanded', 'false');
  const stubs = new Map<string, Element>([['.mobile-nav', mobileNav], ['.mobile-menu', mobileMenu]]);
  stubs.forEach(decorate);

  const localLocation = Object.defineProperty({}, 'hash', {
    get: () => currentHash,
    set: (value: string) => {
      if (disposed) return;
      const path = prototypeHashToPath(value.startsWith('#') ? value : `#${value}`);
      if (path) options.navigate(path);
    },
  });
  const windowValues: Record<PropertyKey, unknown> = Object.create(null) as Record<PropertyKey, unknown>;
  let localWindow: object;
  const fonts = document.fonts;
  const guardedFonts = fonts && new Proxy(fonts, {
    get(target, key) {
      if (key === 'ready') return {
        then: (ready?: (value: FontFaceSet) => unknown, rejected?: (reason: unknown) => unknown) => target.ready.then(
          value => !disposed && ready ? ready(value) : undefined,
          reason => !disposed && rejected ? rejected(reason) : undefined,
        ),
      };
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const documentValues: Record<PropertyKey, unknown> = {
    querySelector: (selector: string) => root.querySelector(selector) ?? stubs.get(selector) ?? null,
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    getElementById: (id: string) => root.getElementById(id),
    createElement: (tag: string, settings?: ElementCreationOptions) => {
      const element = document.createElement(tag, settings);
      decorate(element);
      return element;
    },
    createElementNS: (namespace: string | null, qualifiedName: string, settings?: string | ElementCreationOptions) => {
      const element = document.createElementNS(namespace, qualifiedName, settings);
      decorate(element);
      return element;
    },
    createTreeWalker: document.createTreeWalker.bind(document),
    addEventListener: (type: string, listener: Listener | null, settings?: ListenerOptions) => listen(root, type, listener, settings),
    removeEventListener: (type: string, listener: Listener | null, settings?: boolean | EventListenerOptions) => unlisten(root, type, listener, settings),
    fonts: guardedFonts,
  };
  const localDocument = new Proxy(documentValues, {
    get(target, key) {
      if (key === 'title') return document.title;
      if (key === 'activeElement') return root.activeElement ?? root.querySelector('main') ?? root.host;
      if (key === 'body' || key === 'documentElement') return root.host;
      if (key === 'defaultView') return localWindow;
      if (key === 'location') return localLocation;
      return target[key];
    },
    set(target, key, value) {
      if (key === 'title') {
        if (!disposed) { ownedTitle = String(value); document.title = ownedTitle; }
      } else target[key] = value;
      return true;
    },
  });
  Object.assign(windowValues, {
    document: localDocument,
    location: localLocation,
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    requestAnimationFrame: requestFrame,
    cancelAnimationFrame: cancelFrame,
    addEventListener: (type: string, listener: Listener | null, settings?: ListenerOptions) => listen(type === 'hashchange' ? hashEvents : browser, type, listener, settings),
    removeEventListener: (type: string, listener: Listener | null, settings?: boolean | EventListenerOptions) => unlisten(type === 'hashchange' ? hashEvents : browser, type, listener, settings),
    scrollTo: () => { if (!disposed) root.host.scrollIntoView({ block: 'start', behavior: 'auto' }); },
  });
  localWindow = new Proxy(windowValues, {
    get(target, key) {
      if (key === 'window' || key === 'self' || key === 'globalThis') return localWindow;
      if (Reflect.has(target, key)) return target[key];
      const value = Reflect.get(browser, key, browser) as unknown;
      return typeof value === 'function' ? value.bind(browser) : value;
    },
    set(target, key, value) { target[key] = value; return true; },
  });

  listen(root, 'click', event => {
    const mouse = event as MouseEvent;
    if (mouse.button !== 0 || mouse.ctrlKey || mouse.metaKey || mouse.shiftKey || mouse.altKey) return;
    const target = event.target instanceof browser.Element ? event.target : null;
    if (!target) return;
    if (target.closest('[data-workspace]')) {
      event.preventDefault(); event.stopImmediatePropagation();
      options.navigate('/app/ads');
      return;
    }
    const anchor = target.closest('a');
    if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return;
    const href = anchor.getAttribute('href');
    if (href === '#main' || href === '#result-panel') {
      const section = root.getElementById(href.slice(1));
      if (section) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (href === '#main' && section instanceof browser.HTMLElement) section.focus({ preventScroll: true });
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    const path = href?.startsWith('#') ? prototypeHashToPath(href)
      : href && prototypeHashToPath(pathToPrototypeHash(href));
    if (path && (href === '/tools' || href === '/tools/' || href === path || href?.startsWith('#/'))) {
      event.preventDefault(); event.stopImmediatePropagation();
      options.navigate(path);
    }
  }, true);

  const observer = new browser.MutationObserver(records => {
    if (disposed) return;
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof browser.Element) prepareTree(node);
    }
  });
  observer.observe(root, { childList: true, subtree: true });

  function dispose() {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    removeListeners.forEach(remove => remove());
    timers.forEach(id => browser!.clearTimeout(id));
    frames.forEach(id => browser!.cancelAnimationFrame(id));
    animations.forEach(animation => animation.cancel());
    root.querySelectorAll('*').forEach(element => element.getAnimations?.().forEach(animation => animation.cancel()));
    root.querySelectorAll('dialog[open]').forEach(dialog => { if (dialog instanceof browser!.HTMLDialogElement) dialog.close(); });
    objectUrls.forEach(url => browser!.URL.revokeObjectURL(url));
    timers.clear(); frames.clear(); animations.clear(); objectUrls.clear();
    registrations.length = 0; removeListeners.length = 0;
    root.replaceChildren();
    if (ownedTitle !== undefined && document.title === ownedTitle) document.title = previousTitle;
  }

  try {
    for (const factory of [iconsData, icons, calculations, policies, motion, app] as SourceFactory[]) {
      factory(localWindow, localDocument, localLocation, requestFrame, cancelFrame, setTimer, clearTimer);
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    setPath(pathname: string) {
      if (disposed) return;
      const hash = pathToPrototypeHash(pathname);
      if (hash === currentHash) return;
      currentHash = hash;
      hashEvents.dispatchEvent(new browser.Event('hashchange'));
    },
    dispose,
  };
}
