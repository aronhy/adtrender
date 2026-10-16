import type { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { createStripeBilling, type StripeBillingConfig } from './stripe';

const secret = 'whsec_local_test_fixture';
const sdk = new Stripe('sk_test_local_fixture', { maxNetworkRetries: 0 });
const config: StripeBillingConfig = { publicAppUrl: 'https://app.example.test', webhookSecret: secret, mode: 'test', refundPolicy: 'REVOKE_FULL_CURRENT_PERIOD' };
describe('Stripe signature and deployment boundary', () => {
  it('rejects forged and body-altered signatures before database access', async () => {
    const billing = createStripeBilling({} as PrismaClient, sdk, config);
    const body = JSON.stringify({ id: 'evt_fixture', type: 'product.created', created: Math.floor(Date.now() / 1000), livemode: false, data: { object: { id: 'prod_fixture' } } });
    const signature = sdk.webhooks.generateTestHeaderString({ payload: body, secret });
    await expect(billing.handleWebhook(Buffer.from(`${body} `), signature)).rejects.toMatchObject({ status: 400, code: 'INVALID_WEBHOOK_SIGNATURE' });
    await expect(billing.handleWebhook(Buffer.from(body), 't=1,v1=bad')).rejects.toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' });
  });
  it('accepts an authentic unrelated event as ignored without a database query', async () => {
    const body = JSON.stringify({ id: 'evt_unrelated', type: 'product.created', created: Math.floor(Date.now() / 1000), livemode: false, data: { object: { id: 'prod_fixture' } } });
    const signature = sdk.webhooks.generateTestHeaderString({ payload: body, secret });
    await expect(createStripeBilling({} as PrismaClient, sdk, config).handleWebhook(Buffer.from(body), signature)).resolves.toMatchObject({ ignored: true });
  });
  it('rejects live activation without an explicit gate and rejects arbitrary return URL origins', () => {
    expect(() => createStripeBilling({} as PrismaClient, sdk, { ...config, mode: 'live' })).toThrowError('LIVE_PAYMENTS_DISABLED');
    expect(() => createStripeBilling({} as PrismaClient, sdk, { ...config, publicAppUrl: 'javascript:alert(1)' })).toThrowError('INVALID_PUBLIC_URL');
    expect(() => createStripeBilling({} as PrismaClient, sdk, { ...config, publicAppUrl: 'https://user:password@app.example.test' })).toThrowError('INVALID_PUBLIC_URL');
  });
  it('rejects live events on a test billing installation', async () => {
    const body = JSON.stringify({ id: 'evt_live', type: 'product.created', created: Math.floor(Date.now() / 1000), livemode: true, data: { object: { id: 'prod_fixture' } } });
    const signature = sdk.webhooks.generateTestHeaderString({ payload: body, secret });
    await expect(createStripeBilling({} as PrismaClient, sdk, config).handleWebhook(Buffer.from(body), signature)).rejects.toMatchObject({ code: 'STRIPE_MODE_MISMATCH' });
  });
});
