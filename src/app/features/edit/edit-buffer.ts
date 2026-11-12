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

/** A row that is not in the table yet (prompt 032). A cell without a value gets what the database gives. */
export interface NewRow {
  readonly id: number;
  /** By index of the result column; never `default` (that is a cell without an entry). */
  readonly cells: Readonly<Record<number, NewValue>>;
}

/** A row marked to be deleted. */
export interface RowGone {
  readonly row: number;
  readonly original: readonly Cell[];
}

/** What undo and redo go back to. */
interface Snapshot {
  readonly rows: EditBuffer['rows'];
  readonly inserts: EditBuffer['inserts'];
  readonly deletes: EditBuffer['deletes'];
}

export interface EditBuffer {
  /** Changed cells, by key of the row (`rowKey`). */
  readonly rows: Readonly<Record<string, RowEdit>>;
  /** New rows, in the order they are shown below the rows of the table. */
  readonly inserts: readonly NewRow[];
  /** Rows to delete, by key. */
  readonly deletes: Readonly<Record<string, RowGone>>;
  readonly undo: readonly Snapshot[];
  readonly redo: readonly Snapshot[];
  /** What stopped the last writing, to mark it: the key of a row, or `new:<id>` of a new one. */
  readonly failed: string | null;
  /**
   * Where the rows of the buffer are from: connection, table and result, as one text (`originOf`). Set
   * with the first change. Changes are only ever written where they were made.
   */
  readonly origin: string | null;
  /** The id the next new row gets. */
  readonly nextId: number;
}

export const EMPTY_BUFFER: EditBuffer = {
  rows: {},
  inserts: [],
  deletes: {},
  undo: [],
  redo: [],
  failed: null,
  origin: null,
  nextId: 1,
};

/** What tells where rows are from. */
export function originOf(
  connection: string,
  schema: string | null,
  table: string,
  resultId: number,
): string {
  return JSON.stringify([connection, schema, table, resultId]);
}

/** Steps kept for undo. */
export const MAX_UNDO = 500;
/** Rows written at once at most (`MAX_UPDATE_ROWS` in edit.rs). */
export const MAX_EDIT_ROWS = 20_000;
/** A text this long may be cut in the row the window has: it is no value to lock on. */
const CUT_FROM = 1000;
/** Cells of a row in a statement at most (`MAX_ROW_CELLS`). */
const MAX_ROW_CELLS = 400;

const keyText = (cell: Cell | undefined): string | null =>
  cell === null || cell === undefined || typeof cell === 'object' ? null : String(cell);

/**
 * What identifies a row: the values of its key; `null` if a part of the key is NULL, no plain value, or
 * a text so long that the row may hold it cut (two rows could look the same, and the cut text finds none).
 */
export function rowKey(cells: readonly Cell[], pk: readonly number[]): string | null {
  const values = pk.map((i) => keyText(cells[i]));
  return pk.length > 0 && values.every((v) => v !== null && v.length < CUT_FROM)
    ? JSON.stringify(values)
    : null;
}

/** Whether a new value is what the cell holds anyway. */
function unchanged(value: NewValue, original: Cell | undefined): boolean {
  if (value.kind === 'null') return original === null;
  if (value.kind === 'default') return false;
  const text = keyText(original);
  // a long text may be cut in the row: it is never „the same“
  return text !== null && text.length < CUT_FROM && text === value.text;
}

/** The buffer after a change: what it was goes onto the undo stack, what could be redone is gone. */
function changed(
  buffer: EditBuffer,
  next: Partial<Snapshot>,
  more: Partial<EditBuffer> = {},
): EditBuffer {
  const before: Snapshot = { rows: buffer.rows, inserts: buffer.inserts, deletes: buffer.deletes };
  return {
    ...buffer,
    ...next,
    ...more,
    undo: [...buffer.undo, before].slice(-MAX_UNDO),
    redo: [],
  };
}

/**
 * Changes a cell of a row of the table. A value that is what the cell holds takes the change away.
 * `original`: the row as the result has it.
 */
