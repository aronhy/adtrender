import {isIP} from 'node:net';

/** Only deployment-owned Docker names or local/private IPs are valid endpoints. */
export function metaProxy(value: string | undefined): {server: string} | undefined {
  if (value === undefined) return undefined;
  const invalid = () => new Error('META_PROXY_CONFIG_INVALID');
  let url: URL;
  try {url = new URL(value);} catch {throw invalid();}
  const host = url.hostname;
  const privateIPv4 = isIP(host) === 4 && (
    host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.') ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
  );
  const ownedEndpoint = /^adtrender-egress-[a-z0-9](?:[a-z0-9-]{0,39})$/.test(host);
  if (value !== value.trim() || url.protocol !== 'socks5:' || url.username || url.password ||
      !url.port || Number(url.port) < 1 || url.search || url.hash ||
      !['', '/'].includes(url.pathname) ||
      !(privateIPv4 || ownedEndpoint || host === 'localhost' || host === '[::1]')) throw invalid();
  return {server: `${url.protocol}//${url.host}`};
}
