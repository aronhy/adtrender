import express, { type Request, type Response } from 'express';
import type { MiddlewareConfigFn } from 'wasp/server/middleware';
import { prisma } from 'wasp/server';
import { DomainError } from '../team/access';
import { consumeRateLimit } from '../server/rate-limit';
import { resolveClientIp } from '../server/client-ip';
import { activeGrowthToken, assertGrowthOrigin, clearGrowthCookie, consentInput, eventInput, growthCookie, readGrowthCookie } from './contract';
import { acceptConsent, recordPublicEvent, revokeConsent } from './service';

const failure = (res: Response, error: unknown) => res.status(error instanceof DomainError ? error.status : 503).json({ error: error instanceof DomainError ? error.code : 'GROWTH_UNAVAILABLE' });
export const growthMiddleware: MiddlewareConfigFn = config => {
  config.delete('express.json'); config.delete('express.urlencoded');
  config.set('growth.origin', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try { assertGrowthOrigin(req.headers); next(); } catch (error) { failure(res, error); }
  });
  const parse = express.json({ limit: '4kb', strict: true });
  config.set('growth.json', (req, res, next) => parse(req, res, error => {
    if (error) { res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: 'INVALID_GROWTH_REQUEST' }); return; }
    next();
  }));
  return config;
};
export async function growthConsent(req: Request, res: Response, _context: unknown) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    assertGrowthOrigin(req.headers);
    const parsed = consentInput.safeParse(req.body);
    if (!parsed.success) throw new DomainError(400, 'INVALID_GROWTH_REQUEST');
    const token = readGrowthCookie(req.headers.cookie);
    await consumeRateLimit(prisma, 'GROWTH_CONSENT', resolveClientIp(req), { limit: 60, windowMs: 60000 });
    if (parsed.data.choice === 'rejected') {
      await revokeConsent(prisma, token);
      // Retain the HttpOnly handle on failure so the browser can retry a real
      // server-side revocation. Its JS consent marker is already absent.
      res.setHeader('Set-Cookie', clearGrowthCookie());
      res.json({ consent: 'rejected', recording: false }); return;
    }
    const result = await acceptConsent(prisma, token, parsed.data.attribution);
    res.setHeader('Set-Cookie', growthCookie(result.token, (result.visit.expiresAt.valueOf() - Date.now()) / 1000));
    res.json({ consent: 'accepted', recording: true });
  } catch (error) { failure(res, error); }
}
export async function growthEvents(req: Request, res: Response, _context: unknown) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    assertGrowthOrigin(req.headers);
    const parsed = eventInput.safeParse(req.body);
    if (!parsed.success) throw new DomainError(400, 'INVALID_GROWTH_REQUEST');
    await consumeRateLimit(prisma, 'GROWTH_EVENT', resolveClientIp(req), { limit: 120, windowMs: 60000 });
    res.json(await recordPublicEvent(prisma, activeGrowthToken(req.headers.cookie), parsed.data));
  } catch (error) { failure(res, error); }
}
