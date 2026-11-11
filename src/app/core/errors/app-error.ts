import { ERROR_TEXTS } from './error-texts';

/** Mirrors `ErrorCode` in src-tauri/src/error.rs. */
export type ErrorCode =
  | 'invalid_query'
  | 'unsupported'
  | 'invalid_theme'
  | 'too_large'
  | 'not_found'
  | 'invalid_session'
  | 'unknown_result'
  | 'encoding_failed'
  | 'connection_failed'
  | 'auth_failed'
  | 'tls_failed'
  | 'timeout'
  | 'cancelled'
  | 'permission_denied'
  | 'confirmation_required'
  | 'secret_required'
  | 'host_key_unknown'
  | 'host_key_changed'
  | 'ssh_secret_required'
  | 'keychain_unavailable'
  | 'invalid_profile'
  | 'unknown_connection'
  | 'not_connected'
  | 'io'
  /** No desktop backend (browser, tests). */
  | 'backend_unavailable'
  | 'unknown';

export interface AppError {
  code: ErrorCode;
  message: string;
}

const CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'invalid_query',
  'unsupported',
  'invalid_theme',
  'too_large',
  'not_found',
  'invalid_session',
  'unknown_result',
  'encoding_failed',
  'connection_failed',
  'auth_failed',
  'tls_failed',
  'timeout',
  'cancelled',
  'permission_denied',
  'confirmation_required',
  'secret_required',
  'host_key_unknown',
  'host_key_changed',
  'ssh_secret_required',
  'keychain_unavailable',
  'invalid_profile',
  'unknown_connection',
  'not_connected',
  'io',
  'backend_unavailable',
  'unknown',
]);

/** Whatever a command rejected with, as an `AppError`. */
export function toAppError(e: unknown): AppError {
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    if (typeof o['code'] === 'string' && typeof o['message'] === 'string') {
      return {
        code: CODES.has(o['code']) ? (o['code'] as ErrorCode) : 'unknown',
        message: o['message'],
      };
    }
    if (e instanceof Error) return { code: 'unknown', message: e.message };
  }
  return { code: 'unknown', message: typeof e === 'string' ? e : 'unknown error' };
}

/**
 * What the user reads for an error of the app itself (not the message of a database server), in the
 * current language (`error-texts.ts`).
 */
export function errorText(e: unknown): string {
  return ERROR_TEXTS[toAppError(e).code];
}

/** The text of the code and, where it says more, what the backend or the server reported. */
export function describeError(e: unknown): string {
  const error = toAppError(e);
  const text = ERROR_TEXTS[error.code];
  const detail = error.message.trim();
  const says = [
    'invalid_query',
    'connection_failed',
    'auth_failed',
    'tls_failed',
    'host_key_unknown',
    'host_key_changed',
    'ssh_secret_required',
    'permission_denied',
    'not_found',
    'invalid_session',
    'unknown_result',
    'encoding_failed',
    'invalid_profile',
    'keychain_unavailable',
    'unknown',
  ].includes(error.code);
  return says && detail ? `${text} ${detail}` : text;
}
