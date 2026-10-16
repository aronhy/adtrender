import cors from 'cors';

type Environment = Record<string, string | undefined>;

/** A destination is an origin, never a request-supplied redirect URL. */
export function adminWebOrigin(env: Environment = process.env): string | null {
  const value = env.ADMIN_WEB_CLIENT_URL?.trim();
  if (!value) return null;
  try {
    if (!/^https?:\/\/[^/?#\\]+\/?$/i.test(value)) throw new Error();
    const url = new URL(value);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error();
    const customer = new URL(env.WASP_WEB_CLIENT_URL?.trim() || 'http://localhost:3000').origin;
    if (url.origin === customer) throw new Error();
    return url.origin;
  } catch {
    // Configuration failures must never echo a potentially credential-bearing URL.
    throw new Error('INVALID_ADMIN_WEB_CLIENT_URL');
  }
}

export function clientCorsOrigins(env: Environment = process.env): string[] {
  const customer = new URL(env.WASP_WEB_CLIENT_URL?.trim() || 'http://localhost:3000').origin;
  const admin = adminWebOrigin(env);
  return admin ? [customer, admin] : [customer];
}

export function clientCorsMiddleware(env: Environment = process.env) {
  return cors({ origin: clientCorsOrigins(env) });
}
