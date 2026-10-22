import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('wasp/client/auth', () => ({ login: vi.fn(), signup: vi.fn(), requestPasswordReset: vi.fn(), resetPassword: vi.fn(), verifyEmail: vi.fn(), googleSignInUrl: 'https://adtrender.com/auth/google/login' }));
vi.mock('wasp/client/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
import { LoginPage } from './Pages';

const render = (surface: string) => {
  vi.stubEnv('VITE_APP_SURFACE', surface);
  const page = createElement(MemoryRouter, { initialEntries: ['/login?lang=zh-CN'] }, createElement(LoginPage));
  // The customer creative uses the real Wasp query hook. Administrator sign-in
  // deliberately renders without a query provider: mounting customer queries
  // there would fail this regression instead of being hidden by an RPC mock.
  if (surface === 'admin') return renderToStaticMarkup(page);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try { return renderToStaticMarkup(createElement(QueryClientProvider, { client }, page)); }
  finally { client.clear(); }
};
afterEach(() => vi.unstubAllEnvs());

describe('separate administrator sign-in presentation', () => {
  it('keeps customer signup reachable without a platform management entry', () => {
    const html = render('customer');
    expect(html).toContain('欢迎回来');
    expect(html).toContain('/signup?lang=zh-CN');
    expect(html).not.toContain('管理后台登录');
    expect(html).not.toContain('/app/admin');
    expect(html).toContain('auth-studio-creative');
  });
  it('labels the administrator login and removes customer signup and creative marketing', () => {
    const html = render('admin');
    expect(html).toContain('管理后台登录');
    expect(html).toContain('仅限已获平台管理权限的账号');
    expect(html).not.toContain('/signup');
    expect(html).not.toContain('开启你的下一个灵感');
    expect(html).not.toContain('auth-creative-images');
    expect(html).not.toContain('auth-studio-creative');
    expect(html).toContain('href="https://adtrender.com/terms?lang=zh-CN"');
    expect(html).toContain('href="https://adtrender.com/privacy?lang=zh-CN"');
    expect(html).toContain('返回客户网站');
  });
});
