/** Mirrors `ErrorCode` in src-tauri/src/error.rs. */
export type ErrorCode =
  | 'invalid_query'
  | 'unsupported'
  | 'invalid_theme'
  | 'too_large'
  | 'not_found'
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

const TEXTS: Readonly<Record<ErrorCode, string>> = {
  invalid_query: 'Die Anweisung ist ungültig.',
  unsupported: 'Das wird nicht unterstützt.',
  invalid_theme: 'Das ist kein gültiges Farbschema.',
  too_large: 'Die Datei ist zu groß.',
  not_found: 'Die Datei wurde nicht gefunden.',
  io: 'Die Datei konnte nicht gelesen oder geschrieben werden.',
  backend_unavailable: 'Das geht nur in der Desktop-App.',
  unknown: 'Unerwarteter Fehler.',
};

/** What the user reads for an error of the app itself (not the message of a database server). */
export function errorText(e: unknown): string {
  return TEXTS[toAppError(e).code];
}
