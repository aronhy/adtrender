import { isIP } from 'node:net';

type RequestAddress = {
  socket: { remoteAddress?: string };
  headers: { [name: string]: string | string[] | undefined };
};

function normalizeIp(value: string): string | null {
  // Zone identifiers, ports, lists and CIDRs are not exact client addresses.
  if (value.includes('%')) return null;
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return null;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function resolveClientIp(request: RequestAddress, trustedProxyIps = process.env.TRUSTED_PROXY_IPS): string {
  const remoteAddress = request.socket.remoteAddress;
  const socketIp = remoteAddress ? normalizeIp(remoteAddress) : null;
  const fallback = socketIp ?? (remoteAddress || 'unknown');
  if (!socketIp || !trustedProxyIps?.trim()) return fallback;
  const trusted = trustedProxyIps.split(',').map((value) => normalizeIp(value.trim()));
  // A typo must not silently broaden the operator's intended trust boundary.
  if (trusted.some((address) => address === null) || !trusted.includes(socketIp)) return fallback;
  const realIp = request.headers['x-real-ip'];
  if (typeof realIp !== 'string') return fallback;
  // The trusted edge must overwrite X-Real-IP; X-Forwarded-For is never consulted.
  return normalizeIp(realIp.trim()) ?? fallback;
}
