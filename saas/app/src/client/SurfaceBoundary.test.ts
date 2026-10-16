import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ redirects: [] as string[] }));
vi.mock('react-router', async importOriginal => ({ ...await importOriginal<typeof import('react-router')>(), Navigate: ({ to }: { to: string }) => { fixture.redirects.push(to); return null; } }));
import { SurfaceBoundary } from './SurfaceBoundary';

beforeEach(() => { fixture.redirects.length = 0; });
afterEach(() => vi.unstubAllEnvs());
function render(surface: string, path: string) {
  vi.stubEnv('VITE_APP_SURFACE', surface);
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] }, createElement(SurfaceBoundary, { children: createElement('p', null, 'mounted protected content') })));
}
describe('entry boundary mounts only the selected application', () => {
  it('does not mount administrator children on a customer admin bookmark', () => {
    expect(render('customer', '/app/admin?module=users&token=private')).not.toContain('mounted protected content');
    expect(fixture.redirects).toEqual([]);
  });
  it('redirects the admin root before mounting the customer homepage', () => {
    expect(render('admin', '/?lang=en')).not.toContain('mounted protected content');
    expect(fixture.redirects).toEqual(['/app/admin?lang=en']);
  });
  it('allows account callback content to consume and strip its one-use fragment', () => {
    expect(render('admin', '/login/google/callback#one-use-code')).toContain('mounted protected content');
    expect(fixture.redirects).toEqual([]);
  });
});
