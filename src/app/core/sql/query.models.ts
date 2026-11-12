/** Mirrors `ColKind` in src-tauri/src/db/value.rs: how to read the cells of a column. */
export type ColKind =
  | 'int'
  | 'float'
  | 'decimal'
  | 'bool'
  | 'text'
  | 'bytes'
  | 'timestamp'
  | 'timestampTz'
  | 'date'
  | 'time'
  | 'json'
  | 'uuid'
  | 'other';

/** Mirrors `Column`. */
export interface QueryColumn {
  readonly name: string;
  readonly kind: ColKind;
  /** The type as the database names it (`INT4`, `VARCHAR` …); `''` when unknown. */
  readonly typeName: string;
}

/**
 * A cell as it crosses the bridge, without loss: `null`, a boolean, a number, or text. Integers beyond ±2^53,
 * decimals, dates, times, UUIDs and JSON are text – the column's kind says how to read it. Binary data is its
 * length and its first bytes as hex; a value the driver could not read names its type.
 */
export type Cell =
  | null
  | boolean
  | number
  | string
  | { readonly bytes: number; readonly hex: string }
  | { readonly unreadable: string };

/** A result in the store of the backend (prompt 006): its rows are asked for in windows. */
export interface ResultRef {
  readonly resultId: number;
  readonly columns: readonly QueryColumn[];
}

/** Mirrors `RunEvent` in src-tauri/src/commands.rs: what a running statement reports. */
export type RunEvent =
  | {
      readonly kind: 'started';
      readonly resultId: number;
      readonly columns: readonly QueryColumn[];
    }
  | { readonly kind: 'rows'; readonly rows: number };

/**
 * Mirrors `Bind` in src-tauri/src/db/mod.rs: a value bound to a placeholder of a statement (prompt 025).
 * Numbers and dates travel as text, so no digit is lost on the way.
 */
export type BoundValue =
  | { readonly kind: 'text' | 'int' | 'decimal' | 'date' | 'datetime'; readonly value: string }
  | { readonly kind: 'bool'; readonly value: boolean };

/** Mirrors `Op` in src-tauri/src/db/filter.rs: how a condition of a table view compares. */
export type FilterOp =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'like'
  | 'notLike'
  | 'contains'
  | 'containsNoCase'
  | 'in'
  | 'between'
  | 'isNull'
  | 'isNotNull';

/** Mirrors `Condition`: the values are what the user typed – the backend binds them. */
export interface FilterCondition {
  /** The name of the column as the catalog has it; the backend quotes it. */
  readonly column: string;
  readonly op: FilterOp;
  readonly values: readonly string[];
  readonly kind: 'number' | 'bool' | 'text';
  /** The type of the column as the database names it; PostgreSQL casts the value to it. */
  readonly typeName: string;
}

/** Mirrors `Order`. */
export interface FilterOrder {
  readonly column: string;
  readonly desc: boolean;
  readonly nulls: 'first' | 'last' | null;
}

/** Mirrors `TableQuery`: what a table view shows. */
export interface TableQuery {
  readonly schema: string | null;
  readonly table: string;
  readonly conditions: readonly FilterCondition[];
  /** Joined with OR (else AND). */
  readonly any: boolean;
  /** A condition written as SQL by the user: one expression, no `;`, no comments. */
  readonly whereSql: string | null;
  readonly order: readonly FilterOrder[];
  /** Rows at most; `null` = all. */
  readonly limit: number | null;
  /** Only rows with one of these keys (prompt 030); joined to the conditions with AND. */
  readonly keys?: KeySet | null;
  /** Count the rows instead of reading them. */
  readonly count?: boolean;
}

/** Mirrors `KeySet` in src-tauri/src/db/filter.rs: values of a key, row by row – the backend binds them. */
export interface KeySet {
  readonly columns: readonly {
    readonly column: string;
    readonly kind: 'number' | 'bool' | 'text';
    readonly typeName: string;
  }[];
  readonly rows: readonly (readonly string[])[];
}

