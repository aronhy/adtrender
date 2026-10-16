import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, Link2Off, LoaderCircle } from 'lucide-react';
import { api, setSessionId } from 'wasp/client/api';
import { googleAuthErrorKey } from './GoogleAuth';
import { loginDestination } from '../client/app-surface';
import { AuthFrame } from './AuthFrame';
import { AuthLocaleProvider, useAuthLocale } from './locale';
import type { MessageKey } from './messages';

function Callback() {
  const { t, href } = useAuthLocale();
  const started = useRef(false);
  const mounted = useRef(false);
  const [error, setError] = useState<MessageKey | null>(null);

  useEffect(() => {
    mounted.current = true;
    const finish = async () => {
      try {
        const url = new URL(window.location.href);
        const code = url.hash.slice(1);
        const errorCode = url.searchParams.has('oauth_error') ? url.searchParams.get('oauth_error')
          : ['error', 'error_description', 'error_uri'].some(key => url.searchParams.has(key)) ? 'GOOGLE_SIGN_IN_FAILED' : null;
        // Remove credentials before requesting the one-use code exchange.
        const clean = new URLSearchParams();
        if (url.searchParams.has('lang')) clean.set('lang', url.searchParams.get('lang')!);
        window.history.replaceState(window.history.state, '', url.pathname + (clean.size ? `?${clean}` : ''));
        if (errorCode !== null) { setError(googleAuthErrorKey(errorCode)); return; }
        if (!code || code.length > 8192) { setError('google.callbackInvalid'); return; }
        const data = await api.post('/auth/exchange-code', { json: { code }, retry: 0, timeout: 10000 }).json<unknown>();
        if (!mounted.current) return;
        if (!data || typeof data !== 'object' || !('sessionId' in data) || typeof data.sessionId !== 'string' || !data.sessionId) {
          setError('google.failed'); return;
        }
        setSessionId(data.sessionId);
        window.location.replace(loginDestination(url.search));
      } catch { if (mounted.current) setError('google.callbackInvalid'); }
    };
    // Strict Mode replays effects; never exchange a one-use code twice.
    if (!started.current) { started.current = true; void finish(); }
    return () => { mounted.current = false; };
  }, []);

  return <AuthFrame title={t(error ? 'callback.failed' : 'callback.title')} description={error ? undefined : t('callback.description')}>
    <div className="auth-result">
      {error ? <><span className="auth-status-icon error"><Link2Off size={25} aria-hidden="true" /></span><p className="auth-alert" role="alert">{t(error)}</p></>
        : <p role="status"><LoaderCircle className="auth-spinner" size={20} aria-hidden="true" /> {t('action.working')}</p>}
      <Link className="auth-button-secondary" to={href('/login')}><ArrowLeft size={16} aria-hidden="true" />{t('action.backLogin')}</Link>
    </div>
  </AuthFrame>;
}
export function GoogleCallbackPage() { return <AuthLocaleProvider><Callback /></AuthLocaleProvider>; }
