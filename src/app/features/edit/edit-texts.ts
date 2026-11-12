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
    unsupported:
      'Rows of this database are not edited here: it has no transactions and no unique keys to tell rows apart.',
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
  pending: (cells: number, rows: number, inserts: number, deletes: number) =>
    `${[
      cells > 0
        ? `${cells === 1 ? '1 change' : `${cells} changes`} in ${rows === 1 ? '1 row' : `${rows} rows`}`
        : '',
      inserts > 0 ? (inserts === 1 ? '1 new row' : `${inserts} new rows`) : '',
      deletes > 0 ? (deletes === 1 ? '1 row to delete' : `${deletes} rows to delete`) : '',
    ]
      .filter(Boolean)
      .join(', ')} – not written`,
  preview: 'Preview',
  write: 'Write',
  discard: 'Discard',
  undo: 'Undo',
  redo: 'Redo',
  nothing: 'There are no changes to write.',
  tooMany: (max: number) => `More than ${max} changed rows: write them in parts.`,
  written: (rows: number) => (rows === 1 ? '1 row written.' : `${rows} rows written.`),
  conflict: (what: string) =>
    `${what} was changed by someone else in the meantime (or is gone). Nothing was written.`,
  conflictSome:
    'A row was changed by someone else in the meantime (or is gone). Nothing was written.',
  failed: (what: string, why: string) => `${what}: ${why} Nothing was written.`,
  notWritten: (why: string) => `Nothing was written: ${why}`,
  txOpen: 'A transaction is open in this tab: commit or roll it back first.',
  unknownOutcome:
    'The connection was lost while committing: whether the rows are written is not known. Read the table again and look.',
  stale:
    'These changes were made in another table, connection or result than the tab shows now. They can only be discarded.',
  staleCell: 'The rows have been read anew since this cell was opened: open it again.',
  busy: 'The changes are being written.',
  blocksSwitch:
    'Changes are not written yet: write or discard them before the tab changes its connection.',
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
  rowN: (n: number) => `Row ${n}`,
  newRowsSpan: (from: number, to: number) => `New rows ${from}–${to} (one of them)`,
  notOneRow: (what: string) =>
    `${what} did not come out as exactly one row: it was changed or is gone, or a trigger or rule turned the statement away. Nothing was written.`,
  deleteTitle: 'Delete rows?',
  deleteQuestion: (n: number, table: string) =>
    n === 1 ? `1 row of ${table} is deleted.` : `${n} rows of ${table} are deleted.`,
  deleteYes: 'Delete and write',
  newRowN: (n: number) => `New row ${n}`,
  rowDeleted: 'This row is marked to be deleted: take the mark away to edit it.',
  tooManyRows: (max: number) => `More than ${max} rows marked.`,
  duplicated: (n: number) =>
    n === 1 ? '1 row duplicated as a new row.' : `${n} rows duplicated as new rows.`,
  nothingToPaste: 'There is no text on the clipboard.',
  nothingToFill: 'Mark cells of two or more rows: the value of the top cell fills those below.',
  pasteTitle: 'Paste the block?',
  pasteQuestion: (rows: number, columns: number, over: number, added: number) =>
    `${rows} rows of ${columns} ${columns === 1 ? 'cell' : 'cells'}: ${over} existing ${over === 1 ? 'row is' : 'rows are'} overwritten, ${added} new ${added === 1 ? 'row is' : 'rows are'} added. Nothing is written yet.`,
  pasteYes: 'Paste',
  pasted: (cells: number, added: number, invalid: number, skipped: number, cut: boolean) =>
    [
      `${cells} cells pasted`,
      added > 0 ? `${added} new rows` : '',
      invalid > 0 ? `${invalid} cells hold a value their column cannot take (marked)` : '',
      skipped > 0 ? `${skipped} rows without a key left out` : '',
      cut ? 'the block was longer than what is taken at once' : '',
    ]
      .filter(Boolean)
      .join('; ') + '.',
  invalidCells: (n: number) =>
    n === 1
      ? 'One cell holds a value its column cannot take (marked). Put it right first.'
      : `${n} cells hold a value their column cannot take (marked). Put them right first.`,
  writtenAll: (deleted: number, changed: number, inserted: number, keys: readonly string[]) =>
    [
      deleted > 0 ? `${deleted} deleted` : '',
      changed > 0 ? `${changed} changed` : '',
      inserted > 0 ? `${inserted} inserted` : '',
    ]
      .filter(Boolean)
      .join(', ') +
    ' – written.' +
    (keys.length > 0 ? ` New keys: ${keys.join(', ')}.` : ''),
  previewCounts: (deleted: number, changed: number, inserted: number) =>
    `Rows to delete: ${deleted} · to change: ${changed} · to insert: ${inserted}. In this order.`,
  addRow: 'New row',
  marked: { null: 'NULL', default: 'DEFAULT' },
};

export const EDIT_TEXTS = translatable('edit', EDIT_EN, { de: EDIT_DE });
