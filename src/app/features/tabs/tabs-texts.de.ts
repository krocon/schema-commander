import type { Translation } from '../../core/i18n/i18n';
import type { TABS_EN } from './tabs-texts';

export const TABS_DE: Translation<typeof TABS_EN> = {
  errorCode: 'Code',
  errorDetail: 'Detail',
  errorHint: 'Hinweis',
  errorContext: 'Kontext',
  errorObject: 'Objekt',
  errorGoTo: 'Zur Stelle',
  errorCopy: 'Meldung kopieren',
  errorShowTable: (table) => `Details zu ${table}`,
  editorLabel: (title) => `SQL-Editor: ${title}`,
  loadingText: 'Text wird geladen …',
  resultWidth: 'Breite des Ergebnisbereichs',
  resultHeight: 'Höhe des Ergebnisbereichs',
  result: 'Ergebnis',
  results: 'Ergebnisse',
  messages: 'Meldungen',
  compareTitle: (left, right) => `${left} ↔ ${right}`,
  pinResult: 'Anpinnen: dieses Ergebnis behalten, wenn der nächste Lauf beginnt',
  unpinResult: 'Lösen: dieses Ergebnis geht mit dem nächsten Lauf',
  closeResult: 'Dieses Ergebnis schließen',
  renameResult: 'Name des Ergebnisses',
  renameHint: 'Doppelklick oder F2 benennt um',
  pinnedMark: 'angepinnt',
  compareMark: 'Vergleich',
  keptUsage: (results, size) =>
    results === 1 ? `1 gehaltenes Ergebnis · ${size}` : `${results} gehaltene Ergebnisse · ${size}`,
  releaseKept: 'Gehaltene Ergebnisse schließen',
  releaseKeptHint: 'Schließt alle gehaltenen Ergebnisse dieses Tabs und gibt ihren Speicher frei',
  noMessages: 'Noch keine Meldungen.',
  runningNow: 'Läuft …',
  cancelledNow: 'Abgebrochen.',
  noResult: 'Noch kein Ergebnis.',

  rows: (n, rows) => (n === 1 ? `${rows} Zeile` : `${rows} Zeilen`),
  rowsChanged: (n, rows) => (n === 1 ? `${rows} Zeile geändert` : `${rows} Zeilen geändert`),
  truncated: ' (abgeschnitten)',
  error: 'Fehler',
  cancelled: 'Abgebrochen',
  notRun: 'Nicht ausgeführt',
  ready: 'Bereit',
  resultNotKept: (rows, kept) =>
    `Dieses Ergebnis (${rows} Zeilen) wurde nicht behalten: Ein Lauf behält die ersten ${kept} Ergebnisse. Die Anweisung einzeln ausführen zeigt es.`,
  position: (at, total) => ` (${at} von ${total})`,
  rowsRead: (rows) => ` · ${rows} Zeilen gelesen`,
  statements: (n) => `${n} Anweisungen`,
  executed: (n) => `${n} ausgeführt`,
  withError: (n) => `${n} mit Fehler`,
  someCancelled: (n) => `${n} abgebrochen`,
  someNotRun: (n) => `${n} nicht ausgeführt`,

  txUnknown: 'Transaktion: Zustand unbekannt (der Server gab keine Auskunft)',
  txFailed: (lasted) => `Transaktion fehlgeschlagen – nur Rollback möglich (offen seit ${lasted})`,
  txOpen: (lasted, statements, holdsLocks) =>
    `Transaktion offen seit ${lasted} · ${statements === 1 ? '1 Anweisung' : `${statements} Anweisungen`}${holdsLocks ? ' – sie hält Sperren' : ''}`,
  closeQuestion: (what, tabs) =>
    `${what} hat ${tabs === 1 ? 'eine offene Transaktion' : `${tabs} Tabs mit offener Transaktion`}. Was nicht mit Commit bestätigt wird, geht verloren.`,
  theTab: (title) => `Der Tab „${title}“`,
  openTransaction: 'Offene Transaktion',
  commit: 'Commit',
  rollback: 'Rollback',
  txNotEnded: (problem) => `Die Transaktion ließ sich nicht beenden: ${problem}`,
  txBlocksSwitch:
    'Dieser Tab hat eine offene Transaktion: erst Commit oder Rollback, dann die Verbindung wechseln.',
  connectionLostInTx:
    'Die Verbindung ging mitten in einer Transaktion verloren. Was nicht bestätigt war, ist zurückgerollt oder sein Stand unbekannt – bitte prüfen.',
  txCommitted: 'Transaktion bestätigt',
  txRolledBack: 'Transaktion zurückgerollt',

  untitled: 'Abfrage',
  utf8WithBom: 'UTF-8 mit BOM',
  allFiles: 'Alle Dateien',
  openSqlFile: 'SQL-Datei öffnen',
  saveSqlFile: 'SQL-Datei speichern',
  savedAsUtf8: (file) =>
    `${file} wurde als UTF-8 gespeichert: Die bisherige Kodierung kann nicht alle Zeichen des Textes darstellen.`,
};
