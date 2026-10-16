import { describe, expect, it } from 'vitest';
import { validateRuntimeConfig, redact } from './config';

describe('startup configuration', () => {
  const production={NODE_ENV:'production',DATABASE_URL:'postgresql://localhost/test',WASP_WEB_CLIENT_URL:'https://research.example.test',WASP_SERVER_URL:'https://api.example.test',JWT_SECRET:'x'.repeat(32),SMTP_HOST:'smtp.example.test',SMTP_USERNAME:'fixture',SMTP_PASSWORD:'fixture',EMAIL_FROM:'mail@research.example.test',S3_BUCKET:'fixture',S3_REGION:'us-east-1',AWS_ACCESS_KEY_ID:'fixture',AWS_SECRET_ACCESS_KEY:'fixture',OUTBOX_ENCRYPTION_KEY:'a'.repeat(64)};
  it('refuses production without mandatory infrastructure and secure origins', () => {
    expect(() => validateRuntimeConfig({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL/);
    expect(() => validateRuntimeConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://localhost/db', WASP_WEB_CLIENT_URL: 'http://example.com' })).toThrow();
  });
  it('accepts local development without activating paid providers', () => {
    const config = validateRuntimeConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgresql://localhost/test' });
    expect(config.registrationMode).toBe('invite');
    expect(config.billingEnabled).toBe(false);
    expect(config.publicPricingEnabled).toBe(false);
    expect(config.trialConfig).toEqual({days:14,workspaces:1,members:3,savedAds:100,analyses:20});
  });
  it('validates an optional separate admin origin and requires its signing secret', () => {
    const base = { NODE_ENV: 'development', DATABASE_URL: 'postgresql://localhost/test', WASP_WEB_CLIENT_URL: 'http://127.0.0.1:3100' };
    expect(() => validateRuntimeConfig({ ...base, ADMIN_WEB_CLIENT_URL: 'http://127.0.0.1:3102' })).toThrow('ADMIN_GOOGLE_TARGET_REQUIRES_JWT_SECRET');
    expect(() => validateRuntimeConfig({ ...base, ADMIN_WEB_CLIENT_URL: 'https://admin.example.test/path', JWT_SECRET: 'x'.repeat(32) })).toThrow('INVALID_ADMIN_WEB_CLIENT_URL');
    expect(() => validateRuntimeConfig({ ...base, ADMIN_WEB_CLIENT_URL: 'http://127.0.0.1:3102', JWT_SECRET: 'x'.repeat(32) })).not.toThrow();
    expect(() => validateRuntimeConfig({ ...base, ADMIN_WEB_CLIENT_URL: base.WASP_WEB_CLIENT_URL, JWT_SECRET: 'x'.repeat(32) })).toThrow('INVALID_ADMIN_WEB_CLIENT_URL');
  });
  it('refuses production startup until all trial terms are explicit and valid',()=>{
    expect(()=>validateRuntimeConfig(production)).toThrow('TRIAL_NOT_CONFIGURED');
    const configured={...production,TRIAL_DAYS:'7',TRIAL_WORKSPACES:'1',TRIAL_MEMBERS:'2',TRIAL_SAVED_ADS:'10',TRIAL_ANALYSES:'3'};
    expect(validateRuntimeConfig(configured).trialConfig).toEqual({days:7,workspaces:1,members:2,savedAds:10,analyses:3});
    expect(()=>validateRuntimeConfig({...configured,TRIAL_MEMBERS:'2.5'})).toThrow('INVALID_TRIAL_CONFIG');
    expect(()=>validateRuntimeConfig({...configured,TRIAL_DAYS:undefined})).toThrow('TRIAL_NOT_CONFIGURED');
  });
  it('rejects live Stripe keys unless live charging is explicitly enabled', () => {
    expect(() => validateRuntimeConfig({ DATABASE_URL: 'postgresql://localhost/test', STRIPE_SECRET_KEY: 'sk_live_test' })).toThrow(/LIVE_BILLING_ENABLED/);
  });
  it('does not activate public prices from a test key or an incomplete explicit launch configuration',()=>{
    const live={DATABASE_URL:'postgresql://localhost/test',PUBLIC_PRICING_ENABLED:'true',BILLING_ENABLED:'true',LIVE_BILLING_ENABLED:'true',STRIPE_SECRET_KEY:'sk_live_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',STRIPE_REFUND_POLICY:'RETAIN_PAID_PERIOD'};
    expect(validateRuntimeConfig(live).publicPricingEnabled).toBe(true);
    for(const invalid of [{PUBLIC_PRICING_ENABLED:'yes'},{BILLING_ENABLED:'false'},{STRIPE_SECRET_KEY:'sk_test_fixture'},{STRIPE_REFUND_POLICY:''}])expect(()=>validateRuntimeConfig({...live,...invalid})).toThrow();
  });
  it('redacts credentials and sensitive URLs recursively', () => {
    expect(redact({ token: 'secret', url: 'https://example.org/reset?token=secret', nested: { password: 'secret', status: 'ok' } })).toEqual({ token: '[REDACTED]', url: 'https://example.org/reset?[REDACTED]', nested: { password: '[REDACTED]', status: 'ok' } });
  });
});
