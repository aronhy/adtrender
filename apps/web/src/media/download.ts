import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { request, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';

export type AllowedHost = string | { hostname: string; includeSubdomains?: boolean; pathPattern?: string; redirectOnly?: boolean };
export type DownloadOptions = { allowedHosts: readonly AllowedHost[]; allowedMimeTypes?: readonly MediaMimeType[]; maxBytes: number; timeoutMs: number };
export type DownloadNetwork = {
  resolve(hostname: string): Promise<Array<{ address: string; family: number }>>;
  request(url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest;
};
export const META_MEDIA_HOSTS: readonly AllowedHost[] = [
  { hostname: 'facebook.com', includeSubdomains: true },
  { hostname: 'fbcdn.net', includeSubdomains: true },
  { hostname: 'cdninstagram.com', includeSubdomains: true },
];
export const MEDIA_MAX_BYTES = 256 * 1024 * 1024;
export const MEDIA_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm'] as const;
export type MediaMimeType = typeof MEDIA_MIME_TYPES[number];
export type MediaDownloadErrorCode = 'MEDIA_OPTIONS_INVALID' | 'MEDIA_URL_REJECTED' | 'MEDIA_ADDRESS_REJECTED'
  | 'MEDIA_REDIRECT_LIMIT' | 'MEDIA_HTTP_FAILED' | 'MEDIA_TOO_LARGE' | 'MEDIA_TYPE_REJECTED'
  | 'MEDIA_LENGTH_MISMATCH' | 'MEDIA_TIMEOUT' | 'MEDIA_NETWORK_FAILED';
export type DownloadResult = { ok: true; bytes: Buffer; mimeType: MediaMimeType; sizeBytes: number; sha256: string }
  | { ok: false; errorCode: MediaDownloadErrorCode };
class DownloadError extends Error {
  constructor(readonly code: MediaDownloadErrorCode) { super(code); }
}
const nativeNetwork: DownloadNetwork = { resolve: hostname => lookup(hostname, { all: true, verbatim: true }), request };

/** Conservative global-unicast check; IPv4-mapped/translated IPv6 is never accepted. */
export function isPublicAddress(address: string): boolean {
  if (address.includes('%') || address === '168.63.129.16') return false;
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes('.')) return false;
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  const value = groups.reduce((n, group) => (n << 16n) | BigInt(`0x${group}`), 0n);
  const inPrefix = (prefix: bigint, bits: number) => value >> BigInt(128 - bits) === prefix >> BigInt(128 - bits);
  return value >> 125n === 1n
    && !inPrefix(0x20010000000000000000000000000000n, 23)
    && !inPrefix(0x20010db8000000000000000000000000n, 32)
    && !inPrefix(0x20020000000000000000000000000000n, 16)
    && !inPrefix(0x3fff0000000000000000000000000000n, 20);
}

function validateUrl(raw: string, rules: readonly AllowedHost[], redirected = false): URL {
  if (raw !== raw.trim() || /[\\\u0000-\u0020]/.test(raw)) throw new DownloadError('MEDIA_URL_REJECTED');
  let url: URL;
  try { url = new URL(raw); } catch { throw new DownloadError('MEDIA_URL_REJECTED'); }
  const authority = /^https:\/\/([^/?#]+)/i.exec(raw)?.[1];
  const allowed = rules.some(rule => {
    const hostname = typeof rule === 'string' ? rule : rule.hostname;
    const suffix = typeof rule !== 'string' && rule.includeSubdomains;
    return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname) && !hostname.includes('..')
      && hostname.includes('.') && !isIP(hostname)
      && (url.hostname === hostname || (suffix && url.hostname.endsWith(`.${hostname}`)))
      && (typeof rule === 'string' || !rule.redirectOnly || redirected)
      && (typeof rule === 'string' || !rule.pathPattern || new RegExp(rule.pathPattern).test(url.pathname));
  });
  if (!authority || authority.includes(':') || authority.includes('@') || url.protocol !== 'https:'
    || url.username || url.password || url.port || isIP(url.hostname) || !allowed) throw new DownloadError('MEDIA_URL_REJECTED');
  return url;
}

export function isMediaUrlAllowed(raw: string, rules: readonly AllowedHost[]): boolean {
  try { validateUrl(raw, rules); return true; } catch { return false; }
}

export function matchesMediaSignature(mimeType: string, bytes: Uint8Array): mimeType is MediaMimeType {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (mimeType === 'image/jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mimeType === 'image/png') return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/gif') return data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'));
  if (mimeType === 'image/webp') return data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mimeType === 'video/mp4') return data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp';
  if (mimeType === 'video/webm') return data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return false;
}

async function download(raw: string, options: DownloadOptions, network: DownloadNetwork, signal: AbortSignal): Promise<DownloadResult> {
  let current = raw;
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    const url = validateUrl(current, options.allowedHosts, redirects > 0);
    const addresses = await network.resolve(url.hostname);
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address) || isIP(address) !== family)) {
      throw new DownloadError('MEDIA_ADDRESS_REJECTED');
    }
    const pinned = addresses[0];
    const response = await new Promise<IncomingMessage>((resolveResponse, reject) => {
      const req = network.request(url, {
        method: 'GET', agent: false, signal, rejectUnauthorized: true, maxHeaderSize: 16 * 1024,
        headers: { Accept: MEDIA_MIME_TYPES.join(', '), 'Accept-Encoding': 'identity' },
        lookup: (hostname, lookupOptions, callback) => {
          if (hostname !== url.hostname) return callback(new Error('MEDIA_ADDRESS_REJECTED'), '', 0);
          if (lookupOptions.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
      }, resolveResponse);
      req.once('error', reject);
      req.end();
    });
    const abortResponse = () => response.destroy(new DownloadError('MEDIA_TIMEOUT'));
    signal.addEventListener('abort', abortResponse, { once: true });
    try {
      signal.throwIfAborted();
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        if (redirects >= 3) throw new DownloadError('MEDIA_REDIRECT_LIMIT');
        const location = response.headers.location;
        if (!location || /[\\\u0000-\u0020]/.test(location)) throw new DownloadError('MEDIA_URL_REJECTED');
        // Validate raw absolute URLs before URL normalization can remove an explicit :443 port.
        if (/^[a-z][a-z\d+.-]*:/i.test(location)) validateUrl(location, options.allowedHosts, true);
        if (location.startsWith('//')) validateUrl(`https:${location}`, options.allowedHosts, true);
        current = new URL(location, url).href;
        continue;
      }
      if (status !== 200) throw new DownloadError('MEDIA_HTTP_FAILED');
      const mimeType = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!(MEDIA_MIME_TYPES as readonly string[]).includes(mimeType)
        || (options.allowedMimeTypes && !(options.allowedMimeTypes as readonly string[]).includes(mimeType))
        || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) throw new DownloadError('MEDIA_TYPE_REJECTED');
      const lengthHeader = response.headers['content-length'];
      if (lengthHeader !== undefined && !/^\d+$/.test(String(lengthHeader))) throw new DownloadError('MEDIA_LENGTH_MISMATCH');
      const declaredSize = lengthHeader === undefined ? undefined : Number(lengthHeader);
      if (declaredSize !== undefined && (!Number.isSafeInteger(declaredSize) || declaredSize > options.maxBytes)) throw new DownloadError('MEDIA_TOO_LARGE');
      const chunks: Buffer[] = []; let sizeBytes = 0;
      for await (const chunk of response) {
        signal.throwIfAborted();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sizeBytes += bytes.length;
        if (sizeBytes > options.maxBytes) throw new DownloadError('MEDIA_TOO_LARGE');
        chunks.push(bytes);
      }
      if (declaredSize !== undefined && sizeBytes !== declaredSize) throw new DownloadError('MEDIA_LENGTH_MISMATCH');
      const bytes = Buffer.concat(chunks, sizeBytes);
      if (!matchesMediaSignature(mimeType, bytes)) throw new DownloadError('MEDIA_TYPE_REJECTED');
      return { ok: true, bytes, mimeType, sizeBytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    } finally { signal.removeEventListener('abort', abortResponse); response.destroy(); }
  }
}

/** Server-only HTTPS download. The optional boundary supports alternate production DNS/transport providers. */
export async function safeDownload(url: string, options: DownloadOptions, network: DownloadNetwork = nativeNetwork): Promise<DownloadResult> {
  if (!Array.isArray(options.allowedHosts) || !options.allowedHosts.length || !Number.isSafeInteger(options.maxBytes)
    || (options.allowedMimeTypes && (!options.allowedMimeTypes.length || options.allowedMimeTypes.some(type => !(MEDIA_MIME_TYPES as readonly string[]).includes(type))))
    || options.maxBytes <= 0 || options.maxBytes > MEDIA_MAX_BYTES || !Number.isSafeInteger(options.timeoutMs)
    || options.timeoutMs <= 0 || options.timeoutMs > 120_000) return { ok: false, errorCode: 'MEDIA_OPTIONS_INVALID' };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      download(url, options, network, controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new DownloadError('MEDIA_TIMEOUT')); }, options.timeoutMs); }),
    ]);
  } catch (error) {
    return { ok: false, errorCode: controller.signal.aborted ? 'MEDIA_TIMEOUT' : error instanceof DownloadError ? error.code : 'MEDIA_NETWORK_FAILED' };
  } finally { clearTimeout(timer); }
}
