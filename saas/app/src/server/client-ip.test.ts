import { describe, expect, it } from 'vitest';
import { resolveClientIp } from './client-ip';

function request(remoteAddress: string | undefined, realIp?: string | string[], forwardedFor?: string) {
  return { socket: { remoteAddress }, headers: { 'x-real-ip': realIp, 'x-forwarded-for': forwardedFor } };
}

describe('authentication rate-limit client IP trust boundary', () => {
  it('keeps direct requests on their socket address without a configured proxy', () => {
    expect(resolveClientIp(request('203.0.113.10', '198.51.100.2'), '')).toBe('203.0.113.10');
  });

  it('rejects spoofed headers from an untrusted direct connection', () => {
    expect(resolveClientIp(request('203.0.113.10', '198.51.100.2', '198.51.100.3'), '172.18.0.1')).toBe('203.0.113.10');
  });

  it('distinguishes clients behind the same explicitly trusted proxy', () => {
    expect(resolveClientIp(request('172.18.0.1', '198.51.100.2'), '172.18.0.1')).toBe('198.51.100.2');
    expect(resolveClientIp(request('172.18.0.1', '198.51.100.3'), '172.18.0.1')).toBe('198.51.100.3');
  });

  it.each(['127.0.0.1', '::ffff:127.0.0.1', '::FFFF:7F00:1'])('normalizes IPv4-mapped proxy %s and client addresses', (proxy) => {
    expect(resolveClientIp(request(proxy, '::ffff:192.0.2.10'), '::ffff:127.0.0.1')).toBe('192.0.2.10');
  });

  it('compares canonical IPv6 addresses and supports comma-separated exact proxy addresses', () => {
    expect(resolveClientIp(request('2001:DB8:0:0:0:0:0:1', '2001:DB8:0:0:0:0:0:2'), '172.18.0.1, 2001:db8::1')).toBe('2001:db8::2');
  });

  it.each([undefined, '', 'not-an-ip', '198.51.100.2, 198.51.100.3', ['198.51.100.2', '198.51.100.3'], '198.51.100.2:443', '[2001:db8::2]', 'fe80::2%eth0'])('falls back for an absent or invalid real-IP header: %j', (header) => {
    expect(resolveClientIp(request('::ffff:172.18.0.1', header, '198.51.100.5'), '172.18.0.1')).toBe('172.18.0.1');
  });

  it.each(['*', '172.18.0.0/16', '172.18.0.1,not-an-ip', 'localhost'])('does not accept malformed or broad trust configuration %s', (trusted) => {
    expect(resolveClientIp(request('172.18.0.1', '198.51.100.2'), trusted)).toBe('172.18.0.1');
  });

  it('does not trust a header when the socket address is absent', () => {
    expect(resolveClientIp(request(undefined, '198.51.100.2'), '172.18.0.1')).toBe('unknown');
  });
});
