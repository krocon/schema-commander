/** Mirrors `Column` in src-tauri/src/demo_db.rs. */
export interface QueryColumn {
  readonly name: string;
  /** Declared type of a table column (`INTEGER`, `TEXT` …); `null` for expressions. */
  readonly declType: string | null;
}

/** A cell as it crosses the bridge: `null`, number, text, or the length of a blob. */
export type Cell = null | number | string | { readonly blob: number };

/** Mirrors `QueryResult` in src-tauri/src/demo_db.rs. */
export interface QueryResult {
  readonly columns: readonly QueryColumn[];
  readonly rows: readonly (readonly Cell[])[];
  /** The result was cut off at the row limit of the backend. */
  readonly truncated: boolean;
  /** Rows changed by a statement without a result; `null` for a statement with one. */
  readonly rowsAffected: number | null;
  readonly elapsedMs: number;
}
