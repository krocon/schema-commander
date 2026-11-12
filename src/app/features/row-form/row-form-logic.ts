import { Cell, QueryColumn } from '../../core/sql/query.models';
import { NewValue } from '../edit/edit-buffer';
import { CellFormat, ShownCell, showCell } from '../results/cell-format';

/**
 * Pure logic of the row form (prompt 040): one row as fields „name – value“, rows side by side with
 * what differs between them, and the row as text.
 */

/** Rows that are laid side by side at most. */
export const MAX_COMPARED = 8;
/** Characters of a value from which the form offers „more“ (the value panel shows all of it). */
export const LONG_FROM = 300;

export interface FormField {
  /** The column of the result. */
  readonly index: number;
  readonly name: string;
  readonly typeName: string;
  readonly shown: ShownCell;
  readonly isNull: boolean;
  /** The value is waiting in the edit buffer. */
  readonly changed: boolean;
  /** Longer than the form shows at once. */
  readonly long: boolean;
}

const NO_FORMAT: CellFormat = { groupDigits: false };

/** A value of the edit buffer as the form shows it. */
function shownNew(value: NewValue, format: CellFormat): ShownCell {
  if (value.kind === 'null') return { text: format.nullText ?? 'NULL', cls: 'sc-null' };
  if (value.kind === 'default') return { text: 'DEFAULT', cls: 'sc-null' };
  return { text: value.text, cls: '' as ShownCell['cls'] };
}

/** The fields of a row; `changedAt` gives what the edit buffer holds for a column. */
export function formFields(
  columns: readonly QueryColumn[],
  row: readonly Cell[] | null,
  changedAt: (column: number) => NewValue | null = () => null,
  format: CellFormat = NO_FORMAT,
): FormField[] {
  if (!row) return [];
  return columns.map((column, index) => {
    const cell = row[index] ?? null;
    const change = changedAt(index);
    const shown = change ? shownNew(change, format) : showCell(cell, column.kind, format);
    return {
      index,
      name: column.name,
      typeName: column.typeName,
      shown,
      isNull: change ? change.kind === 'null' : cell === null,
      changed: change !== null,
      long: shown.text.length >= LONG_FROM,
    };
  });
}

export interface FieldFilter {
  /** Part of a column's name, whatever its case. */
  readonly text: string;
  readonly nonNull: boolean;
  readonly changed: boolean;
}

export const NO_FILTER: FieldFilter = { text: '', nonNull: false, changed: false };

export function filterFields<T extends { name: string }>(
  fields: readonly T[],
  filter: FieldFilter,
  is: (field: T) => { isNull: boolean; changed: boolean },
): T[] {
  const text = filter.text.trim().toLowerCase();
  return fields.filter((f) => {
    const state = is(f);
    return (
      (text === '' || f.name.toLowerCase().includes(text)) &&
      (!filter.nonNull || !state.isNull) &&
      (!filter.changed || state.changed)
    );
  });
}

/** One column of the result across the rows that are compared. */
export interface ComparedField {
  readonly index: number;
  readonly name: string;
  readonly typeName: string;
  readonly values: readonly ShownCell[];
  /** Not every row has the same value here. */
  readonly differs: boolean;
  readonly isNull: boolean;
}

const same = (a: Cell, b: Cell): boolean =>
  a === b ||
  (a !== null && b !== null && typeof a === 'object' && JSON.stringify(a) === JSON.stringify(b));

/** Rows as columns: a line per column of the result, a value per row. */
export function transposed(
  columns: readonly QueryColumn[],
  rows: readonly (readonly Cell[])[],
  format: CellFormat = NO_FORMAT,
): ComparedField[] {
  return columns.map((column, index) => {
    const cells = rows.map((r) => r[index] ?? null);
    return {
      index,
      name: column.name,
      typeName: column.typeName,
      values: cells.map((c) => showCell(c, column.kind, format)),
      differs: cells.some((c) => !same(c, cells[0])),
      isNull: cells.every((c) => c === null),
    };
  });
}

/** The first rows of a selection, in their order, without repeats. */
export function selectedRows(
  ranges: readonly (readonly [number, number])[],
  max = MAX_COMPARED,
): number[] {
  const out: number[] = [];
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    for (let row = from; row <= to && out.length < max; row++) {
      if (!out.includes(row)) out.push(row);
    }
  }
  return out;
}

/** A value as plain text for the clipboard: what is in the cell, not how it is drawn. */
function plain(cell: Cell): string {
  if (cell === null) return 'NULL';
  if (typeof cell === 'object') return 'hex' in cell ? `0x${cell.hex}` : cell.unreadable;
  return String(cell);
}

/** The row as lines „name: value“. */
export function rowAsList(columns: readonly QueryColumn[], row: readonly Cell[]): string {
  return `${columns.map((c, i) => `${c.name}: ${plain(row[i] ?? null)}`).join('\n')}\n`;
}

/**
 * The row as a JSON object. Numbers the grid holds as text (exact decimals, large integers) stay text
 * there – as a JSON number they would lose digits.
 */
export function rowAsJson(columns: readonly QueryColumn[], row: readonly Cell[]): string {
  const object: Record<string, unknown> = {};
  columns.forEach((c, i) => {
    const cell = row[i] ?? null;
    // two columns of one name: the later ones get a number, nothing is lost
    let key = c.name;
    for (let n = 2; key in object; n++) key = `${c.name}_${n}`;
    object[key] = cell !== null && typeof cell === 'object' ? plain(cell) : cell;
  });
  return `${JSON.stringify(object, null, 2)}\n`;
}

/** The row a step leads to, kept inside the result. */
export function stepRow(
  row: number,
  step: 'first' | 'prev' | 'next' | 'last',
  rows: number,
): number {
  if (rows <= 0) return 0;
  const to =
    step === 'first' ? 0 : step === 'last' ? rows - 1 : step === 'prev' ? row - 1 : row + 1;
  return Math.min(rows - 1, Math.max(0, to));
}

/** What was typed as a row number (from 1) as a row; `null`: no such row. */
export function rowFromText(text: string, rows: number): number | null {
  const n = Number(text.trim().replace(/[\s.,_']/g, ''));
  return Number.isInteger(n) && n >= 1 && n <= rows ? n - 1 : null;
}
