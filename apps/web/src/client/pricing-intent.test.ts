import { describe, expect, it } from 'vitest';
import { clearPricingIntent, consumePricingIntent, continuePricingAfterSetup, rememberPricingIntent } from './pricing-intent';

const planId = '830c7d10-afda-4bdb-87b6-66d97308b947';
const now = 1791150000000;
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, values };
}
describe('public plan selection through authentication', () => {
  it('retains only the plan choice and consumes it once into a fixed internal billing route', () => {
    const store = storage(); rememberPricingIntent(planId, store, now);
    expect(consumePricingIntent(store, now + 60000)).toBe(`/app/settings?plan=${planId}#billing`);
    expect(consumePricingIntent(store, now + 60000)).toBe('/app');
    expect(store.values.size).toBe(0);
  });
  it('expires old choices and rejects clock rollback', () => {
    const store = storage(); rememberPricingIntent(planId, store, now);
    expect(consumePricingIntent(store, now + 3600000)).toBe('/app');
    rememberPricingIntent(planId, store, now);
    expect(consumePricingIntent(store, now - 1)).toBe('/app');
  });
  it.each(['https://external.test/pay', '//external.test', 'javascript:alert(1)', '../admin', ''])('cannot store a redirect target: %s', value => {
    const store = storage(); rememberPricingIntent(value, store, now);
    expect(consumePricingIntent(store, now)).toBe('/app');
  });
  it('rejects malformed storage and does not interrupt login when storage is unavailable', () => {
    const store = storage(); rememberPricingIntent(planId, store, now);
    for (const key of store.values.keys()) store.values.set(key, '{broken');
    expect(consumePricingIntent(store, now)).toBe('/app');
    const denied = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); }, removeItem() { throw Error('denied'); } };
    expect(() => rememberPricingIntent(planId, denied, now)).not.toThrow();
    expect(consumePricingIntent(denied, now)).toBe('/app');
  });
  it('clears the remembered choice once the settings page is reached', () => {
    const store = storage(); rememberPricingIntent(planId, store, now); clearPricingIntent(store);
    expect(consumePricingIntent(store, now)).toBe('/app');
  });
  it('keeps the selected plan after first login and organization/workspace setup', () => {
    const store = storage(); rememberPricingIntent(planId, store, now);
    const loginDestination = new URL(consumePricingIntent(store, now), 'https://app.example.test');
    clearPricingIntent(store);
    const workspaceId = '6da6c116-1889-4787-960a-3f0b8567987d';
    for (const commandType of ['CREATE_ORGANIZATION', 'CREATE_WORKSPACE']) {
      expect(continuePricingAfterSetup(commandType, workspaceId, loginDestination.searchParams.get('plan')))
        .toBe(`/app/settings?workspace=${workspaceId}&plan=${planId}#billing`);
    }
    expect(continuePricingAfterSetup('ARCHIVE_WORKSPACE', null, planId)).toBeNull();
    expect(continuePricingAfterSetup('CREATE_ORGANIZATION', workspaceId, '//external.test')).toBeNull();
    expect(continuePricingAfterSetup('CREATE_ORGANIZATION', workspaceId, null)).toBeNull();
  });
});
