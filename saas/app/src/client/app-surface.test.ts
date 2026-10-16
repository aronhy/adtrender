import { describe, expect, it } from 'vitest';
import { adminEntryUrl, googleLoginTarget, loginDestination, parseAppSurfaceConfig, surfaceDestination } from './app-surface';

describe('customer and administrator entry separation', () => {
  it('uses the existing public domain for the default customer and admin origins', () => {
    expect(parseAppSurfaceConfig({})).toEqual({ surface: 'customer', adminOrigin: 'https://admin.adtrender.com', customerOrigin: 'https://adtrender.com' });
  });
  it('allows two explicit loopback origins for local preview', () => {
    expect(parseAppSurfaceConfig({ surface: 'admin', adminOrigin: 'http://127.0.0.1:3102', customerOrigin: 'http://127.0.0.1:3100' }).surface).toBe('admin');
  });
  it.each(['https://admin.adtrender.com/path', 'https://admin.adtrender.com/path/..', 'https://user:secret@admin.adtrender.com', 'https://admin.adtrender.com/?returnTo=evil', 'https://admin.adtrender.com/#token', 'http://admin.adtrender.com', 'javascript:alert(1)', '//evil.test'])('rejects unsafe configured origins: %s', adminOrigin => {
    expect(() => parseAppSurfaceConfig({ adminOrigin })).toThrow();
  });
  it('refuses unknown surface and redirect loops', () => {
    expect(() => parseAppSurfaceConfig({ surface: 'whatever' })).toThrow();
    expect(() => parseAppSurfaceConfig({ adminOrigin: 'https://adtrender.com' })).toThrow();
  });
  it('preserves only known module and language choices across sites', () => {
    const url = new URL(adminEntryUrl('?module=users&lang=es&workspace=private&organization=private&token=secret&returnTo=https://evil.test'));
    expect(url.origin).toBe('https://admin.adtrender.com');
    expect(url.pathname).toBe('/app/admin');
    expect(Object.fromEntries(url.searchParams)).toEqual({ module: 'users', lang: 'es' });
    expect(adminEntryUrl('?module=//evil.test&lang=evil&code=secret')).toBe('https://admin.adtrender.com/app/admin');
    expect(new URL(adminEntryUrl('?module=seeds&lang=zh-TW')).searchParams.get('module')).toBe('seeds');
  });
  it('redirects every customer admin path before mounting administration content', () => {
    for (const path of ['/app/admin', '/app/admin/', '/app/admin/nested', '/app/ADMIN', '/APP/ADMIN', '/app/%61dmin', '/%61pp/admin', '/app/%61DMIN/nested']) {
      expect(surfaceDestination(path, '?lang=zh-CN', 'customer')).toEqual({ type: 'external', to: 'https://admin.adtrender.com/app/admin?lang=zh-CN' });
    }
    expect(surfaceDestination('/app/ads', '', 'customer')).toBeNull();
    expect(surfaceDestination('/login', '', 'customer')).toBeNull();
  });
  it('canonicalizes admin route aliases while preserving one-use callback fragments on the same origin', () => {
    expect(surfaceDestination('/APP/%61DMIN', '?module=users&lang=es&token=private', 'admin')).toEqual({ type: 'internal', to: '/app/admin?module=users&lang=es' });
    expect(surfaceDestination('/LOGIN/google/callback', '?lang=en', 'admin', '#one-use-code')).toEqual({ type: 'internal', to: '/login/google/callback?lang=en#one-use-code' });
    expect(surfaceDestination('/app%2Fadmin', '', 'customer')).toBeNull();
  });
  it('keeps the admin site in admin and account recovery routes', () => {
    expect(surfaceDestination('/', '?lang=en&plan=secret', 'admin')).toEqual({ type: 'internal', to: '/app/admin?lang=en' });
    expect(surfaceDestination('/app/ads', '?lang=es&workspace=secret', 'admin')).toEqual({ type: 'internal', to: '/app/admin?lang=es' });
    expect(surfaceDestination('/signup', '?lang=es', 'admin')).toEqual({ type: 'internal', to: '/login?lang=es' });
    for (const path of ['/app/admin', '/login', '/login/google/callback', '/request-password-reset', '/password-reset', '/email-verification']) {
      expect(surfaceDestination(path, '?token=local-link', 'admin')).toBeNull();
    }
  });
  it('sends Google to the shared API with a fixed admin marker, never a callback URL', () => {
    expect(googleLoginTarget('https://adtrender.com/auth/google/login', 'admin')).toBe('https://adtrender.com/auth/google/login?app=admin');
    expect(googleLoginTarget('https://adtrender.com/auth/google/login', 'customer')).toBe('https://adtrender.com/auth/google/login');
    expect(googleLoginTarget('http://127.0.0.1:3101/auth/google/login', 'admin')).toBe('http://127.0.0.1:3101/auth/google/login?app=admin');
  });
  it('returns an admin login to the admin site without consuming a customer billing intent', () => {
    let consumed = 0;
    expect(loginDestination('?lang=es&returnTo=https://evil.test', 'admin', () => { consumed++; return '/app/settings?plan=private'; })).toBe('/app/admin?lang=es');
    expect(consumed).toBe(0);
    expect(loginDestination('', 'customer', () => { consumed++; return '/app/settings?plan=private'; })).toBe('/app/settings?plan=private');
    expect(consumed).toBe(1);
  });
  it('restores a homepage search before billing and leaves customer intents untouched on admin login', () => {
    let pricingConsumed = 0;
    let searchConsumed = 0;
    const pricing = () => { pricingConsumed++; return '/app/settings?plan=private'; };
    const search = () => { searchConsumed++; return '/app/ads?lang=es&q=zapatos&platform=google&source=google&media=TEXT'; };
    expect(loginDestination('?lang=es', 'admin', pricing, search)).toBe('/app/admin?lang=es');
    expect([pricingConsumed, searchConsumed]).toEqual([0, 0]);
    expect(loginDestination('', 'customer', pricing, search)).toBe('/app/ads?lang=es&q=zapatos&platform=google&source=google&media=TEXT');
    expect([pricingConsumed, searchConsumed]).toEqual([0, 1]);
    expect(loginDestination('', 'customer', pricing, () => null)).toBe('/app/settings?plan=private');
    expect(pricingConsumed).toBe(1);
  });
});
