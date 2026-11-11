import { Injectable } from '@angular/core';
import { Channel } from '@tauri-apps/api/core';
import { call } from '../backend/call';
import { CopySelection } from '../backend/clipboard-api';
import {
  BoundValue,
  BuiltQuery,
  CellValuePart,
  RowWindow,
  RunEvent,
  RunOutcome,
  TableQuery,
  TxState,
  Verdict,
  ViewSpec,
  ResultStats,
  ViewedResult,
} from './query.models';

/** What lets a guarded statement run (prompt 012). */
export interface RunGuard {
  /** The token `confirm` gave for exactly this statement. */
  readonly confirmation?: string | null;
  /** The user's setting: dangerous statements on free connections need no confirmation. */
  readonly allowDangerous?: boolean;
  /** The session to run on: the id of the tab. Each tab has its own, so its transaction is its own. */
  readonly session?: string;
  /** Manual commit: a transaction is opened before the statement when none is open. */
  readonly manual?: boolean;
  /**
   * Values for the placeholders of the statement (prompt 025), in their order: `$1`, `?`, `@P1`, `?1` –
   * the form of the driver. The driver binds them; they are never part of the text.
   */
  readonly params?: readonly BoundValue[];
}

/**
 * Running statements on an open connection (prompts 003, 006). The rows of a statement stay in the backend;
 * the window asks for the slice it shows.
 */
export abstract class QueryApi {
  /**
   * Runs one statement and resolves when it has ended. While it runs, `onEvent` says when a result is there
   * (`started`) and how many rows it has by now (`rows`) – they can be asked for at once. Rejects with an
   * `AppError`: `invalid_query` carries the server's message, `cancelled` follows `cancel`, `timeout` the
   * time limit (`timeoutMs`, 0 = none), `not_connected` means the connection must be opened (again). A
   * statement that fails leaves no result behind.
   */
  abstract run(
    connectionId: string,
    sql: string,
    timeoutMs?: number,
    onEvent?: (event: RunEvent) => void,
    guard?: RunGuard,
  ): Promise<RunOutcome>;
  /**
   * What statements are and what they need on a connection: `refused` never runs there, `confirm` and
   * `type_name` need a token of `confirm`. The backend decides; `run` rejects with `confirmation_required`
   * or `permission_denied` whatever the window thinks.
   */
  abstract check(
    connectionId: string,
    sqls: readonly string[],
    allowDangerous: boolean,
  ): Promise<Verdict[]>;
  /**
   * The user said yes: a token for each statement that needs one (`null` for the others). Statements with
   * `type_name` need the name of the connection as the user typed it; a wrong one rejects.
   */
  abstract confirm(
    connectionId: string,
    sqls: readonly string[],
    typedName: string | null,
    allowDangerous: boolean,
  ): Promise<(string | null)[]>;
  /** Stops the statement that runs on a connection. */
  abstract cancel(connectionId: string, session?: string): Promise<void>;
  /** `COMMIT` or `ROLLBACK` on the session of a tab; resolves with what the server says afterwards. */
  abstract endTransaction(connectionId: string, session: string, commit: boolean): Promise<TxState>;
  /** What the server said last about the transaction of a tab (asked after a statement that failed). */
  abstract txState(connectionId: string, session: string): Promise<TxState>;
  /** Closes the session of a tab; the server rolls back what was open on it. */
  abstract closeSession(connectionId: string, session: string): Promise<void>;
  /** Rows `from..from + count` of a result (fewer at its end; long texts cut). */
  abstract window(resultId: number, from: number, count: number): Promise<RowWindow>;
  /** Forgets results that are no longer shown. */
  abstract free(resultIds: readonly number[]): Promise<void>;
  /**
   * A part of the whole value of a cell (prompt 026): at most `max` bytes from byte `from` (a text part
   * ends at a character, so it can be a few bytes longer). Rejects with `not_found` for a cell that is not
   * there and `unknown_result` for a result that is gone.
   */
  abstract cellValue(
    resultId: number,
    row: number,
    col: number,
    from: number,
    max: number,
  ): Promise<CellValuePart>;
  /** Writes the whole value into a file (text as UTF-8, binary data raw); resolves with the bytes. */
  abstract saveCellValue(resultId: number, row: number, col: number, path: string): Promise<number>;
  /** Puts the whole text of a cell on the clipboard; resolves with its characters. */
  abstract copyCellValue(resultId: number, row: number, col: number): Promise<number>;
  /**
   * The statement of a table view (prompt 027), built by the backend: names quoted, every value a
   * placeholder. Run it with `run(…, built.sql, …, { params: built.params })`. Rejects with
   * `unsupported` for a query that is none (a condition without its values, a free condition with `;`).
   */
  abstract tableQuery(connectionId: string, query: TableQuery): Promise<BuiltQuery>;
  /**
   * A result seen through a text filter and in an order – done in the store, the query is not touched.
   * Resolves with a view that is read like a result and must be freed like one. A job: `cancelView`
   * stops it (`cancelled`); `too_large` says a result is too big to sort here.
   */
  abstract resultView(jobId: number, resultId: number, spec: ViewSpec): Promise<ViewedResult>;
  abstract cancelView(jobId: number): Promise<void>;
  /**
   * The figures of a selection of a result (prompt 028), worked out over the store; `top` adds the most
   * frequent values. A job: `cancelStats` stops it (`cancelled`).
   */
  abstract resultStats(
    jobId: number,
    resultId: number,
    selection: CopySelection,
    top: boolean,
  ): Promise<ResultStats>;
  abstract cancelStats(jobId: number): Promise<void>;
}

