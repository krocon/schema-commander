import { translatable } from './core/i18n/i18n';
import { APP_DE } from './app-texts.de';

/** Texts of the window: toolbar, sidebar, status line, notices. English is the source. */
export const APP_EN = {
  noStar:
    'No * to expand at the caret, or the columns of its tables are not known (is the connection open?).',
  toolbar: 'Toolbar',
  toggleSidebar: 'Show or hide the sidebar',
  runHint: 'Run the selection or the statement under the cursor',
  run: 'Run',
  runScriptHint: 'Run the whole script',
  script: 'Script',
  cancelHint: 'Cancel the running statement',
  manualCommitHint: 'Manual commit: changes stay open until they are committed',
  autoCommitHint: 'Auto-commit: every statement takes effect at once',
  txManual: 'Tx: manual',
  txAuto: 'Tx: auto',
  commitHint: 'Commit the transaction',
  commit: 'Commit',
  rollbackHint: 'Roll back the transaction',
  rollback: 'Rollback',
  notConnected: 'not connected',
  tlsUncheckedHint: 'The certificate of the server is not verified',
  tlsUnchecked: 'TLS unverified',
  palette: 'Command palette',
  colorScheme: 'Choose a colour scheme',
  sidebar: 'Sidebar',
  sidebarView: 'View of the sidebar',
  databaseHint: 'Connections and schema',
  database: 'Database',
  historyHint: 'Recently run statements',
  history: 'History',
  savedHint: 'Saved queries',
  saved: 'Saved',
  sidebarWidth: 'Width of the sidebar',
  revealExport: 'Show in the file manager',
  dismissExport: 'Close the message of the export',
  caret: (line: number, column: number) => `Line ${line}, column ${column}`,
  copyAs: 'Copy as',
  dropHint: 'Drop an SQL file here',
  hostKeyTitle: 'Unknown SSH server',
  hostKeyMessage: (host: string, keyType: string, fingerprint: string) =>
    `${host} presents the key ${keyType} ${fingerprint}. Does the fingerprint match that of the server? Trust it only then – it is remembered and checked from now on.`,
  trust: 'Trust',
  txStillOpen:
    'The transaction is still open: commit or roll back first, then switch back to auto-commit.',
  noTransactions: 'This database has no transactions: every statement is kept as it runs.',
  historyConnectionOn: 'The history records the statements of this connection again.',
  historyConnectionOff: 'The history no longer records statements of this connection.',
  historyOn: 'The history is switched on.',
  historyOff: 'The history is switched off.',
  confirmDangerousOn: 'Destructive statements ask for confirmation everywhere again.',
  confirmDangerousOff:
    'Destructive statements no longer ask for confirmation on unprotected connections. Protected connections still ask.',
  /** Both hints are ` (shortcut)` or empty. */
  zen: (zenHint: string, paletteHint: string) =>
    `Zen mode: only the queries.${zenHint} ends it, the command palette${paletteHint} stays.`,
  commitFailed: (problem: string) => `Commit failed: ${problem}`,
  rollbackFailed: (problem: string) => `Rollback failed: ${problem}`,
  /** Subject of the question about open transactions: "The window has …". */
  theWindow: 'The window',
  editorNotEmpty:
    'The editor is not empty: the history does not replace text you have written. Open the history to insert a statement.',
};

export const APP_TEXTS = translatable('app', APP_EN, { de: APP_DE });
