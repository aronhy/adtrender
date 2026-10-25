import { afterEach, expect, it, vi } from 'vitest';
import { adminEntryUrl, appSurface, customerAppOrigin, loginDestination, surfaceDestination } from './app-surface';
import { clientCorsOrigins } from '../server/admin-web';

afterEach(() => vi.unstubAllEnvs());

it.each(['localhost', 'research.example.test'])('keeps customer and administrator navigation on the self-hosted %s instance', host => {
  const customer = `https://${host}`, admin = `https://admin.${host}`;
  vi.stubEnv('VITE_APP_SURFACE', 'customer');
  vi.stubEnv('VITE_CUSTOMER_APP_ORIGIN', customer);
  vi.stubEnv('VITE_ADMIN_APP_ORIGIN', admin);
  expect(appSurface()).toBe('customer');
  expect(customerAppOrigin()).toBe(customer);
  expect(adminEntryUrl('?module=users&lang=en&token=private')).toBe(`${admin}/app/admin?module=users&lang=en`);
  expect(surfaceDestination('/app/admin', '?lang=en')).toEqual({ type: 'external', to: `${admin}/app/admin?lang=en` });
  expect(clientCorsOrigins({ WASP_WEB_CLIENT_URL: customer, ADMIN_WEB_CLIENT_URL: admin })).toEqual([customer, admin]);
  vi.stubEnv('VITE_APP_SURFACE', 'admin');
  expect(surfaceDestination('/app/admin')).toBeNull();
  expect(surfaceDestination('/signup', '?lang=en')).toEqual({ type: 'internal', to: '/login?lang=en' });
  expect(loginDestination('?lang=en')).toBe('/app/admin?lang=en');
});
