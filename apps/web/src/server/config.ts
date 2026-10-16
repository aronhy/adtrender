import {trialConfigFromEnvironment} from '../billing/trial-config';
import { validateGoogleAuthConfig } from '../auth/google';
import { publicPricingEnabled } from './public-pricing';
import { adminWebOrigin } from './admin-web';

export function validateRuntimeConfig(env: Record<string, string | undefined>) {
  validateGoogleAuthConfig(env);
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing configuration: ${key}`);
    return value;
  };
  const databaseUrl = required('DATABASE_URL');
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error('DATABASE_URL must be PostgreSQL');
  if (adminWebOrigin(env) && (env.JWT_SECRET?.trim().length ?? 0) < 32) throw new Error('ADMIN_GOOGLE_TARGET_REQUIRES_JWT_SECRET');
  const registrationMode = env.REGISTRATION_MODE ?? 'invite';
  if (!['invite', 'public'].includes(registrationMode)) throw new Error('Invalid REGISTRATION_MODE');
  const billingEnabled = env.BILLING_ENABLED === 'true';
  if (env.STRIPE_SECRET_KEY?.startsWith('sk_live_') && env.LIVE_BILLING_ENABLED !== 'true') {
    throw new Error('LIVE_BILLING_ENABLED must explicitly enable live payments');
  }
  if (billingEnabled) {
    required('STRIPE_SECRET_KEY');
    required('STRIPE_WEBHOOK_SECRET');
  }
  if (env.NODE_ENV === 'production') {
    for (const key of ['WASP_WEB_CLIENT_URL', 'WASP_SERVER_URL']) {
      const url = new URL(required(key));
      if (url.protocol !== 'https:') throw new Error(`${key} must use HTTPS`);
    }
    for (const key of ['JWT_SECRET', 'SMTP_HOST', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'EMAIL_FROM', 'S3_BUCKET', 'S3_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'OUTBOX_ENCRYPTION_KEY']) required(key);
    if (required('JWT_SECRET').length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
    if (!/^[a-f0-9]{64}$/i.test(required('OUTBOX_ENCRYPTION_KEY'))) throw new Error('OUTBOX_ENCRYPTION_KEY must be 32 bytes encoded as hex');
    if (env.EMAIL_FROM?.endsWith('@example.com')) throw new Error('Configure verified EMAIL_FROM');
  }
  const trialConfig=trialConfigFromEnvironment(env);
  return { databaseUrl, registrationMode: registrationMode as 'invite' | 'public', billingEnabled,trialConfig,publicPricingEnabled:publicPricingEnabled(env) };
}

/** Only structured metadata is logged. Free-form errors from providers are excluded. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, /token|password|secret|authorization|cookie|payload|body|email|api.?key/i.test(key) ? '[REDACTED]' : redact(child)]),
  );
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) {
      const url = new URL(value); url.username = ''; url.password = ''; url.hash = '';
      return `${url.origin}${url.pathname}${url.search ? '?[REDACTED]' : ''}`;
    }
    return value.replace(/\b(sk|rk)_(live|test)_[\w]+\b/g, '[REDACTED]');
  }
  return value;
}
