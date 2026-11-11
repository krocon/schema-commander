import { translatable } from '../../core/i18n/i18n';
import { EDIT_DE } from './edit-texts.de';

/** Texts of editing cells (prompt 031). English is the source. */
export const EDIT_EN = {
  reasons: {
    noTable: 'Cells can be edited in a table opened from the schema tree ("Open data").',
    noSchema: 'The schema of the table is not known: it cannot be edited here.',
    noKey: 'The table has no primary key: its rows cannot be told apart, so it is read only.',
    keyMissing: 'The primary key is not among the columns shown: read only.',
    readonly: 'This connection only reads.',
    unknown: 'The columns of the table are still being read.',
    local: 'Reset the local order and filter first: rows are edited where the table stands.',
    running: 'The rows are still being read.',
  },
  noCell: 'Choose a cell first.',
  noRowKey: 'The key of this row is NULL: it cannot be edited.',
  tooBig: 'This value is too big to edit here.',
  binary: 'Binary data cannot be edited here.',
  bar: 'Edit the cell',
  where: (row: number, column: string) => `Row ${row} · ${column}`,
  value: 'New value',
  setNull: 'NULL',
  setNullHint: 'Set the cell to NULL',
  setDefault: 'Default',
  setDefaultHint: 'Set the cell to the default of its column',
  take: 'OK',
  cancel: 'Cancel',
  problems: {
    notNull: 'The column takes no NULL.',
    number: 'Not a number.',
    integer: 'Not a whole number.',
    bool: 'true or false.',
    json: 'Not valid JSON.',
    tooLong: (max: number) => `Longer than the ${max} characters the column takes.`,
    date: 'A date is written 2026-11-11.',
  },
  pending: (cells: number, rows: number) =>
    `${cells === 1 ? '1 change' : `${cells} changes`} in ${rows === 1 ? '1 row' : `${rows} rows`}, not written`,
  preview: 'Preview',
  write: 'Write',
  discard: 'Discard',
  undo: 'Undo',
  redo: 'Redo',
  nothing: 'There are no changes to write.',
  tooMany: (max: number) => `More than ${max} changed rows: write them in parts.`,
  written: (rows: number) => (rows === 1 ? '1 row written.' : `${rows} rows written.`),
  conflict: (row: number) =>
    `Row ${row} was changed by someone else in the meantime (or is gone). Nothing was written.`,
  failed: (row: number, why: string) => `Row ${row}: ${why} Nothing was written.`,
  notWritten: (why: string) => `Nothing was written: ${why}`,
  txOpen: 'A transaction is open in this tab: commit or roll it back first.',
  previewTitle: (rows: number) =>
    rows === 1 ? '1 statement will be written' : `${rows} statements will be written`,
  previewNote:
    'Shown with the values written out; they are sent bound. All in one transaction: all or none.',
  locked: 'A row somebody else changed in the meantime is not overwritten.',
  unlocked: 'Rows are found by their key only: a change by somebody else is overwritten.',
  close: 'Close',
  discardTitle: 'Discard the changes?',
  discardMessage: (cells: number) =>
    cells === 1
      ? 'One changed cell is not written. It is lost if you go on.'
      : `${cells} changed cells are not written. They are lost if you go on.`,
  discardYes: 'Discard',
  marked: { null: 'NULL', default: 'DEFAULT' },
};

export const EDIT_TEXTS = translatable('edit', EDIT_EN, { de: EDIT_DE });
