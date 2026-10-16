import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';
import { activeGrowthToken, GROWTH_ORIGIN } from './contract';

// Only server-observed cookies enter this context. No request body user IDs or
// client-provided conversion names can reach the business conversion recorder.
export const growthContext = new AsyncLocalStorage<{ token?: string }>();
export const currentGrowthToken = () => growthContext.getStore()?.token;
export const growthContextMiddleware: RequestHandler = (req, _res, next) => {
  // OAuth's top-level GET callback carries SameSite=Lax cookies. Mutating
  // browser requests additionally need our exact origin, never an ambient
  // cookie attached to a cross-site form submission.
  const allowed = ['GET', 'HEAD'].includes(req.method) || req.headers.origin === GROWTH_ORIGIN;
  growthContext.run({ token: allowed ? activeGrowthToken(req.headers.cookie) : undefined }, next);
};