/** Mirrors `Built`: the statement of a table view with placeholders, its values, and a readable form. */
export interface BuiltQuery {
  readonly sql: string;
  readonly params: readonly BoundValue[];
  /** With the values written out as literals: to read and to go on with in an editor. */
  readonly display: string;
}

/** Mirrors `ViewSpec` in src-tauri/src/results.rs: a result seen through a text filter, in an order. */
export interface ViewSpec {
  /** Rows in which the text occurs (case does not matter); `''` = all. */
  readonly text: string;
  /** The column to look in; `null` = every column. */
  readonly column: number | null;
  readonly sort: readonly { readonly column: number; readonly desc: boolean }[];
}

/** Mirrors `Viewed`: a view is read, copied and freed like a result. */
export interface ViewedResult {
  readonly resultId: number;
  readonly rows: number;
}

/** Mirrors `ImageInfo` in src-tauri/src/image_info.rs: what picture a binary value says it is. */
export interface ImageInfo {
  readonly mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** As the header says; 0 = it did not say. */
  readonly width: number;
  readonly height: number;
}

/**
 * Mirrors `CellValue` in src-tauri/src/results.rs: a part of the whole value of a cell (prompt 026). Long
 * texts and binary data are not in the rows the grid gets; they are asked for piece by piece.
 */
export interface CellValuePart {
  /** `unreadable`: `text` names the type. */
  readonly kind: 'null' | 'text' | 'bytes' | 'unreadable';
  /** Bytes of the whole value (of a text: in UTF-8). */
  readonly total: number;
  /** The bytes this part covers; `to` is the `from` of the next part. */
  readonly from: number;
  readonly to: number;
  readonly text?: string;
  /** Binary data, Base64. */
  readonly base64?: string;
  /** Only with the first part of binary data. */
  readonly image?: ImageInfo;
}

/** Mirrors `RunOutcome`: how a statement ended. */
export interface RunOutcome {
  /** Where the rows are; `null` for a statement without a result. */
  readonly resultId: number | null;
  readonly columns: readonly QueryColumn[];
  readonly rows: number;
  /** More rows existed than the store takes. */
  readonly truncated: boolean;
  /** Rows changed by a statement without a result; `null` for a statement with one. */
  readonly rowsAffected: number | null;
  readonly elapsedMs: number;
  /** What the server says about the transaction of the session afterwards (prompt 013). */
  readonly tx: TxState;
}

/** A window of rows as it crosses the bridge. */
export type RowWindow = readonly (readonly Cell[])[];

/** Mirrors `Class` in src-tauri/src/db/guard.rs: what a statement does, the mildest first. */
export type StatementClass = 'read' | 'write' | 'ddl' | 'dangerous';

/** Mirrors `Need`: what a statement needs before it may run on its connection. */
export type StatementNeed = 'nothing' | 'confirm' | 'type_name' | 'refused';

/** Mirrors `Verdict`. */
export interface Verdict {
  readonly class: StatementClass;
  readonly need: StatementNeed;
}

/**
 * Mirrors `TxState` in src-tauri/src/db/mod.rs: whether a transaction is open on a session, as the server
 * says. `failed`: open, but only a rollback gets out of it. `unknown`: the server could not be asked.
 */
export type TxState = 'idle' | 'active' | 'failed' | 'unknown';

/** Mirrors `Frequent` in src-tauri/src/stats.rs: a value (`null` = NULL) and how often it occurs. */
export interface FrequentValue {
  readonly value: string | null;
  readonly count: number;
}

/**
 * Mirrors `Stats` in src-tauri/src/stats.rs (prompt 028): the figures of a selection. Numbers come as
 * decimal text – they are exact and can be longer than a JavaScript number holds.
 */
export interface ResultStats {
  readonly cells: number;
  readonly nonNull: number;
  readonly distinct: number;
  readonly distinctCapped: boolean;
  /** Cells that are numbers: sum, mean, min and max are theirs. */
  readonly numbers: number;
  /** Cells with a value that is no number while others are. */
  readonly ignored: number;
  readonly sum: string | null;
  readonly mean: string | null;
  readonly min: string | null;
  readonly max: string | null;
  readonly first: string | null;
  readonly last: string | null;
  readonly spanMs: number | null;
  readonly shortest: number | null;
  readonly longest: number | null;
  readonly top: readonly FrequentValue[];
  readonly topPartial: boolean;
}

