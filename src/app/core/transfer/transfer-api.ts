import { Injectable } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { call } from '../backend/call';

/** Mirrors `Request` in src-tauri/src/db/transfer.rs (prompt 045). */
export interface TransferRequest {
  readonly sourceSchema: string;
  readonly tables: readonly string[];
  readonly targetSchema: string;
  /** `clear`: a table that is there is emptied first. */
  readonly mode: 'append' | 'clear';
  /** Indexes and foreign keys of the source for tables that are created, after the rows. */
  readonly withKeys: boolean;
  /** All rows of a table or none. */
  readonly wholeTransaction: boolean;
  /** `skip`: a row the target refuses is left out and noted. */
  readonly onError: 'abort' | 'skip';
}

/** Mirrors `ColumnPlan`. */
export interface TransferColumn {
  readonly name: string;
  readonly sourceType: string;
  /** `null`: the target table has no such column – it is left out. */
  readonly target: string | null;
  readonly targetType: string | null;
  /** What gets lost on the way; `null`: nothing. */
  readonly loss: string | null;
}

/** Mirrors `TablePlan` (what is serialized of it). */
export interface TransferTable {
  readonly table: string;
  readonly exists: boolean;
  readonly columns: readonly TransferColumn[];
  readonly notes: readonly string[];
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/** Mirrors `Plan`: the tables in the order they are copied. */
export interface TransferPlan {
  readonly tables: readonly TransferTable[];
  /** Every statement that runs in the target: what its guard is asked about. */
  readonly statements: readonly string[];
  /** Tables whose keys point to each other in a circle. */
  readonly cycle: readonly string[];
}

/** Mirrors `Event`. */
export type TransferEvent =
  | {
      readonly kind: 'table';
      readonly table: string;
      readonly index: number;
      readonly of: number;
    }
  | { readonly kind: 'rows'; readonly table: string; readonly read: number };

/** Mirrors `Loaded` in src-tauri/src/db/load.rs, as far as the report shows it. */
export interface TransferLoaded {
  readonly read: number;
  readonly written: number;
  readonly skipped: number;
  readonly errors: readonly { readonly line: number; readonly reason: string }[];
  readonly cancelled: boolean;
  readonly failed: boolean;
  readonly rolledBack: boolean;
  readonly errorFile: boolean;
  readonly cleared: boolean;
}

/** Mirrors `TableReport`. */
export interface TransferTableReport {
  readonly table: string;
  /** Not begun: a table before it failed, or the transfer was stopped. */
  readonly skipped: boolean;
  readonly loaded: TransferLoaded;
  /** This run created the table: it is there, whatever became of its rows. */
  readonly created: boolean;
  readonly elapsedMs: number;
  readonly error: string | null;
}

/** Mirrors `Report`. */
export interface TransferReport {
  readonly tables: readonly TransferTableReport[];
  readonly afterErrors: readonly string[];
  readonly cancelled: boolean;
}

/** Copying tables from one connection to another (prompt 045). Both must be connected. */
export abstract class TransferApi {
  /** What the transfer would do – nothing is written. */
  abstract plan(source: string, target: string, request: TransferRequest): Promise<TransferPlan>;
  /**
   * Copies the tables. The backend makes the plan again and asks the guard of the target for each of
   * its statements (`confirmations[i]`). A job: `cancel` ends it at the next block. `errorPath` (from
   * the save dialog) names the files for rows that were left out.
   */
  abstract run(
    jobId: number,
    source: string,
    target: string,
    request: TransferRequest,
    confirmations: readonly (string | null)[],
    allowDangerous: boolean,
    errorPath: string | null,
    timeoutMs: number,
    onEvent: (event: TransferEvent) => void,
  ): Promise<TransferReport>;
  abstract cancel(jobId: number): Promise<void>;
}

@Injectable()
export class TauriTransferApi extends TransferApi {
  plan(source: string, target: string, request: TransferRequest): Promise<TransferPlan> {
    return call('transfer_plan', { source, target, request });
  }

  run(
    jobId: number,
    source: string,
    target: string,
    request: TransferRequest,
    confirmations: readonly (string | null)[],
    allowDangerous: boolean,
    errorPath: string | null,
    timeoutMs: number,
    onEvent: (event: TransferEvent) => void,
  ): Promise<TransferReport> {
    const channel = new Channel<TransferEvent>();
    channel.onmessage = onEvent;
    return call('transfer_run', {
      jobId,
      source,
      target,
      request,
      confirmations,
      allowDangerous,
      errorPath,
      timeoutMs: timeoutMs > 0 ? timeoutMs : null,
      onEvent: channel,
    });
  }

  cancel(jobId: number): Promise<void> {
    return call('cancel_job', { jobId });
  }
}
