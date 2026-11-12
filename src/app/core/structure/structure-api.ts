import { Injectable } from '@angular/core';
import { call } from '../backend/call';
import { AppError } from '../errors/app-error';

/** Mirrors `Column` in src-tauri/src/db/compare.rs: a column as the catalog gives it. */
export interface ColumnDef {
  readonly name: string;
  readonly typeName: string;
  readonly nullable: boolean;
  /** The default as the database writes it; `null` = none. */
  readonly default: string | null;
}

/** Mirrors `Index`. */
export interface IndexDef {
  readonly name: string;
  readonly unique: boolean;
  readonly columns: readonly string[];
  /** The whole statement where the database gives it (PostgreSQL); an index edited here has none. */
  readonly definition: string | null;
}

/** Mirrors `Key`: a foreign key. */
export interface KeyDef {
  readonly name: string;
  readonly columns: readonly string[];
  /** `''`: the schema of the table itself. */
  readonly refSchema: string;
  readonly refTable: string;
  readonly refColumns: readonly string[];
}

/** Mirrors `Named`: a check. */
export interface CheckDef {
  readonly name: string;
  readonly text: string;
}

/** Mirrors `Table`: what the structure editor reads and writes (prompt 043). */
export interface TableDef {
  readonly name: string;
  readonly columns: readonly ColumnDef[];
  readonly pk: readonly string[];
  readonly indexes: readonly IndexDef[];
  readonly keys: readonly KeyDef[];
  readonly checks: readonly CheckDef[];
  readonly comment: string | null;
  /** SQLite: the statement that made the table. */
  readonly definition: string | null;
}

/** Mirrors `Request` in src-tauri/src/db/structure.rs. The window sends tables, never SQL. */
export type StructRequest =
  | {
      readonly kind: 'change';
      readonly schema: string;
      /** The table as it was read; `null`: it is new. */
      readonly before: TableDef | null;
      readonly after: TableDef;
      readonly renames: readonly { readonly from: string; readonly to: string }[];
    }
  | { readonly kind: 'drop'; readonly schema: string; readonly table: string }
  | { readonly kind: 'truncate'; readonly schema: string; readonly table: string }
  | {
      readonly kind: 'duplicate';
      readonly schema: string;
      readonly table: TableDef;
      readonly name: string;
      readonly data: boolean;
    };

/** Mirrors `ScriptStep`: one statement, or a remark where the database cannot do it this way. */
export interface StructStep {
  /** Empty for a remark. */
  readonly sql: string;
  /** Why the step may lose data; `null`: it does not. */
  readonly danger: string | null;
  readonly note: string | null;
}

/** Mirrors `Plan`. */
export interface StructPlan {
  readonly steps: readonly StructStep[];
  /** One transaction: a failure leaves nothing. `false`: every statement commits by itself. */
  readonly transactional: boolean;
  /** A part of the change is not written (a remark stands for it): the plan is shown, not run. */
  readonly incomplete: boolean;
}

/** Mirrors `Ran`. */
export interface StructRan {
  readonly done: number;
  /** The statement that failed, counted among those that run. */
  readonly failed: number | null;
  readonly error: AppError | null;
  readonly transactional: boolean;
  readonly rolledBack: boolean;
}

/** Editing the structure of tables (prompt 043). */
export abstract class StructureApi {
  /** A table with its columns, keys, indexes and checks; `not_found` when it is gone. */
  abstract load(connectionId: string, schema: string, table: string): Promise<TableDef>;
  /** The statements of a request – nothing runs. `unsupported`: the table makes no sense as it is. */
  abstract plan(connectionId: string, request: StructRequest): Promise<StructPlan>;
  /**
   * Runs the statements of a request: written again in the backend, each through the guard
   * (`confirmations[i]` for statement `i`), in one transaction where the database can.
   */
  abstract apply(
    connectionId: string,
    request: StructRequest,
    confirmations: readonly (string | null)[],
    allowDangerous: boolean,
    timeoutMs: number,
  ): Promise<StructRan>;
}

@Injectable()
export class TauriStructureApi extends StructureApi {
  load(connectionId: string, schema: string, table: string): Promise<TableDef> {
    return call('struct_load', { id: connectionId, schema, table });
  }

  plan(connectionId: string, request: StructRequest): Promise<StructPlan> {
    return call('struct_plan', { id: connectionId, request });
  }

  apply(
    connectionId: string,
    request: StructRequest,
    confirmations: readonly (string | null)[],
    allowDangerous: boolean,
    timeoutMs: number,
  ): Promise<StructRan> {
    return call('struct_apply', {
      id: connectionId,
      request,
      confirmations,
      allowDangerous,
      timeoutMs: timeoutMs > 0 ? timeoutMs : null,
    });
  }
}
