import { translatable } from '../../core/i18n/i18n';
import { TRANSFER_DE } from './transfer-texts.de';

/** Texts of copying tables between connections (prompt 045). English is the source. */
export const TRANSFER_EN = {
  title: 'Copy tables to another connection',
  source: 'From',
  sourceOf: (connection: string, schema: string) => `${connection} · ${schema}`,
  tables: 'Tables',
  loadingTables: 'Reading the tables …',
  all: 'All',
  none: 'None',
  target: 'To',
  targetConnection: 'Connection',
  noConnection: '(choose a connection that is connected)',
  targetSchema: 'Schema',
  options: 'Options',
  modes: {
    append: 'Add the rows to a table that is there',
    clear: 'Empty a table that is there first',
  },
  withKeys: 'Create the indexes and foreign keys of new tables, after the rows',
  wholeTransaction: 'Each table in one transaction: all its rows or none',
  onErrors: {
    abort: 'A row that fails ends the transfer',
    skip: 'A row that fails is left out and noted in a file',
  },
  preview: 'Show what will happen',
  back: 'Back',
  problems: {
    noTarget: 'Choose where the tables go: a connection that is connected.',
    noTables: 'Choose at least one table.',
    noSchema: 'Name the schema of the target.',
    sameTable: 'Source and target are the same schema: a table cannot be copied into itself.',
  },
  plan: 'What will happen',
  table: 'Table',
  inTarget: 'In the target',
  created: 'is created',
  exists: 'is there',
  columnsHead: 'Columns',
  columnsCopied: (copied: number, of: number) => `${copied} of ${of}`,
  leftOut: (names: string) => `Not in the target, left out: ${names}`,
  losses: 'What gets lost',
  noLosses: 'Nothing is lost by the types.',
  lossLine: (table: string, column: string, from: string, to: string) =>
    `${table}.${column} (${from} → ${to})`,
  cycle: (names: string) =>
    `These tables point to each other in a circle and are copied in the order given: ${names}. With foreign keys in the target, rows may be refused.`,
  statements: (n: number) =>
    n === 1 ? '1 statement in the target' : `${n} statements in the target`,
  run: 'Copy',
  running: 'Copying …',
  progress: (table: string, index: number, of: number, rows: string) =>
    `Table ${index} of ${of}: ${table} – ${rows} rows read`,
  stop: 'Stop',
  errorFileTitle: 'File for rows that are left out',
  report: 'Result',
  outcomes: {
    done: 'copied',
    skipped: 'not begun',
    failed: 'failed',
    stopped: 'stopped',
    withGaps: 'copied, rows left out',
  },
  rows: 'Rows',
  rowsOf: (written: string, read: string) => `${written} of ${read}`,
  time: 'Time',
  rolledBack: 'nothing of it stays',
  partly: 'what was written before stays',
  createdStays: 'the table was created and is there',
  clearedStays: 'the table was emptied before: its old rows are gone',
  errorFile: 'see the error file',
  afterErrors: 'Indexes and keys that could not be created:',
  allDone: (rows: string) => `Done: ${rows} rows copied.`,
  notAllDone: 'Not everything was copied: see the table.',
  cancel: 'Cancel',
  close: 'Close',
};

export type TransferTexts = typeof TRANSFER_EN;
export const TRANSFER_TEXTS = translatable('transfer', TRANSFER_EN, { de: TRANSFER_DE });
