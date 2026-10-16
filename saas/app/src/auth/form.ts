import type { MessageKey } from './messages';

export function newPasswordError(password: string, confirmation: string): MessageKey | null {
  if (password.length < 8 || password.length > 128) return 'error.passwordLength';
  if (!/\d/.test(password)) return 'error.passwordNumber';
  if (password !== confirmation) return 'error.passwordMismatch';
  return null;
}

/** Return translation keys only. Provider diagnostics must never enter the UI. */
export function authErrorKey(reason: unknown): MessageKey {
  const error = reason && typeof reason === 'object' ? reason as {
    message?: unknown; name?: unknown; statusCode?: number;
    response?: { status?: number }; data?: { message?: unknown; data?: { message?: unknown } };
  } : {};
  const status = error.statusCode ?? error.response?.status;
  const values = [error.message, error.data?.message, error.data?.data?.message].filter((v): v is string => typeof v === 'string');
  if (status === 429 || values.some(v => /^RATE_LIMIT/.test(v))) return 'error.rateLimit';
  if (values.some(v => /^(AUTH_LINK_INVALID|LINK_INVALID|TOKEN_EXPIRED)$/.test(v))) return 'link.invalidBody';
  if (values.some(v => /^(INVITATION_REQUIRED|REGISTRATION_NOT_ALLOWED)$/.test(v))) return 'error.invitation';
  if (values.some(v => /^(EMAIL_NOT_VERIFIED|Email not verified|Email is not verified)$/i.test(v))) return 'error.verification';
  if (values.some(v => /^(ACCOUNT_DISABLED|USER_DISABLED)$/.test(v))) return 'error.disabled';
  if (values.some(v => v === 'INVALID_EMAIL' || /^email must be/.test(v))) return 'error.invalidEmail';
  if (values.some(v => /^password must contain a number$/.test(v))) return 'error.passwordNumber';
  if (values.some(v => /^password must be at least 8 characters$/.test(v))) return 'error.passwordLength';
  if (status === 401 || values.some(v => /^Invalid credentials$/i.test(v))) return 'error.credentials';
  if (error.name === 'TypeError' || error.name === 'TimeoutError' || error.name === 'NetworkError' || values.some(v => /^(Failed to fetch|Network request failed|Load failed)$/.test(v))) return 'error.network';
  return 'error.generic';
}
