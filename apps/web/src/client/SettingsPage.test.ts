import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppCommand, AppState } from './types';
import { settingsMessages } from './workspace-i18n/settings';
import { WorkspaceLocaleProvider } from './workspace-i18n/locale';

type FormProps = { children: ReactNode; label: string; disabled?: boolean; build: (data: FormData) => AppCommand };
type ButtonProps = { children: ReactNode; command: AppCommand; disabled?: boolean; confirmText?: string };
const fixture = vi.hoisted(() => ({ state: null as AppState | null, forms: [] as FormProps[], buttons: [] as ButtonProps[] }));
vi.mock('./App', () => ({
  useApp: () => ({ state: fixture.state, refresh: vi.fn() }),
  canManage: (state: AppState) => ['OWNER', 'ADMIN'].includes(state.role),
  formText: (data: FormData, key: string) => String(data.get(key) ?? '').trim(),
  Field: ({ label, children }: { label: string; children: ReactNode }) => createElement('label', null, label, children),
  PageHeader: ({ title }: { title: string }) => createElement('h1', null, title),
  Status: ({ value }: { value?: string }) => createElement('span', null, value),
  SourceLink: ({ children }: { children: ReactNode }) => createElement('span', null, children),
  CommandForm: (props: FormProps) => {
    fixture.forms.push(props);
    return createElement('form', { 'data-label': props.label }, createElement('fieldset', { disabled: props.disabled }, props.children));
  },
  CommandButton: (props: ButtonProps) => {
    fixture.buttons.push(props);
    return createElement('button', { disabled: props.disabled, 'data-command': props.command.type }, props.children);
  },
}));
vi.mock('./WorkspacePages', () => ({ BillingSummary: () => null, WorkspaceSetup: () => null, InvitationForm: () => null }));
import { SettingsPage } from './SettingsPage';

function state(role: 'OWNER' | 'ADMIN' | 'VIEWER'): AppState {
  return {
    user: { id: 'self', email: 'owner@example.test', displayName: 'Original name', isAdmin: false, emailNotifications: true },
    organizations: [{ id: 'org', name: 'Original organization', role: role === 'VIEWER' ? 'MEMBER' : role }],
    workspaces: [{ id: 'workspace', organizationId: 'org', name: 'Original workspace' }],
    selectedWorkspace: { id: 'workspace', organizationId: 'org', name: 'Original workspace' }, role,
    overview: { savedCount: 0, analysisCount: 0, pendingAnalysisCount: 0, dataUpdatedAt: null, sourceHealth: { status: 'READY' } },
    research: { folders: [], savedAds: [], notes: [], analyses: [] },
    members: [{ id: 'owner', email: 'owner@example.test', displayName: 'Owner', organizationRole: 'OWNER' },
      { id: 'member', email: 'member@example.test', displayName: 'Member', organizationRole: 'MEMBER', workspaceRole: 'VIEWER' },
      { id: 'admin', email: 'admin@example.test', displayName: 'Admin', organizationRole: 'ADMIN' }],
    billing: { organizationId: 'org', planName: 'Original plan', status: 'ACTIVE', periodEnd: null, cancelAtPeriodEnd: false, checkoutEnabled: true, entitlements: [],
      plans: [{ id: 'pro', name: 'Original plan', priceMinor: 1200, currency: 'USD', interval: 'month', features: ['Original feature'] }] },
  };
}
function render(role: 'OWNER' | 'ADMIN' | 'VIEWER', locale = 'en') {
  fixture.state = state(role);
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [`/app/settings?lang=${locale}&workspace=workspace&plan=pro#billing`] },
    createElement(WorkspaceLocaleProvider, null, createElement(SettingsPage))));
}

beforeEach(() => { fixture.forms.length = 0; fixture.buttons.length = 0; });
describe('settings permissions and localization', () => {
  it('provides four complete translations with consistent interpolation and no Chinese in English or Spanish', () => {
    for (const [key, values] of Object.entries(settingsMessages)) {
      expect(Object.keys(values).sort(), key).toEqual(['en', 'es', 'zh-CN', 'zh-TW']);
      for (const value of Object.values(values)) {
        expect(value.trim()).not.toBe('');
        expect((value.match(/\{\w+\}/g) ?? []).sort(), key).toEqual((values.en.match(/\{\w+\}/g) ?? []).sort());
      }
      expect(values.en, key).not.toMatch(/[\u3400-\u9fff]/);
      expect(values.es, key).not.toMatch(/[\u3400-\u9fff]/);
    }
  });
  it('keeps management, billing, ownership and organization-deletion controls restricted by role', () => {
    for (const role of ['OWNER', 'ADMIN', 'VIEWER'] as const) {
      fixture.forms.length = 0; fixture.buttons.length = 0;
      const html = render(role);
      const form = (label: string) => fixture.forms.find(item => item.label === label)!;
      expect(form('Create workspace').disabled).toBe(role === 'VIEWER');
      expect(form('Send invitation').disabled).toBe(role === 'VIEWER');
      expect(form('Continue to checkout').disabled).toBe(role !== 'OWNER');
      expect(fixture.forms.some(item => item.label === 'Confirm ownership transfer')).toBe(role === 'OWNER');
      expect(html.includes('<option value="ORGANIZATION">')).toBe(role === 'OWNER');
      const archive = fixture.buttons.find(item => item.command.type === 'ARCHIVE_WORKSPACE')!;
      expect(archive.disabled).toBe(role === 'VIEWER');
      expect(archive.confirmText).toContain('Original workspace');
      expect(archive.confirmText).toContain('Self-service restoration is not available');
      for (const button of fixture.buttons.filter(item => ['REMOVE_MEMBER', 'REMOVE_WORKSPACE_MEMBER'].includes(item.command.type))) {
        expect(button.disabled).toBe(role === 'VIEWER');
        expect(button.confirmText?.length).toBeGreaterThan(50);
      }
    }
  });
  it('prevents an admin from selecting an admin promotion while retaining allowed invitations', () => {
    const html = render('ADMIN');
    const updateForms = [...html.matchAll(/<form data-label="Update role">([\s\S]*?)<\/form>/g)].map(match => match[1]);
    expect(updateForms).toHaveLength(2);
    for (const form of updateForms) expect(form).toContain('<option value="ADMIN" disabled="">');
    expect(updateForms[1]).toContain('<option value="" disabled="" selected="">');
    expect(updateForms[1]).toContain('required=""');
    const invitation = html.match(/<form data-label="Send invitation">([\s\S]*?)<\/form>/)?.[1];
    expect(invitation).toContain('<option value="ADMIN">');
  });
  it('keeps existing deep links, purchase selection and backend values across all four languages', () => {
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'es']) {
      const html = render('OWNER', locale);
      for (const anchor of ['account', 'profile', 'team', 'billing', 'feedback', 'danger']) expect(html).toContain(`id="${anchor}"`);
      expect(html).toContain('<option value="pro" selected="">');
      expect(html).toContain(`/request-password-reset?lang=${locale}`);
      expect(html).toContain('Original workspace');
      expect(html).toContain('Original feature');
      expect(html).not.toMatch(/settings\.[a-zA-Z.]+/);
    }
  });
});
