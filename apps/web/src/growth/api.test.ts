import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';
const mocks = vi.hoisted(() => ({ accept: vi.fn(), revoke: vi.fn(), event: vi.fn(), rate: vi.fn() }));
vi.mock('wasp/server', () => ({ prisma: {} }));
vi.mock('./service', () => ({ acceptConsent: mocks.accept, revokeConsent: mocks.revoke, recordPublicEvent: mocks.event }));
vi.mock('../server/rate-limit', () => ({ consumeRateLimit: mocks.rate }));
import { growthConsent, growthEvents, growthMiddleware } from './api';
function request(body: unknown, cookie = '', origin = 'https://adtrender.com') { return { body, headers: { cookie, origin }, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } } as any; }
function response() { return { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() } as any; }
afterEach(() => { vi.resetAllMocks(); });
describe('growth HTTP boundary', () => {
  it('enforces the raw 4KB limit and rejects malformed JSON before a handler or database call', async () => {
    const app = express(), config = growthMiddleware(new Map([['express.json', express.json()]]));
    app.post('/growth/consent', ...config.values(), (req, res) => { void growthConsent(req, res, {}); });
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('INVALID_LOCAL_LISTENER');
      const url = `http://127.0.0.1:${address.port}/growth/consent`, headers = { origin: 'https://adtrender.com', 'content-type': 'application/json' };
      expect((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ choice: 'accepted', unexpected: 'x'.repeat(4096) }) })).status).toBe(413);
      expect((await fetch(url, { method: 'POST', headers, body: '{' })).status).toBe(400);
      expect((await fetch(url, { method: 'POST', headers, body: '{}' })).status).toBe(400);
      expect(mocks.rate).not.toHaveBeenCalled(); expect(mocks.accept).not.toHaveBeenCalled();
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it('denies missing/cross-site origin and arbitrary conversion payloads before storage', async () => {
    const res = response(); await growthConsent(request({ choice: 'accepted' }, '', 'https://evil.test'), res, {});
    expect(res.status).toHaveBeenCalledWith(403); expect(mocks.accept).not.toHaveBeenCalled();
    const eventRes = response(); await growthEvents(request({ name: 'ACCOUNT_CREATED', userId: 'victim' }), eventRes, {});
    expect(eventRes.status).toHaveBeenCalledWith(400); expect(mocks.event).not.toHaveBeenCalled();
  });
  it('keeps the opaque cookie for retry when persistent withdrawal fails, then clears it on success', async () => {
    mocks.revoke.mockRejectedValue(new Error('private connection details'));
    const res = response(); await growthConsent(request({ choice: 'rejected' }, '__Host-adtrender-growth=' + 'A'.repeat(43)), res, {});
    expect(res.setHeader).not.toHaveBeenCalledWith('Set-Cookie', expect.anything());
    expect(res.status).toHaveBeenCalledWith(503); expect(res.json).toHaveBeenCalledWith({ error: 'GROWTH_UNAVAILABLE' });
    mocks.revoke.mockResolvedValue(undefined);
    const retry = response(); await growthConsent(request({ choice: 'rejected' }, '__Host-adtrender-growth=' + 'A'.repeat(43)), retry, {});
    expect(retry.setHeader).toHaveBeenCalledWith('Set-Cookie', expect.stringContaining('Max-Age=0'));
    expect(retry.json).toHaveBeenCalledWith({ consent: 'rejected', recording: false });
  });
  it('does not admit first-party events on an old HttpOnly cookie after JS withdrawal', async () => {
    mocks.event.mockResolvedValue({ recorded: false });
    await growthEvents(request({ name: 'PAGE_VIEW', pathname: '/', requestNonce: 'c5712813-5554-4c30-a3b7-f8244c936def' }, '__Host-adtrender-growth=' + 'A'.repeat(43)), response(), {});
    expect(mocks.event).toHaveBeenCalledWith(expect.anything(), undefined, expect.anything());
  });
});
