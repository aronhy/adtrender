type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = 'ad-research:selected-plan';
const validId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const defaultStorage = (): IntentStorage | undefined => { try { return window.sessionStorage; } catch { return undefined; } };

// Only a public plan ID crosses login; the server still checks the selected
// organization, ownership and current plan availability before any purchase.
export function rememberPricingIntent(planId: string, storage = defaultStorage(), now = Date.now()) {
  if (!validId(planId)) return;
  try { storage?.setItem(key, JSON.stringify({ planId, createdAt: now })); } catch { /* Login remains available without browser storage. */ }
}
export function clearPricingIntent(storage = defaultStorage()) {
  try { storage?.removeItem(key); } catch { /* Optional navigation preference. */ }
}
export function continuePricingAfterSetup(commandType: string, workspaceId: string | null | undefined, planId: string | null): string | null {
  if (!['CREATE_ORGANIZATION', 'CREATE_WORKSPACE'].includes(commandType) || !validId(workspaceId) || !validId(planId)) return null;
  return `/app/settings?workspace=${encodeURIComponent(workspaceId)}&plan=${encodeURIComponent(planId)}#billing`;
}
export function consumePricingIntent(storage = defaultStorage(), now = Date.now()): string {
  try {
    const raw = storage?.getItem(key); clearPricingIntent(storage);
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== 'object' || !('planId' in value) || !validId(value.planId)
      || !('createdAt' in value) || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)
      || now < value.createdAt || now - value.createdAt >= 30 * 60000) return '/app';
    return `/app/settings?plan=${encodeURIComponent(value.planId)}#billing`;
  } catch { return '/app'; }
}