/** Mirrors `SearchSpec` in src-tauri/src/search.rs (prompt 029): what is looked for in a result. */
export interface SearchSpec {
  readonly text: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  /** `text` is a regular expression (of the Rust `regex` crate: no backreferences, no lookaround). */
  readonly regex: boolean;
  /** Indices of result columns to look in; empty = all. */
  readonly columns: readonly number[];
}

/** Mirrors `Found`: the hits of a stretch of rows (`[row, column]`) and where to go on. */
export interface SearchFound {
  readonly hits: readonly (readonly [number, number])[];
  readonly next: number;
  readonly done: boolean;
}

/** Mirrors `Seek`: the next cell with another value, or the next NULL. */
export type SeekKind = 'change' | 'null';

/** Mirrors `CellValue` in src-tauri/src/db/edit.rs: a column and a value of it (`null` = NULL). */
export interface EditCell {
  readonly column: string;
  readonly kind: 'number' | 'bool' | 'text';
  readonly typeName: string;
  readonly value: string | null;
}

/** Mirrors `SetCell`: what a cell becomes; `default` asks for the default of the column. */
export interface EditSet extends EditCell {
  readonly default: boolean;
}

/** Mirrors `RowUpdate`: a row by its key, the cells to set, and the old values that must still be there. */
export interface RowUpdate {
  readonly key: readonly EditCell[];
  readonly set: readonly EditSet[];
  readonly expect: readonly EditCell[];
}

/** Mirrors `UpdatePlan` (prompt 031): the changed rows of one table. The backend writes the SQL. */
export interface UpdatePlan {
  readonly schema: string | null;
  readonly table: string;
  /** Rows changed. */
  readonly rows: readonly RowUpdate[];
  /** Rows to delete (prompt 032): by key, with the lock only as they were read. */
  readonly deletes?: readonly RowDelete[];
  /** New rows: the cells the user gave a value. */
  readonly inserts?: readonly RowInsert[];
  /** A column whose value new rows report back (the key the database assigns). */
  readonly returning?: string | null;
}

/** Mirrors `RowDelete`. */
export interface RowDelete {
  readonly key: readonly EditCell[];
  readonly expect: readonly EditCell[];
}

/** Mirrors `RowInsert`. */
export interface RowInsert {
  readonly set: readonly EditSet[];
}

/** Mirrors `StepKind`: what a statement of a plan does. They run in this order. */
export type EditKind = 'delete' | 'update' | 'insert';

/** Mirrors `Step`: one statement of a plan, and the rows of its kind it covers. */
export interface EditStep extends BuiltQuery {
  readonly kind: EditKind;
  readonly first: number;
  readonly rows: number;
  readonly returns: boolean;
}

/** Mirrors `Applied` in src-tauri/src/db/manager.rs: all statements are committed (`done`), or none. */
export interface Applied {
  readonly done: number;
  /** The row that stopped everything: its place among the rows of its kind in the plan, from 0. */
  readonly failed: number | null;
  /** Whether that row was to be deleted, changed or inserted. */
  readonly failedKind: EditKind | null;
  /**
   * How many rows from `failed` on it could have been: 1 when the row is known, more when a statement
   * for several new rows failed and the row could not be told.
   */
  readonly failedSpan: number;
  /** The keys the database gave new rows, where it reports them (PostgreSQL, SQLite). */
  readonly inserted: readonly string[];
  /** It changed no row or several: the row is not what it was when it was read. */
  readonly conflict: boolean;
  readonly error: { readonly code: string; readonly message: string } | null;
  /** A transaction of the user's own is open on the session: nothing was tried. */
  readonly blocked: boolean;
  /** The connection was lost while committing: whether the rows are written is not known. */
  readonly unknown: boolean;
  readonly tx: TxState;
}
