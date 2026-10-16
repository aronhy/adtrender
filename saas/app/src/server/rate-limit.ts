import type { Prisma } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { DomainError } from '../team/access';
export async function consumeRateLimit(db:Prisma.TransactionClient,scope:string,principal:string,policy:{limit:number;windowMs:number},now=new Date()):Promise<void> {
  if (!principal || !Number.isSafeInteger(policy.limit) || policy.limit<1 || !Number.isSafeInteger(policy.windowMs) || policy.windowMs<1000) throw new DomainError(400,'INVALID_RATE_POLICY');
  const secret=process.env.RATE_LIMIT_HMAC_SECRET ?? process.env.JWT_SECRET ?? (process.env.NODE_ENV==='production' ? '' : 'local-development-only');
  if (!secret) throw new DomainError(503,'RATE_LIMIT_UNCONFIGURED');
  const principalHash=createHmac('sha256',secret).update(principal).digest('hex');
  const windowStart=new Date(Math.floor(now.getTime()/policy.windowMs)*policy.windowMs);
  const expiresAt=new Date(windowStart.getTime()+policy.windowMs);
  const id=createHmac('sha256',secret).update(`${scope}:${principalHash}:${windowStart.toISOString()}`).digest('hex');
  // Both the id and the scope/principal/window tuple are unique. Ignoring every
  // insertion conflict avoids concurrent first requests colliding on the other
  // unique index; the following atomic increment counts each request once.
  await db.$executeRaw`INSERT INTO "RateLimitBucket" ("id","scope","principalHash","windowStart","expiresAt","count","updatedAt") VALUES (${id},${scope},${principalHash},${windowStart},${expiresAt},0,${now}) ON CONFLICT DO NOTHING`;
  const bucket=await db.rateLimitBucket.update({where:{id},data:{count:{increment:1}}});
  if (bucket.count>policy.limit) throw new DomainError(429,'RATE_LIMITED','操作过于频繁，请稍后再试。');
}