@Injectable()
export class TauriQueryApi extends QueryApi {
  run(
    connectionId: string,
    sql: string,
    timeoutMs = 0,
    onEvent?: (event: RunEvent) => void,
    guard: RunGuard = {},
  ): Promise<RunOutcome> {
    const channel = new Channel<RunEvent>();
    if (onEvent) channel.onmessage = onEvent;
    return call('run_query', {
      id: connectionId,
      sql,
      timeoutMs: timeoutMs > 0 ? timeoutMs : null,
      confirmation: guard.confirmation ?? null,
      allowDangerous: guard.allowDangerous ?? false,
      session: guard.session ?? null,
      manual: guard.manual ?? false,
      params: guard.params && guard.params.length > 0 ? guard.params : null,
      onEvent: channel,
    });
  }

  check(
    connectionId: string,
    sqls: readonly string[],
    allowDangerous: boolean,
  ): Promise<Verdict[]> {
    return call('check_statements', { id: connectionId, sqls, allowDangerous });
  }

  confirm(
    connectionId: string,
    sqls: readonly string[],
    typedName: string | null,
    allowDangerous: boolean,
  ): Promise<(string | null)[]> {
    return call('confirm_statements', { id: connectionId, sqls, typedName, allowDangerous });
  }

  cancel(connectionId: string, session?: string): Promise<void> {
    return call('cancel_query', { id: connectionId, session: session ?? null });
  }

  endTransaction(connectionId: string, session: string, commit: boolean): Promise<TxState> {
    return call('end_transaction', { id: connectionId, session, commit });
  }

  txState(connectionId: string, session: string): Promise<TxState> {
    return call('tx_state', { id: connectionId, session });
  }

  closeSession(connectionId: string, session: string): Promise<void> {
    return call('close_session', { id: connectionId, session });
  }

  window(resultId: number, from: number, count: number): Promise<RowWindow> {
    return call('result_window', { resultId, from, count });
  }

  free(resultIds: readonly number[]): Promise<void> {
    return call('free_results', { resultIds });
  }

  cellValue(
    resultId: number,
    row: number,
    col: number,
    from: number,
    max: number,
  ): Promise<CellValuePart> {
    return call('cell_value', { resultId, row, col, from, max });
  }

  saveCellValue(resultId: number, row: number, col: number, path: string): Promise<number> {
    return call('save_cell_value', { resultId, row, col, path });
  }

  copyCellValue(resultId: number, row: number, col: number): Promise<number> {
    return call('copy_cell_value', { resultId, row, col });
  }

  tableQuery(connectionId: string, query: TableQuery): Promise<BuiltQuery> {
    return call('table_query', { id: connectionId, query });
  }

  resultView(jobId: number, resultId: number, spec: ViewSpec): Promise<ViewedResult> {
    return call('result_view', { jobId, resultId, spec });
  }

  cancelView(jobId: number): Promise<void> {
    return call('cancel_job', { jobId });
  }

  resultStats(
    jobId: number,
    resultId: number,
    selection: CopySelection,
    top: boolean,
  ): Promise<ResultStats> {
    return call('result_stats', { jobId, resultId, selection, top });
  }

  cancelStats(jobId: number): Promise<void> {
    return call('cancel_job', { jobId });
  }
}
