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

/** Mirrors `QueryResult`. */
export interface QueryResult {
  readonly columns: readonly QueryColumn[];
  readonly rows: readonly (readonly Cell[])[];
  /** The result was cut off at the row or memory limit of the backend. */
  readonly truncated: boolean;
  /** Rows changed by a statement without a result; `null` for a statement with one. */
  readonly rowsAffected: number | null;
  readonly elapsedMs: number;
}
