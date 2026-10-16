import { type ReactNode } from 'react';
import { LogOut } from 'lucide-react';
import { Brand } from './brand/Brand';
import type { AppState } from './types';
import { WorkspaceLanguagePicker, useWorkspaceLocale } from './workspace-i18n/locale';
import { useAdminCopy, type AdminCopyDictionary } from './platform-admin/admin-i18n';
import { permissionError } from './platform-admin/navigation';
import './admin-shell.css';

const copy: AdminCopyDictionary = {
  '管理后台': { 'zh-TW': '管理後台', en: 'Administration', es: 'Administración' },
  '正在读取后台会话…': { 'zh-TW': '正在讀取後台工作階段…', en: 'Loading administrator session…', es: 'Cargando la sesión de administración…' },
  '后台数据暂时无法读取': { 'zh-TW': '後台資料暫時無法讀取', en: 'Administration data is unavailable', es: 'Los datos de administración no están disponibles' },
  '请检查网络连接后重试。': { 'zh-TW': '請檢查網路連線後重試。', en: 'Check your connection and try again.', es: 'Comprueba la conexión e inténtalo de nuevo.' },
};

export type AdminShellProps = {
  state?: Pick<AppState, 'user'>;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  onSignOut: () => void;
  children?: ReactNode;
};

/** Presentation only: the caller owns authentication, scoped queries, and the app context. */
export function AdminShell({ state, loading, error, onRetry, onSignOut, children }: AdminShellProps) {
  const { t: workspaceText, href, locale } = useWorkspaceLocale();
  const { t } = useAdminCopy(copy);
  const denied = permissionError(error) || (!loading && !error && state && !state.user.isAdmin);
  let body: ReactNode;
  if (loading) {
    body = <div className="admin-shell-state" role="status"><span className="spinner" aria-hidden="true" /><p>{t('正在读取后台会话…')}</p></div>;
  } else if (denied) {
    body = <section className="admin-shell-state" role="alert"><h1>{t('没有访问权限')}</h1><p>{t('当前账号没有有效的平台管理权限，请联系平台管理员。')}</p></section>;
  } else if (error || !state) {
    body = <section className="admin-shell-state" role="alert"><h1>{t('后台数据暂时无法读取')}</h1><p>{t('请检查网络连接后重试。')}</p>{onRetry && <button type="button" className="button secondary" onClick={onRetry}>{workspaceText('common.retry')}</button>}</section>;
  } else {
    body = children;
  }
  return <div className="admin-shell workspace-shell" lang={locale} data-locale={locale}>
    <a href="#main-content" className="workspace-skip">{workspaceText('nav.skip')}</a>
    <header className="admin-shell-header">
      <div className="admin-shell-brand"><Brand to={href('/app/admin')} /><span>{t('管理后台')}</span></div>
      <div className="admin-shell-controls"><span className="admin-shell-identity" title={state?.user.email}>{state?.user.displayName || state?.user.email}</span><WorkspaceLanguagePicker /><button type="button" className="icon-button admin-shell-signout" onClick={onSignOut} aria-label={workspaceText('nav.signOut')} title={workspaceText('nav.signOut')}><LogOut size={18} aria-hidden="true" /></button></div>
    </header>
    <main id="main-content" className="admin-shell-main" tabIndex={-1}>{body}</main>
  </div>;
}
