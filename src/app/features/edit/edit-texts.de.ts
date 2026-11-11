import type { Translation } from '../../core/i18n/i18n';
import type { EDIT_EN } from './edit-texts';

export const EDIT_DE: Translation<typeof EDIT_EN> = {
  reasons: {
    noTable:
      'Zellen lassen sich in einer Tabelle bearbeiten, die aus dem Schema-Baum geöffnet wurde („Daten öffnen“).',
    noSchema: 'Das Schema der Tabelle ist nicht bekannt: Hier lässt sie sich nicht bearbeiten.',
    noKey:
      'Die Tabelle hat keinen Primärschlüssel: Ihre Zeilen lassen sich nicht unterscheiden, also nur lesen.',
    keyMissing: 'Der Primärschlüssel ist nicht unter den gezeigten Spalten: nur lesen.',
    readonly: 'Diese Verbindung liest nur.',
    unknown: 'Die Spalten der Tabelle werden noch gelesen.',
    local:
      'Erst die lokale Sortierung und den lokalen Filter zurücksetzen: Bearbeitet wird, wo die Tabelle steht.',
    running: 'Die Zeilen werden noch gelesen.',
  },
  noCell: 'Erst eine Zelle wählen.',
  noRowKey: 'Der Schlüssel dieser Zeile ist NULL: Sie lässt sich nicht bearbeiten.',
  tooBig: 'Dieser Wert ist zu groß, um ihn hier zu bearbeiten.',
  binary: 'Binärdaten lassen sich hier nicht bearbeiten.',
  bar: 'Zelle bearbeiten',
  where: (row, column) => `Zeile ${row} · ${column}`,
  value: 'Neuer Wert',
  setNull: 'NULL',
  setNullHint: 'Zelle auf NULL setzen',
  setDefault: 'Default',
  setDefaultHint: 'Zelle auf den Default ihrer Spalte setzen',
  take: 'OK',
  cancel: 'Abbrechen',
  problems: {
    notNull: 'Die Spalte nimmt kein NULL.',
    number: 'Keine Zahl.',
    integer: 'Keine ganze Zahl.',
    bool: 'true oder false.',
    json: 'Kein gültiges JSON.',
    tooLong: (max) => `Länger als die ${max} Zeichen, die die Spalte nimmt.`,
    date: 'Ein Datum schreibt sich 2026-11-11.',
  },
  pending: (cells, rows) =>
    `${cells === 1 ? '1 Änderung' : `${cells} Änderungen`} in ${rows === 1 ? '1 Zeile' : `${rows} Zeilen`}, nicht geschrieben`,
  preview: 'Vorschau',
  write: 'Schreiben',
  discard: 'Verwerfen',
  undo: 'Rückgängig',
  redo: 'Wiederholen',
  nothing: 'Es gibt keine Änderungen zu schreiben.',
  tooMany: (max) => `Mehr als ${max} geänderte Zeilen: in Teilen schreiben.`,
  written: (rows) => (rows === 1 ? '1 Zeile geschrieben.' : `${rows} Zeilen geschrieben.`),
  conflict: (row) =>
    `Zeile ${row} wurde inzwischen von jemand anderem geändert (oder ist weg). Nichts wurde geschrieben.`,
  conflictSome:
    'Eine Zeile wurde inzwischen von jemand anderem geändert (oder ist weg). Nichts wurde geschrieben.',
  failed: (row, why) => `Zeile ${row}: ${why} Nichts wurde geschrieben.`,
  notWritten: (why) => `Nichts wurde geschrieben: ${why}`,
  txOpen: 'In diesem Tab ist eine Transaktion offen: erst Commit oder Rollback.',
  unknownOutcome:
    'Die Verbindung ging beim Commit verloren: Ob die Zeilen geschrieben sind, ist nicht bekannt. Die Tabelle neu lesen und nachsehen.',
  stale:
    'Diese Änderungen wurden in einer anderen Tabelle, Verbindung oder einem anderen Ergebnis gemacht, als der Tab jetzt zeigt (andere Tabelle). Sie lassen sich nur verwerfen.',
  staleCell: 'Die Zeilen wurden neu gelesen, seit diese Zelle geöffnet wurde: noch einmal öffnen.',
  busy: 'Die Änderungen werden gerade geschrieben.',
  blocksSwitch:
    'Änderungen sind noch nicht geschrieben: erst schreiben oder verwerfen, bevor der Tab die Verbindung wechselt.',
  previewTitle: (rows) =>
    rows === 1 ? '1 Anweisung wird geschrieben' : `${rows} Anweisungen werden geschrieben`,
  previewNote:
    'Gezeigt mit ausgeschriebenen Werten; gesendet werden sie gebunden. Alles in einer Transaktion: alles oder nichts.',
  locked: 'Eine Zeile, die inzwischen jemand anderes geändert hat, wird nicht überschrieben.',
  unlocked:
    'Zeilen werden nur über ihren Schlüssel gefunden: Eine Änderung von jemand anderem wird überschrieben.',
  close: 'Schließen',
  discardTitle: 'Änderungen verwerfen?',
  discardMessage: (cells) =>
    cells === 1
      ? 'Eine geänderte Zelle ist nicht geschrieben. Sie geht verloren, wenn du weitermachst.'
      : `${cells} geänderte Zellen sind nicht geschrieben. Sie gehen verloren, wenn du weitermachst.`,
  discardYes: 'Verwerfen',
  marked: { null: 'NULL', default: 'DEFAULT' },
};
