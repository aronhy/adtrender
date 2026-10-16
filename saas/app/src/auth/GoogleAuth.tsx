import { useEffect, useId, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api } from 'wasp/client/api';
import { googleSignInUrl } from 'wasp/client/auth';
import { LoaderCircle } from 'lucide-react';
import { useAuthLocale } from './locale';
import type { MessageKey } from './messages';
import { googleLoginTarget } from '../client/app-surface';

type Availability = 'loading' | 'available' | 'unconfigured' | 'unreachable';

export function googleAuthErrorKey(code: string | null): MessageKey | null {
  switch (code) {
    case null: return null;
    case 'EMAIL_ACCOUNT_EXISTS': return 'google.accountExists';
    case 'GOOGLE_UNAVAILABLE': return 'google.unconfigured';
    case 'ACCOUNT_DISABLED': return 'error.disabled';
    case 'INVITATION_REQUIRED': return 'error.invitation';
    case 'GOOGLE_EMAIL_REQUIRES_VERIFICATION': return 'google.emailVerification';
    case 'GOOGLE_EMAIL_CHANGED': return 'google.emailChanged';
    default: return 'google.failed';
  }
}

export function GoogleAuth({ mode }: { mode: 'login' | 'signup' }) {
  const { t } = useAuthLocale();
  const location = useLocation();
  const navigate = useNavigate();
  const descriptionId = useId();
  const [availability, setAvailability] = useState<Availability>('loading');
  const [attempt, setAttempt] = useState(0);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState(() => googleAuthErrorKey(new URLSearchParams(location.search).get('oauth_error')));

  useEffect(() => {
    const search = new URLSearchParams(location.search);
    if (!search.has('oauth_error')) return;
    setError(googleAuthErrorKey(search.get('oauth_error')));
    search.delete('oauth_error');
    navigate({ pathname: location.pathname, search: search.toString(), hash: location.hash }, { replace: true, state: location.state });
  }, [location.pathname, location.search, location.hash, location.state, navigate]);

  useEffect(() => {
    const controller = new AbortController();
    setAvailability('loading');
    void api.get('/auth/options', { signal: controller.signal, retry: 0, timeout: 10000 }).json<unknown>().then(options => {
      if (controller.signal.aborted) return;
      if (!options || typeof options !== 'object' || !('google' in options) || typeof options.google !== 'boolean') {
        setAvailability('unreachable'); return;
      }
      setAvailability(options.google ? 'available' : 'unconfigured');
    }).catch(() => { if (!controller.signal.aborted) setAvailability('unreachable'); });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => {
    const resetLaunching = () => setLaunching(false);
    window.addEventListener('pageshow', resetLaunching);
    return () => window.removeEventListener('pageshow', resetLaunching);
  }, []);

  const signIn = () => {
    if (availability !== 'available' || launching) return;
    setError(null); setLaunching(true);
    try { window.location.assign(googleLoginTarget(googleSignInUrl)); }
    catch { setLaunching(false); setError('google.failed'); }
  };
  const buttonLabel = launching ? t('google.launching') : availability === 'loading' ? t('google.loading')
    : availability === 'available' ? t(mode === 'signup' ? 'google.signup' : 'google.login') : t('google.unavailable');
  const showDescription = availability === 'unconfigured' || availability === 'unreachable';

  return <>
    <section className="auth-google" aria-label="Google">
      {error && <p className="auth-google-error" role="alert">{t(error)}</p>}
      <button type="button" className="auth-google-button" disabled={availability !== 'available' || launching} onClick={signIn} aria-describedby={showDescription ? descriptionId : undefined}>
        {launching || availability === 'loading' ? <LoaderCircle className="auth-spinner" size={18} aria-hidden="true" /> : <span className="auth-google-mark" aria-hidden="true">G</span>}{buttonLabel}
      </button>
      {showDescription && <p className="auth-google-state" role="status" id={descriptionId}>{t(availability === 'unconfigured' ? 'google.unconfigured' : 'google.unreachable')}</p>}
      {availability === 'unreachable' && <button type="button" className="auth-text-button" onClick={() => setAttempt(value => value + 1)}>{t('google.retry')}</button>}
    </section>
    <div className="auth-divider"><span>{t('google.divider')}</span></div>
  </>;
}