export function setCell(
  buffer: EditBuffer,
  key: string,
  row: number,
  original: readonly Cell[],
  column: number,
  value: NewValue | null,
): EditBuffer {
  const have = buffer.rows[key];
  const base = have?.original ?? original;
  const after = value !== null && unchanged(value, base[column]) ? null : value;
  const before = have?.cells[column] ?? null;
  if (JSON.stringify(before) === JSON.stringify(after)) return buffer;
  const rows = { ...buffer.rows };
  const cells = { ...(have?.cells ?? {}) };
  if (after === null) delete cells[column];
  else cells[column] = after;
  if (Object.keys(cells).length === 0) delete rows[key];
  else rows[key] = { row: have?.row ?? row, original: base, cells };
  return changed(buffer, { rows }, { failed: buffer.failed === key ? null : buffer.failed });
}

export function undoEdit(buffer: EditBuffer): EditBuffer {
  const back = buffer.undo.at(-1);
  if (!back) return buffer;
  const now: Snapshot = { rows: buffer.rows, inserts: buffer.inserts, deletes: buffer.deletes };
  return { ...buffer, ...back, undo: buffer.undo.slice(0, -1), redo: [...buffer.redo, now] };
}

export function redoEdit(buffer: EditBuffer): EditBuffer {
  const again = buffer.redo.at(-1);
  if (!again) return buffer;
  const now: Snapshot = { rows: buffer.rows, inserts: buffer.inserts, deletes: buffer.deletes };
  return { ...buffer, ...again, undo: [...buffer.undo, now], redo: buffer.redo.slice(0, -1) };
}

/** Takes everything back that was done to a row of the table: its changed cells, its deletion. */
export function resetRow(buffer: EditBuffer, key: string): EditBuffer {
  if (!buffer.rows[key] && !buffer.deletes[key]) return buffer;
  const rows = { ...buffer.rows };
  const deletes = { ...buffer.deletes };
  delete rows[key];
  delete deletes[key];
  return changed(
    buffer,
    { rows, deletes },
    { failed: buffer.failed === key ? null : buffer.failed },
  );
}

// --- whole rows (prompt 032) --------------------------------------------------------------------------

/** Adds new rows with the cells given (a `default` is no cell). All of them are one step of undo. */
export function addRows(
  buffer: EditBuffer,
  rows: readonly Readonly<Record<number, NewValue>>[],
): { buffer: EditBuffer; ids: number[] } {
  if (rows.length === 0) return { buffer, ids: [] };
  const ids = rows.map((_, i) => buffer.nextId + i);
  const added = rows.map((cells, i) => ({
    id: ids[i],
    cells: Object.fromEntries(Object.entries(cells).filter(([, v]) => v.kind !== 'default')),
  }));
  return {
    buffer: changed(
      buffer,
      { inserts: [...buffer.inserts, ...added] },
      { nextId: buffer.nextId + rows.length },
    ),
    ids,
  };
}

/** Sets a cell of a new row; `null` or `default` leaves it to the database. */
export function setNewCell(
  buffer: EditBuffer,
  id: number,
  column: number,
  value: NewValue | null,
): EditBuffer {
  const at = buffer.inserts.findIndex((r) => r.id === id);
  if (at < 0) return buffer;
  const cells = { ...buffer.inserts[at].cells };
  const after = value && value.kind !== 'default' ? value : null;
  if (JSON.stringify(cells[column] ?? null) === JSON.stringify(after)) return buffer;
  if (after === null) delete cells[column];
  else cells[column] = after;
  const inserts = [...buffer.inserts];
  inserts[at] = { id, cells };
  const mark = `new:${id}`;
  return changed(buffer, { inserts }, { failed: buffer.failed === mark ? null : buffer.failed });
}

/** Takes new rows away again. */
export function removeNewRows(buffer: EditBuffer, ids: readonly number[]): EditBuffer {
  const inserts = buffer.inserts.filter((r) => !ids.includes(r.id));
  return inserts.length === buffer.inserts.length ? buffer : changed(buffer, { inserts });
}

/**
 * Marks rows of the table to be deleted – or, when all of them are marked already, takes the mark away.
 * One step of undo.
 */
