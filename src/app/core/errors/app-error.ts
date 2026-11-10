/** Mirrors `ErrorCode` in src-tauri/src/error.rs. */
export type ErrorCode =
  | 'invalid_query'
  | 'unsupported'
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
