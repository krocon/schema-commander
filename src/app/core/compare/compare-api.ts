import { Injectable } from '@angular/core';
import { call } from '../backend/call';
import { DbKind } from '../connections/connection.models';

/**
 * Mirrors `Snapshot` in src-tauri/src/db/compare.rs (prompt 038): what a schema is made of. The window
 * only carries it (from the backend, or from a file the user chose) – the backend checks and compares.
 */
export interface SchemaSnapshot {
  readonly kind: DbKind;
  readonly schema: string;
  readonly tables: readonly { readonly name: string }[];
  readonly views: readonly { readonly name: string }[];
  readonly routines: readonly { readonly name: string }[];
  readonly triggers: readonly { readonly name: string }[];
}

/** Mirrors `ItemKind`. */
export type CompareKind =
  'table' | 'column' | 'primaryKey' | 'index' | 'key' | 'check' | 'view' | 'routine' | 'trigger';
/** Mirrors `State`. */
export type CompareState = 'same' | 'onlyLeft' | 'onlyRight' | 'different';

/** Mirrors `Item`: one thing of the two schemas and how it differs. */
export interface CompareItem {
  /** Names the item for a script: `column:orders.total`. */
  readonly id: string;
  readonly kind: CompareKind;
  /** The table a part belongs to. */
  readonly table: string | null;
  readonly name: string;
  readonly state: CompareState;
  readonly left: string | null;
  readonly right: string | null;
}

/** Mirrors `Rename`: a pair the user says is one thing under two names. */
export interface SchemaRename {
  /** The table of a column that was renamed; `null`: the table itself was. */
  readonly table: string | null;
  /** The name on the side that is changed. */
  readonly from: string;
  /** The name it gets. */
  readonly to: string;
}

/**
 * Comparing schemas (prompt 038). Nothing here changes a database: a snapshot reads the catalog, the
 * comparison and the script are computed. Rejects with an `AppError`.
 */
export abstract class CompareApi {
  abstract snapshot(connectionId: string, schema: string): Promise<SchemaSnapshot>;
  /** The difference; `renames` are applied to the right side first. */
  abstract compare(
    left: SchemaSnapshot,
    right: SchemaSnapshot,
    renames: readonly SchemaRename[],
  ): Promise<CompareItem[]>;
  /** The script that would make `target` like `source`, for the chosen differences (`null`: all). */
  abstract script(
    source: SchemaSnapshot,
    target: SchemaSnapshot,
    picks: readonly string[] | null,
    renames: readonly SchemaRename[],
  ): Promise<string>;
}

@Injectable()
export class TauriCompareApi extends CompareApi {
  snapshot(connectionId: string, schema: string): Promise<SchemaSnapshot> {
    return call('schema_snapshot', { id: connectionId, schema });
  }

  compare(
    left: SchemaSnapshot,
    right: SchemaSnapshot,
    renames: readonly SchemaRename[],
  ): Promise<CompareItem[]> {
    return call('schema_compare', { left, right, renames });
  }

  script(
    source: SchemaSnapshot,
    target: SchemaSnapshot,
    picks: readonly string[] | null,
    renames: readonly SchemaRename[],
  ): Promise<string> {
    return call('schema_script', { source, target, picks, renames });
  }
}
