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
  pending: (cells, rows, inserts, deletes) =>
    `${[
      cells > 0
        ? `${cells === 1 ? '1 Änderung' : `${cells} Änderungen`} in ${rows === 1 ? '1 Zeile' : `${rows} Zeilen`}`
        : '',
      inserts > 0 ? (inserts === 1 ? '1 neue Zeile' : `${inserts} neue Zeilen`) : '',
      deletes > 0 ? (deletes === 1 ? '1 Zeile zu löschen' : `${deletes} Zeilen zu löschen`) : '',
    ]
      .filter(Boolean)
      .join(', ')} – nicht geschrieben`,
  preview: 'Vorschau',
  write: 'Schreiben',
  discard: 'Verwerfen',
  undo: 'Rückgängig',
  redo: 'Wiederholen',
  nothing: 'Es gibt keine Änderungen zu schreiben.',
  tooMany: (max) => `Mehr als ${max} geänderte Zeilen: in Teilen schreiben.`,
  written: (rows) => (rows === 1 ? '1 Zeile geschrieben.' : `${rows} Zeilen geschrieben.`),
  conflict: (what) =>
    `${what} wurde inzwischen von jemand anderem geändert (oder ist weg). Nichts wurde geschrieben.`,
  conflictSome:
    'Eine Zeile wurde inzwischen von jemand anderem geändert (oder ist weg). Nichts wurde geschrieben.',
  failed: (what, why) => `${what}: ${why} Nichts wurde geschrieben.`,
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
  rowN: (n) => `Zeile ${n}`,
  newRowN: (n) => `Neue Zeile ${n}`,
  rowDeleted:
    'Diese Zeile ist zum Löschen vorgemerkt: erst die Marke wegnehmen, um sie zu bearbeiten.',
  tooManyRows: (max) => `Mehr als ${max} Zeilen markiert.`,
  duplicated: (n) =>
    n === 1 ? '1 Zeile als neue Zeile dupliziert.' : `${n} Zeilen als neue Zeilen dupliziert.`,
  nothingToPaste: 'In der Zwischenablage ist kein Text.',
  nothingToFill:
    'Zellen von zwei oder mehr Zeilen markieren: Der Wert der obersten Zelle füllt die darunter.',
  pasteTitle: 'Block einfügen?',
  pasteQuestion: (rows, columns, over, added) =>
    `${rows} Zeilen mit je ${columns} ${columns === 1 ? 'Zelle' : 'Zellen'}: ${over} vorhandene ${over === 1 ? 'Zeile wird' : 'Zeilen werden'} überschrieben, ${added} neue ${added === 1 ? 'Zeile kommt' : 'Zeilen kommen'} hinzu. Geschrieben wird noch nichts.`,
  pasteYes: 'Einfügen',
  pasted: (cells, added, invalid, skipped, cut) =>
    [
      `${cells} Zellen eingefügt`,
      added > 0 ? `${added} neue Zeilen` : '',
      invalid > 0
        ? `${invalid} Zellen halten einen Wert, den ihre Spalte nicht nimmt (markiert)`
        : '',
      skipped > 0 ? `${skipped} Zeilen ohne Schlüssel ausgelassen` : '',
      cut ? 'der Block war länger, als auf einmal genommen wird' : '',
    ]
      .filter(Boolean)
      .join('; ') + '.',
  invalidCells: (n) =>
    n === 1
      ? 'Eine Zelle hält einen Wert, den ihre Spalte nicht nimmt (markiert). Erst richtigstellen.'
      : `${n} Zellen halten einen Wert, den ihre Spalte nicht nimmt (markiert). Erst richtigstellen.`,
  writtenAll: (deleted, changed, inserted, keys) =>
    [
      deleted > 0 ? `${deleted} gelöscht` : '',
      changed > 0 ? `${changed} geändert` : '',
      inserted > 0 ? `${inserted} eingefügt` : '',
    ]
      .filter(Boolean)
      .join(', ') +
    ' – geschrieben.' +
    (keys.length > 0 ? ` Neue Schlüssel: ${keys.join(', ')}.` : ''),
  previewCounts: (deleted, changed, inserted) =>
    `Zeilen zu löschen: ${deleted} · zu ändern: ${changed} · einzufügen: ${inserted}. In dieser Reihenfolge.`,
  addRow: 'Neue Zeile',
  marked: { null: 'NULL', default: 'DEFAULT' },
};
