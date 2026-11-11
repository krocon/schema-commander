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
