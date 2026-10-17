import { uiMessages } from './ui';
import { commonMessages } from './common';
import { workspaceMessages } from './workspace';
import { adsMessages } from './ads';
import { adDetailMessages } from './ad-detail';
import { researchMessages } from './research';
import { settingsMessages } from './settings';
import type { Locale } from '../landing/messages';

export const workspaceCatalog: Record<string, Record<Locale, string>> = { ...uiMessages, ...commonMessages, ...workspaceMessages, ...adsMessages, ...adDetailMessages, ...researchMessages, ...settingsMessages };
export type MessageValues = Record<string, string | number>;
export function translate(locale: Locale, key: string, values: MessageValues = {}) {
  return (workspaceCatalog[key]?.[locale] ?? key).replace(/\{(\w+)\}/g, (placeholder, name: string) => String(values[name] ?? placeholder));
}
export function workspaceLink(path: string, locale: Locale) {
  const url = new URL(path, 'https://workspace.invalid');
  if (url.origin !== 'https://workspace.invalid') return path;
  url.searchParams.set('lang', locale);
  return url.pathname + url.search + url.hash;
}
export function workspaceLanguageSearch(search: string, locale: Locale) {
  const params = new URLSearchParams(search);
  for (const key of ['invite', 'token', 'oauth_error']) params.delete(key);
  params.set('lang', locale);
  return params;
}
export function workspaceErrorKey(reason: unknown) {
  const raw = reason instanceof Error ? reason.message : String(reason ?? '');
  if (/HISTORY_CHANGED_RELOAD/.test(raw)) return 'ads.history.changedReload';
  if (/SOURCE_CAPABILITY_UNVERIFIED/.test(raw)) return 'error.source';
  if (/WORKSPACE_ROLE_INHERITED/.test(raw)) return 'error.inherited';
  if (/ANALYSIS_ATTEMPT_LIMIT/.test(raw)) return 'error.attempts';
  if (/ANALYSIS_NOT_RETRYABLE|ANALYSIS_RETRY_KEY_USED/.test(raw)) return 'error.analysisChanged';
  if (/FORBIDDEN|AUTH_REQUIRED|ACCOUNT_DISABLED|403/.test(raw)) return 'error.permission';
  if (/RATE|429/.test(raw)) return 'error.rate';
  if (/QUOTA|LIMIT|ENTITLEMENT/.test(raw)) return 'error.quota';
  if (/NOT_CONFIGURED|DISABLED|UNAVAILABLE|NOT_ENABLED/.test(raw)) return 'error.unavailable';
  if (/EXPIRED/.test(raw)) return 'error.expired';
  if (/OWNER|LAST_OWNER/.test(raw)) return 'error.owner';
  if (/INVALID|VALIDATION|400/.test(raw)) return 'error.invalid';
  return 'error.generic';
}
const statusKeys: Record<string, string> = {
  ACTIVE: 'active', TRIALING: 'trial', active: 'sourceActive', inactive: 'sourceInactive', INACTIVE: 'inactive', UNKNOWN: 'unknown', unknown: 'sourceUnknown', READY: 'ready', CACHED: 'ready', PENDING: 'pending', QUEUED: 'queued', RUNNING: 'running', SUCCEEDED: 'done', COMPLETED: 'done', PARTIAL: 'partial', FAILED: 'failed', CANCELED: 'canceled', PAUSED: 'paused', HEALTHY: 'healthy', DEGRADED: 'delayed', DELAYED: 'delayed', UNCONFIGURED: 'unconfigured', PAST_DUE: 'pastDue', CANCELED_AT_PERIOD_END: 'ending', UNAVAILABLE: 'unavailable', DISABLED: 'inactive', NONE: 'none', OWNER: 'owner', ADMIN: 'admin', EDITOR: 'editor', VIEWER: 'viewer', MEMBER: 'member', REFUNDED: 'refunded', UNPAID: 'unpaid', INCOMPLETE: 'incomplete', INCOMPLETE_EXPIRED: 'paymentExpired', OPEN: 'open', RESOLVED: 'resolved', INVITED: 'invited', EXPIRED: 'expired',
};
export function workspaceStatusKey(value?: string | null) { return `status.${statusKeys[value ?? 'UNKNOWN'] ?? 'unknown'}`; }
const noticeKeys: Record<string, string> = {
  CREATE_ORGANIZATION: 'organization', CREATE_WORKSPACE: 'workspace', ARCHIVE_WORKSPACE: 'archived', REMOVE_WORKSPACE_MEMBER: 'removedAccess', ANALYZE_AD: 'analysis', RETRY_ANALYSIS: 'analysis', CANCEL_ANALYSIS: 'analysisCanceled', INVITE_MEMBER: 'invitation', ACCEPT_INVITATION: 'accepted', CANCEL_SUBSCRIPTION: 'cancelSubscription', CHANGE_PLAN: 'changePlan',
};
export function commandNoticeKey(type: string) { return noticeKeys[type] ? `notice.${noticeKeys[type]}` : 'common.updated'; }
