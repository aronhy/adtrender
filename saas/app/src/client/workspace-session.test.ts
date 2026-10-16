// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';

const session = vi.hoisted(() => ({
  auth: { data: null as null | { id: string }, isLoading: false, error: null as Error | null, refetch: async () => undefined },
  workspace: { data: undefined, isLoading: false, error: new Error('AUTH_REQUIRED'), refetch: async () => undefined },
}));
// The SDK is the network boundary. Keep the app layout and routing real.
vi.mock('wasp/client/auth', () => ({ useAuth: () => session.auth, logout: async () => undefined }));
vi.mock('wasp/client/operations', () => ({ useQuery: () => session.workspace, getAppState: {}, appCommand: async () => ({}) }));
import { App } from './App';

let container: HTMLDivElement;
let root: Root;
const app = () => createElement(MemoryRouter, { initialEntries: ['/app'] },
  createElement(Routes, null,
    createElement(Route, { path: '/app', element: createElement(App) }),
    createElement(Route, { path: '/login', element: createElement('h1', null, 'Sign in') }),
  ));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  session.auth = { data: null, isLoading: false, error: null, refetch: async () => undefined };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('workspace session boundary', () => {
  it('sends an expired or missing session to login even when the workspace query failed', async () => {
    await act(async () => root.render(app()));
    expect(container.querySelector('h1')?.textContent).toBe('Sign in');
    expect(container.textContent).not.toContain('暂时无法读取工作区');
  });

  it('returns to login when logout clears a previously authenticated session', async () => {
    session.auth.data = { id: 'member' };
    await act(async () => root.render(app()));
    expect(container.textContent).toContain('暂时无法读取工作区');
    session.auth.data = null;
    await act(async () => root.render(app()));
    expect(container.querySelector('h1')?.textContent).toBe('Sign in');
  });

  it('waits for the session check rather than redirecting while it is loading', async () => {
    session.auth.isLoading = true;
    await act(async () => root.render(app()));
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Sign in');
    expect(container.textContent).not.toContain('暂时无法读取工作区');
  });

  it('keeps a failed session request retryable instead of treating a network error as logout', async () => {
    session.auth.error = new Error('Network unavailable');
    await act(async () => root.render(app()));
    expect(container.textContent).toContain('暂时无法确认登录状态');
    expect(container.textContent).not.toContain('Sign in');
  });
});
