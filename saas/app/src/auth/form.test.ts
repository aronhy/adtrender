import { describe, expect, it } from 'vitest';
import { authErrorKey, newPasswordError } from './form';

describe('authentication form validation', () => {
  it('matches the native password rules and checks confirmation before submitting', () => {
    expect(newPasswordError('short1', 'short1')).toBe('error.passwordLength');
    expect(newPasswordError('letters-only', 'letters-only')).toBe('error.passwordNumber');
    expect(newPasswordError('a'.repeat(128) + '1', 'a'.repeat(128) + '1')).toBe('error.passwordLength');
    expect(newPasswordError('Unique-pass-42', 'Other-pass-42')).toBe('error.passwordMismatch');
    expect(newPasswordError('Unique-pass-42', 'Unique-pass-42')).toBeNull();
    expect(newPasswordError(' 空格不被删除的密码42 ', ' 空格不被删除的密码42 ')).toBeNull();
  });
  it('recognizes native Wasp errors and raw ky response errors without displaying their payloads', () => {
    expect(authErrorKey(Object.assign(new Error('Invalid credentials'), { statusCode: 401 }))).toBe('error.credentials');
    expect(authErrorKey(Object.assign(new Error('Request failed'), { response: { status: 429 }, data: { message: 'RATE_LIMITED' } }))).toBe('error.rateLimit');
    expect(authErrorKey({ message: 'Validation failed', data: { data: { message: 'password must contain a number' } } })).toBe('error.passwordNumber');
    expect(authErrorKey({ data: { message: 'INVITATION_REQUIRED' }, response: { status: 403 } })).toBe('error.invitation');
    expect(authErrorKey(new Error('AUTH_LINK_INVALID'))).toBe('link.invalidBody');
    expect(authErrorKey(new Error('EMAIL_NOT_VERIFIED'))).toBe('error.verification');
    expect(authErrorKey(new TypeError('Failed to fetch'))).toBe('error.network');
    expect(authErrorKey(Object.assign(new Error('Request failed'), { name: 'NetworkError' }))).toBe('error.network');
    expect(authErrorKey(new Error('Unexpected secret/password/token provider diagnostic'))).toBe('error.generic');
  });
});
