import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { generateIdFromEntropySize, TimeSpan } from 'lucia';
import { validateJWT } from 'wasp/auth/jwt';
import { DomainError, lockAccountAdministration } from '../team/access';

type OAuthCodeClaims = { id: string; exp: number };
export type OAuthCodeVerifier = (code: string) => Promise<OAuthCodeClaims>;
const nativeVerifier: OAuthCodeVerifier = code => validateJWT<OAuthCodeClaims>(code);
const invalid = () => new DomainError(401, 'GOOGLE_SIGN_IN_FAILED', 'Google 登录失败，请重新登录。');

function canonicalCode(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  const parts = value.split('.');
  // Oslo verifies signatures with permissive base64 decoding. Equivalent
  // padded/nonzero-pad-bit spellings must not evade the durable code hash.
  return parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)
    && Buffer.from(part, 'base64url').toString('base64url') === part);
}

/** Replaces only Wasp's exchange endpoint. JWT verification and the existing
 * Auth/Session models remain native; never call global createSession while a
 * transaction owns Auth's row lock (its other connection would wait on us).
 * Injected verifiers are server-side test seams, never request input. */
export async function completeOAuthCode(
  db: PrismaClient,
  input: { code: unknown },
  verify: OAuthCodeVerifier = nativeVerifier,
): Promise<{ sessionId: string }> {
  try {
    if (!canonicalCode(input?.code)) throw invalid();
    const code = input.code;
    const claims = await verify(code);
    if (!claims || typeof claims.id !== 'string' || !claims.id || claims.id.length > 100
      || !Number.isSafeInteger(claims.exp)) throw invalid();
    const expiresAt = new Date(claims.exp * 1000);
    // Native Wasp OAuth codes expire after one minute; other purpose JWTs
    // (email/reset tokens) are not accepted as a substitute for this shape.
    if (expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + 60_000) throw invalid();
    const tokenHash = createHash('sha256').update(code).digest('hex');
    return await db.$transaction(async tx => {
      // Same order as account administration: global admission/disable fence,
      // then Auth row. A later disable deletes this transaction's new session.
      await lockAccountAdministration(tx);
      await tx.$queryRaw`SELECT id FROM "Auth" WHERE id=${claims.id} FOR UPDATE`;
      const auth = await tx.auth.findUnique({
        where: { id: claims.id },
        include: { user: true, identities: { where: { providerName: 'google' } } },
      });
      if (!auth?.user || auth.user.disabledAt || !auth.user.email || auth.identities.length !== 1) throw invalid();
      const admission: unknown = JSON.parse(auth.identities[0].providerData);
      if (!admission || typeof admission !== 'object' || Array.isArray(admission)
        || !('version' in admission) || admission.version !== 1
        || !('admitted' in admission) || admission.admitted !== true
        || !('verifiedEmail' in admission) || admission.verifiedEmail !== auth.user.email.toLowerCase()) throw invalid();
      // clock_timestamp, not transaction_timestamp: lock waiting must not let
      // an expired code pass using the transaction's stale start time.
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
      if (expiresAt <= clock.now || expiresAt.getTime() > clock.now.getTime() + 60_000) throw invalid();
      await tx.oAuthCodeUse.create({ data: {
        tokenHash, authId: auth.id, userId: auth.user.id, source: 'GOOGLE', expiresAt, consumedAt: clock.now,
      } });
      // Matches Wasp 0.25's Lucia 3.2.2 createSession: 25 bytes of entropy,
      // base32 ID, 30-day expiration. Use Lucia's generator, not a second
      // session/password format. Native Wasp session validation reads this row.
      const sessionId = generateIdFromEntropySize(25);
      await tx.session.create({ data: {
        id: sessionId, userId: auth.id,
        expiresAt: new Date(Date.now() + new TimeSpan(30, 'd').milliseconds()),
      } });
      return { sessionId };
    }, { maxWait: 10_000, timeout: 20_000 });
  } catch {
    // Do not echo codes, admission data, JWT errors or database details.
    throw invalid();
  }
}
