import { ColumnInfo } from '../../core/schema/schema.models';
import {
  Cell,
  ColKind,
  EditCell,
  QueryColumn,
  RowUpdate,
  UpdatePlan,
} from '../../core/sql/query.models';

/**
 * The changes to the cells of a table that are not written yet (prompt 031) – pure logic. Nothing goes
 * to the database while the user edits: the changes are collected here, each with the row as it was read,
 * can be undone step by step, and become one `UPDATE` per row when they are written. A row is known by
 * its key, not by where it stands. No SQL is written here: a plan names cells and values, the backend
 * builds the statements and binds every value (`db/edit.rs`).
 */

/** What a cell becomes. */
export type NewValue =
  | { readonly kind: 'value'; readonly text: string }
  | { readonly kind: 'null' }
  | { readonly kind: 'default' };

/** The changes of one row. */
export interface RowEdit {
  /** Where the row stood in the result when it was edited (for marking it). */
  readonly row: number;
  /** The cells of the row as they were read. */
  readonly original: readonly Cell[];
  /** By index of the result column. */
  readonly cells: Readonly<Record<number, NewValue>>;
}

/** One change of one cell, as undo and redo see it. */
interface Step {
  readonly key: string;
  readonly row: number;
  readonly original: readonly Cell[];
  readonly column: number;
  readonly before: NewValue | null;
  readonly after: NewValue | null;
}

export interface EditBuffer {
  /** By key of the row (`rowKey`). */
  readonly rows: Readonly<Record<string, RowEdit>>;
  readonly undo: readonly Step[];
  readonly redo: readonly Step[];
  /** The row whose statement stopped the last writing, to mark it. */
  readonly failed: string | null;
}

export const EMPTY_BUFFER: EditBuffer = { rows: {}, undo: [], redo: [], failed: null };
/** Steps kept for undo. */
export const MAX_UNDO = 500;
/** Rows written at once at most (`MAX_UPDATE_ROWS` in edit.rs). */
export const MAX_EDIT_ROWS = 1000;
/** A text this long may be cut in the row the window has: it is no value to lock on. */
const CUT_FROM = 1000;

const keyText = (cell: Cell | undefined): string | null =>
  cell === null || cell === undefined || typeof cell === 'object' ? null : String(cell);

/** What identifies a row: the values of its key; `null` if a part of the key is NULL or no plain value. */
export function rowKey(cells: readonly Cell[], pk: readonly number[]): string | null {
  const values = pk.map((i) => keyText(cells[i]));
  return pk.length > 0 && values.every((v) => v !== null) ? JSON.stringify(values) : null;
}

/** Whether a new value is what the cell holds anyway. */
function unchanged(value: NewValue, original: Cell | undefined): boolean {
  if (value.kind === 'null') return original === null;
  if (value.kind === 'default') return false;
  const text = keyText(original);
  // a long text may be cut in the row: it is never „the same“
  return text !== null && text.length < CUT_FROM && text === value.text;
}

function put(buffer: EditBuffer, step: Step, value: NewValue | null): EditBuffer['rows'] {
  const rows = { ...buffer.rows };
  const have = rows[step.key];
  const cells = { ...(have?.cells ?? {}) };
  if (value === null) delete cells[step.column];
  else cells[step.column] = value;
  if (Object.keys(cells).length === 0) delete rows[step.key];
  else rows[step.key] = { row: step.row, original: have?.original ?? step.original, cells };
  return rows;
}

/**
 * Changes a cell. A value that is what the cell holds takes the change away. `original`: the row as the
 * result has it.
 */
export function setCell(
  buffer: EditBuffer,
  key: string,
  row: number,
  original: readonly Cell[],
  column: number,
  value: NewValue | null,
): EditBuffer {
  const base = buffer.rows[key]?.original ?? original;
  const after = value !== null && unchanged(value, base[column]) ? null : value;
  const before = buffer.rows[key]?.cells[column] ?? null;
  if (JSON.stringify(before) === JSON.stringify(after)) return buffer;
  const step: Step = { key, row, original: base, column, before, after };
  return {
    rows: put(buffer, step, after),
    undo: [...buffer.undo, step].slice(-MAX_UNDO),
    redo: [],
    failed: buffer.failed === key ? null : buffer.failed,
  };
}

export function undoEdit(buffer: EditBuffer): EditBuffer {
  const step = buffer.undo.at(-1);
  if (!step) return buffer;
  return {
    ...buffer,
    rows: put(buffer, step, step.before),
    undo: buffer.undo.slice(0, -1),
    redo: [...buffer.redo, step],
  };
}

export function redoEdit(buffer: EditBuffer): EditBuffer {
  const step = buffer.redo.at(-1);
  if (!step) return buffer;
  return {
    ...buffer,
    rows: put(buffer, step, step.after),
    undo: [...buffer.undo, step],
    redo: buffer.redo.slice(0, -1),
  };
}

/** Takes the changes of a row back (each cell a step that can be undone). */
export function resetRow(buffer: EditBuffer, key: string): EditBuffer {
  const have = buffer.rows[key];
  if (!have) return buffer;
  return Object.keys(have.cells).reduce(
    (b, column) => setCell(b, key, have.row, have.original, Number(column), null),
    buffer,
  );
}

/** How many cells are changed, in how many rows. */
export function editCount(buffer: EditBuffer): { cells: number; rows: number } {
  const rows = Object.values(buffer.rows);
  return { rows: rows.length, cells: rows.reduce((n, r) => n + Object.keys(r.cells).length, 0) };
}

/** For the grid: what a cell shows instead of what was read. */
export interface EditMarks {
  at(row: number, column: number): NewValue | null;
  /** The row whose statement failed. */
  failed(row: number): boolean;
}

