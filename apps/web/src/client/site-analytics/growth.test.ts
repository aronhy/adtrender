import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { createGrowthCapture } from './growth';

const { JSDOM, CookieJar } = createRequire(import.meta.url)('jsdom');
function fixture(url = 'https://adtrender.com/?utm_source=x&token=secret') {
  const dom = new JSDOM('', { url });
  const requests: Array<{ path: string; body: any; cookie: string }> = [];
  dom.window.fetch = async (path: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    requests.push({ path, body, cookie: dom.window.document.cookie });
    return { ok: true, json: async () => path.endsWith('/consent') ? { consent: body.choice, recording: body.choice === 'accepted' } : { recorded: true } };
  };
  const capture = createGrowthCapture(dom.window, { landingPath: '/', source: 'x', medium: 'social', campaign: 'launch-202610', referrerOrigin: 'https://example.com' });
  return { dom, capture, requests };
}

describe('first-party acquisition consent and delivery', () => {
  it('sends nothing until new explicit consent and binds attribution before events', async () => {
    const f = fixture();
    f.capture.event('PAGE_VIEW', '/'); await f.capture.flush();
    expect(f.requests).toEqual([]);
    f.capture.start(); f.capture.event('PAGE_VIEW', '/'); f.capture.event('CTA_CLICK', '/', 'signup');
    await f.capture.flush();
    expect(f.requests.map(r => r.path)).toEqual(['/growth/consent', '/growth/events', '/growth/events']);
    expect(f.requests[0]!.cookie).toContain('adtrender_analytics_consent=v2.accepted');
    expect(f.requests[0]!.body.attribution).toMatchObject({ source: 'x', campaign: 'launch-202610', landingPath: '/' });
    expect(f.requests[2]!.body).toMatchObject({ name: 'CTA_CLICK', target: 'signup', pathname: '/' });
    expect(f.requests[1]!.body.requestNonce).not.toBe(f.requests[2]!.body.requestNonce);
    expect(JSON.stringify(f.requests)).not.toMatch(/token|secret/);
    f.dom.window.close();
  });
  it('does not collect private pages or preview hosts', async () => {
    for (const url of ['https://adtrender.com/login?code=secret', 'http://localhost:3000/', 'https://adtrender.com.evil.test/']) {
      const f = fixture(url); f.capture.start(); f.capture.event('PAGE_VIEW', '/'); await f.capture.flush();
      expect(f.requests).toEqual([]); f.dom.window.close();
    }
  });
  it('refuses private event paths and deduplicates repeated initialization', async () => {
    const f = fixture(); f.capture.start(); f.capture.start(); f.capture.event('PAGE_VIEW', '/app');
    await f.capture.flush(); expect(f.requests).toHaveLength(1); f.dom.window.close();
  });
  it('clears the consent marker immediately and drops queued events on withdrawal', async () => {
    const f = fixture(); f.capture.start(); await f.capture.flush();
    f.capture.event('PAGE_VIEW', '/'); f.capture.revoke();
    expect(f.dom.window.document.cookie).not.toContain('v2.accepted');
    await f.capture.flush(); f.capture.event('CTA_CLICK', '/', 'signup'); await f.capture.flush();
    expect(f.requests.map(r => r.body.choice ?? r.body.name)).toEqual(['accepted', 'rejected']);
    expect(f.capture.status()).toBe('idle'); f.dom.window.close();
  });
  it('marks failed withdrawal for retry without keeping consent active', async () => {
    const f = fixture(); f.capture.start(); await f.capture.flush();
    const originalFetch = f.dom.window.fetch;
    f.dom.window.fetch = async () => { throw new Error('offline'); };
    f.capture.revoke(); await f.capture.flush();
    expect(f.capture.status()).toBe('revocation_pending');
    expect(f.dom.window.document.cookie).not.toContain('v2.accepted');
    f.dom.window.fetch = originalFetch;
    const fresh = createGrowthCapture(f.dom.window, null); fresh.restore(); await fresh.flush();
    expect(f.requests.at(-1)!.body).toEqual({ choice: 'rejected' });
    expect(fresh.status()).toBe('idle'); f.dom.window.close();
  });
  it('does not send events when the server declines or is unavailable', async () => {
    const f = fixture();
    f.dom.window.fetch = async () => ({ ok: false, json: async () => ({}) });
    f.capture.start(); f.capture.event('PAGE_VIEW', '/'); await f.capture.flush();
    expect(f.capture.status()).toBe('unavailable');
    // This cookie records the user's choice, not one tab's transport health.
    expect(f.dom.window.document.cookie).toContain('v2.accepted'); f.dom.window.close();
  });
  it('retries a failed consent request in the same document', async () => {
    const f = fixture(); const originalFetch = f.dom.window.fetch;
    f.dom.window.fetch = async () => { throw new Error('offline'); };
    f.capture.start(); await f.capture.flush();
    expect(f.capture.status()).toBe('unavailable');
    f.dom.window.fetch = originalFetch;
    f.capture.start(); f.capture.event('PAGE_VIEW', '/'); await f.capture.flush();
    expect(f.requests.map(r => r.body.choice ?? r.body.name)).toEqual(['accepted', 'PAGE_VIEW']);
    expect(f.capture.status()).toBe('active'); f.dom.window.close();
  });
  it('does not let one failed tab remove another tab\'s accepted marker', async () => {
    const cookieJar = new CookieJar();
    const a = new JSDOM('', { url: 'https://adtrender.com/', cookieJar });
    const b = new JSDOM('', { url: 'https://adtrender.com/', cookieJar });
    let rejectA!: (error: Error) => void;
    a.window.fetch = () => new Promise((_, reject) => { rejectA = reject; });
    const cookies: string[] = [];
    b.window.fetch = async () => { cookies.push(b.window.document.cookie); return { ok: true, json: async () => ({ consent: 'accepted', recording: true }) }; };
    const first = createGrowthCapture(a.window, { landingPath: '/' });
    const second = createGrowthCapture(b.window, { landingPath: '/' });
    first.start(); second.start(); await second.flush();
    rejectA(new Error('offline')); await first.flush();
    second.event('CTA_CLICK', '/', 'signup'); await second.flush();
    expect(cookies).toHaveLength(2);
    expect(cookies[1]).toContain('adtrender_analytics_consent=v2.accepted');
    expect(second.status()).toBe('active'); a.window.close(); b.window.close();
  });
  it('settles admission before handoff and dispatches page and click without waiting for their responses', async () => {
    const f = fixture();
    expect(f.capture.handoff).toBeTypeOf('function');
    let accept!: () => void;
    const admission = new Promise<void>(resolve => { accept = resolve; });
    const events: Array<() => void> = [];
    const sent: Array<{ name: string; keepalive: boolean | undefined; cookie: string }> = [];
    f.dom.window.fetch = async (_: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      sent.push({ name: body.choice ?? body.name, keepalive: init.keepalive, cookie: f.dom.cookieJar.getCookieStringSync(f.dom.window.location.href) });
      if (body.choice) {
        await admission;
        f.dom.cookieJar.setCookieSync('__Host-adtrender-growth=example; Path=/; Secure; HttpOnly', f.dom.window.location.href);
        return { ok: true, json: async () => ({ consent: 'accepted', recording: true }) };
      }
      await new Promise<void>(resolve => events.push(resolve));
      return { ok: true, json: async () => ({ recorded: true }) };
    };
    f.capture.start(); f.capture.event('PAGE_VIEW', '/'); f.capture.event('CTA_CLICK', '/', 'signup');
    let handedOff = false;
    const handoff = f.capture.handoff().then(() => { handedOff = true; });
    await Promise.resolve();
    expect(handedOff).toBe(false);
    expect(sent.map(row => row.name)).toEqual(['accepted']);
    accept(); await handoff;
    expect(sent.map(row => row.name)).toEqual(['accepted', 'PAGE_VIEW', 'CTA_CLICK']);
    expect(sent.slice(1).every(row => row.keepalive && row.cookie.includes('__Host-adtrender-growth=example'))).toBe(true);
    expect(events).toHaveLength(2);
    let flushed = false;
    const flush = f.capture.flush().then(() => { flushed = true; });
    await Promise.resolve(); expect(flushed).toBe(false);
    events.forEach(resolve => resolve()); await flush; f.dom.window.close();
  });
  it('releases handoff after the two-second consent timeout without sending queued events', async () => {
    const f = fixture(); expect(f.capture.handoff).toBeTypeOf('function');
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      f.dom.window.fetch = (_: string, init: RequestInit) => {
        sent.push(JSON.parse(init.body as string).choice);
        return new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      };
      f.capture.start(); f.capture.event('PAGE_VIEW', '/');
      let handedOff = false;
      const handoff = f.capture.handoff().then(() => { handedOff = true; });
      await vi.advanceTimersByTimeAsync(1000); expect(handedOff).toBe(false);
      await vi.advanceTimersByTimeAsync(1000); await handoff; await f.capture.flush();
      expect(sent).toEqual(['accepted']); expect(f.capture.status()).toBe('unavailable');
    } finally { vi.useRealTimers(); f.dom.window.close(); }
  });
  it('does not put withdrawal behind an in-flight event response', async () => {
    const f = fixture(); expect(f.capture.handoff).toBeTypeOf('function');
    f.capture.start(); await f.capture.flush();
    const originalFetch = f.dom.window.fetch;
    let release!: () => void;
    f.dom.window.fetch = async (path: string, init: RequestInit) => {
      if (path.endsWith('/events')) await new Promise<void>(resolve => { release = resolve; });
      return originalFetch(path, init);
    };
    f.capture.event('PAGE_VIEW', '/'); await Promise.resolve();
    f.capture.revoke(); await f.capture.handoff();
    expect(f.capture.status()).toBe('idle');
    expect(f.requests.map(row => row.body.choice)).toEqual(['accepted', 'rejected']);
    release(); await f.capture.flush(); f.dom.window.close();
  });
  it('coalesces superseded withdrawal retries while preserving the final rejection', async () => {
    const f = fixture(); f.capture.start(); await f.capture.flush();
    f.capture.revoke(); f.capture.revoke(); f.capture.revoke(); await f.capture.flush();
    expect(f.requests.map(row => row.body.choice)).toEqual(['accepted', 'rejected']);
    expect(f.capture.status()).toBe('idle'); f.dom.window.close();
  });
});
