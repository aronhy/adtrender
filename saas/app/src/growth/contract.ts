import { z } from 'zod';
import { DomainError } from '../team/access';
import { isIP } from 'node:net';

export const GROWTH_ORIGIN = 'https://adtrender.com';
export const GROWTH_COOKIE = '__Host-adtrender-growth';
export const GROWTH_LIFETIME_MS = 30 * 86400_000;
export const GROWTH_CONSENT_VERSION = 'website-analytics.v2';
const publicPath = z.enum(['/', '/pricing', '/help', '/terms', '/privacy']);
const label = z.string().regex(/^[a-z][a-z\d._-]{0,79}$/i).refine(value => !/[a-f\d]{24,}/i.test(value));
const referrer = z.string().max(253).refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password && !isIP(url.hostname.replace(/^\[|\]$/g, '')) && url.hostname.includes('.'); } catch { return false; }
});
export const attributionInput = z.object({ landingPath: publicPath, source: label.optional(), medium: label.optional(), campaign: label.optional(), content: label.optional(), referrerOrigin: referrer.optional() }).strict();
export type AttributionInput = z.infer<typeof attributionInput>;
const googleDomains = new Set(['google.com', 'google.co.uk', 'google.com.hk', 'google.com.tw', 'google.com.au', 'google.co.jp', 'google.de', 'google.fr', 'google.es', 'google.it', 'google.ca', 'google.com.br', 'google.co.in', 'google.co.kr']);
export function normalizeAttribution(input: AttributionInput) {
  const data = attributionInput.parse(input);
  if (data.source || data.medium) return { ...data, source: data.source ?? 'unknown', medium: data.medium ?? 'unknown' };
  const hostname = data.referrerOrigin ? new URL(data.referrerOrigin).hostname.replace(/^www\./, '') : '';
  if (!hostname || hostname === 'adtrender.com' || hostname.endsWith('.adtrender.com')) return { ...data, source: 'direct', medium: 'none' };
  if (googleDomains.has(hostname)) return { ...data, source: 'google', medium: 'organic' };
  if (hostname === 'bing.com' || hostname === 'cn.bing.com') return { ...data, source: 'bing', medium: 'organic' };
  return { ...data, source: hostname, medium: 'referral' };
}
export const consentInput = z.discriminatedUnion('choice', [
  z.object({ choice: z.literal('accepted'), attribution: attributionInput.optional() }).strict(),
  z.object({ choice: z.literal('rejected') }).strict(),
]);
export const eventInput = z.discriminatedUnion('name', [
  z.object({ name: z.literal('PAGE_VIEW'), pathname: publicPath, requestNonce: z.uuid() }).strict(),
  z.object({ name: z.literal('CTA_CLICK'), pathname: publicPath, target: z.enum(['signup', 'login', 'pricing']), requestNonce: z.uuid() }).strict(),
]);
export type PublicEventInput = z.infer<typeof eventInput>;
export function assertGrowthOrigin(headers: { origin?: string|string[]; 'sec-fetch-site'?: string|string[] }) {
  if (headers.origin !== GROWTH_ORIGIN || (headers['sec-fetch-site'] !== undefined && headers['sec-fetch-site'] !== 'same-origin')) throw new DomainError(403, 'GROWTH_ORIGIN_DENIED');
}
function cookieValue(header: string | undefined, name: string): string | undefined {
  const values = (header ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  return values.length === 1 ? values[0].slice(name.length + 1) : undefined;
}
export function readGrowthCookie(header?: string): string | undefined {
  const value = cookieValue(header, GROWTH_COOKIE); return value && /^[\w-]{43}$/.test(value) ? value : undefined;
}
export function activeGrowthToken(header?: string): string | undefined {
  return cookieValue(header, 'adtrender_analytics_consent') === 'v2.accepted' ? readGrowthCookie(header) : undefined;
}
export const growthCookie = (token: string, maxAge = GROWTH_LIFETIME_MS / 1000) => `${GROWTH_COOKIE}=${token}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
export const clearGrowthCookie = () => growthCookie('', 0);
export const growthEnabled = () => process.env.GROWTH_ATTRIBUTION_ENABLED === 'true';