export function toggleDeleted(
  buffer: EditBuffer,
  rows: readonly {
    readonly key: string;
    readonly row: number;
    readonly original: readonly Cell[];
  }[],
): EditBuffer {
  if (rows.length === 0) return buffer;
  const deletes = { ...buffer.deletes };
  if (rows.every((r) => deletes[r.key])) for (const r of rows) delete deletes[r.key];
  else for (const r of rows) deletes[r.key] = { row: r.row, original: r.original };
  return changed(buffer, { deletes });
}

/** Several changes as one step of undo. */
export function asOneStep(buffer: EditBuffer, f: (b: EditBuffer) => EditBuffer): EditBuffer {
  const after = f(buffer);
  if (after === buffer) return buffer;
  const before: Snapshot = { rows: buffer.rows, inserts: buffer.inserts, deletes: buffer.deletes };
  return { ...after, undo: [...buffer.undo, before].slice(-MAX_UNDO), redo: [] };
}

/** What a pasted text means for a column: an empty cell is NULL, except in a text column. */
export function textToValue(text: string, column: QueryColumn): NewValue {
  return text === '' && valueKind(column.kind) !== 'text'
    ? { kind: 'null' }
    : { kind: 'value', text };
}

/** Where a block of cells goes. */
export interface PasteTarget {
  /** The rows of the table from the cursor down (`key: null`: a row without a usable key – left out). */
  readonly existing: readonly {
    readonly key: string | null;
    readonly row: number;
    readonly original: readonly Cell[];
  }[];
  /** The new row the block goes on in below the rows of the table (an index into the new rows). */
  readonly firstNew: number;
  /** The columns of the result, left to right from the cursor. */
  readonly columns: readonly number[];
}

/**
 * Puts a block of cells into the buffer (prompt 032): over the rows of the table from the cursor down,
 * then over new rows, adding as many as it needs. Columns beyond the last one are left out. One step of
 * undo. Says how many cells were set, how many rows added, and how many rows it could not touch.
 */
export function pasteBlock(
  buffer: EditBuffer,
  block: readonly (readonly string[])[],
  target: PasteTarget,
  columns: readonly QueryColumn[],
): { buffer: EditBuffer; cells: number; added: number; skipped: number } {
  let cells = 0;
  let added = 0;
  let skipped = 0;
  const after = asOneStep(buffer, (start) => {
    let b = start;
    // the new rows are written into a copy of their list, once – not cell by cell (a block has
    // thousands of rows)
    const inserts = [...start.inserts];
    let nextId = start.nextId;
    let touched = false;
    block.forEach((line, n) => {
      const values = target.columns
        .slice(0, line.length)
        .map((c, i) => [c, textToValue(line[i], columns[c])] as const);
      const row = target.existing[n];
      if (row) {
        // a row without a usable key, or one that is to be deleted, is left alone
        if (row.key === null || b.deletes[row.key]) {
          skipped++;
          return;
        }
        for (const [c, value] of values) {
          b = setCell(b, row.key, row.row, row.original, c, value);
        }
        cells += values.length;
        return;
      }
      const at = target.firstNew + (n - target.existing.length);
      const have = inserts[at];
      const next = { ...(have?.cells ?? {}) };
      for (const [c, value] of values) next[c] = value;
      if (have) inserts[at] = { id: have.id, cells: next };
      else {
        inserts[at] = { id: nextId++, cells: next };
        added++;
      }
      touched = true;
      cells += values.length;
    });
    return touched ? { ...b, inserts, nextId } : b;
  });
  return { buffer: after, cells, added, skipped };
}

