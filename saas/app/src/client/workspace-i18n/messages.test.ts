import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { locales } from '../landing/messages';
import { commonMessages } from './common';
import { workspaceMessages } from './workspace';
import { adsMessages } from './ads';
import { adDetailMessages } from './ad-detail';
import { researchMessages } from './research';
import { settingsMessages } from './settings';
import { commandNoticeKey, translate, workspaceCatalog, workspaceErrorKey, workspaceLanguageSearch, workspaceLink, workspaceStatusKey } from './messages';
import { WorkspaceLocaleProvider, useWorkspaceLocale } from './locale';

function serverLocale(query = '') {
  let context: ReturnType<typeof useWorkspaceLocale> | undefined;
  function Probe() { context = useWorkspaceLocale(); return null; }
  renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [`/app${query}`] }, createElement(WorkspaceLocaleProvider, null, createElement(Probe))));
  if (!context) throw new Error('Locale probe was not rendered');
  return context;
}
const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort();

describe('workspace message catalog', () => {
  it('has no overlapping page keys and supplies four complete translations with the same placeholders', () => {
    const keys = [commonMessages, workspaceMessages, adsMessages, adDetailMessages, researchMessages, settingsMessages].flatMap(catalog => Object.keys(catalog));
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(workspaceCatalog).sort()).toEqual(keys.sort());
    for (const [key, messages] of Object.entries(workspaceCatalog)) {
      expect(Object.keys(messages).sort(), key).toEqual([...locales].sort());
      for (const locale of locales) {
        expect(messages[locale].trim().length, `${key}:${locale}`).toBeGreaterThan(0);
        expect(placeholders(messages[locale]), `${key}:${locale}`).toEqual(placeholders(messages.en));
      }
      expect(messages.en, key).not.toMatch(/[\u3400-\u9fff]/);
      expect(messages.es, key).not.toMatch(/[\u3400-\u9fff]/);
    }
  });
  it('provides every literal translation used by the shared shell and overview', () => {
    for (const filename of ['../App.tsx', '../WorkspacePages.tsx', '../AdsPages.tsx', '../AdHistoryPanel.tsx']) {
      const source = readFileSync(new URL(filename, import.meta.url), 'utf8');
      for (const match of source.matchAll(/\bt\(\s*['"]([\w.-]+)['"]/g)) expect(Object.hasOwn(workspaceCatalog, match[1]), `${filename}: ${match[1]}`).toBe(true);
    }
  });
  it('inserts literal backend values without translating them or interpreting replacement syntax', () => {
    expect(translate('en', 'settings.team.memberCount', { count: 0 })).toBe('Members: 0');
    const value = '原始品牌 $& {date} <script>';
    expect(translate('es', 'settings.feedback.requestId', { id: value })).toBe(`ID: ${value}`);
    expect(translate('en', 'settings.feedback.requestId')).toBe('ID: {id}');
  });
});

describe('workspace navigation language', () => {
  it('retains workspace, organization, plan, extra parameters and anchors while replacing language', () => {
    const result = workspaceLink('/app/settings?workspace=space%2Fone&organization=org-2&plan=annual&lang=en&filter=active#billing', 'es');
    const url = new URL(result, 'https://workspace.example');
    expect(url.pathname).toBe('/app/settings');
    expect(Object.fromEntries(url.searchParams)).toEqual({ workspace: 'space/one', organization: 'org-2', plan: 'annual', lang: 'es', filter: 'active' });
    expect(url.hash).toBe('#billing');
    expect(url.searchParams.getAll('lang')).toEqual(['es']);
    expect(workspaceLink('/app', 'zh-TW')).toBe('/app?lang=zh-TW');
  });
  it('leaves external checkout and receipt links unchanged', () => {
    for (const url of ['https://checkout.example/session?plan=annual&signature=synthetic#payment', '//receipts.example/receipt?token=synthetic']) expect(workspaceLink(url, 'es')).toBe(url);
  });
  it('removes all invite, auth token and OAuth error values without losing view scope', () => {
    const query = '?workspace=space-a&organization=org-a&plan=annual&invite=first&token=first&lang=en&oauth_error=expired&invite=second&token=second';
    const updated = workspaceLanguageSearch(query, 'zh-TW');
    expect(Object.fromEntries(updated)).toEqual({ workspace: 'space-a', organization: 'org-a', plan: 'annual', lang: 'zh-TW' });
    for (const key of ['invite', 'token', 'oauth_error']) expect(updated.has(key)).toBe(false);
    expect(Object.fromEntries(workspaceLanguageSearch(updated.toString(), 'es'))).toEqual({ workspace: 'space-a', organization: 'org-a', plan: 'annual', lang: 'es' });
  });
});

describe('workspace safe error and status messages', () => {
  it('classifies rate limiting as retry feedback rather than exhausted plan quota', () => {
    for (const reason of [new Error('RATE_LIMITED'), 'RATE_LIMIT', new Error('Request failed: 429 RATE_LIMITED')]) expect(workspaceErrorKey(reason)).toBe('error.rate');
    expect(workspaceErrorKey(new Error('QUOTA_EXCEEDED'))).toBe('error.quota');
    expect(workspaceErrorKey(new Error('ANALYSIS_ATTEMPT_LIMIT'))).toBe('error.attempts');
  });
  it('maps supported errors and never displays raw provider diagnostics', () => {
    const examples = [['SOURCE_CAPABILITY_UNVERIFIED', 'error.source'], ['WORKSPACE_ROLE_INHERITED', 'error.inherited'], ['ANALYSIS_RETRY_KEY_USED', 'error.analysisChanged'], ['WORKSPACE_FORBIDDEN', 'error.permission'], ['SERVICE_NOT_CONFIGURED', 'error.unavailable'], ['TOKEN_EXPIRED', 'error.expired'], ['LAST_OWNER', 'error.owner'], ['INVALID_EMAIL', 'error.invalid']];
    for (const [code, key] of examples) expect(workspaceErrorKey(new Error(code))).toBe(key);
    const diagnostic = 'Provider detail: token=synthetic-secret password=synthetic-password';
    for (const reason of [new Error(diagnostic), diagnostic, { message: diagnostic, status: 500 }, null]) {
      expect(workspaceErrorKey(reason)).toBe('error.generic');
      for (const locale of locales) {
        const message = translate(locale, workspaceErrorKey(reason));
        expect(message).toBe(workspaceCatalog['error.generic'][locale]);
        expect(message).not.toMatch(/synthetic-secret|synthetic-password/);
      }
    }
  });
  it('separates source reports from subscription status and handles unknown statuses safely', () => {
    expect(workspaceStatusKey('active')).toBe('status.sourceActive');
    expect(workspaceStatusKey('ACTIVE')).toBe('status.active');
    expect(workspaceStatusKey('unknown')).toBe('status.sourceUnknown');
    for (const value of [null, undefined, 'UNRECOGNIZED_PROVIDER_STATUS']) expect(workspaceStatusKey(value)).toBe('status.unknown');
    for (const code of ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER', 'UNPAID', 'INCOMPLETE_EXPIRED', 'RESOLVED']) expect(Object.hasOwn(workspaceCatalog, workspaceStatusKey(code))).toBe(true);
    expect(commandNoticeKey('ANALYZE_AD')).toBe('notice.analysis');
    expect(commandNoticeKey('ARCHIVE_WORKSPACE')).toBe('notice.archived');
    expect(commandNoticeKey('UNKNOWN_ACTION')).toBe('common.updated');
  });
});

describe('workspace SSR and locale formatting', () => {
  it('renders without browser globals and selects supported query languages', () => {
    expect(serverLocale().locale).toBe('zh-CN');
    expect(serverLocale('?lang=unsupported').locale).toBe('zh-CN');
    for (const locale of locales) {
      const context = serverLocale(`?lang=${locale}`);
      expect(context.locale).toBe(locale);
      expect(context.t('nav.overview')).toBe(workspaceCatalog['nav.overview'][locale]);
      expect(context.href('/app/settings?workspace=a&plan=annual#billing')).toBe(`/app/settings?workspace=a&plan=annual&lang=${locale}#billing`);
    }
  });
  it('formats minor-unit amounts with each currency precision and locale', () => {
    for (const locale of locales) {
      const context = serverLocale(`?lang=${locale}`);
      for (const [amount, currency, major] of [[123456, 'USD', 1234.56], [123456, 'JPY', 123456], [123456, 'KWD', 123.456], [0, 'EUR', 0]] as const) expect(context.money(amount, currency)).toBe(new Intl.NumberFormat(locale, { style: 'currency', currency }).format(major));
      expect(context.money(null, 'USD')).toBe(context.t('common.noPrice'));
      expect(context.money(100, null)).toBe(context.t('common.noPrice'));
      expect(context.money(100, 'INVALID')).toBe(context.t('common.unknownPrice'));
    }
  });
  it('formats dates in the active locale and translates missing or invalid values', () => {
    const value = new Date('2026-10-07T08:30:00.000Z');
    for (const locale of locales) {
      const context = serverLocale(`?lang=${locale}`);
      expect(context.date(value)).toBe(new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(value));
      expect(context.date(value.toISOString(), true)).toBe(new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(value));
      expect(context.date(null)).toBe(context.t('common.noDate'));
      expect(context.date('not-a-date')).toBe(context.t('common.unknownDate'));
      expect(context.status('OWNER')).toBe(workspaceCatalog['status.owner'][locale]);
      expect(context.error(new Error('INVALID_EMAIL'))).toBe(workspaceCatalog['error.invalid'][locale]);
    }
  });
});
