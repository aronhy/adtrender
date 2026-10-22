import { isFreeToolPath } from '../../shared/free-tools';

export type GrowthAttribution = { landingPath: string; source?: string; medium?: string; campaign?: string; content?: string; referrerOrigin?: string };
export type GrowthStatus = 'idle' | 'active' | 'unavailable' | 'revocation_pending';
const paths = new Set(['/', '/pricing', '/help', '/terms', '/privacy']);
const isPublicPath = (path: string) => paths.has(path) || isFreeToolPath(path);
const pendingKey = 'adtrender.growth.revoke.v2';
/** The first-party cookie is issued only by the server. This removable marker
 * also makes withdrawal effective for business requests while offline. */
export function createGrowthCapture(window: Window, attribution: GrowthAttribution | null) {
  const production = window.location.origin === 'https://adtrender.com';
  const publicDocument = production && isPublicPath(window.location.pathname);
  let active = false, admitted = false, version = 0, status: GrowthStatus = 'idle';
  let consentQueue = Promise.resolve();
  const events = new Set<Promise<void>>();
  const listeners = new Set<() => void>();
  const notify = (value: GrowthStatus) => { status = value; for (const listener of listeners) listener(); };
  const marker = (accepted: boolean) => {
    if (production) window.document.cookie = `adtrender_analytics_consent=${accepted ? 'v2.accepted' : ''}; Path=/; Secure; SameSite=Lax; Max-Age=${accepted ? 30 * 86400 : 0}`;
  };
  const pending = (value: boolean) => { try { if (value) window.localStorage.setItem(pendingKey, '1'); else window.localStorage.removeItem(pendingKey); } catch { /* Cookie marker still denies collection. */ } };
  const enqueueConsent = (task: () => Promise<void>) => { consentQueue = consentQueue.then(task).catch(() => {}); };
  async function post(path: string, body: unknown): Promise<Record<string, unknown> | null> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2000);
    try {
      const response = await window.fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true, signal: controller.signal });
      return response.ok ? await response.json() : null;
    } catch { return null; } finally { window.clearTimeout(timeout); }
  }
  function start() {
    if (!publicDocument || !attribution || active) return;
    active = true; admitted = false; marker(true);
    const attempt = ++version;
    enqueueConsent(async () => {
      if (attempt !== version || !active) return;
      const result = await post('/growth/consent', { choice: 'accepted', attribution });
      if (attempt !== version) return;
      admitted = result?.consent === 'accepted' && result.recording === true;
      if (admitted) { pending(false); notify('active'); }
      // A failed request must not erase another tab's explicit consent. The
      // server still requires a valid visit cookie; this tab sends no events.
      else { active = false; notify('unavailable'); }
    });
  }
  function revoke() {
    active = false; admitted = false; marker(false);
    if (!production) return;
    const attempt = ++version;
    pending(true); notify('revocation_pending');
    enqueueConsent(async () => {
      if (attempt !== version) return;
      const result = await post('/growth/consent', { choice: 'rejected' });
      if (attempt !== version) return;
      if (result?.consent === 'rejected' && result.recording === false) { pending(false); notify('idle'); }
    });
  }
  function event(name: 'PAGE_VIEW' | 'CTA_CLICK', pathname: string, target?: 'signup' | 'login' | 'pricing') {
    if (!publicDocument || !active || !isPublicPath(pathname)) return;
    const attempt = version;
    const requestNonce = window.crypto.randomUUID();
    // Admission is ordered, delivery is independent: a slow page view must not
    // leave the click queued in a document that is about to navigate away.
    const request = consentQueue.then(async () => {
      if (!active || !admitted || attempt !== version) return;
      await post('/growth/events', { name, pathname, ...(target ? { target } : {}), requestNonce });
    }).catch(() => {});
    events.add(request);
    void request.finally(() => events.delete(request));
  }
  function restore() {
    marker(false);
    try { if (window.localStorage.getItem(pendingKey) === '1') revoke(); } catch { /* Storage may be unavailable. */ }
  }
  async function handoff() {
    await consentQueue;
    // Let all already queued event callbacks dispatch their keepalive requests.
    await Promise.resolve();
  }
  const flush = async () => { await Promise.all([consentQueue, ...events]); };
  return { start, revoke, restore, event, handoff, flush, status: () => status,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
