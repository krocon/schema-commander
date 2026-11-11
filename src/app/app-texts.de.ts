import type { Translation } from './core/i18n/i18n';
import type { APP_EN } from './app-texts';

export const APP_DE: Translation<typeof APP_EN> = {
  noStar:
    'Kein * an der Stelle des Cursors, oder die Spalten seiner Tabellen sind nicht bekannt (ist die Verbindung offen?).',
  toolbar: 'Werkzeugleiste',
  toggleSidebar: 'Seitenleiste ein-/ausblenden',
  runHint: 'Auswahl oder Anweisung unter dem Cursor ausführen',
  run: 'Ausführen',
  runScriptHint: 'Ganzes Skript ausführen',
  script: 'Skript',
  cancelHint: 'Laufende Anweisung abbrechen',
  manualCommitHint: 'Manueller Commit: Änderungen bleiben offen, bis sie bestätigt werden',
  autoCommitHint: 'Auto-Commit: jede Anweisung gilt sofort',
  txManual: 'Tx: manuell',
  txAuto: 'Tx: auto',
  commitHint: 'Transaktion bestätigen',
  commit: 'Commit',
  rollbackHint: 'Transaktion zurückrollen',
  rollback: 'Rollback',
  notConnected: 'nicht verbunden',
  tlsUncheckedHint: 'Das Zertifikat des Servers wird nicht geprüft',
  tlsUnchecked: 'TLS ungeprüft',
  palette: 'Befehlspalette',
  colorScheme: 'Farbschema wählen',
  sidebar: 'Seitenleiste',
  sidebarView: 'Ansicht der Seitenleiste',
  databaseHint: 'Verbindungen und Schema',
  database: 'Datenbank',
  historyHint: 'Zuletzt ausgeführte Anweisungen',
  history: 'Verlauf',
  sidebarWidth: 'Breite der Seitenleiste',
  revealExport: 'Im Dateimanager zeigen',
  dismissExport: 'Meldung des Exports schließen',
  caret: (line, column) => `Zeile ${line}, Spalte ${column}`,
  copyAs: 'Kopieren als',
  dropHint: 'SQL-Datei hier ablegen',
  hostKeyTitle: 'Unbekannter SSH-Server',
  hostKeyMessage: (host, keyType, fingerprint) =>
    `${host} zeigt den Schlüssel ${keyType} ${fingerprint}. Stimmt der Fingerabdruck mit dem des Servers überein? Nur dann vertrauen – er wird gemerkt und künftig geprüft.`,
  trust: 'Vertrauen',
  txStillOpen:
    'Die Transaktion ist noch offen: erst Commit oder Rollback, dann zurück zu Auto-Commit.',
  historyConnectionOn: 'Der Verlauf merkt sich die Anweisungen dieser Verbindung wieder.',
  historyConnectionOff: 'Der Verlauf merkt sich keine Anweisungen dieser Verbindung mehr.',
  historyOn: 'Der Verlauf ist eingeschaltet.',
  historyOff: 'Der Verlauf ist ausgeschaltet.',
  confirmDangerousOn: 'Zerstörende Anweisungen fragen wieder überall nach.',
  confirmDangerousOff:
    'Zerstörende Anweisungen fragen auf ungeschützten Verbindungen nicht mehr nach. Geschützte Verbindungen fragen weiter.',
  zen: (zenHint, paletteHint) =>
    `Zen-Modus: nur die Abfragen.${zenHint} beendet ihn, die Befehlspalette${paletteHint} bleibt.`,
  commitFailed: (problem) => `Commit gescheitert: ${problem}`,
  rollbackFailed: (problem) => `Rollback gescheitert: ${problem}`,
  theWindow: 'Das Fenster',
  editorNotEmpty:
    'Der Editor ist nicht leer: Der Verlauf ersetzt keinen geschriebenen Text. Verlauf öffnen fügt ein.',
};
