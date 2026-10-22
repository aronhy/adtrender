/// <reference types="vite/client" />
import { consumePricingIntent } from './pricing-intent';
import { consumeHomeSearchIntent } from './home-search-intent';
import { consumeWorkspaceEntryIntent } from './workspace-entry-intent';

export type AppSurface = 'customer' | 'admin';
type PublicConfig = { surface?: string; adminOrigin?: string; customerOrigin?: string };
const modules = new Set(['dashboard', 'users', 'ads', 'analytics', 'operations', 'email', 'showcase', 'seeds']);
const languages = new Set(['zh-CN', 'zh-TW', 'en', 'es']);

function origin(value: string): string {
  if (!/^https?:\/\/[^/?#\\]+\/?$/i.test(value)) throw new Error('APP_SURFACE_ORIGIN_INVALID');
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('APP_SURFACE_ORIGIN_INVALID');
  }
  return url.origin;
}

/** Public build values only. Admin authorization remains on the API. */
export function parseAppSurfaceConfig(config: PublicConfig) {
  const surface = config.surface || 'customer';
  if (surface !== 'customer' && surface !== 'admin') throw new Error('APP_SURFACE_INVALID');
  const adminOrigin = origin(config.adminOrigin || 'https://admin.adtrender.com');
  const customerOrigin = origin(config.customerOrigin || 'https://adtrender.com');
  if (adminOrigin === customerOrigin) throw new Error('APP_SURFACE_ORIGINS_MUST_DIFFER');
  return { surface: surface as AppSurface, adminOrigin, customerOrigin };
}

function configured() {
  return parseAppSurfaceConfig({ surface: import.meta.env.VITE_APP_SURFACE, adminOrigin: import.meta.env.VITE_ADMIN_APP_ORIGIN, customerOrigin: import.meta.env.VITE_CUSTOMER_APP_ORIGIN });
}
export function appSurface(): AppSurface { return configured().surface; }
export function customerAppOrigin() { return configured().customerOrigin; }

function adminPath(search: string, includeModule = true) {
  const input = new URLSearchParams(search), safe = new URLSearchParams();
  const module = input.get('module'), lang = input.get('lang');
  if (includeModule && module && modules.has(module)) safe.set('module', module);
  if (lang && languages.has(lang)) safe.set('lang', lang);
  return `/app/admin${safe.size ? `?${safe}` : ''}`;
}
export function adminEntryUrl(search = '') { return configured().adminOrigin + adminPath(search); }

/** Match React Router's segment decoding without turning encoded slashes into separators. */
function routePath(pathname: string) {
  const decoded = pathname.split('/').map(segment => {
    try { return decodeURIComponent(segment).replace(/\//g, '%2F'); } catch { return segment; }
  }).join('/');
  return decoded.replace(/\/+$/, '').toLowerCase() || '/';
}

/** Old customer bookmarks carry no private scope or authentication values. */
export function surfaceDestination(pathname: string, search = '', surface = appSurface(), hash = ''): { type: 'internal' | 'external'; to: string } | null {
  const path = routePath(pathname);
  const admin = path === '/app/admin' || path.startsWith('/app/admin/');
  if (surface === 'customer') return admin ? { type: 'external', to: adminEntryUrl(search) } : null;
  if (path === '/app/admin') return pathname === path ? null : { type: 'internal', to: adminPath(search) };
  if (['/login', '/login/google/callback', '/request-password-reset', '/password-reset', '/email-verification'].includes(path)) {
    return pathname === path ? null : { type: 'internal', to: path + search + hash };
  }
  const destination = adminPath(search, false);
  return { type: 'internal', to: path === '/signup' ? destination.replace('/app/admin', '/login') : destination };
}

export function googleLoginTarget(value: string, surface = appSurface()) {
  const url = new URL(value);
  if (surface === 'admin') url.searchParams.set('app', 'admin');
  else url.searchParams.delete('app');
  return url.href;
}
export function loginDestination(search = '', surface = appSurface(), customerDestination = consumePricingIntent, homeSearchDestination = consumeHomeSearchIntent) {
  // Admin login does not consume customer intents. A fresh homepage search wins
  // once; without it, the existing billing intent/default destination applies.
  return surface === 'admin' ? adminPath(search, false) : consumeWorkspaceEntryIntent() ?? homeSearchDestination() ?? customerDestination();
}
