import {afterEach, describe, expect, it, vi} from 'vitest';
import {chromium} from 'playwright';
import {browserContext} from './browser';

// The public Playwright boundary is replaced so no browser or source request runs.
vi.mock('playwright', () => ({chromium: {launchPersistentContext: vi.fn(async () => ({}))}}));
afterEach(() => {vi.unstubAllEnvs(); vi.clearAllMocks();});

describe('Meta browser egress', () => {
  it('passes the configured private SOCKS endpoint to the actual browser launch boundary', async () => {
    vi.stubEnv('META_PROXY_URL', 'socks5://adtrender-egress-us01:11081');
    await browserContext('/private-profile');
    expect(chromium.launchPersistentContext).toHaveBeenCalledWith('/private-profile', expect.objectContaining({proxy: {server: 'socks5://adtrender-egress-us01:11081'}}));
  });

  it('retains direct collection when no egress is configured', async () => {
    vi.stubEnv('META_PROXY_URL', undefined);
    await browserContext('/private-profile');
    const options = vi.mocked(chromium.launchPersistentContext).mock.calls[0][1];
    expect(options).not.toHaveProperty('proxy');
  });

  it.each([
    '',
    'https://adtrender-egress-us01:11081',
    'socks5://user:private-password@adtrender-egress-us01:11081',
    'socks5://adtrender-egress-us01',
    'socks5://adtrender-egress-us01:11081/path',
    'socks5://adtrender-egress-us01:11081?mode=direct',
    'socks5://unapproved.example.com:11081',
  ])('stops before launching rather than silently collecting directly for invalid endpoint %s', async endpoint => {
    vi.stubEnv('META_PROXY_URL', endpoint);
    await expect(browserContext('/private-profile')).rejects.toThrow('META_PROXY_CONFIG_INVALID');
    expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
  });

  it('does not pass collector credentials or SSH settings into the browser process', async () => {
    vi.stubEnv('META_PROXY_URL', 'socks5://adtrender-egress-us01:11081');
    vi.stubEnv('DATABASE_URL', 'private-database');
    vi.stubEnv('SSH_ASKPASS', '/private/ssh-askpass');
    await browserContext('/private-profile');
    const options = vi.mocked(chromium.launchPersistentContext).mock.calls[0][1];
    expect(options?.env).not.toHaveProperty('DATABASE_URL');
    expect(options?.env).not.toHaveProperty('SSH_ASKPASS');
    expect(options?.env).not.toHaveProperty('META_PROXY_URL');
  });
});
