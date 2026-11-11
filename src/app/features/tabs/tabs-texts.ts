import { translatable } from '../../core/i18n/i18n';
import { TABS_DE } from './tabs-texts.de';

/** Texts of the query tabs: pane, runs, transactions, files (prompts 004, 005, 013). English is the source. */
export const TABS_EN = {
  errorCode: 'Code',
  errorDetail: 'Detail',
  errorHint: 'Hint',
  errorContext: 'Context',
  errorObject: 'Object',
  errorGoTo: 'Go to the place',
  errorCopy: 'Copy the message',
  errorShowTable: (table: string) => `Details of ${table}`,
  // the pane of a tab
  editorLabel: (title: string) => `SQL editor: ${title}`,
  loadingText: 'Loading the text …',
  resultWidth: 'Width of the result area',
  resultHeight: 'Height of the result area',
  result: 'Result',
  results: 'Results',
  messages: 'Messages',
  noMessages: 'No messages yet.',
  runningNow: 'Running …',
  cancelledNow: 'Cancelled.',
  noResult: 'No result yet.',

  // runs
  /** `rows`: the number as it is shown (digits in groups). */
  rows: (n: number, rows: string) => (n === 1 ? `${rows} row` : `${rows} rows`),
  rowsChanged: (n: number, rows: string) =>
    n === 1 ? `${rows} row changed` : `${rows} rows changed`,
  truncated: ' (truncated)',
  error: 'Error',
  cancelled: 'Cancelled',
  notRun: 'Not run',
  ready: 'Ready',
  resultNotKept: (rows: number, kept: number) =>
    `This result (${rows} rows) was not kept: a run keeps the first ${kept} results. Run the statement on its own to see it.`,
  position: (at: number, total: number) => ` (${at} of ${total})`,
  rowsRead: (rows: string) => ` · ${rows} rows read`,
  statements: (n: number) => (n === 1 ? '1 statement' : `${n} statements`),
  executed: (n: number) => `${n} executed`,
  withError: (n: number) => `${n} failed`,
  someCancelled: (n: number) => `${n} cancelled`,
  someNotRun: (n: number) => `${n} not run`,

  // transactions
  txUnknown: 'Transaction: state unknown (the server gave no answer)',
  txFailed: (lasted: string) =>
    `Transaction failed – only a rollback is possible (open for ${lasted})`,
  txOpen: (lasted: string, statements: number, holdsLocks: boolean) =>
    `Transaction open for ${lasted} · ${statements === 1 ? '1 statement' : `${statements} statements`}${holdsLocks ? ' – it holds locks' : ''}`,
  /** `what`: {@link TABS_EN.theTab} or the window. */
  closeQuestion: (what: string, tabs: number) =>
    `${what} has ${tabs === 1 ? 'an open transaction' : `${tabs} tabs with an open transaction`}. What is not committed is lost.`,
  theTab: (title: string) => `The tab “${title}”`,
  openTransaction: 'Open transaction',
  commit: 'Commit',
  rollback: 'Rollback',
  txNotEnded: (problem: string) => `The transaction could not be ended: ${problem}`,
  txBlocksSwitch:
    'This tab has an open transaction: commit or roll back first, then change the connection.',
  connectionLostInTx:
    'The connection was lost in the middle of a transaction. What was not committed is rolled back or its state is unknown – please check.',
  txCommitted: 'Transaction committed',
  txRolledBack: 'Transaction rolled back',

  // titles and files
  untitled: 'Query',
  utf8WithBom: 'UTF-8 with BOM',
  allFiles: 'All files',
  openSqlFile: 'Open SQL file',
  saveSqlFile: 'Save SQL file',
  savedAsUtf8: (file: string) =>
    `${file} was saved as UTF-8: the previous encoding cannot represent every character of the text.`,
};

export const TABS_TEXTS = translatable('tabs', TABS_EN, { de: TABS_DE });
