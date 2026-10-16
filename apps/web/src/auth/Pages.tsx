import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, Link2Off, LoaderCircle, Mail } from 'lucide-react';
import { login, signup, requestPasswordReset, resetPassword, verifyEmail } from 'wasp/client/auth';
import { api } from 'wasp/client/api';
import { GoogleAuth } from './GoogleAuth';
import { AuthFrame } from './AuthFrame';
import { AuthLocaleProvider, useAuthLocale } from './locale';
import { authErrorKey, newPasswordError } from './form';
import type { MessageKey } from './messages';
import { appSurface, customerAppOrigin, loginDestination } from '../client/app-surface';

type Mode = 'login' | 'signup' | 'request' | 'reset' | 'verify';
type Result = 'signup' | 'request' | 'resent' | 'reset' | 'verify' | null;

function PasswordField({ name, label, newPassword = false, children }: {
  name: string; label: string; newPassword?: boolean; children?: ReactNode;
}) {
  const { t } = useAuthLocale();
  const [visible, setVisible] = useState(false);
  const id = useId();
  return <div className="auth-field">
    <span className="auth-label-row"><label htmlFor={id}>{label}</label>{children}</span>
    <span className="auth-password"><input id={id} name={name} type={visible ? 'text' : 'password'} required
      autoComplete={newPassword ? 'new-password' : 'current-password'} minLength={newPassword ? 8 : 1}
      maxLength={newPassword ? 128 : undefined} aria-describedby={newPassword && name === 'password' ? `${id}-hint` : undefined} />
      <button type="button" onClick={() => setVisible(value => !value)} aria-label={t(visible ? 'field.hidePassword' : 'field.showPassword')} aria-pressed={visible}>
        {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
      </button>
    </span>
    {newPassword && name === 'password' && <small className="auth-hint" id={`${id}-hint`}>{t('field.passwordHint')}</small>}
  </div>;
}

function AuthLegal() {
  const { t, href } = useAuthLocale();
  if (appSurface() === 'admin') return <p className="auth-legal">{t('legal.before')} <a href={customerAppOrigin() + href('/terms')}>{t('nav.terms')}</a> {t('legal.and')} <a href={customerAppOrigin() + href('/privacy')}>{t('nav.privacy')}</a>{t('legal.after')}</p>;
  return <p className="auth-legal">{t('legal.before')} <Link to={href('/terms')}>{t('nav.terms')}</Link> {t('legal.and')} <Link to={href('/privacy')}>{t('nav.privacy')}</Link>{t('legal.after')}</p>;
}

function EmailForm({ mode }: { mode: Mode }) {
  const { t, href } = useAuthLocale();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [result, setResult] = useState<Result>(null);
  const [email, setEmail] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const captured = useRef(false);
  const [invalidLink, setInvalidLink] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const feedback = useRef<HTMLDivElement>(null);
  const emailId = useId();
  const needsToken = mode === 'reset' || mode === 'verify';

  useEffect(() => {
    if (!needsToken || captured.current) return;
    captured.current = true;
    const url = new URL(window.location.href);
    const value = url.searchParams.get('token') ?? '';
    setToken(value);
    setInvalidLink(!/^[a-f\d]{64}$/i.test(value));
    url.searchParams.delete('token');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }, [needsToken]);

  useEffect(() => {
    const update = () => setSeconds(Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000)));
    update();
    if (cooldownUntil <= Date.now()) return;
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  useEffect(() => { if (result || error || invalidLink) feedback.current?.focus(); }, [result, error, invalidLink]);

  const startCooldown = () => { setCooldownUntil(Date.now() + 60_000); setSeconds(60); };
  const fail = (reason: unknown) => {
    const key = authErrorKey(reason);
    if (key === 'link.invalidBody' && needsToken) setInvalidLink(true);
    else setError(key);
    if (key === 'error.rateLimit') startCooldown();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current) return;
    const data = new FormData(event.currentTarget);
    const password = String(data.get('password') ?? '');
    if (mode === 'signup' || mode === 'reset') {
      const validation = newPasswordError(password, String(data.get('confirmPassword') ?? ''));
      if (validation) { setError(validation); return; }
    }
    submitting.current = true; setBusy(true); setError(null);
    try {
      const address = email.trim();
      if (mode === 'login') { await login({ email: address, password }); navigate(loginDestination(window.location.search), { replace: true }); }
      else if (mode === 'signup') {
        if (!(await signup({ email: address, password })).success) throw new Error('SIGNUP_FAILED');
        setEmail(address); setResult('signup'); startCooldown();
      } else if (mode === 'request') {
        if (!(await requestPasswordReset({ email: address })).success) throw new Error('REQUEST_FAILED');
        setEmail(address); setResult('request'); startCooldown();
      } else if (mode === 'reset') {
        if (!(await resetPassword({ token: token ?? '', password })).success) throw new Error('LINK_INVALID');
        setResult('reset');
      } else {
        if (!(await verifyEmail({ token: token ?? '' })).success) throw new Error('LINK_INVALID');
        setResult('verify');
      }
    } catch (reason) { fail(reason); }
    finally { submitting.current = false; setBusy(false); }
  };

  const resend = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (submitting.current || cooldownUntil > Date.now() || !email.trim()) return;
    const input = document.getElementById(emailId) as HTMLInputElement | null;
    if (input && !input.reportValidity()) return;
    submitting.current = true; setBusy(true); setError(null);
    try {
      if (mode === 'request') {
        if (!(await requestPasswordReset({ email: email.trim() })).success) throw new Error('REQUEST_FAILED');
        setResult('request');
      } else {
        const response = await api.post('/auth/email/resend-verification', { json: { email: email.trim() }, retry: 0 }).json<{ success: boolean }>();
        if (!response.success) throw new Error('REQUEST_FAILED');
        setResult('resent');
      }
      setEmail(value => value.trim()); startCooldown();
    } catch (reason) { fail(reason); }
    finally { submitting.current = false; setBusy(false); }
  };

  const emailField = <label className="auth-field" htmlFor={emailId}><span>{t('field.email')}</span><input id={emailId} name="email" type="email" required autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254} value={email} onChange={event => { setEmail(event.target.value); setError(null); }} /></label>;
  const errorMessage = error && <div className="auth-alert" role="alert" tabIndex={-1} ref={feedback}>{t(error)}</div>;
  const back = <Link className="auth-back" to={href('/login')}><ArrowLeft size={16} aria-hidden="true" />{t('action.backLogin')}</Link>;
  const mailLabel = busy ? t('action.sending') : seconds > 0 ? t('action.wait').replace('{seconds}', String(seconds)) : t(mode === 'request' ? 'action.resendReset' : 'action.resend');
  const actionLabel = busy ? t('action.working') : seconds > 0 && (mode === 'signup' || mode === 'request') ? t('action.wait').replace('{seconds}', String(seconds)) : t(`${mode}.submit`);

  if (needsToken && token === null) return <p role="status"><LoaderCircle className="auth-spinner" size={20} aria-hidden="true" /> {t('action.working')}</p>;
  if (result === 'reset' || result === 'verify') return <div className="auth-result" ref={feedback} tabIndex={-1} role="status">
    <span className="auth-status-icon success"><Check size={26} aria-hidden="true" /></span>
    <h2>{t(result === 'reset' ? 'success.resetTitle' : 'success.verifyTitle')}</h2>
    <p>{t(result === 'reset' ? 'success.resetBody' : 'success.verifyBody')}</p>
    <Link className="auth-button" to={href('/login')}>{t('action.signIn')}<ArrowRight size={18} aria-hidden="true" /></Link>
  </div>;
  if (result) return <div className="auth-result">
    <div ref={feedback} tabIndex={-1} role="status"><span className="auth-status-icon mail"><Mail size={25} aria-hidden="true" /></span>
      <h2>{t('mail.title')}</h2><p className="auth-email">{email}</p><p>{t(result === 'signup' ? 'mail.signup' : result === 'request' ? 'mail.request' : 'mail.resent')}</p><p className="auth-hint">{t('mail.hint')}</p>
    </div>
    <Link className="auth-button" to={href('/login')} onClick={() => { setResult(null); setError(null); }}>{t('action.backLogin')}<ArrowRight size={18} aria-hidden="true" /></Link>
    <div className="auth-resend"><p className="auth-hint">{t('mail.notReceived')}</p><button type="button" className="auth-text-button" onClick={() => void resend()} disabled={busy || seconds > 0}>{mailLabel}</button></div>
    <button type="button" className="auth-text-button" onClick={() => { setResult(null); setError(null); }} disabled={busy}>{t('action.changeEmail')}</button>
    {errorMessage}
  </div>;
  if (invalidLink) return <div className="auth-result">
    <div ref={feedback} tabIndex={-1} role="alert"><span className="auth-status-icon error"><Link2Off size={25} aria-hidden="true" /></span><h2>{t('link.invalidTitle')}</h2><p>{t('link.invalidBody')}</p></div>
    {mode === 'reset' ? <Link className="auth-button" to={href('/request-password-reset')}>{t('action.newLink')}<ArrowRight size={18} aria-hidden="true" /></Link>
      : <form className="auth-form" onSubmit={event => void resend(event)}><p className="auth-hint">{t('link.verifyHelp')}</p><fieldset disabled={busy}>{emailField}<button className="auth-button" type="submit" disabled={seconds > 0}>{mailLabel}</button></fieldset>{errorMessage}</form>}
    {back}
  </div>;

  return <>
    {(mode === 'login' || mode === 'signup') && <GoogleAuth mode={mode} />}
    <form className="auth-form" onSubmit={event => void submit(event)} aria-busy={busy}>
      <fieldset disabled={busy}>
        {(mode === 'login' || mode === 'signup' || mode === 'request') && emailField}
        {(mode === 'login' || mode === 'signup' || mode === 'reset') && <PasswordField name="password" label={t(mode === 'reset' ? 'field.newPassword' : 'field.password')} newPassword={mode !== 'login'}>
          {mode === 'login' && <Link to={href('/request-password-reset')}>{t('action.forgot')}</Link>}
        </PasswordField>}
        {(mode === 'signup' || mode === 'reset') && <PasswordField name="confirmPassword" label={t('field.confirmPassword')} newPassword />}
        {errorMessage}
        <button className="auth-button" type="submit" disabled={busy || ((mode === 'signup' || mode === 'request') && seconds > 0)}>
          {busy && <LoaderCircle className="auth-spinner" size={18} aria-hidden="true" />}{actionLabel}{!busy && <ArrowRight size={18} aria-hidden="true" />}
        </button>
      </fieldset>
    </form>
    {mode === 'login' && <div className="auth-resend"><button type="button" className="auth-text-button" disabled={busy || !email.trim() || seconds > 0} onClick={() => void resend()}>{mailLabel}</button></div>}
    {(mode === 'login' || mode === 'signup') ? <>{appSurface() === 'customer' && <p className="auth-switch">{t(`${mode}.switch`)} <Link to={href(mode === 'login' ? '/signup' : '/login')}>{t(`${mode}.switchLink`)}</Link></p>}<AuthLegal /></> : back}
  </>;
}

function AuthPage({ mode }: { mode: Mode }) {
  const { t } = useAuthLocale();
  const admin = appSurface() === 'admin' && mode === 'login';
  return <AuthFrame title={t(admin ? 'admin.title' : `${mode}.title`)} description={t(admin ? 'admin.description' : `${mode}.description`)}><EmailForm key={mode} mode={mode} /></AuthFrame>;
}
export function LoginPage() { return <AuthLocaleProvider><AuthPage mode="login" /></AuthLocaleProvider>; }
export function SignupPage() { return <AuthLocaleProvider><AuthPage mode="signup" /></AuthLocaleProvider>; }
export function RequestPasswordResetPage() { return <AuthLocaleProvider><AuthPage mode="request" /></AuthLocaleProvider>; }
export function PasswordResetPage() { return <AuthLocaleProvider><AuthPage mode="reset" /></AuthLocaleProvider>; }
export function EmailVerificationPage() { return <AuthLocaleProvider><AuthPage mode="verify" /></AuthLocaleProvider>; }