export function marksOf(buffer: EditBuffer): EditMarks | null {
  const entries = Object.entries(buffer.rows);
  if (entries.length === 0) return null;
  const byRow = new Map(entries.map(([key, edit]) => [edit.row, { key, edit }]));
  return {
    at: (row, column) => byRow.get(row)?.edit.cells[column] ?? null,
    failed: (row) => buffer.failed !== null && byRow.get(row)?.key === buffer.failed,
  };
}

export const valueKind = (kind: ColKind): 'number' | 'bool' | 'text' =>
  kind === 'int' || kind === 'float' || kind === 'decimal'
    ? 'number'
    : kind === 'bool'
      ? 'bool'
      : 'text';

function editCell(column: QueryColumn, value: string | null): EditCell {
  return { column: column.name, kind: valueKind(column.kind), typeName: column.typeName, value };
}

/**
 * The plan for writing the buffer: one row each, found by its key. With `lock`, the values the changed
 * cells had when they were read must still be there – except where equality is no test: floating point
 * numbers, binary data, and texts so long that the row may hold them cut.
 */
export function planOf(
  buffer: EditBuffer,
  columns: readonly QueryColumn[],
  pk: readonly number[],
  lock: boolean,
  schema: string | null,
  table: string,
): { plan: UpdatePlan; keys: string[] } {
  const keys = Object.keys(buffer.rows).sort((a, b) => buffer.rows[a].row - buffer.rows[b].row);
  const rows = keys.map((key): RowUpdate => {
    const edit = buffer.rows[key];
    const changed = Object.keys(edit.cells)
      .map(Number)
      .sort((a, b) => a - b);
    const lockable = (c: number) => {
      const cell = edit.original[c];
      if (columns[c].kind === 'float') return false;
      if (cell !== null && typeof cell === 'object') return false;
      return !(typeof cell === 'string' && cell.length >= CUT_FROM);
    };
    return {
      key: pk.map((c) => editCell(columns[c], keyText(edit.original[c]))),
      set: changed.map((c) => {
        const value = edit.cells[c];
        return {
          ...editCell(columns[c], value.kind === 'value' ? value.text : null),
          default: value.kind === 'default',
        };
      }),
      expect: lock
        ? changed.filter(lockable).map((c) => editCell(columns[c], keyText(edit.original[c])))
        : [],
    };
  });
  return { plan: { schema, table, rows }, keys };
}

// --- may this be edited, and is this a value? ---------------------------------------------------------

/** Why a result cannot be edited. */
export type ReadOnlyReason =
  'noTable' | 'noSchema' | 'noKey' | 'keyMissing' | 'readonly' | 'unknown';

/** The columns of the result that make up the primary key of the table, or why there is no editing. */
export function editability(
  isTable: boolean,
  hasSchema: boolean,
  info: readonly ColumnInfo[] | undefined,
  columns: readonly QueryColumn[],
  readOnlyConnection: boolean,
): { readonly pk: readonly number[] } | { readonly reason: ReadOnlyReason } {
  if (!isTable) return { reason: 'noTable' };
  if (readOnlyConnection) return { reason: 'readonly' };
  if (!hasSchema) return { reason: 'noSchema' };
  if (!info) return { reason: 'unknown' };
  const key = info.filter((c) => c.key === 'pk').map((c) => c.name);
  if (key.length === 0) return { reason: 'noKey' };
  const pk = key.map((name) => columns.findIndex((c) => c.name === name));
  return pk.some((i) => i < 0) ? { reason: 'keyMissing' } : { pk };
}

/** What is wrong about a value for a column; `null` if nothing is. */
export type ValueProblem = 'notNull' | 'number' | 'integer' | 'bool' | 'json' | 'tooLong' | 'date';

const BOOLS = new Set(['true', 'false', 't', 'f', '1', '0', 'yes', 'no']);

/** The length a type allows (`varchar(40)`), if it says one. */
export function maxLength(typeName: string): number | null {
  const m = /^\s*(?:n?var)?char(?:acter)?(?:\s+varying)?\s*\(\s*(\d+)\s*\)/i.exec(typeName);
  return m ? Number(m[1]) : null;
}

/**
 * Checks a value before it goes into the buffer: its kind, its length, NULL where the column takes none.
 * The database has the last word; this only catches what is certainly wrong.
 */
export function validate(
  value: NewValue,
  column: QueryColumn,
  info: ColumnInfo | undefined,
): ValueProblem | null {
  if (value.kind === 'default') return null;
  if (value.kind === 'null') return info && !info.nullable ? 'notNull' : null;
  const text = value.text;
  const t = text.trim();
  switch (column.kind) {
    case 'int':
      return /^[+-]?\d+$/.test(t) ? null : 'integer';
    case 'float':
    case 'decimal':
      return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ||
        (column.kind === 'float' && /^[+-]?(nan|inf(inity)?)$/i.test(t))
        ? null
        : 'number';
    case 'bool':
      return BOOLS.has(t.toLowerCase()) ? null : 'bool';
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(t) ? null : 'date';
    default:
      break;
  }
  if (/^jsonb?$/i.test(column.typeName.trim())) {
    try {
      JSON.parse(text);
    } catch {
      return 'json';
    }
    return null;
  }
  const max = maxLength(column.typeName);
  return max !== null && [...text].length > max ? 'tooLong' : null;
}

/** The text an editor starts with for a cell (a change of the buffer first). */
export function startText(cell: Cell | undefined, edit: NewValue | null): string {
  if (edit) return edit.kind === 'value' ? edit.text : '';
  return keyText(cell) ?? '';
}