/** Which buffered values a column cannot take: `key|column` of rows, `new:id|column` of new rows. */
export function invalidCells(
  buffer: EditBuffer,
  columns: readonly QueryColumn[],
  info: readonly (ColumnInfo | undefined)[],
): ReadonlyMap<string, ValueProblem> {
  const out = new Map<string, ValueProblem>();
  const check = (id: string, cellsOf: Readonly<Record<number, NewValue>>) => {
    for (const [c, value] of Object.entries(cellsOf)) {
      const column = columns[Number(c)];
      const problem = column ? validate(value, column, info[Number(c)]) : null;
      if (problem) out.set(`${id}|${c}`, problem);
    }
  };
  for (const [key, edit] of Object.entries(buffer.rows)) {
    // a row that is to be deleted is not changed: what its cells hold in the buffer is never written
    if (!buffer.deletes[key]) check(key, edit.cells);
  }
  for (const row of buffer.inserts) check(`new:${row.id}`, row.cells);
  return out;
}

/** What is to be written: changed cells in rows, new rows, rows to delete. */
export function editCount(buffer: EditBuffer): {
  cells: number;
  rows: number;
  inserts: number;
  deletes: number;
  /** Anything at all. */
  total: number;
} {
  const rows = Object.values(buffer.rows);
  const cells = rows.reduce((n, r) => n + Object.keys(r.cells).length, 0);
  const inserts = buffer.inserts.length;
  const deletes = Object.keys(buffer.deletes).length;
  return { rows: rows.length, cells, inserts, deletes, total: cells + inserts + deletes };
}

/** For the grid: what a cell shows instead of what was read, and the rows below those of the table. */
export interface EditMarks {
  at(row: number, column: number): NewValue | null;
  /** The row whose statement failed. */
  failed(row: number): boolean;
  /** The row is marked to be deleted. */
  deleted(row: number): boolean;
  /** How many new rows stand below the rows of the table. */
  readonly extra: number;
  /** A cell of the `n`th new row; `null`: left to the database. */
  newAt(n: number, column: number): NewValue | null;
  newFailed(n: number): boolean;
  /** The value in the buffer is none the column takes. */
  invalid(row: number, column: number): boolean;
  newInvalid(n: number, column: number): boolean;
}

