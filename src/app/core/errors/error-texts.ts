import { translatable } from '../i18n/i18n';
import type { ErrorCode } from './app-error';
import { ERROR_DE } from './error-texts.de';

/** What the user reads for an error code of the app (not the message of a database server). */
export const ERROR_EN = {
  invalid_query: 'The statement is invalid.',
  unsupported: 'This is not supported.',
  invalid_theme: 'This is not a valid colour scheme.',
  too_large: 'The file is too large.',
  not_found: 'Not found.',
  invalid_session: 'The stored session is invalid.',
  unknown_result: 'This result no longer exists.',
  encoding_failed: 'The encoding of the file cannot represent every character of the text.',
  connection_failed: 'The connection failed.',
  auth_failed: 'The login was rejected.',
  tls_failed: 'The encrypted connection (TLS) could not be established.',
  timeout: 'No answer within the time allowed.',
  cancelled: 'Cancelled.',
  permission_denied: 'You do not have permission to do this.',
  confirmation_required: 'This statement needs a confirmation.',
  secret_required: 'A password is required.',
  host_key_unknown: 'The SSH server presents a key that has not been confirmed yet.',
  host_key_changed:
    'The key of the SSH server does not match the known one. The connection is not established.',
  ssh_secret_required: 'The SSH tunnel needs a password or the passphrase of the key.',
  keychain_unavailable: 'The keychain of the system is not available.',
  invalid_profile: 'The details of the connection are incomplete or invalid.',
  unknown_connection: 'This connection does not exist (any more).',
  not_connected: 'The connection is not open.',
  format_incomplete: 'Not formatted: the text ends inside a string, a quoted name or a comment.',
  format_too_deep: 'Not formatted: brackets and blocks are nested too deep.',
  format_unsafe:
    'Not formatted: the result would not have been the same SQL. The text is unchanged.',
  io: 'The file could not be read or written.',
  backend_unavailable: 'This only works in the desktop app.',
  unknown: 'Unexpected error.',
} satisfies Record<ErrorCode, string>;

export const ERROR_TEXTS = translatable('errors', ERROR_EN, { de: ERROR_DE });
