import type { Translation } from '../i18n/i18n';
import type { ERROR_EN } from './error-texts';

export const ERROR_DE: Translation<typeof ERROR_EN> = {
  invalid_query: 'Die Anweisung ist ungültig.',
  unsupported: 'Das wird nicht unterstützt.',
  invalid_theme: 'Das ist kein gültiges Farbschema.',
  too_large: 'Die Datei ist zu groß.',
  program_not_found: 'Ein Programm der Datenbank ist auf diesem Rechner nicht vorhanden.',
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
  host_key_unknown: 'Der SSH-Server zeigt einen Schlüssel, der noch nicht bestätigt ist.',
  host_key_changed:
    'Der Schlüssel des SSH-Servers passt nicht zum bekannten. Die Verbindung wird nicht aufgebaut.',
  ssh_secret_required: 'Der SSH-Tunnel braucht ein Passwort oder die Passphrase des Schlüssels.',
  keychain_unavailable: 'Der Schlüsselbund des Systems ist nicht verfügbar.',
  invalid_profile: 'Die Angaben der Verbindung sind unvollständig oder ungültig.',
  unknown_connection: 'Diese Verbindung gibt es nicht (mehr).',
  not_connected: 'Die Verbindung ist nicht geöffnet.',
  format_incomplete:
    'Nicht formatiert: Der Text endet in einem String, einem Namen in Anführungszeichen oder einem Kommentar.',
  format_too_deep: 'Nicht formatiert: Klammern und Blöcke sind zu tief verschachtelt.',
  format_unsafe:
    'Nicht formatiert: Das Ergebnis wäre nicht dasselbe SQL gewesen. Der Text ist unverändert.',
  io: 'Die Datei konnte nicht gelesen oder geschrieben werden.',
  backend_unavailable: 'Das geht nur in der Desktop-App.',
  unknown: 'Unerwarteter Fehler.',
};
