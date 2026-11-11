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
  | 'format_incomplete'
  | 'format_too_deep'
  | 'format_unsafe'
  | 'io'
  /** No desktop backend (browser, tests). */
  | 'backend_unavailable'
  | 'unknown';

/** Mirrors `ErrorDetails`: what a database said about a failed statement beyond its message (prompt 022). */
export interface ErrorDetails {
  /** `SQLSTATE` or the number of the error. */
  readonly sqlstate?: string;
  readonly detail?: string;
  readonly hint?: string;
  /** Where in the statement, in characters from 1. */
  readonly position?: number;
  /** The line of the statement, from 1. */
  readonly line?: number;
  /** The text the database stumbled over. */
  readonly near?: string;
  readonly context?: string;
  readonly schema?: string;
  readonly table?: string;
  readonly column?: string;
  readonly constraint?: string;
}

export interface AppError {
  code: ErrorCode;
  message: string;
  /** Absent for errors of the app itself. */
  details?: ErrorDetails;
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
  'format_incomplete',
  'format_too_deep',
  'format_unsafe',
  'io',
  'backend_unavailable',
  'unknown',
]);

const TEXT_DETAILS = [
  'sqlstate',
  'detail',
  'hint',
  'near',
  'context',
  'schema',
  'table',
  'column',
  'constraint',
] as const;

/** The details of an error as far as they are what they must be; `null` when nothing is left. */
function readDetails(raw: unknown): ErrorDetails | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const out: Record<string, string | number> = {};
  for (const key of TEXT_DETAILS) {
    const value = o[key];
    if (typeof value === 'string' && value !== '') out[key] = value.slice(0, 20_000);
  }
  for (const key of ['position', 'line'] as const) {
    const value = o[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) out[key] = value;
  }
  return Object.keys(out).length > 0 ? (out as ErrorDetails) : null;
}

/** Whatever a command rejected with, as an `AppError`. */
export function toAppError(e: unknown): AppError {
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    if (typeof o['code'] === 'string' && typeof o['message'] === 'string') {
      const details = readDetails(o['details']);
      return {
        code: CODES.has(o['code']) ? (o['code'] as ErrorCode) : 'unknown',
        message: o['message'],
        ...(details ? { details } : {}),
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