export function marksOf(
  buffer: EditBuffer,
  invalid: ReadonlyMap<string, unknown> = new Map(),
): EditMarks | null {
  const entries = Object.entries(buffer.rows);
  const gone = Object.entries(buffer.deletes);
  if (entries.length === 0 && gone.length === 0 && buffer.inserts.length === 0) return null;
  const byRow = new Map(entries.map(([key, edit]) => [edit.row, { key, edit }]));
  const goneRows = new Map(gone.map(([key, g]) => [g.row, key]));
  return {
    at: (row, column) => byRow.get(row)?.edit.cells[column] ?? null,
    failed: (row) =>
      buffer.failed !== null &&
      (byRow.get(row)?.key === buffer.failed || goneRows.get(row) === buffer.failed),
    deleted: (row) => goneRows.has(row),
    extra: buffer.inserts.length,
    newAt: (n, column) => buffer.inserts[n]?.cells[column] ?? null,
    newFailed: (n) => buffer.failed === `new:${buffer.inserts[n]?.id}`,
    invalid: (row, column) => {
      const key = byRow.get(row)?.key;
      return key !== undefined && invalid.has(`${key}|${column}`);
    },
    newInvalid: (n, column) => invalid.has(`new:${buffer.inserts[n]?.id}|${column}`),
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

/** What a plan was made of, to find the row a failure names. */
export interface Planned {
  readonly plan: UpdatePlan;
  /** Keys of the changed rows, in the order of `plan.rows`. */
  readonly keys: string[];
  /** Keys of the rows to delete, in the order of `plan.deletes`. */
  readonly deleteKeys: string[];
  /** Ids of the new rows, in the order of `plan.inserts`. */
  readonly insertIds: number[];
}

/**
 * The plan for writing the buffer: rows to delete and changed rows are found by their key, new rows
 * carry the cells that were given. With `lock`, the values cells had when they were read must still be
 * there (the changed cells of a changed row, all cells of a row to delete) – except where equality is no
 * test: floating point numbers, binary data, types without `=`, and texts so long that the row may hold
 * them cut. A row that is changed and deleted is deleted.
 */
export function planOf(
  buffer: EditBuffer,
  columns: readonly QueryColumn[],
  pk: readonly number[],
  lock: boolean,
  schema: string | null,
  table: string,
  dialect: Dialect = 'sqlite',
): Planned {
  const byPlace = (a: { row: number }, b: { row: number }) => a.row - b.row;
  const lockable = (original: readonly Cell[], c: number) => {
    const cell = original[c];
    if (columns[c].kind === 'float' || !comparable(dialect, columns[c].typeName)) return false;
    if (cell !== null && typeof cell === 'object') return false;
    return !(typeof cell === 'string' && cell.length >= CUT_FROM);
  };
  const keyOf = (original: readonly Cell[]) =>
    pk.map((c) => editCell(columns[c], keyText(original[c])));
  const deleteKeys = Object.keys(buffer.deletes).sort((a, b) =>
    byPlace(buffer.deletes[a], buffer.deletes[b]),
  );
  const keys = Object.keys(buffer.rows)
    .filter((key) => !buffer.deletes[key])
    .sort((a, b) => byPlace(buffer.rows[a], buffer.rows[b]));
  const rows = keys.map((key): RowUpdate => {
    const edit = buffer.rows[key];
    const changedCells = Object.keys(edit.cells)
      .map(Number)
      .sort((a, b) => a - b);
    return {
      key: keyOf(edit.original),
      set: changedCells.map((c) => {
        const value = edit.cells[c];
        return {
          ...editCell(columns[c], value.kind === 'value' ? value.text : null),
          default: value.kind === 'default',
        };
      }),
      expect: lock
        ? changedCells
            .filter((c) => lockable(edit.original, c))
            .map((c) => editCell(columns[c], keyText(edit.original[c])))
        : [],
    };
  });
  const deletes = deleteKeys.map((key) => {
    const original = buffer.deletes[key].original;
    return {
      key: keyOf(original),
      expect: lock
        ? columns
            .map((_, c) => c)
            .filter((c) => !pk.includes(c) && lockable(original, c))
            .slice(0, MAX_ROW_CELLS)
            .map((c) => editCell(columns[c], keyText(original[c])))
        : [],
    };
  });
  const inserts = buffer.inserts.map((row) => ({
    set: Object.keys(row.cells)
      .map(Number)
      .sort((a, b) => a - b)
      .map((c) => {
        const value = row.cells[c];
        return {
          ...editCell(columns[c], value.kind === 'value' ? value.text : null),
          default: false,
        };
      }),
  }));
  return {
    plan: {
      schema,
      table,
      rows,
      deletes,
      inserts,
      // the key the database gives a new row (the first column of the key)
      returning: inserts.length > 0 && pk.length > 0 ? columns[pk[0]].name : null,
    },
    keys,
    deleteKeys,
    insertIds: buffer.inserts.map((r) => r.id),
  };
}

/** The database of a connection, as far as the lock cares. */
export type Dialect =
  | 'postgres'
  | 'mysql'
  | 'sqlserver'
  | 'sqlite'
  | 'oracle'
  | 'duckdb'
  | 'clickhouse'
  | 'trino'
  | 'firebird'
  | 'bigquery'
  | 'snowflake'
  | 'db2';

/** Types a database cannot compare with `=` (or never finds equal to a text): no lock on them. */
const NO_EQUALS: Readonly<Record<Dialect, RegExp>> = {
  postgres: /^(json|xml|point|line|lseg|box|path|polygon|circle)(\[\])?$/i,
  mysql: /^(json|geometry)$/i,
  sqlserver: /^(text|ntext|image|xml)$/i,
  sqlite: /^$/,
  oracle: /^(clob|nclob|blob|long|long raw|json|xmltype|bfile)$/i,
  // lists, structs and maps come as text: what was read cannot be compared with what is stored
  duckdb: /(\[\]$|^struct|^map|^union|^json$)/i,
  // nothing is edited there
  clickhouse: /^$/,
  trino: /^$/,
  // a BLOB cannot be compared with `=`
  firebird: /^blob/i,
  // nothing is edited there
  bigquery: /^$/,
  snowflake: /^$/,
  db2: /^$/,
};

export function comparable(dialect: Dialect, typeName: string): boolean {
  return !NO_EQUALS[dialect].test(typeName.trim());
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
