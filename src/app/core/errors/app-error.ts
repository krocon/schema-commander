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

const TEXTS: Readonly<Record<ErrorCode, string>> = {
  invalid_query: 'Die Anweisung ist ungültig.',
  unsupported: 'Das wird nicht unterstützt.',
  invalid_theme: 'Das ist kein gültiges Farbschema.',
  too_large: 'Die Datei ist zu groß.',
  not_found: 'Nicht gefunden.',
  invalid_session: 'Die gespeicherte Sitzung ist ungültig.',
  unknown_result: 'Dieses Ergebnis gibt es nicht mehr.',
  encoding_failed: 'Die Kodierung der Datei kann nicht alle Zeichen des Textes darstellen.',
  connection_failed: 'Die Verbindung ist fehlgeschlagen.',
  auth_failed: 'Die Anmeldung wurde abgelehnt.',
  tls_failed: 'Die verschlüsselte Verbindung (TLS) kam nicht zustande.',
  timeout: 'Keine Antwort in der vorgesehenen Zeit.',
  cancelled: 'Abgebrochen.',
  permission_denied: 'Dafür fehlen die Rechte.',
  confirmation_required: 'Diese Anweisung braucht eine Bestätigung.',
  secret_required: 'Ein Passwort ist nötig.',
  keychain_unavailable: 'Der Schlüsselbund des Systems ist nicht verfügbar.',
  invalid_profile: 'Die Angaben der Verbindung sind unvollständig oder ungültig.',
  unknown_connection: 'Diese Verbindung gibt es nicht (mehr).',
  not_connected: 'Die Verbindung ist nicht geöffnet.',
  io: 'Die Datei konnte nicht gelesen oder geschrieben werden.',
  backend_unavailable: 'Das geht nur in der Desktop-App.',
  unknown: 'Unerwarteter Fehler.',
};

/** What the user reads for an error of the app itself (not the message of a database server). */
export function errorText(e: unknown): string {
  return TEXTS[toAppError(e).code];
}

/** The text of the code and, where it says more, what the backend or the server reported. */
export function describeError(e: unknown): string {
  const error = toAppError(e);
  const text = TEXTS[error.code];
  const detail = error.message.trim();
  const says = [
    'invalid_query',
    'connection_failed',
    'auth_failed',
    'tls_failed',
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
